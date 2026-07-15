#!/usr/bin/env node
import process from "node:process";
import { run } from "./research-memory.mjs";

run(["task", "complete", ...process.argv.slice(2)]).catch((error) => {
  console.error(`research-memory task complete: ${error.message}`);
  process.exitCode = 2;
});
