import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_TOOLS, browserAvailable, browserServer, collectScreenshots } from "../src/browser.js";
import { uploadThreadFiles } from "../src/slack/slack.js";

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe("browserAvailable", () => {
  it("needs Playwright's Chromium under PLAYWRIGHT_BROWSERS_PATH", async () => {
    const browsers = await tmp("army-browsers-");
    expect(browserAvailable({ PLAYWRIGHT_BROWSERS_PATH: browsers })).toBe(false);
    await mkdir(join(browsers, "ffmpeg-1011"));
    expect(browserAvailable({ PLAYWRIGHT_BROWSERS_PATH: browsers })).toBe(false);
    await mkdir(join(browsers, "chromium-1252"));
    expect(browserAvailable({ PLAYWRIGHT_BROWSERS_PATH: browsers })).toBe(true);
  });

  it("is off without the variable, with a missing folder, or when switched off", async () => {
    const browsers = await tmp("army-browsers-");
    await mkdir(join(browsers, "chromium-1252"));
    expect(browserAvailable({})).toBe(false);
    expect(browserAvailable({ PLAYWRIGHT_BROWSERS_PATH: join(browsers, "missing") })).toBe(false);
    expect(browserAvailable({ PLAYWRIGHT_BROWSERS_PATH: browsers, BROWSER: "off" })).toBe(false);
  });
});

describe("browserServer", () => {
  it("runs the launcher next to browser.ts, headless and isolated, saving into the screenshots folder", () => {
    const config = browserServer("/work/army-1/screenshots", {
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      SLACK_BOT_TOKEN: "xoxb-secret",
      MASTER_KEY: "master",
    });
    expect(config.type).toBe("stdio");
    expect(config.command).toBe(process.execPath);
    const [launcher, ...flags] = config.args ?? [];
    expect(isAbsolute(launcher!)).toBe(true);
    expect(launcher).toBe(fileURLToPath(new URL("../src/browser-mcp.js", import.meta.url)));
    expect(flags).toEqual([
      "--headless",
      "--browser",
      "chromium",
      "--no-sandbox",
      "--isolated",
      "--ignore-roots",
      "--output-dir",
      "/work/army-1/screenshots",
      "--viewport-size",
      "1280x800",
      "--image-responses",
      "allow",
    ]);
    // No secrets: only what the browser needs, and where to run from.
    expect(config.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      BROWSER_MCP_CWD: "/work/army-1/screenshots",
    });
    expect(config.timeout).toBe(120_000);
  });

  it("never offers the tool that runs code inside the server", () => {
    expect(BROWSER_TOOLS).not.toContain("mcp__browser__browser_run_code_unsafe");
  });
});

describe("browser-mcp launcher", () => {
  const launcher = fileURLToPath(new URL("../src/browser-mcp.ts", import.meta.url));
  const run = (env: Record<string, string>, input?: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", launcher, "--headless", "--isolated", "--ignore-roots"], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (input && stdout.includes('"id":1')) child.kill();
      });
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      if (input) child.stdin.write(input);
      else child.stdin.end();
    });

  it("refuses to start without an existing screenshots folder", async () => {
    const missing = await run({});
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/BROWSER_MCP_CWD/);
    expect((await run({ BROWSER_MCP_CWD: join(tmpdir(), "army-no-such-folder") })).code).toBe(1);
  });

  it("starts the Playwright MCP server from the screenshots folder", async () => {
    const shots = await tmp("army-shots-");
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const result = await run({ BROWSER_MCP_CWD: shots }, `${initialize}\n`);
    expect(result.stdout).toContain('"serverInfo"');
    expect(result.stdout).toContain("Playwright");
  }, 30_000);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("collectScreenshots", () => {
  it("returns the images, oldest first, skipping other files, empty and oversized images and links", async () => {
    const dir = await tmp("army-shots-");
    const at = (name: string, seconds: number) => utimes(join(dir, name), seconds, seconds);
    await writeFile(join(dir, "home.png"), PNG);
    await writeFile(join(dir, "after.JPG"), PNG);
    await writeFile(join(dir, "mobile.webp"), PNG);
    await writeFile(join(dir, "page.yml"), "- snapshot");
    await writeFile(join(dir, "console.log"), "log");
    await writeFile(join(dir, "empty.png"), "");
    await writeFile(join(dir, "huge.jpeg"), Buffer.alloc(2048));
    await mkdir(join(dir, "flows"));
    await writeFile(join(dir, "flows", "login.jpeg"), PNG);
    await symlink(join(dir, "home.png"), join(dir, "link.png"));
    await at("home.png", 1000);
    await at("flows/login.jpeg", 2000);
    await at("after.JPG", 3000);
    await at("mobile.webp", 4000);

    const shots = await collectScreenshots(dir, { maxBytes: 1024 });
    expect(shots.map((s) => s.name)).toEqual(["home.png", "flows-login.jpeg", "after.JPG", "mobile.webp"]);
    expect(shots[0]!.bytes).toEqual(PNG);
  });

  it("keeps the newest when there are more than the maximum", async () => {
    const dir = await tmp("army-shots-");
    for (let i = 1; i <= 10; i++) {
      await writeFile(join(dir, `shot-${i}.png`), PNG);
      await utimes(join(dir, `shot-${i}.png`), i * 100, i * 100);
    }
    expect((await collectScreenshots(dir)).map((s) => s.name)).toEqual([
      "shot-3.png",
      "shot-4.png",
      "shot-5.png",
      "shot-6.png",
      "shot-7.png",
      "shot-8.png",
      "shot-9.png",
      "shot-10.png",
    ]);
    expect(await collectScreenshots(dir, { max: 2 })).toHaveLength(2);
  });

  it("returns nothing for an empty or missing folder", async () => {
    const dir = await tmp("army-shots-");
    expect(await collectScreenshots(dir)).toEqual([]);
    expect(await collectScreenshots(join(dir, "missing"))).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("uploadThreadFiles", () => {
  it("posts the files as one reply in the thread, with the comment", async () => {
    const client = { filesUploadV2: vi.fn(async () => ({ ok: true, files: [] })) };
    await uploadThreadFiles(client as never, {
      channel: "C1",
      threadTs: "100.1",
      comment: ":camera: 2 screenshots from the browser checks.",
      files: [
        { filename: "home.png", data: PNG },
        { filename: "after.png", data: PNG },
      ],
    });
    expect(client.filesUploadV2).toHaveBeenCalledWith({
      channel_id: "C1",
      thread_ts: "100.1",
      initial_comment: ":camera: 2 screenshots from the browser checks.",
      file_uploads: [
        { file: PNG, filename: "home.png", title: "home.png" },
        { file: PNG, filename: "after.png", title: "after.png" },
      ],
    });
  });

  it("does nothing without files and passes Slack's errors on", async () => {
    const client = { filesUploadV2: vi.fn(async () => ({ ok: true, files: [] })) };
    await uploadThreadFiles(client as never, { channel: "C1", threadTs: "1.1", comment: "x", files: [] });
    expect(client.filesUploadV2).not.toHaveBeenCalled();

    const refusing = { filesUploadV2: vi.fn().mockRejectedValue(Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } })) };
    await expect(
      uploadThreadFiles(refusing as never, { channel: "C1", threadTs: "1.1", comment: "x", files: [{ filename: "a.png", data: PNG }] }),
    ).rejects.toThrow(/missing_scope/);
  });
});
