import fs from "fs";
import http2, { ServerHttp2Stream, Http2ServerRequest, Http2ServerResponse } from "http2";
import { prepareStream } from "../prepareStream";
import { diff } from "../rsync/src/diff";
import { Readable, Writable } from "stream";
import { BLOCK_SIZE_BYTES, CHUNK_SIZE, HEADER_SIZE, Status, syncFileName } from "../constants";
import path from "path";
import { apply } from "../rsync/src/apply";
import { numberToBufferOfLength, scan } from "../utils";
import { IncomingHttpHeaders } from "http";

export class RsyncHTTP2Server {
    static streamHandledPath = [
        "/version",
        "/scan",
        "/push",
        "/pull",
        "/bump"
    ];

    port: number = 8000;
    baseDir: string = "";
    ssl: {
        cert: string | Buffer,
        key: string | Buffer,
    };

    pull(stream: ServerHttp2Stream) {
        return new Promise(resolve => {
            let itemPathLength: number;
            let itemPath: string;
            let itemExistsOnClient: boolean;

            let checksum: Uint8Array | undefined;
            let checksumSize: number, receivedChecksumBytes: number = 0;
            const receiveData = (chunk: Buffer): Buffer => {
                if (!checksum) return chunk;

                // there might be data for the next processing item
                let leftover = Buffer.from("")
                if (receivedChecksumBytes + chunk.byteLength > checksumSize) {
                    // for next item
                    const limit = checksumSize - receivedChecksumBytes;
                    leftover = chunk.subarray(limit);

                    // to complete our file
                    chunk = chunk.subarray(0, limit);
                }

                checksum.set(chunk, receivedChecksumBytes);
                receivedChecksumBytes += chunk.byteLength;

                // we now have everything to diff the transfering file
                // calculate diffs and stream the result back to client
                // then wait for next item.
                if (receivedChecksumBytes === checksumSize) {
                    const patches = diff(fs.readFileSync(path.resolve(this.baseDir, itemPath)), checksum);

                    stream.write(numberToBufferOfLength(patches.byteLength, 4));
                    stream.write(new Uint8Array(patches));

                    itemPathLength = 0;
                    itemPath = "";
                    itemExistsOnClient = false;
                    checksum = undefined;
                    checksumSize = 0;
                    receivedChecksumBytes = 0;
                }

                return leftover;
            }

            let accumulator = Buffer.from("");
            stream.on("data", (chunk: Buffer) => {
                // we might be receiving a lot of data
                // for a big checksum fof file
                chunk = receiveData(chunk);
                // we're not done
                if (chunk.byteLength === 0)
                    return;

                // this is computationnaly expensive since it could copy a lot of data
                // it should only happen with small amounts of data
                accumulator = Buffer.concat([accumulator, chunk]);

                const processAccumulator = () => {
                    if (accumulator.byteLength === 0)
                        return;

                    // 4.
                    // the rsync process began
                    // get the size of the checksum we're streaming
                    if (itemExistsOnClient && itemPath) {
                        if (accumulator.byteLength < HEADER_SIZE) {
                            return;
                        }

                        const blockCount = accumulator.subarray(BLOCK_SIZE_BYTES, HEADER_SIZE).readUint32LE();
                        checksumSize = blockCount * CHUNK_SIZE + HEADER_SIZE;

                        checksum = new Uint8Array(checksumSize);

                        accumulator = receiveData(accumulator);
                        processAccumulator();
                    }

                    // 3.
                    // the one byte that tells if we are about the start the rsync process
                    // or the client is just waiting for the data transfer
                    else if (itemPathLength && itemPath) {
                        itemExistsOnClient = accumulator.subarray(0, 1).at(0) === 1;
                        accumulator = accumulator.subarray(1);

                        // simply stream the whole file
                        if (!itemExistsOnClient) {
                            const localPath = path.resolve(this.baseDir, itemPath);

                            const { size } = fs.statSync(localPath);
                            stream.write(numberToBufferOfLength(size, 4));

                            const readStream = fs.createReadStream(localPath);

                            // for some unknown reasons, if we pipe directly to the stream
                            // the process manage to end the Http2Stream before finishing to read
                            const writeStream = new Writable({
                                write(chunk: Buffer, _: BufferEncoding, next) {
                                    stream.write(chunk);
                                    next();
                                }
                            });
                            readStream.pipe(writeStream);


                            itemPathLength = 0;
                            itemPath = "";
                        }

                        processAccumulator();
                    }

                    // 2.
                    // we've received an itemPathLength
                    // so the stream now has the itemPath stored
                    else if (itemPathLength && accumulator.byteLength >= itemPathLength) {
                        itemPath = accumulator.subarray(0, itemPathLength).toString("utf-8");
                        accumulator = accumulator.subarray(itemPathLength);

                        processAccumulator();
                    }

                    // 1.
                    // initial file transfer
                    // get the itemPath bytes length
                    else if (!itemPathLength && accumulator.byteLength >= 2) {
                        itemPathLength = accumulator.subarray(0, 2).readUInt16LE();
                        accumulator = accumulator.subarray(2);

                        processAccumulator();
                    }

                }

                processAccumulator();
            });


            stream.on("close", resolve);
        })
    }

