import CommandInterface from "@fullstacked/cli/CommandInterface";
import CLIParser from "@fullstacked/cli/utils/CLIParser";
import {WebSocket} from "ws";

export default class Share extends CommandInterface {
    static commandLineArguments = {
        port: {
            type: "number",
            default: 8000
        },
        server: {
            type: "string",
            default: "https://share.fullstacked.cloud"
        }
    } as const;
    config = CLIParser.getCommandLineArgumentsValues(Share.commandLineArguments);

    run(): void {
        const serverURL = new URL(this.config.server);
        const ws = new WebSocket(`${serverURL.protocol === "https:" ? "wss" : "ws"}://${serverURL.host}`);
        const proxiedWS = new Map<string, WebSocket>();
        ws.on("message",  async (message) => {
            const data = JSON.parse(message.toString());
            if(data.hash){
                console.log(`${serverURL.protocol}//${data.hash}.${serverURL.host}`);
                return;
            }

            if(data.ws){
                if(data.close){
                    proxiedWS.get(data.wsId)?.close();
                    proxiedWS.delete(data.wsId);
                    return;
                }

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
                })
                return;
            }

            delete data.headers.connection;

            const response = await fetch(`http://0.0.0.0:${this.config.port}${data.url}`, {
                method: data.method,
                headers: data.headers
            });
            const body = await response.text();
            const headers = [];
            response.headers.forEach((value, key) =>
                headers.push([key, value]));
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
