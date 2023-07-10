import {randomBytes} from "crypto";

export default function (length: number = 6){
    return randomBytes(length).toString('hex');
}
