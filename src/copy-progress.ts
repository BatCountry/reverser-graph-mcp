#!/usr/bin/env node
import { copyProgress } from "./compare/cli.js";

process.exitCode = copyProgress(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line));
