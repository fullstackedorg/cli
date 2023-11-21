import { Writable } from "stream";
import { adler32 } from "./rsync/src/utils/adler32";
import { md5 } from "./rsync/src/utils/md5";
import { DEFAULT_BLOCK_SIZE } from "./rsync/src/utils/options";
import fs from "fs";

const processBlock = (data: Uint8Array) => {
    const checksum = new Uint8Array(4 + 16);

    checksum.set(numberToBufferOfLength(adler32(data), 4), 0);

    const md5_array = md5(data);
    checksum.set(numberToBufferOfLength(md5_array[0], 4), 4);
    checksum.set(numberToBufferOfLength(md5_array[1], 4), 8);
    checksum.set(numberToBufferOfLength(md5_array[2], 4), 12);
    checksum.set(numberToBufferOfLength(md5_array[3], 4), 16);
    
    return checksum
}

export function prepareStream(filePath: string, outStream: Writable, cb: () => void, blockSize = DEFAULT_BLOCK_SIZE) {
    const { size } = fs.statSync(filePath);

    const readStream = fs.createReadStream(filePath);
    const blockCount = Math.ceil(size / blockSize);

    outStream.write(numberToBufferOfLength(blockSize, 4));
    outStream.write(numberToBufferOfLength(blockCount, 4));

    let accumulator: Uint8Array = new Uint8Array(size);

    let offset = 0, completedBlock = 0;
    const onData = (chunk: Buffer) => {
        accumulator.set(chunk, offset);
        offset += chunk.byteLength;

        const progress = completedBlock * blockSize;
        let blockCount = Math.floor((offset - progress) / blockSize);

        for(let i = 0; i < blockCount; i++){
            const block = accumulator.subarray(i * blockSize + progress, (i + 1) * blockSize + progress);
            outStream.write(processBlock(block));
            completedBlock++;
        }
    }

    const onEnd = () => {
        // process leftover
        const leftover = accumulator.subarray(completedBlock * blockSize);
        if(leftover.byteLength)
            outStream.write(processBlock(leftover));
        cb();
    }

    readStream.on("data", onData);
    readStream.on("end", onEnd);
}

export function numberToBufferOfLength(num: number, byteLength: number){
    let uint8Arr = new Uint8Array(byteLength);

    for (let i = 0; i < byteLength; i++) {
        uint8Arr[i] = num % 256;
        num = Math.floor(num / 256);
    }

    return uint8Arr;
}