#!/usr/bin/env node
// npm create agent-army / npx create-agent-army
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`create-agent-army needs Node.js 20 or newer (this is ${process.versions.node}): https://nodejs.org`);
  process.exit(1);
}

const { main } = await import("../src/cli.js");
main(process.argv.slice(2), { handleSignals: true }).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`create-agent-army failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
