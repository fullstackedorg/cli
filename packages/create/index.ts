import CommandInterface from "@fullstacked/cli/CommandInterface";
import CLIParser from "@fullstacked/cli/utils/CLIParser";
import {argsSpecs} from "./args";
import create from "./create";

export default class Create extends CommandInterface {
    static commandLineArguments = argsSpecs;
    config = CLIParser.getCommandLineArgumentsValues(Create.commandLineArguments);

    run() {
        return create();
    }

    runCLI() {
        return this.run();
    }
}
