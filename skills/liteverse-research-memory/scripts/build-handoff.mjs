#!/usr/bin/env node
import process from "node:process";
import { run } from "./research-memory.mjs";

run(["handoff", "build", ...process.argv.slice(2)]).catch((error) => {
  console.error(`research-memory handoff: ${error.message}`);
  process.exitCode = 2;
});
