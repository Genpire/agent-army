import { describe, expect, it } from "vitest";
import { RESERVED_ENV_KEYS, RepoSetupSchema } from "../../src/core/config.js";
import { setupEnv } from "../../src/tasks/repo-setup.js";

/**
 * The names a repository's variables may not use (reservedEnvKeyProblem in
 * config.ts), listed here on their own so that dropping one from the code
 * is noticed: every name the platform sets for the agents' shell, every
 * name that redirects Claude Code, and the names next to them that stay free.
 */

/** The platform sets these in the task's environment itself. */
const PLATFORM_NAMES = ["PATH", "HOME", "LANG", "CI", "ANTHROPIC_API_KEY", "MASTER_KEY", "SETUP_TOKEN", "TASK_B64", "CLAUDE_AGENT_SDK_CLIENT_APP", "PLAYWRIGHT_BROWSERS_PATH"];
/** These decide where Claude Code sends its requests and key, or whom it trusts. */
const CLIENT_NAMES = ["NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "CLAUDE_CONFIG_DIR"];
const CLIENT_PREFIXED = ["ANTHROPIC_BASE_URL", "anthropic_auth_token", "CLAUDE_CODE_USE_VERTEX", "Claude_Code_Use_Bedrock", "AWS_REGION", "aws_profile", "VERTEX_REGION_CLAUDE_5_5_OPUS", "vertex_region_x"];
const PROXY_NAMES = ["HTTP_PROXY", "https_proxy", "All_Proxy", "NO_PROXY", "SOCKS_PROXY"];
const FREE_NAMES = ["DATABASE_URL", "NODE_ENV", "NODE_OPTIONS", "PATHS", "HOMEPAGE_URL", "LANGUAGE", "CI_NAME", "MY_CI", "TASK_B64_X", "MY_AWS_BUCKET", "PROXY_URL", "PROXY", "ANTHROPIC", "MASTER_KEY_ID", "STRIPE_KEY", "Path", "home"];

describe("repository variable names", () => {
  it("reserves every name the platform sets, exactly as written", () => {
    for (const name of PLATFORM_NAMES) {
      expect(RESERVED_ENV_KEYS.has(name), name).toBe(true);
      const parsed = RepoSetupSchema.safeParse({ env: { [name]: "value-1" } });
      expect(parsed.success, name).toBe(false);
      // Said as the platform's own name, even where a prefix rule would also refuse it (ANTHROPIC_API_KEY).
      expect(parsed.error?.issues[0]?.message, name).toBe(`${name} is reserved by the platform: it sets it itself. Remove it from this repository's variables.`);
    }
  });

  it("reserves the names, prefixes and proxy settings that redirect Claude Code, in any case", () => {
    for (const name of [...CLIENT_NAMES, ...CLIENT_PREFIXED, ...PROXY_NAMES]) {
      expect(RESERVED_ENV_KEYS.has(name), name).toBe(true);
      expect(RepoSetupSchema.safeParse({ env: { [name]: "value-1" } }).success, name).toBe(false);
    }
  });

  it("leaves the names next to them free", () => {
    for (const name of FREE_NAMES) {
      expect(RESERVED_ENV_KEYS.has(name), name).toBe(false);
      expect(RepoSetupSchema.safeParse({ env: { [name]: "value-1" } }).success, name).toBe(true);
    }
  });

  it("never gives a reserved name to the agents' shell, even from a setup built by hand", () => {
    const env = Object.fromEntries([...PLATFORM_NAMES, ...CLIENT_NAMES, ...CLIENT_PREFIXED, ...PROXY_NAMES, ...FREE_NAMES].map((name) => [name, "value-1"]));
    const setup = { setupCommand: "", startCommand: "", appUrl: "", env };
    expect(Object.keys(setupEnv(setup)).sort()).toEqual([...FREE_NAMES].sort());
  });
});
