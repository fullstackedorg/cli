import {execSync} from "child_process";
import {resolve} from "path";
import {existsSync, readFileSync, rmSync, writeFileSync} from "fs";
import CLIParser from "./utils/CLIParser";

function packPackage(packageDirectory: string){
    const packageFilename = execSync("npm pack", {cwd: packageDirectory})
        .toString()
        .split("\n")
        .filter(line => line.trim())
        .pop();
    return resolve(packageDirectory, packageFilename);
}

// pack fullstacked main package
export const fullstackedPackage = packPackage(".");

function installPackageInPackage(packageDirectory: string, packageToInstall: string, dev?: boolean){
    execSync(`npm i ${packageToInstall} ${dev ? "-D" : ""}`, {cwd: packageDirectory, stdio: "inherit"});
}

const toPack = CLIParser.getCommandLineArgumentsValues({
    packages: {
        type: "string[]"
    }
})

function installPackageThenPack(packageToPack: string, packageToInstall: string){
    if(toPack?.packages && !toPack.packages.includes(packageToPack))
        return;

    packageToPack = "packages/" + packageToPack;
    installPackageInPackage(packageToPack, packageToInstall);
    return packPackage(packageToPack);
}

function removePackages(packageLocation: string, packages: string[]){
    packageLocation = "packages/" + packageLocation
    const packageJSON = JSON.parse(readFileSync(packageLocation + "/package.json").toString());
    packages.forEach(packageName => {
        delete packageJSON.devDependencies[packageName];
        delete packageJSON.dependencies[packageName];
    });
    writeFileSync(packageLocation + "/package.json", JSON.stringify(packageJSON, null, 2));
    if(existsSync(packageLocation + "/node_modules"))
        rmSync(packageLocation + "/node_modules", {recursive: true});
    if(existsSync(packageLocation + "/package-lock.json"))
        rmSync(packageLocation + "/package-lock.json");
}

// pack packages
export const buildPackage  = installPackageThenPack("build"   , fullstackedPackage);
export const runPackage    = installPackageThenPack("run"     , fullstackedPackage);
export const watchPackage  = installPackageThenPack("watch"   , fullstackedPackage);
export const deployPackage = installPackageThenPack("deploy"  , fullstackedPackage);
export const backupPackage = installPackageThenPack("backup"  , fullstackedPackage);
export const sharePackage  = installPackageThenPack("share"   , fullstackedPackage);
export const syncPackage   = installPackageThenPack("sync"    , fullstackedPackage);
export const webappPackage = installPackageThenPack("webapp"  , fullstackedPackage);
export const createPackage = installPackageThenPack("create"  , fullstackedPackage);

// gui
const guiLocation = "gui";
if(!toPack?.packages || toPack.packages.includes(guiLocation)){
    removePackages(guiLocation, [
        "@fullstacked/build",
        "@fullstacked/deploy",
        "@fullstacked/watch",
        "@fullstacked/webapp"
    ]);
    installPackageInPackage(guiLocation, buildPackage, true);
    installPackageInPackage(guiLocation, deployPackage, true);
    installPackageInPackage(guiLocation, watchPackage, true);
    installPackageInPackage(guiLocation, webappPackage, true);  
}
export const guiPackage = installPackageThenPack(guiLocation, fullstackedPackage);
