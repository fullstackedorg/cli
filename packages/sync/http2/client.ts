import fs from "fs";
import { ClientHttp2Session, ClientHttp2Stream, connect } from "http2";
import path from "path";
import { apply } from "../rsync/src/apply";
import { Writable } from "stream";
import { diff } from "../rsync/src/diff";
import { prepareStream } from "../prepareStream";
import { BLOCK_SIZE_BYTES, CHUNK_SIZE, HEADER_SIZE, ProgressInfo, Status, syncFileName } from "../constants";
import { Snapshot, createSnapshot, getSnapshotDiffs, numberToBufferOfLength, scan } from "../utils";


type PushOptions = {
    progress?(info: ProgressInfo): void,
    force?: boolean,
    filters?: string[]
}

type PullOptions = {
    progress?(info: ProgressInfo): void,
    force?: boolean,
    exclude?: string[]
}

export class RsyncHTTP2Client {
    endpoint: string;
    baseDir: string = "";
    maximumConcurrentStreams: number = 5;
    headers: {
        [header: string]: string
    } = {};

    constructor(endpoint: string) {
        this.endpoint = endpoint;
    }

    private getSavedSnapshotAndVersion(itemLocalPath: string){
        const syncFile = path.resolve(itemLocalPath, syncFileName);

        if(!fs.existsSync(syncFile)){
            return { version: null };
        }

        return JSON.parse(fs.readFileSync(syncFile).toString())
    }

    private saveSnapshotAndVersion(itemLocalPath: string, snapshot: Snapshot, version: number) {
        const syncFile = path.resolve(itemLocalPath, syncFileName);
        fs.writeFileSync(syncFile, JSON.stringify({...snapshot, version: version}))
    }

    private getVersionOnRemote(session: ClientHttp2Session, itemPath: string): Promise<number>{
        const stream = session.request({
            ':path': '/version',
            ':method': 'POST',
            ...this.headers
        });
        stream.write(itemPath)
        stream.end();

        stream.setEncoding('utf8');
        return new Promise(resolve => {
            let data = ''
            stream.on('data', (chunk) => { data += chunk })
            stream.on('end', () => {
                resolve(JSON.parse(data).version);
            });
        })
    }

    private bumpVersionOnRemote(session: ClientHttp2Session, itemPath: string, version: number): Promise<number> {
        const stream = session.request({
            ':path': '/bump',
            ':method': 'POST',
            ...this.headers
        });
        stream.write(JSON.stringify({
            itemPath,
            version
        }))
        stream.end();

        stream.setEncoding('utf8');
        return new Promise(resolve => {
            let data = ''
            stream.on('data', (chunk) => { data += chunk })
            stream.on('end', () => {
                resolve(JSON.parse(data).version);
            });
        })
    }

    private scanItemOnRemote(session: ClientHttp2Session, itemPath: string): Promise<ReturnType<typeof scan>> {
        const stream = session.request({
            ':path': '/scan',
            ':method': 'POST',
            ...this.headers
        });
        stream.write(itemPath)
        stream.end();

        stream.setEncoding('utf8')
        return new Promise(resolve => {
            let data = ''
            stream.on('data', (chunk) => { data += chunk })
            stream.on('end', () => {
                resolve(JSON.parse(data));
            });
        })
    }

