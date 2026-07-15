#!/usr/bin/env node
import process from "node:process";
import { run } from "./research-memory.mjs";

run(["record", "memory", ...process.argv.slice(2)]).catch((error) => {
  console.error(`research-memory record: ${error.message}`);
  process.exitCode = 2;
});
