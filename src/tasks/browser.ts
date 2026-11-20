import { readdirSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * Headless browser for repo tasks: agents that can run commands get the
 * Playwright MCP server's tools, so they can start the app, click through a
 * change and take screenshots. Screenshots are written outside the checkout
 * (the server runs from that folder) and posted in the task's Slack thread.
 */

/** MCP server name; tools are called mcp__browser__<tool>. */
export const BROWSER_SERVER = "browser";

const tool = (name: string) => `mcp__${BROWSER_SERVER}__${name}`;

/**
 * The browser tools agents may use. browser_run_code_unsafe is left out on
 * purpose: it runs arbitrary code inside the MCP server's process, outside
 * the shell guard.
 */
export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_hover",
  "browser_drag",
  "browser_press_key",
  "browser_wait_for",
  "browser_resize",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_evaluate",
  "browser_handle_dialog",
  "browser_tabs",
  "browser_close",
  "browser_file_upload",
  "browser_find",
  "browser_emulate_media",
].map(tool);

export type BrowserServerConfig = McpStdioServerConfig;

/**
 * Whether this worker can give the team a browser: not switched off with
 * BROWSER=off, Playwright's Chromium installed under PLAYWRIGHT_BROWSERS_PATH
 * (the image installs it there), and the Playwright MCP package present.
 */
export function browserAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BROWSER === "off") return false;
  const dir = env.PLAYWRIGHT_BROWSERS_PATH;
  if (!dir) return false;
  try {
    if (!readdirSync(dir).some((entry) => entry.startsWith("chromium"))) return false;
    createRequire(import.meta.url).resolve("@playwright/mcp/package.json");
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser MCP server the agents that can run commands get. It runs
 * browser-mcp.js (next to this module), which starts Playwright MCP from
 * `shotsDir`: a screenshot saved under an explicit relative name resolves
 * against the server's workspace root, its cwd with --ignore-roots, so
 * screenshots never land in the checkout the worker commits. Its
 * environment carries no secrets.
 */
export function browserServer(shotsDir: string, env: NodeJS.ProcessEnv = process.env): BrowserServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./browser-mcp.js", import.meta.url)),
      "--headless",
      "--browser",
      "chromium",
      "--no-sandbox",
      "--isolated",
      "--ignore-roots",
      "--output-dir",
      shotsDir,
      "--viewport-size",
      "1280x800",
      "--image-responses",
      "allow",
    ],
    env: {
      PATH: env.PATH ?? "",
      HOME: env.HOME ?? "/tmp",
      LANG: env.LANG ?? "C.UTF-8",
      ...(env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH } : {}),
      BROWSER_MCP_CWD: shotsDir,
    },
    timeout: 120_000,
  };
}

export interface Screenshot {
  /** File name for Slack: the path inside the screenshots folder, separators replaced. */
  name: string;
  bytes: Buffer;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const SCREENSHOTS_MAX = 8;
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The screenshots the browser checks left in `shotsDir`, oldest first: the
 * newest `max` images (png, jpg, jpeg, webp), skipping empty files and files
 * over `maxBytes`. Links are not followed. A missing folder means none.
 */
export async function collectScreenshots(
  shotsDir: string,
  opts: { max?: number; maxBytes?: number } = {},
): Promise<Screenshot[]> {
  const { max = SCREENSHOTS_MAX, maxBytes = SCREENSHOT_MAX_BYTES } = opts;
  let entries;
  try {
    entries = await readdir(shotsDir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const found: { path: string; name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      const info = await stat(path);
      if (info.size === 0 || info.size > maxBytes) continue;
      found.push({ path, name: relative(shotsDir, path).split(sep).join("-"), mtimeMs: info.mtimeMs });
    } catch {
      // vanished or unreadable: skipped
    }
  }
  found.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const out: Screenshot[] = [];
  for (const shot of found.slice(-max)) {
    try {
      out.push({ name: shot.name, bytes: await readFile(shot.path) });
    } catch {
      // vanished or unreadable: skipped
    }
  }
  return out;
}
