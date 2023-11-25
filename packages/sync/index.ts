import CommandInterface from "@fullstacked/cli/CommandInterface";
import CLIParser from "@fullstacked/cli/utils/CLIParser";
import { RsyncHTTP2Server } from "./http2/server";
import { RsyncHTTP2Client } from "./http2/client";
import fs from "fs";
import { ProgressInfo, Status } from "./constants";
import prettyBytes from 'pretty-bytes';

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
        filters: {
            type: "string[]",
            description: "File to use to filter out files to sync",
            defaultDescription: ".gitignore",
            default: [".gitignore"] as string[]
        },
        exclude: {
            type: "string[]",
            description: "Items to skip"
        },
        maxStream: {
            type: "number",
            description: "Maximum concurrent streams",
            defaultDescription: "5",
            default: 5
        },
        force: {
            short: "f",
            type: "boolean",
            description: "Force operation even if there are conflicts or version mismatch",
            defaultDescription: "false",
            default: false
        },
        // encryptionKey: {
        //     short: "e",
        //     type: "string",
        //     description: "Add an encryption key to encrypt before push and decrypt after pull",
        //     default: ""
        // },
        pull: {
            type: "boolean",
            description: "Pull files from remote server",
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


    async run(progress?:(info: ProgressInfo) => void): Promise<Status> {
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

            return server.start();
        }

        const client = new RsyncHTTP2Client(this.config.endpoint);
        client.maximumConcurrentStreams = this.config.maxStream;
        client.baseDir = this.config.directory;
        if(this.config.pull){
            return client.pull(".", {
                progress,
                exclude: this.config.exclude?.map(item => item.trim()),
                force: this.config.force
            })
        } else {
            return client.push(".", {
                progress,
                filters: this.config.filters?.map(filter => filter.trim()),
                force: this.config.force
            })
        }
    }

    async runCLI() {
        let logging: string[];

        const status = await this.run((progress) => {
                
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);

            if(logging?.length) {
                for(let i = 0; i < logging.length - 1; i++){
                    process.stdout.moveCursor(0, -1);
                    process.stdout.clearLine(0);
                    process.stdout.cursorTo(0);
                }
            }

            logging = [];
            if(progress.items){
                logging.push(`Item Completed: ${progress.items.completed}/${progress.items.total}`);
            }

            if(progress.streams){
                const cols = process.stdout.columns;

                Object.keys(progress.streams).forEach(stream => {
                    const data = progress.streams[stream];
                    const percent = data.transfered / data.total * 100;

                    if(isNaN(percent)) return;

                    let line = "[" + stream + "] " + 
                        (data.transfered/data.total * 100).toFixed(2) + "%" + 
                        ` (${prettyBytes(data.total)}) `;

                    let itemPath = data.itemPath;
                    if(itemPath.length > cols - line.length - 3)
                        itemPath = "..." + itemPath.slice(0 - cols + line.length + 3)

                    logging.push(line + itemPath);
                })
            }

            process.stdout.write(logging.join("\n"));
        });

        process.stdout.write("\n");

        if(status.status === "error")
            throw Error(status.message);
        else if(status.status === "conflicts")
            console.log(`Can't pull. Changes in [${status.items.join(" ")}]`)
        else
            console.log(status.message);
    }
    
}