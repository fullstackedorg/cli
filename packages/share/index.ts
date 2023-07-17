import CommandInterface from "@fullstacked/cli/CommandInterface";
import CLIParser from "@fullstacked/cli/utils/CLIParser";
import {WebSocket} from "ws";
import prompts from "prompts";
import cookie from "cookie";
import passwordPage from "./password";
import fs from "fs";
import os from "os";
import {randomUUID} from "crypto";

type ShareEventCallbackData = {
    type: "url",
    url: string
} | {
    type: "login",
    url: string
} | {
    type: "password",
    callback: (password: string) => void
} | {
    type: "end"
} | {
    type: "error",
    message: string
};

export default class Share extends CommandInterface {
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
        },
        userData: {
            type: "string"
        }
    } as const;
    config = CLIParser.getCommandLineArgumentsValues(Share.commandLineArguments);

    accessTokens = new Set<string>();
    private ws: WebSocket = null;
    listeners: Set<(data: ShareEventCallbackData) => any> = new Set();

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

    getCacheData(){
        const cacheDir = os.homedir() + "/.cache";
        if(!fs.existsSync(cacheDir))
            fs.mkdirSync(cacheDir);

        const shareCacheFile = cacheDir + "/fullstacked-share.json";
        if(!fs.existsSync(shareCacheFile))
            fs.writeFileSync(shareCacheFile, "{}");

        return {
            filePath: shareCacheFile,
            data: JSON.parse(fs.readFileSync(shareCacheFile).toString())
        }
    }

    saveCacheData(newData: object){
        let {filePath, data} = this.getCacheData();
        fs.writeFileSync(filePath, JSON.stringify({
            ...data,
            ...newData
        }));
    }


    run(): void {
        const serverURL = new URL(this.config.server);
        this.ws = new WebSocket(`${serverURL.protocol === "https:" ? "wss" : "ws"}://${serverURL.host}`);
        const proxiedWS = new Map<string, WebSocket>();
        this.ws.on("message",  async (message) => {
            const data = JSON.parse(message.toString());
            if(data.require === "password"){
                this.listeners.forEach(listener => {
                    listener({
                        type: "password",
                        callback: (password) => this.ws.send(JSON.stringify({
                            reqId: data.reqId,
                            data: password
                        }))
                    })
                });
                return;
            }else if(data.require === "login"){
                let userData = this.getCacheData().data[this.config.server];

                const validateAuth = async () => {
                    try{
                        const response = await fetch(data.validateURL, {
                            method: "POST",
                            body: userData
                        });
                        if(response.status >= 400)
                            userData = undefined;
                        else
                            userData = await response.text();
                    }catch (e) {
                        userData = undefined;
                    }
                }

                // try directly if userData exists for server
                if(userData){
                    await validateAuth();
                }

                // if no userData after first validation
                // try login
                if(!userData) {
                    this.saveCacheData({[this.config.server]: undefined});
                    this.listeners.forEach(listener => {
                        listener({
                            type: "login",
                            url: data.loginURL
                        })
                    })
                    userData = await this.waitTwoMinutesForAuth(data.validateURL);
                    await validateAuth();
                }

                // save whatever we came up with
                this.saveCacheData({[this.config.server]: userData});

                // notify that it never seemed work
                if(!userData) {
                    this.listeners.forEach(listener => {
                        listener({
                            type: "error",
                            message: "Failed to authenticate"
                        })
                    })
                }

                // return req to share-server
                this.ws.send(JSON.stringify({
                    reqId: data.reqId,
                    data: userData
                }));
                return;
            }

            if(data.hash){
                this.listeners.forEach(listener => {
                    listener({
                        type: "url",
                        url: `${serverURL.protocol}//${data.hash}.${serverURL.host}`
                    })
                })
                return;
            }

            if(data.ws){
                if(data.close){
                    proxiedWS.get(data.wsId)?.close();
                    proxiedWS.delete(data.wsId);
                    return;
                }else if(data.url){
                    const proxyWS = new WebSocket(`ws://0.0.0.0:${this.config.port}${data.url}`, data.headers["sec-websocket-protocol"],{
                        headers: data.headers
                    });
                    proxiedWS.set(data.wsId, proxyWS);
                    proxyWS.on("message", message => {
                        this.ws.send(JSON.stringify({
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
                            this.ws.send(JSON.stringify({
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

                    this.ws.send(JSON.stringify({
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

            let response;
            try {
                response = await fetch(`http://0.0.0.0:${this.config.port}${data.url}`, {
                    method: data.method,
                    headers: data.headers
                });
            } catch (e) {
                this.stop();
                return;
            }
            const responseData = await response.arrayBuffer();
            const uint8Array = new Uint8Array(responseData);
            const body = uint8Array.reduce((acc, i) =>
                acc + String.fromCharCode.apply(null, [i]), '');
            const headers = [];
            response.headers.forEach((value, key) => headers.push([key, value]));
            this.ws.send(JSON.stringify({reqId: data.reqId, data: {
                status: response.status,
                headers,
                body
            }}));
        });
        this.ws.on("close", () => {
            this.listeners.forEach(listener => {
                listener({type: "end"})
            });
        })
    }

    stop(){
        this.ws.close();
    }

    runCLI(): void {
        this.listeners.add(async data => {
            switch (data.type){
                case "url":
                    console.log(data.url);
                    return;
                case "login":
                    console.log(`Please login at ${data.url}`);
                    return;
                case "password":
                    const {password} = await prompts({
                        type: "password",
                        name: "password",
                        message: "FullStacked Share Server requires password"
                    })
                    data.callback(password);
                    return;
                case "error":
                    console.log(data.message);
                    return;
                case "end":
                    console.log(`Port ${this.config.port} has stopped sharing`);
                    process.exit();
                    return;
            }
        })

        this.run();
    }
}