    async push(itemPath: string, options?: PushOptions): Promise<Status> {
        const session = connect(this.endpoint);
        session.on('error', (err) => {
            throw err;
        });

        const items = scan(this.baseDir, itemPath, options?.filters);

        if(!items.length) return;

        const mainItemPathIsDirectory = items[0][1];
        let onFinish;
        if(mainItemPathIsDirectory){
            const mainLocalPath = path.resolve(this.baseDir, itemPath);
            const fileItemsPaths = items
                .filter(([_, isDir]) => !isDir)
                .map(([itemPath]) => itemPath);

            const snapshot = await createSnapshot(this.baseDir, fileItemsPaths);
            const { version, ...previousSnapshot } = this.getSavedSnapshotAndVersion(mainLocalPath);

            const remoteVersion = await this.getVersionOnRemote(session, itemPath);

            const {
                diffs,
                missingInA,
                missingInB
            } = getSnapshotDiffs(previousSnapshot, snapshot);
            if(!diffs.length && !missingInA.length && !missingInB.length && remoteVersion !== null){
                session.close();
                return {
                    status: "none",
                    message: "No changes. No push needed."
                }
            }

            if(remoteVersion !== null && remoteVersion !== version) {
                session.close();
                return {
                    status: "error",
                    message: `Version Mismatch. Local version [${version}], Remote version [${remoteVersion}]. Pull and retry to push.`
                }
            }

            onFinish = async () => {
                const newVersion = Math.max((version || 0) + 1, (remoteVersion || 0) + 1);
                const bumpedVersion = await this.bumpVersionOnRemote(session, itemPath, newVersion);
                this.saveSnapshotAndVersion(mainLocalPath, snapshot, bumpedVersion);
            }
        }

        // this map allows us to check if item exists on remote
        // and make sure there is no directory <-> file confusion
        const remoteItems = new Map<string, boolean>();
        (await this.scanItemOnRemote(session, itemPath)).forEach(([itemPath, isDirectory]) => {
            remoteItems.set(itemPath, isDirectory);
        });

        const itemsCount = items.length; 
        const progressInfo: ProgressInfo = {
            items: {
                completed: 0,
                total: itemsCount
            },
            streams: {}
        }

        const streamPush = async (stream: ClientHttp2Stream, streamIndex: number) => new Promise<void>(async resolve => {
            const item = items.shift();

            // end the stream
            if (!item) {
                // this is our end signal
                stream.write(new Uint8Array([0, 0]));
                return;
            }

            // init stream
            if (!stream) {
                stream = session.request({
                    ':path': '/push',
                    ':method': 'POST',
                    ...this.headers
                });

                stream.on("end", () => {
                    delete progressInfo.streams[streamIndex];
                    if(options?.progress)
                        options.progress(progressInfo);

                    resolve()
                });
            }

            const itemPath = item[0];
            const isDirectory = item[1];

            progressInfo.items.completed = itemsCount - items.length;

            const updateStreamProgress = (transfered, total) => {
                progressInfo.streams[streamIndex] = {
                    itemPath,
                    transfered,
                    total,
                }
                if(options?.progress)
                    options.progress(progressInfo);
            }

            updateStreamProgress(0, 0);

            const localPath = path.resolve(this.baseDir, itemPath);

            const remoteItemIsDirectory = remoteItems.get(itemPath);
            const itemExistsOnServer = remoteItemIsDirectory !== undefined;

            if (itemExistsOnServer && remoteItemIsDirectory !== isDirectory) {
                throw new Error(`Item [${itemPath}] is ${isDirectory ? "directory" : "file"} locally and a ${remoteItemIsDirectory ? "directory" : "file"} on remote`);
            }

            const itemPathBuffer = Buffer.from(itemPath);
            const pathLength = numberToBufferOfLength(itemPathBuffer.byteLength, 2); // 2-bytes

            await new Promise<void>(resolve2 => {
                // run the rsync algorithm
                if (itemExistsOnServer && !isDirectory) {
                    let accumulator = Buffer.from("");
                    let size = 0;
                    let checksum, receivedData = 0;

                    const receiveChecksum = (chunk: Buffer) => {
                        if (!size) {
                            // accumulate until we have received at least 8-bytes (HEADER_SIZE)
                            // to determine, the block count of the checksum
                            accumulator = Buffer.concat([accumulator, chunk]);
                            if (accumulator.byteLength < HEADER_SIZE)
                                return;

                            const blockCount = accumulator.subarray(BLOCK_SIZE_BYTES, HEADER_SIZE).readUint32LE();
                            size = blockCount * CHUNK_SIZE + HEADER_SIZE;
                            checksum = new Uint8Array(size);
                            chunk = accumulator;
                        }

                        checksum.set(chunk, receivedData);
                        receivedData += chunk.byteLength;

                        updateStreamProgress(receivedData, size);

                        if (receivedData === size) {
                            stream.off("data", receiveChecksum);
                            const patches = diff(fs.readFileSync(localPath), checksum);

                            stream.write(numberToBufferOfLength(patches.byteLength, 4));
                            stream.write(Buffer.from(patches));

                            resolve2();
                        }
                    }

                    stream.on("data", receiveChecksum);
                }

                stream.write(pathLength);
                stream.write(itemPathBuffer);
                stream.write(new Uint8Array([isDirectory ? 1 : 0]));

                if (isDirectory) {
                    resolve2();
                    return;
                }

                // stream the whole file
                if (!itemExistsOnServer) {
                    const { size } = fs.statSync(localPath);
                    stream.write(numberToBufferOfLength(size, 4));

                    let sentBytes = 0;
                    const readStream = fs.createReadStream(localPath);

                    const writeStream = new Writable({
                        write(chunk: Buffer, _: BufferEncoding, next) {
                            stream.write(chunk);

                            sentBytes += chunk.byteLength;
                            
                            updateStreamProgress(sentBytes, size);

                            next();
                        }
                    });
                    readStream.pipe(writeStream);
                    readStream.on("end", resolve2);
                }
            });

            return streamPush(stream, streamIndex);
        });


        const streamsCount = Math.min(items.length, this.maximumConcurrentStreams);
        await Promise.all(new Array(streamsCount).fill(null).map(streamPush));

        if(onFinish)
            await onFinish();

        session.close();

        return {
            status: "success",
            message: "Push done."
        }
    }

