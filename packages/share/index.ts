import CommandInterface from "@fullstacked/cli/CommandInterface";
import CLIParser from "@fullstacked/cli/utils/CLIParser";
import {WebSocket} from "ws";
import prompts from "prompts";
import cookie from "cookie";
import passwordPage from "./password";
import fs from "fs";
import os from "os";
import {randomUUID} from "crypto";

export default class Share extends CommandInterface {
    static TextDecoder = new TextDecoder();
    static commandLineArguments = {
        port: {
            type: "number",
            default: 8000
        },
        server: {
            type: "string",
            default: "https://share.fullstacked.cloud"
        },
        password: {
            type: "string",
        }
    } as const;
    config = CLIParser.getCommandLineArgumentsValues(Share.commandLineArguments);

    accessTokens = new Set<string>();

    waitTwoMinutesForAuth(validateURL: string){

        return new Promise(resolve => {
            const cutoff = setTimeout(() => {
                clearInterval(interval);
                resolve(null);
            }, 1000 * 60 * 2);

            const interval = setInterval(async () => {
                try{
                    const userData = await (await fetch(validateURL)).text();
                    if(userData){
                        clearInterval(interval);
                        clearTimeout(cutoff);
                        resolve(userData);
                    }
                }catch (e){}
            }, 1000);
        });
    }

    getCacheFileData(){
        const cacheDir = os.homedir() + "/.cache";
        if(!cacheDir)
            fs.mkdirSync(cacheDir);

        const shareCacheFile = cacheDir + "/fullstacked-share.json";
        return {
            filePath: shareCacheFile,
            data: fs.existsSync(shareCacheFile) ? JSON.parse(fs.readFileSync(shareCacheFile).toString()) : {}
        }
    }

    saveInCache(newData: object){
        let {filePath, data} = this.getCacheFileData();
        fs.writeFileSync(filePath, JSON.stringify({
            ...data,
            ...newData
        }));
    }

    run(): void {
        const serverURL = new URL(this.config.server);
        const ws = new WebSocket(`${serverURL.protocol === "https:" ? "wss" : "ws"}://${serverURL.host}`);
        const proxiedWS = new Map<string, WebSocket>();
        ws.on("message",  async (message) => {
            const data = JSON.parse(message.toString());
            if(data.require === "password"){
                const {password} = await prompts({
                    type: "password",
                    name: "password",
                    message: "FullStacked Share Server requires password"
                })
                ws.send(JSON.stringify({
                    reqId: data.reqId,
                    data: password
                }));
                return;
            }else if(data.require === "login"){
                let userData = this.getCacheFileData().data[this.config.server];
                if(!userData) {
                    console.log(`Please login at ${data.loginURL}`);
                    userData = await this.waitTwoMinutesForAuth(data.validateURL);
                }

                if(!userData)
                    console.log("Failed to authenticate");
                else
                    this.saveInCache({[this.config.server]: userData});

                ws.send(JSON.stringify({
                    reqId: data.reqId,
                    data: userData
                }));
                return
            }

            if(data.hash){
                console.log(`${serverURL.protocol}//${data.hash}.${serverURL.host}`);
                return;
            }

            if(data.ws){
                if(data.close){
                    proxiedWS.get(data.wsId)?.close();
                    proxiedWS.delete(data.wsId);
                    return;
                }else if(data.url){
                    const proxyWS = new WebSocket(`ws://0.0.0.0:${this.config.port}${data.url}`, {
                        headers: data.headers
                    });
                    proxiedWS.set(data.wsId, proxyWS);
                    proxyWS.on("message", message => {
                        ws.send(JSON.stringify({
                            ws: true,
                            wsId: data.wsId,
                            data: message.toString()
                        }));
                    });
                    return;
                }

                const proxyWS = proxiedWS.get(data.wsId);
                proxyWS.send(data.data);
                return;
            }

            if(this.config.password){
                const cookies = cookie.parse(data.headers.cookie ?? "");
                if(!this.accessTokens.has(cookies.fullstackedShareAccessToken)){

                    if(data.method === "POST"){
                        let parsedBody: any = {};
                        try{
                            parsedBody = JSON.parse(data.body)
                        }catch (e) {}

                        if(parsedBody.password === this.config.password){
                            const accessToken = randomUUID();
                            this.accessTokens.add(accessToken);
                            ws.send(JSON.stringify({
                                reqId: data.reqId,
                                data: {
                                    status: 200,
                                    headers: [
                                        ["content-type", "text/html"],
                                        ["Set-Cookie", cookie.serialize("fullstackedShareAccessToken", accessToken)]
                                    ],
                                    body: "Bonjour"
                                }
                            }));
                            return;
                        }
                    }

                    ws.send(JSON.stringify({
                        reqId: data.reqId,
                        data: {
                            status: 200,
                            headers: [["content-type", "text/html"]],
                            body: passwordPage
                        }
                    }));
                    return;
                }
            }

            delete data.headers.connection;

            const response = await fetch(`http://0.0.0.0:${this.config.port}${data.url}`, {
                method: data.method,
                headers: data.headers
            });
            const responseData = await response.arrayBuffer();
            const uint8Array = new Uint8Array(responseData);
            const body = uint8Array.reduce((acc, i) =>
                acc + String.fromCharCode.apply(null, [i]), '');
            const headers = [];
            response.headers.forEach((value, key) => headers.push([key, value]));
            ws.send(JSON.stringify({reqId: data.reqId, data: {
                status: response.status,
                headers,
                body
            }}));
        });
        ws.on("close", () => {
            console.log("Lost connection to share server");
            process.exit();
        })
    }

    runCLI(): void {
        this.run();
    }
}
