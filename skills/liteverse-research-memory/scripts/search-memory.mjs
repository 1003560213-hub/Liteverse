#!/usr/bin/env node
import process from "node:process";
import { run } from "./research-memory.mjs";

run(["search", ...process.argv.slice(2)]).catch((error) => {
  console.error(`research-memory search: ${error.message}`);
  process.exitCode = 2;
});
