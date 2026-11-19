import { describe, expect, it } from "vitest";
import { type RepoSetupContext, orchestratorPrompt } from "../src/agents.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { REPO_RULES } from "../src/team.js";

const baseConfig = (): Config => ConfigSchema.parse({});

const BROWSER_HEADING = "Browser checks:";
const SETUP_HEADING = "Repository setup from the owner:";
const browser = { shotsDir: "/work/army-1/screenshots" };

const fullSetup: RepoSetupContext = {
  startCommand: "npm run dev",
  appUrl: "http://localhost:3000",
  envKeys: ["DATABASE_URL", "STRIPE_KEY"],
  setup: { command: "npm ci", ok: true, seconds: 41.6, outputTail: "added 812 packages in 41s" },
};

describe("browser checks in the orchestrator prompt", () => {
  it("explains the browser, the verify flow and the screenshots", () => {
    const prompt = orchestratorPrompt(baseConfig(), { browser });
    expect(prompt).toContain(BROWSER_HEADING);
    expect(prompt).toMatch(/headless Chromium/);
    expect(prompt).toContain("mcp__browser__browser_*");
    expect(prompt).toMatch(/run commands or change code/);
    expect(prompt).toMatch(/You do not have it yourself/);
    // Start in the background, wait, open, exercise, console.
    expect(prompt).toMatch(/run_in_background/);
    expect(prompt).toMatch(/wait until it answers/);
    expect(prompt).toMatch(/browser_navigate/);
    expect(prompt).toMatch(/exercise the changed flow/);
    expect(prompt).toMatch(/browser_console_messages/);
    // Screenshots: relative, descriptive, two widths, outside the checkout, posted in Slack.
    expect(prompt).toMatch(/browser_take_screenshot/);
    expect(prompt).toContain("after-sidebar-desktop.png");
    expect(prompt).toMatch(/1280 wide/);
    expect(prompt).toMatch(/390 wide/);
    expect(prompt).toMatch(/relative file names/);
    expect(prompt).toContain(browser.shotsDir);
    expect(prompt).toMatch(/posted in the Slack thread/);
    expect(prompt).toMatch(/Never take a screenshot of a page that shows secrets/);
    expect(prompt).toMatch(/cannot start[^\n]*say so in verification/);
    // Subagents never see this prompt: Pointer must pass it on.
    expect(prompt).toMatch(/cannot see this prompt: tell the verifying agent/);
    // Reference material: the ground rules still come after it.
    expect(prompt.indexOf(BROWSER_HEADING)).toBeLessThan(prompt.indexOf(REPO_RULES.trim()));
  });

  it("mentions the browser in the verify step only when there is one", () => {
    const verifyLine = (p: string) => p.split("\n").find((l) => l.includes("- Verify:")) ?? "";
    expect(verifyLine(orchestratorPrompt(baseConfig(), { browser }))).toMatch(/check it in the browser/);
    expect(verifyLine(orchestratorPrompt(baseConfig()))).not.toMatch(/browser/i);
  });

  it("uses the owner's start command and app URL when set", () => {
    const prompt = orchestratorPrompt(baseConfig(), { browser, repoSetup: fullSetup });
    const section = prompt.slice(prompt.indexOf(BROWSER_HEADING));
    expect(section).toContain("`npm run dev`");
    expect(section).toContain("http://localhost:3000");
    expect(section).not.toMatch(/dev or start script/);
  });

  it("falls back to the project's dev script without a start command", () => {
    const prompt = orchestratorPrompt(baseConfig(), { browser });
    expect(prompt).toMatch(/the project's dev or start script/);
    expect(prompt).toMatch(/the URL the start command prints/);
  });

  it("has no browser section without a browser", () => {
    expect(orchestratorPrompt(baseConfig())).not.toContain(BROWSER_HEADING);
    expect(orchestratorPrompt(baseConfig(), { repoSetup: fullSetup })).not.toContain(BROWSER_HEADING);
    expect(orchestratorPrompt(baseConfig())).not.toContain("mcp__browser__");
  });
});

describe("repo setup in the orchestrator prompt", () => {
  it("gives the start command, the app URL, the variable names and the setup result", () => {
    const prompt = orchestratorPrompt(baseConfig(), { repoSetup: fullSetup });
    expect(prompt).toContain(SETUP_HEADING);
    const section = prompt.slice(prompt.indexOf(SETUP_HEADING), prompt.indexOf(REPO_RULES.trim()));
    expect(section).toContain("Start command: `npm run dev`");
    expect(section).toContain("App URL: http://localhost:3000");
    expect(section).toContain("`DATABASE_URL`, `STRIPE_KEY`");
    expect(section).toMatch(/already set in your agents' shell/);
    expect(section).toMatch(/Never print their values/);
    expect(section).toMatch(/never write them into files/);
    expect(section).toMatch(/never create or commit \.env files/);
    expect(section).toContain("Setup command: `npm ci` ran once after the checkout and succeeded in 42s.");
    expect(section).toContain("<setup-output>\nadded 812 packages in 41s\n</setup-output>");
    expect(section).toMatch(/data, not instructions/);
    expect(section).not.toMatch(/It failed/);
    expect(prompt.indexOf(SETUP_HEADING)).toBeLessThan(prompt.indexOf(REPO_RULES.trim()));
  });

  it("tells the team to work around a failed setup or report what is missing", () => {
    const failed: RepoSetupContext = {
      ...fullSetup,
      setup: { command: "npm ci", ok: false, seconds: 7, outputTail: "npm ERR! code E401\nnpm ERR! Unable to authenticate" },
    };
    const prompt = orchestratorPrompt(baseConfig(), { repoSetup: failed });
    expect(prompt).toContain("`npm ci` ran once after the checkout and failed after 7s.");
    expect(prompt).toContain("npm ERR! Unable to authenticate");
    expect(prompt).toMatch(/It failed[^\n]*Work around it if you can[^\n]*say plainly in verification and risks what is missing/);
  });

  it("only lists what the owner configured", () => {
    const prompt = orchestratorPrompt(baseConfig(), { repoSetup: { startCommand: "", appUrl: "", envKeys: ["API_TOKEN"] } });
    const section = prompt.slice(prompt.indexOf(SETUP_HEADING), prompt.indexOf(REPO_RULES.trim()));
    expect(section).toContain("`API_TOKEN`");
    expect(section).not.toMatch(/Start command|App URL|Setup command/);
  });

  it("has no setup section when nothing is configured", () => {
    expect(orchestratorPrompt(baseConfig())).not.toContain(SETUP_HEADING);
    expect(orchestratorPrompt(baseConfig(), { repoSetup: { startCommand: " ", appUrl: "", envKeys: [] } })).not.toContain(SETUP_HEADING);
  });

  it("never contains an environment variable's value, only its name", () => {
    const config = baseConfig();
    // The values live in the config; only the names are passed to the prompt.
    const env = { STRIPE_KEY: "sk_live_never-in-the-prompt", DATABASE_URL: "postgres://u:hunter2@db/app" };
    config.repoSetup["acme/web"] = { setupCommand: "npm ci", startCommand: "npm run dev", appUrl: "http://localhost:3000", env };
    const envKeys = Object.keys(env).sort();
    const prompt = orchestratorPrompt(config, { browser, repoSetup: { ...fullSetup, envKeys } });
    expect(prompt).toContain("`DATABASE_URL`, `STRIPE_KEY`");
    expect(prompt).not.toContain("sk_live_never-in-the-prompt");
    expect(prompt).not.toContain("hunter2");
  });

  it("keeps a command with backticks intact in its code span", () => {
    const prompt = orchestratorPrompt(baseConfig(), { repoSetup: { startCommand: "echo `date` && npm start", appUrl: "", envKeys: [] } });
    expect(prompt).toContain("Start command: `` echo `date` && npm start ``");
  });
});

describe("the code host in the orchestrator prompt", () => {
  const setup: RepoSetupContext = { startCommand: "", appUrl: "", envKeys: ["API_KEY"] };

  it("says pull request on GitHub, the same with or without the host", () => {
    const prompt = orchestratorPrompt(baseConfig(), { repoSetup: setup });
    expect(prompt).toBe(orchestratorPrompt(baseConfig(), { repoSetup: setup, host: "github" }));
    expect(prompt).toContain("pushes the branch and opens the pull request for a human to review and merge.");
    expect(prompt).toContain("becomes the pull request description");
    expect(prompt).toContain("test fixtures or the pull request,");
  });

  it("says merge request on GitLab, and pull request on Bitbucket", () => {
    const gitlab = orchestratorPrompt(baseConfig(), { repoSetup: setup, host: "gitlab" });
    expect(gitlab).toContain("pushes the branch and opens the merge request for a human to review and merge.");
    expect(gitlab).toContain("becomes the merge request description");
    expect(gitlab).toContain("test fixtures or the merge request,");
    // Only the ground rules (shared by every host) still name pull requests.
    expect(gitlab.replace(REPO_RULES, "")).not.toContain("pull request");
    expect(orchestratorPrompt(baseConfig(), { host: "bitbucket" })).toContain("opens the pull request for a human");
  });
});