    async pull(itemPath: string, options?: PullOptions): Promise<Status> {
        const session = connect(this.endpoint);
        session.on('error', (err) => {
            throw err;
        });

        let items = await this.scanItemOnRemote(session, itemPath);

        if(items.length === 0){
            return {
                status: "error",
                message: `[${itemPath}] does not exists or is empty on remote server.`
            }
        }

        if(options?.exclude){
            items = items.filter(([itemPath]) => {
                // if we find an exclude item that starts with the itemPath
                // then we should exclude. This way we can exclude a directory
                const exclude = options.exclude.find(item => itemPath.startsWith(item));

                // keep only if no exclude found
                return !exclude;
            });
        }

        const mainItemPathIsDirectory = items[0][1];
        let onFinish;
        if(mainItemPathIsDirectory){
            const remoteVersion = await this.getVersionOnRemote(session, itemPath);

            const mainLocalPath = path.resolve(this.baseDir, itemPath);
            const { version, ...previousSnapshot } = this.getSavedSnapshotAndVersion(mainLocalPath);

            if(remoteVersion !== null && version !== null && remoteVersion === version){
                return {
                    status: "none",
                    message: "Same version as remote. No pull needed."
                }
            }

            const fileItemsPaths = items
                .filter(([_, isDir]) => !isDir)
                .map(([itemPath]) => itemPath);

            if (version !== null) {
                const snapshot = await createSnapshot(this.baseDir, fileItemsPaths);

                const {
                    diffs,
                    missingInA,
                    missingInB
                } = getSnapshotDiffs(previousSnapshot, snapshot);

                if(diffs.length){
                    session.close();
                    return {
                        status: "conflicts",
                        items: diffs 
                    };
                }
            }

            onFinish = async () => {
                const remoteVersion = await this.getVersionOnRemote(session, itemPath);
                this.saveSnapshotAndVersion(mainLocalPath, await createSnapshot(this.baseDir, fileItemsPaths), remoteVersion);
            }
        }

        const itemsCount = items.length; 
        const progressInfo: ProgressInfo = {
            items: {
                completed: 0,
                total: itemsCount
            },
            streams: {}
        }

        const streamPull = async (stream: ClientHttp2Stream, streamIndex: number) => {
            const item = items.shift();

            // end the stream
            if (!item) {

                if (stream) {
                    delete progressInfo.streams[streamIndex];
                    if(options?.progress)
                        options.progress(progressInfo);

                    stream.close();
                    stream.end();
                }

                return;
            }

            const itemPath = item[0];
            const isDirectory = item[1];

            progressInfo.items.completed = itemsCount - items.length;
            const updateStreamProgress = (transfered, total) => {
                progressInfo.streams[streamIndex] = {
                    itemPath,
                    transfered,
                    total,
                }
                if(options?.progress)
                    options.progress(progressInfo);
            }
            updateStreamProgress(0, 0);

            // the item is a directory, just create it
            // mkdir -p
            if (isDirectory) {
                fs.mkdirSync(path.resolve(this.baseDir, itemPath), { recursive: true })
                return streamPull(stream, streamIndex);
            }

            // init stream
            if (!stream) {
                stream = session.request({
                    ':path': '/pull',
                    ':method': 'POST',
                    ...this.headers
                });
            }

            const itemPathBuffer = Buffer.from(itemPath);
            const pathLength = numberToBufferOfLength(itemPathBuffer.byteLength, 2); // 2-bytes
            const localPath = path.resolve(this.baseDir, itemPath);
            const exists = fs.existsSync(localPath);

            await new Promise<void>(async resolve => {

                // the server will simply stream whole file
                if (!exists) {
                    const writeStream = fs.createWriteStream(localPath);
                    let size = 0;
                    let written = 0;

                    const writeToFile = (chunk: Buffer) => {
                        if (!size) {
                            size = chunk.subarray(0, 4).readUint32LE();
                            chunk = chunk.subarray(4);
                        }

                        writeStream.write(chunk);
                        written += chunk.byteLength;

                        updateStreamProgress(written, size);

                        if (written === size) {
                            const fileHandleIsClosed = () => {
                                stream.off("data", writeToFile);
                                resolve();
                            }
                            writeStream.end(fileHandleIsClosed);
                        }
                    }

                    stream.on("data", writeToFile);
                }

                stream.write(pathLength);
                stream.write(itemPathBuffer);
                stream.write(new Uint8Array([exists ? 1 : 0]));

                // run the rsync algorithm
                if (exists) {
                    let accumulator = Buffer.from("");
                    let size = 0;
                    let patches, receivedData = 0;

                    const receivePatches = (chunk: Buffer) => {

                        if (!size) {
                            // accumulate until we have received at least 4-bytes 
                            // to determine, the length of the patches buffer
                            accumulator = Buffer.concat([accumulator, chunk]);
                            if (accumulator.byteLength < 4)
                                return;

                            size = accumulator.subarray(0, 4).readUint32LE();
                            patches = new Uint8Array(size);
                            chunk = accumulator.subarray(4);
                        }

                        patches.set(chunk, receivedData);
                        receivedData += chunk.byteLength;

                        updateStreamProgress(receivedData, size);

                        if (receivedData === size) {
                            stream.off("data", receivePatches);
                            try{
                                fs.writeFileSync(localPath, Buffer.from(apply(fs.readFileSync(localPath), patches.buffer)))
                            }catch(e){ 
                                console.log(`Failed to write to [${localPath}]`)
                            }
                            resolve();
                        }
                    }

                    stream.on("data", receivePatches);

                    prepareStream(localPath, stream, () => { })
                }


            });

            return streamPull(stream, streamIndex);
        }

        const streamsCount = Math.min(items.length, this.maximumConcurrentStreams);
        await Promise.all(new Array(streamsCount).fill(null).map(streamPull));

        if(onFinish)
            await onFinish();

        session.close();

        return {
            status: "success",
            message: "Pull done."
        }
    }
}