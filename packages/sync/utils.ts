import fs from "fs";
import path from "path";
import ignore, {Ignore} from "ignore";
import { syncFileName } from "./constants";

export const scan = (baseDir: string, itemPath: string, items: [string, boolean][] = []) => {
    if(itemPath.endsWith(syncFileName)) return;
    
    const localPath = path.resolve(baseDir, itemPath);
    if (!fs.existsSync(localPath))
        return items;

    const isDirectory = fs.statSync(localPath).isDirectory();
    items.push([itemPath, isDirectory]);
    if (isDirectory) {
        fs.readdirSync(localPath).map(subItem => scan(baseDir, itemPath + "/" + subItem, items));
    }

    return items;
}

export function numberToBufferOfLength(num: number, byteLength: number){
    let uint8Arr = new Uint8Array(byteLength);

    for (let i = 0; i < byteLength; i++) {
        uint8Arr[i] = num % 256;
        num = Math.floor(num / 256);
    }

    return uint8Arr;
}

// key => last modified ms
export type Snapshot = { [key: string]: number };

export async function createSnapshot(baseDir: string, keys: string[]) {
    const snapshot: Snapshot  = {};

    await Promise.all(keys.map(key => new Promise<void>(res => {
        // skip fullstacked-sync files
        if(key.endsWith(syncFileName)) {
            return res()
        }

        const filePath = path.resolve(baseDir, key);
        fs.promises.lstat(filePath).then(({mtimeMs}) => {
            snapshot[key] = mtimeMs;
            res();
        })
    })));

    return snapshot;
}

export function getSnapshotDiffs(snapshotA: Snapshot, snapshotB: Snapshot){
    const keysA = Object.keys(snapshotA);
    const keysB = Object.keys(snapshotB);

    const missingInA = keysB.filter(keyFromB => !keysA.includes(keyFromB));
    const missingInB = keysA.filter(keyFromA => !keysB.includes(keyFromA));

    const keysInBoth = Array.from(new Set([
        ...keysA,
        ...keysB
    ])).filter(key => !missingInA.includes(key) && !missingInB.includes(key));

    const diffs = keysInBoth.filter(key => snapshotA[key] !== snapshotB[key]);

    return {
        missingInA,
        missingInB,
        diffs
    }
}

export const normalizePath = (maybeWindowsPath: string) => 
    maybeWindowsPath.split(path.sep).join("/");