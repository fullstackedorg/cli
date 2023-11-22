import CommandInterface from "@fullstacked/cli/CommandInterface";
import CLIParser from "@fullstacked/cli/utils/CLIParser";
import { RsyncHTTP2Server } from "./http2/server";
import { RsyncHTTP2Client } from "./http2/client";
import fs from "fs";

export default class Sync extends CommandInterface {
    static commandLineArguments = {
        endpoint: {
            type: "string",
            description: "Define a remote server endpoint",
            defaultDescription: "https://storage.fullstacked.cloud",
            default: "https://storage.fullstacked.cloud"
        },
        directory: {
            short: "d",
            type: "string",
            description: "Defins a directory where to sync",
            defaultDescription: "current directory",
            default: process.cwd()
        },
        maxStream: {
            type: "number",
            description: "Maximum concurrent streams",
            defaultDescription: "5",
            default: 5
        },
        encryptionKey: {
            short: "e",
            type: "string",
            description: "Add an encryption key to encrypt before push and decrypt after pull",
            default: ""
        },
        pull: {
            type: "boolean",
            description: "Push files to remote server",
            defaultDescription: "Will push if no --pull flag",
            default: false
        },
        server: {
            type: "boolean",
            description: "Run the remote server script",
            defaultDescription: "false",
            default: false
        },
        serverPort: {
            type: "number",
            description: "Listen server at port",
            defaultDescription: "8080",
            default: 8080,
        },
        serverCertSSL: {
            type: "string",
            description: "SSL Certificate file path"
        },
        serverKeySSL: {
            type: "string",
            description: "SSL Private Key file path"
        }
    } as const;
    config = CLIParser.getCommandLineArgumentsValues(Sync.commandLineArguments);


    async run(): Promise<void> {
        if(this.config.server){
            const server = new RsyncHTTP2Server();
            server.baseDir = this.config.directory;
            server.port = this.config.serverPort;

            if(this.config.serverCertSSL && this.config.serverKeySSL){
                server.ssl = {
                    cert: fs.readFileSync(this.config.serverCertSSL),
                    key: fs.readFileSync(this.config.serverKeySSL)
                }
            }

            server.start();
            return;
        }

        const client = new RsyncHTTP2Client(this.config.endpoint);
        client.maximumConcurrentStreams = 5;
        client.baseDir = this.config.directory;
        if(this.config.pull){
            await client.pull(".")
        } else {
            await client.push(".")
        }
    }

    runCLI(): void {
        this.run();
    }
    
}