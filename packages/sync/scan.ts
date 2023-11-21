import fs from "fs";
import path from "path";

export const scan = (baseDir: string, itemPath: string, items: [string, boolean][] = []) => {
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