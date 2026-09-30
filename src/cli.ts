#!/usr/bin/env node
// `branch`: the command's entry. Help (`branch --help`, `branch <command> --help`) and completion scripts are answered
// here, from the few modules that know the commands (src/cli-quick.ts); everything else loads the whole program
// (src/cli-program.ts). Loading the program loads the engine, about 1,200 modules, which took a second or more before
// a help line could print.
import { quickAnswer } from "./cli-quick.js";
import { sayOnceIfNodeIsTooOld } from "./node-floor.js";

const answer = quickAnswer(process.argv.slice(2));
if (answer === null) await import("./cli-program.js");
else {
  sayOnceIfNodeIsTooOld((line) => console.error(line));
  console.log(answer);
}
