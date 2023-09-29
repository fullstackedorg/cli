import stripComments from "strip-comments";

const theFinder = new RegExp(
    /((?<![\(\s]\s*['"])@\w*[\w\d]\s*(?![;])[\((?=\s)])/
);

export default (fileContent) => theFinder.test(stripComments(fileContent));
