import {clearLine, cursorTo} from "readline";
import Docker from "@fullstacked/cli/utils/docker";

export async function maybePullDockerImage(image, tag?, options = {
    verbose: true,
    fallbackTag: "latest"
}){
    const dockerClient = await Docker.getClient();

    tag = tag || "latest";

    const localImage = dockerClient.getImage(`${image}:${tag}`);
    let localImageInspect;
    try {
        localImageInspect = await localImage.inspect();
    }catch (e){ }

    const lastTagPush = await lastTagPushOnDockerHub(image, tag);

    // if doesnt exist locally and doesnt it exist on Docker Hub, redo process with `latest`
    if(!localImageInspect && !lastTagPush){
        if(!options.fallbackTag || options.fallbackTag === tag)
            throw new Error(`Can neither find [${image}:${tag}] on local machine and Docker Hub`);

        return maybePullDockerImage(image, options.fallbackTag);
    }
    // tag exists locally, but not on Docker Hub, proceed.
    else if(localImageInspect && !lastTagPush)
        return `${image}:${tag}`;
    // doesnt exist locally, but do exists on Docker Hub, PULL
    else if(!localImageInspect && lastTagPush) {
        await pullImage(dockerClient, `${image}:${tag}`, options.verbose);
        return `${image}:${tag}`;
    }

    // both exists, pull only if Docker Hub has a newer image for tag
    const localTagCreationDate = new Date(localImageInspect.Created);
    const lastTagPushDate = new Date(lastTagPush);

    if(lastTagPushDate > localTagCreationDate)
        await pullImage(dockerClient, `${image}:${tag}`, options.verbose);

    return `${image}:${tag}`;
}

async function lastTagPushOnDockerHub(image, tag){
    let lastPush;
    try{
        const dockerHubResponse = await fetch(`https://hub.docker.com/v2/repositories/${image}/tags/${tag}`);
        if(dockerHubResponse.status === 200){
            lastPush = (await dockerHubResponse.json()).tag_last_pushed;
        }
    }catch (e) { console.log(e, "Docker Hub") }

    return lastPush;
}

async function pullImage(dockerClient, image, verbose){
    const pullStream = await dockerClient.pull(image);
    await new Promise<void>(resolve => {

        pullStream.on("data", dataRaw => {
            if(!verbose) return;

            const dataParts = dataRaw.toString().match(/{.*}/g);
            dataParts.forEach((part) => {
                const {status, progress} = JSON.parse(part);
                clearLine(process.stdout, 0);
                cursorTo(process.stdout, 0, null);
                process.stdout.write(`[${image}] ${status} ${progress || " "}`);
            });
        });

        pullStream.on("end", () => {
            if(verbose){
                clearLine(process.stdout, 0);
                cursorTo(process.stdout, 0, null);
            }

            resolve();
        });
    });
}