    async push(stream: ServerHttp2Stream) {

        return new Promise(resolve => {
            let itemPathLength: number;
            let itemPath: string;
            let itemExists: boolean | undefined;
            let expectedSize: number;


            let writeStream: Writable | undefined;
            let receivedData = 0;

            const receiveData = (chunk: Buffer): Buffer => {
                // only use this if we have a write stream going on
                if (!writeStream) return chunk;

                // there might be data for the next processing item
                let leftover = Buffer.from("")
                if (receivedData + chunk.byteLength > expectedSize) {
                    // for next item
                    const limit = expectedSize - receivedData;
                    leftover = chunk.subarray(limit);

                    // to complete our file
                    chunk = chunk.subarray(0, limit);
                }

                writeStream.write(chunk);
                receivedData += chunk.byteLength;

                // we're done
                if (receivedData === expectedSize) {
                    writeStream.end();
                    writeStream = undefined;

                    itemPathLength = 0;
                    itemPath = "";
                    itemExists = undefined;
                    expectedSize = 0;
                    receivedData = 0;
                }

                return leftover;
            }

            let accumulator = Buffer.from("");
            stream.on("data", (chunk: Buffer) => {

                // we might be receiving a stream of data
                // like for a whole file, or patches
                chunk = receiveData(chunk);
                // we're not done
                if (chunk.byteLength === 0)
                    return;

                // this is computationnaly expensive since it could copy a lot of data
                // it should only happen with small amounts of data
                accumulator = Buffer.concat([accumulator, chunk]);

                const processAccumulator = () => {
                    if (accumulator.byteLength === 0)
                        return;

                    // 4.
                    // we're about to receive the byte length for whether
                    // the whole file or the patches from the rsync algo
                    if (itemExists !== undefined && itemPath) {
                        if (accumulator.byteLength < 4) return;

                        expectedSize = accumulator.subarray(0, 4).readUint32LE();
                        accumulator = accumulator.subarray(4);

                        const localPath = path.resolve(this.baseDir, itemPath);
                        // directly write to file
                        if (!itemExists) {
                            fs.mkdirSync(path.dirname(localPath), { recursive: true })
                            writeStream = fs.createWriteStream(localPath);
                        }
                        // accumulate patches and then apply
                        else {
                            const patches = new Uint8Array(expectedSize);
                            let receivedPatchesBytes = 0;

                            writeStream = new Writable({
                                write(chunk: Buffer, _, next: Function) {
                                    patches.set(chunk, receivedPatchesBytes);
                                    receivedPatchesBytes += chunk.byteLength;

                                    if (receivedPatchesBytes === expectedSize) {
                                        fs.writeFileSync(localPath, Buffer.from(apply(fs.readFileSync(localPath), patches)));
                                        writeStream?.end();
                                    }

                                    next();
                                }
                            });
                        }

                        accumulator = receiveData(accumulator);
                        processAccumulator();
                    }

                    // 3.
                    // now let's check if item is directory or file
                    // if directory, simply create it and go on,
                    // if file and file is exists, expect rsync process
                    //             else, expect the streaming of whole file 
                    else if (itemPathLength && itemPath) {
                        const isDirectory = accumulator.subarray(0, 1).at(0) === 1;
                        accumulator = accumulator.subarray(1);

                        const localPath = path.resolve(this.baseDir, itemPath);

                        // it's just a directory
                        // on to the next!
                        if (isDirectory) {
                            fs.mkdirSync(localPath, { recursive: true });

                            itemPathLength = 0;
                            itemPath = "";

                            return processAccumulator();
                        }

                        itemExists = fs.existsSync(localPath);

                        // we will receive the whole file
                        if (!itemExists) {
                            return processAccumulator();
                        }

                        // start the rsync algorithm by sending the checksum
                        prepareStream(localPath, stream, processAccumulator);
                    }

                    // 2.
                    // we've received an itemPathLength
                    // so the stream now has the itemPath stored
                    else if (itemPathLength && accumulator.byteLength >= itemPathLength) {
                        itemPath = accumulator.subarray(0, itemPathLength).toString("utf-8");
                        accumulator = accumulator.subarray(itemPathLength);

                        processAccumulator();
                    }

                    // 1.
                    // initial file transfer
                    // get the itemPath bytes length
                    // 2-bytes
                    else if (!itemPathLength && accumulator.byteLength >= 2) {
                        itemPathLength = accumulator.subarray(0, 2).readUInt16LE();

                        // we'll receive \x00 \x00 when finished
                        if (itemPathLength === 0) {
                            stream.close(http2.constants.NGHTTP2_NO_ERROR, () => stream.end());
                            return;
                        }

                        accumulator = accumulator.subarray(2);

                        processAccumulator();
                    }

                }

                processAccumulator();
            });


            stream.on("close", resolve);
        })
    }

