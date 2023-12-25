import { MessageWS } from "./MessageWS";
import {MultiCall} from "./MutliCall";

class Client<ApiDefinition> {
    private cache: {[key: string]: any};
    private recurseInProxy(target, method: "GET" | "POST" | "PUT" | "DELETE", useCache = false, arrayBuffer = false, pathComponents: string[] = []){
        return new Proxy(target, {
            apply: (target, _, argArray) => {
                // activate cache
                if(useCache && !this.cache)
                    this.cache = {};

                // check if response is already in cache
                if(method === "GET" && this.cache) {
                    const pathComponentsAsStr = pathComponents.toString();
                    const argAsStr = argArray.map(arg => JSON.stringify(arg)).toString();

                    if(!this.cache[pathComponentsAsStr])
                        this.cache[pathComponentsAsStr] = {};

                    // update cache
                    if(!this.cache[pathComponentsAsStr][argAsStr] || !useCache)
                        this.cache[pathComponentsAsStr][argAsStr] = target(method, pathComponents, arrayBuffer, ...argArray);

                    return this.cache[pathComponentsAsStr][argAsStr];
                }

                return target(method, pathComponents, arrayBuffer, ...argArray);
            },
            get: (_, p) =>  {
                pathComponents.push(p as string);
                return this.recurseInProxy(target, method, useCache, arrayBuffer, pathComponents);
            }
        })
    }
    origin: string;
    headers: {[key: string]: string} = {};
    requestOptions: RequestInit = {};
    ws: Promise<WebSocket>;
    wsReqs: Map<number, {resolve: Function, reject: Function}> = new Map();
    getWS = async () => {
        if(this.ws) 
            return this.ws;

        let origin = this.origin;
        if(typeof window !== "undefined" && !origin){
            origin = window.location.origin + "/rpc";
        }

        if(!origin)
            throw new Error("No origin defined");

        const wsUrl = new URL(origin);

        wsUrl.protocol = wsUrl.protocol === "https:"
            ? "wss:"
            : "ws:";

        const onClose = () => {
            this.ws = null;
        }

        const onMessage = (rawData: MessageEvent) => {
            const message: MessageWS = JSON.parse(rawData.data);

            const req = this.wsReqs.get(message.reqId);
            req.resolve(message.body);
            this.wsReqs.delete(message.reqId);
        }

        this.ws = new Promise(resolve => {
            const ws = new WebSocket(wsUrl.toString());
            ws.onopen = () => resolve(ws);

            ws.onmessage = onMessage;

            ws.onerror = onClose;
            ws.onclose = onClose;
        })

        return this.ws;
    };

    constructor(origin: string) {
        this.origin = origin;
    }

    call() { return this.recurseInProxy(wsCall.bind(this), null, false, false) as any as ApiDefinition }

    get(useCache = false, arrayBuffer = false){ return this.recurseInProxy(fetchCall.bind(this), "GET", useCache, arrayBuffer) as any as ApiDefinition }
    post(arrayBuffer = false){ return this.recurseInProxy(fetchCall.bind(this), "POST", false, arrayBuffer) as any as ApiDefinition }
    put(arrayBuffer = false){ return this.recurseInProxy(fetchCall.bind(this), "PUT", false, arrayBuffer) as any as ApiDefinition }
    delete(arrayBuffer = false){ return this.recurseInProxy(fetchCall.bind(this), "DELETE", false, arrayBuffer) as any as ApiDefinition }

    multi(){
        const calls : MultiCall[]  = [];
        return {
            add: (arrayBuffer?: boolean) => {
                return this.recurseInProxy((_, pathComponents, arrayBuffer, ...args) => {
                    calls.push({
                        pathComponents,
                        arrayBuffer,
                        args
                    })
                },null, false, arrayBuffer);
            },
            fetch: () => multiFetchCall.bind(this)(calls)
        }
    }
}

async function multiFetchCall(calls: MultiCall[]){
    let origin = this.origin;

    // default origin in browser
    if(typeof window !== "undefined" && !origin){
        origin = window.location.origin + "/rpc";
    }

    if(!origin)
        throw new Error("No origin defined");

    const url = new URL(origin);
    url.pathname += (url.pathname.endsWith("/") ? "" : "/") + "multi";

    const requestInit: RequestInit = {
        ...this.requestOptions,
        method: "POST",
        body: JSON.stringify(calls)
    };

    const headers = {};

    Object.entries(this.headers).forEach(([key, value]) => {
        headers[key] = value;
    });
    requestInit.headers = headers;

    headers["Content-Type"] = "application/json";

    const response = await fetch(url.toString(), requestInit);
    if(response.status >= 400){
        let errorData = await response.text();
        try {
            errorData = JSON.parse(errorData);
        }catch (e){ }

        throw new Error(errorData);
    }

    const json = await response.json();
    return json.map((data, index) => {
        if(calls[index].arrayBuffer && data.type === "Buffer")
            return (new Uint8Array(data.data)).buffer
        return data;
    });
}

