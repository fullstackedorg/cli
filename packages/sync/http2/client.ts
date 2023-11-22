import fs from "fs";
import { ClientHttp2Session, ClientHttp2Stream, connect } from "http2";
import path from "path";
import { apply } from "../rsync/src/apply";
import { Writable } from "stream";
import { diff } from "../rsync/src/diff";
import { prepareStream } from "../prepareStream";
import { BLOCK_SIZE_BYTES, CHUNK_SIZE, HEADER_SIZE, syncFileName } from "../constants";
import { Snapshot, createSnapshot, getSnapshotDiffs, numberToBufferOfLength, scan } from "../utils";

const log = (...args) => {
    console.log("[CLIENT]\n", ...args);
}

export class RsyncHTTP2Client {
    endpoint: string;
    baseDir: string = "";
    maximumConcurrentStreams: number = 10;

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
            ':method': 'POST'
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
            ':method': 'POST'
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
            ':method': 'POST'
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

    async push(itemPath: string) {
        const session = connect(this.endpoint);
        session.on('error', (err) => console.error(err));

        const items = scan(this.baseDir, itemPath);

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
                console.log("No changes, no push needed");
                session.close();
                return;
            }

            if(remoteVersion !== version){
                console.log("versions mismatches");
                session.close();
                return;
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

        const itemCount = items.length;

        const streamPush = async (stream: ClientHttp2Stream, streamIndex: number) => new Promise(async resolve => {
            const item = items.shift();

            log(itemCount - items.length, itemCount)

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
                    ':method': 'POST'
                });

                stream.on("end", resolve)
            }

            const itemPath = item[0];
            const isDirectory = item[1];

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

                            if (itemPath.endsWith("tsserver.js"))
                                log(sentBytes);

                            // 5 mb
                            if (size >= 5 * 1024 * 1024) {
                                console.log(itemPath, (sentBytes / size * 100).toFixed(2) + "%");
                            }

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

        log("Push done");
        session.close();
    }

    async pull(itemPath: string) {
        const session = connect(this.endpoint);
        session.on('error', (err) => console.error(err))

        const items = await this.scanItemOnRemote(session, itemPath);
        const itemCount = items.length;

        const streamPull = async (stream: ClientHttp2Stream, streamIndex: number) => {
            const item = items.shift();

            log(itemCount - items.length, itemCount)

            // end the stream
            if (!item) {

                if (stream) {
                    stream.close();
                    stream.end();
                }

                return;
            }

            const itemPath = item[0];
            const isDirectory = item[1];

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
                    ':method': 'POST'
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

                        // 5 mb
                        if (size >= 5 * 1024 * 1024) {
                            console.log(itemPath, (written / size * 100).toFixed(2) + "%");
                        }

                        if (written === size) {
                            stream.off("data", writeToFile);
                            resolve();
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

                        if (receivedData === size) {
                            stream.off("data", receivePatches);
                            try {
                                fs.writeFileSync(localPath, Buffer.from(apply(fs.readFileSync(localPath), patches.buffer)))
                            } catch (e) {
                                log(`Couln't not write [${itemPath}]`)
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

        log("Pull done");
        session.close();
    }
}