    async requestHandler(req: Http2ServerRequest, res: Http2ServerResponse){
        console.log("handler", req.url);
        console.log(req.headers);

        // will be handled by the stream handler
        if( RsyncHTTP2Server.streamHandledPath.includes(req.url) )
            return;

        if(req.url === "/hello"){
            res.writeHead(200);
            res.end();
            return;
        }
        
        const fsMethod = maybeFsMethod(req.url);

        if (fsMethod){
            console.log("fs method");

            if(req.method !== "POST"){
                res.writeHead(405);
                res.write(`Only POST method allowed. Received [${req.method}]`)
                res.end();
                return;
            }

            const body = await readBody(req);
            let args;
            try{
                args = Object.values<any>(JSON.parse(body));
            } catch (e) {
                console.log("icicic", body, req.url);
                throw e;
            }
            console.log("Received Body", args);

            let result;
            // override readdir withFileTypes to directly return isDirectory
            // this way we can have all the information in one request
            if(fsMethod.name === "readdir" && args.at(1)?.withFileTypes) {
                const items = await fs.promises.readdir(args.at(0), args.at(1) as {withFileTypes: true});
                result = items.map(item => ({
                    ...item,
                    isDirectory: item.isDirectory()
                }));
            } else {
                try{
                    result = await fsMethod(...args);
                } catch (e) {
                    res.writeHead(500);
                    res.write(e.message);
                    res.end();
                    return;
                }
            }

            if(result){
                if(result instanceof Buffer){
                    res.writeHead(200);
                    res.write(result);
                }
                else{
                    res.writeHead(200, {"content-type": "application/json"});
                    res.write(JSON.stringify(result));
                }
            }
        }

        res.end();
    }

    async streamHandler(stream: ServerHttp2Stream, headers: IncomingHttpHeaders) {
        const pathname = headers[":path"].toString();

        // will be handled by request handler
        if( !RsyncHTTP2Server.streamHandledPath.includes(pathname) )
            return;


        console.log("stream", pathname, stream.headersSent)
        // request handler took care of it
        if(stream.headersSent || maybeFsMethod(pathname)) return;

        const outHeaders = {
            ':status': 200
        }

        if (pathname === "/scan") {
            stream.respond(outHeaders);
            const itemPath = await readBody(stream);
            const itemScan = scan(this.baseDir, itemPath, null);
            stream.write(JSON.stringify(itemScan));
        }
        else if (pathname === "/version"){
            stream.respond(outHeaders);
            const syncFile = path.resolve(this.baseDir, await readBody(stream), syncFileName);
            const version = fs.existsSync(syncFile)
                ? JSON.parse(fs.readFileSync(syncFile).toString()).version
                : null;
            stream.write(JSON.stringify({version}));
        }
        else if (pathname === "/bump"){
            stream.respond(outHeaders);
            const {version, itemPath} = JSON.parse(await readBody(stream));
            const syncFile = path.resolve(this.baseDir, itemPath, syncFileName);
            const stringified = JSON.stringify({version});
            fs.writeFileSync(syncFile, stringified);
            stream.write(stringified);
        }
        else if (pathname === "/pull") {
            stream.respond(outHeaders);
            await this.pull(stream);
        }
        else if (pathname === "/push") {
            stream.respond(outHeaders);
            await this.push(stream);
        }
        else {
            stream.respond({":status": 404});
        }

        stream.end();
    }

    start(): Status {
        const server = this.ssl 
            ? http2.createSecureServer({
                    ...this.ssl,
                    allowHTTP1: true
                }, this.requestHandler)
            : http2.createServer(this.requestHandler);

        server
            .on('error', (err) => console.error(err))
            .on('stream', this.streamHandler.bind(this))
            .listen(this.port);

        return {
            status: "success",
            message: `Sync Server listenning on port ${this.port}`
        }
    }
}

const readBody = (stream: Readable) => new Promise<string>(resolve => {
    let data = "";
    stream.on("data", chunk => data += chunk.toString());
    stream.on("end", () => resolve(data))
})

const maybeFsMethod = (pathname: string) => {
    // remove forward slash and queryString
    const maybeFsMethodName = pathname.slice(1).split("?").shift();

    return fs.promises[maybeFsMethodName] as Function;
}