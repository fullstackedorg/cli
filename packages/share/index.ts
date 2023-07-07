import CommandInterface from "@fullstacked/cli/CommandInterface";
import CLIParser from "@fullstacked/cli/utils/CLIParser";
import {WebSocket} from "ws";

export default class Share extends CommandInterface {
    static commandLineArguments = {
        port: {
            type: "number",
            default: 8001
        },
        server: {
            type: "string",
        }
    } as const;
    config = CLIParser.getCommandLineArgumentsValues(Share.commandLineArguments);

    run(): void {
        const ws = new WebSocket("ws://localhost:8000");
        ws.on("message",  async (message) => {
            const data = JSON.parse(message.toString());
            if(data.hash){
                console.log(`${data.hash}.localhost:8000`);
                return;
            }

            if(data.ws){
                const proxyWS = new WebSocket(`ws://localhost:${this.config.port}${data.url}`, {
                    headers: data.headers
                });
                proxyWS.on("message", message => {
                    ws.send(JSON.stringify({
                        ws: true,
                        wsId: data.wsId,
                        data: message.toString()
                    }));
                })
                return;
            }

            const response = await fetch(`http://localhost:${this.config.port}${data.url}`, {
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
        })
    }

    runCLI(): void {
        this.run();
    }
}
