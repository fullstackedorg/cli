import fs from "fs";
import http2, { ServerHttp2Stream } from "http2";
import { numberToBufferOfLength, prepareStream } from "../prepareStream";
import { diff } from "../rsync/src/diff";
import { Writable } from "stream";
import { BLOCK_SIZE_BYTES, CHUNK_SIZE, HEADER_SIZE } from "../constants";
import { scan } from "../scan";
import path from "path";
import { apply } from "../rsync/src/apply";

const log = (...args) => {
    console.log("[SERVER]\n", ...args);
}

export class RsyncHTTP2Server {
    port: number = 8000;
    baseDir: string = "";

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

                        // we'll send \x00 \x00 when finished
                        if (itemPathLength === 0) {
                            stream.close();
                            stream.end();
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

    start() {
        const server = http2.createServer();

        server.on('error', (err) => console.error(err))

        server.on('stream', async (stream, headers) => {
            const pathname = headers[":path"];

            stream.respond({
                ':status': 200
            });

            if (pathname === "/scan") {
                const itemPath = await readBody(stream);
                const itemScan = scan(this.baseDir, itemPath);
                stream.write(JSON.stringify(itemScan));
            }
            else if (pathname === "/pull") {
                await this.pull(stream);
            }
            else if (pathname === "/push") {
                await this.push(stream);
            }

            log("Stream end");
            stream.end();
        })


        server.listen(this.port);
    }
}

const readBody = (stream: ServerHttp2Stream) => new Promise<string>(resolve => {
    let data = '';
    stream.on("data", chunk => data += chunk);
    stream.on("end", () => resolve(data.toString()))
})
