import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Starts the Playwright MCP server from the screenshots folder (see
 * browserServer in browser.ts). With --ignore-roots the server's workspace
 * root is its cwd, and a screenshot saved under an explicit relative name is
 * written there: running from this folder keeps screenshots out of the
 * checkout, which the worker commits as a whole. stdout is the MCP channel,
 * so nothing but the server may write to it.
 */

const cwd = process.env.BROWSER_MCP_CWD;
const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
if (!cwd || !isDirectory(cwd)) {
  console.error("[browser-mcp] BROWSER_MCP_CWD must name an existing folder for screenshots.");
  process.exit(1);
}
process.chdir(cwd);

// The package's exports do not include cli.js, so it is loaded by its absolute path.
const pkgPath = createRequire(import.meta.url).resolve("@playwright/mcp/package.json");
await import(pathToFileURL(join(dirname(pkgPath), "cli.js")).href);
