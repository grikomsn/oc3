#!/usr/bin/env node
const { spawn } = require("node:child_process");
const path = require("node:path");

let binary;
try {
  binary = require.resolve(`@nbrst/oc3-${process.platform}-${process.arch}/bin/oc3`);
} catch {
  console.error(`oc3: no prebuilt binary for ${process.platform}-${process.arch}.`);
  console.error("Install manually: https://github.com/grikomsn/oc3#install");
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