async function fetchCall(method, pathComponents, arrayBuffer, ...args) {
    let origin = this.origin;

    // default origin in browser
    if(typeof window !== "undefined" && !origin){
        origin = window.location.origin + "/rpc";
    }

    if(!origin)
        throw new Error("No origin defined");

    const url = new URL(origin);

    url.pathname += (url.pathname.endsWith("/") ? "" : "/") + pathComponents.join("/");

    const requestInit: RequestInit = {
        ...this.requestOptions,
        method
    };

    const headers = {};

    switch (requestInit.method) {
        case "POST":
        case "PUT": {
            const body = {};
            args.forEach((value, index) => body[index] = value);
            headers["Content-Type"] = "application/json";
            requestInit.body = JSON.stringify(body);
            break;
        }
        default: {
            args.forEach((value, index) => {
                const isObject = typeof value === "object";

                if (!isObject) {
                    url.searchParams.append(index.toString(), value);
                    return;
                }

                headers["Content-Type"] = "application/json";
                url.searchParams.append(index.toString(), JSON.stringify(value));
            });
        }
    }

    Object.entries(this.headers).forEach(([key, value]) => {
        headers[key] = value;
    });
    requestInit.headers = headers;

    const response = await fetch(url.toString(), requestInit);

    const data = arrayBuffer
        ? await response.arrayBuffer()
        : response.headers.get("Content-Type") === "application/json"
            ? await response.json()
            : await response.text();

    if(response.status >= 400){
        const errorData = typeof data === "object"
            ? JSON.stringify(data)
            : data.toString();

        throw new Error(`[${url.toString()}]` + errorData);
    }

    return data;
}

async function wsCall(this: Client<any>, _, pathComponents, __, ...body) {
    const ws = await this.getWS();
    
    const reqId = Math.floor(Math.random() * 1000000);
    const message: MessageWS = {
        reqId,
        method: pathComponents,
        body
    }

    return new Promise((resolve, reject) => {
        this.wsReqs.set(reqId, {resolve, reject});
        ws.send(JSON.stringify(message));
    });
}

type OnlyOnePromise<T> = T extends PromiseLike<any>
    ? T
    : Promise<T>;

type AwaitAll<T> = {
    [K in keyof T]:  T[K] extends ((...args: any) => any)
        ? (...args: T[K] extends ((...args: infer P) => any) ? P : never[]) =>
            OnlyOnePromise<(T[K] extends ((...args: any) => any) ? ReturnType<T[K]> : any)>
        : AwaitAll<T[K]>
}

type NoAwait<T> = {
    [K in keyof T]: T[K] extends ((...args: any) => any) ? (...args: T[K] extends ((...args: infer P) => any) ? P : never[]) => Awaited<OnlyOnePromise<(T[K] extends ((...args: any) => any) ? ReturnType<T[K]> : any)>> : NoAwait<T[K]>;
};


type CommonProperties<T> = {
    headers: Client<T>["headers"],
    origin: Client<T>["origin"]
}

export default function createClient<ApiDefinition>(origin = "") {
    return new Client<ApiDefinition>(origin) as CommonProperties<ApiDefinition> & {
        requestOptions: Client<ApiDefinition>["requestOptions"],
        get(useCache?: boolean, arrayBuffer?: boolean): AwaitAll<ApiDefinition>,
        post(arrayBuffer?: boolean): AwaitAll<ApiDefinition>,
        put(arrayBuffer?: boolean): AwaitAll<ApiDefinition>,
        delete(arrayBuffer?: boolean): AwaitAll<ApiDefinition>,
        multi(): {
            add(arrayBuffer?: boolean): NoAwait<ApiDefinition>
            fetch(): Promise<any[]>;
        }
    };
}

export function createClientWS<ApiDefinition>(origin = "") {
    return new Client<ApiDefinition>(origin) as CommonProperties<ApiDefinition> & {
        call(): AwaitAll<ApiDefinition>
    };
}
