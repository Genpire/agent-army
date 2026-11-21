// Local files: the private keys file and the real file system behind the Fs interface.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @typedef {import("./types.js").Fs} Fs */
/** @typedef {import("./types.js").Secrets} Secrets */

/**
 * The base of the local file names: agent-army-<name>, or just <name> when it already starts with agent-army.
 * @param {string} name
 */
export const localName = (name) => (name.startsWith("agent-army") ? name : `agent-army-${name}`);

/** agent-army-<name>.env: the deployment's keys. @param {string} name */
export const keysFileName = (name) => `${localName(name)}.env`;

/**
 * The keys file: MASTER_KEY decrypts the deployment's data, so it is written with mode 600.
 * @param {{ name: string, provider: string, secrets: Secrets, extra?: Record<string, string>, date: Date }} options
 */
export function keysFileContent({ name, provider, secrets, extra = {}, date }) {
  const lines = [
    `# Agent Army "${name}" on ${provider}, written by create-agent-army on ${date.toISOString().slice(0, 10)}.`,
    "#",
    "# KEEP THIS FILE SAFE AND PRIVATE. MASTER_KEY decrypts everything this deployment stores",
    "# (its settings, API keys and tokens, memory and task records). Without it the data can't be",
    "# read back; with it, anyone holding a copy of the data can read it. Put a copy in a password",
    "# manager, and never commit this file.",
    "",
    `AGENT_ARMY_NAME=${name}`,
    `AGENT_ARMY_PROVIDER=${provider}`,
    ...Object.entries(extra).map(([key, value]) => `${key}=${value}`),
    `MASTER_KEY=${secrets.masterKey}`,
    `SETUP_TOKEN=${secrets.setupToken}`,
    "",
  ];
  return lines.join("\n");
}

/** @type {Fs} */
export const nodeFs = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  writePrivateFile(path, content, overwrite) {
    // "wx" never replaces a file that may hold an earlier deployment's key.
    writeFileSync(path, content, { mode: 0o600, flag: overwrite ? "w" : "wx" });
    chmodSync(path, 0o600);
  },
  writeFile: (path, content) => writeFileSync(path, content),
  makeTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
};
