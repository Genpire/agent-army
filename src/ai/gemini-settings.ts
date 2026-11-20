/**
 * Gemini CLI's system settings for the platform's runs (checked against
 * Gemini CLI 0.70.0). Plain data with no imports: the Dockerfile writes the
 * file from this module at build time.
 *
 * Gemini CLI merges its settings as defaults, system defaults, user, trusted
 * workspace (the checkout's .gemini/settings.json), then system: the system
 * scope comes last, so a repository cannot turn these off. It reads the system
 * file only when the file and every folder above it belong to root and are not
 * writable by group or others, so the image writes it as root and each task
 * checks it is in place (engines.ts) before Gemini CLI may run.
 */

/** Where the image keeps it (Gemini CLI's own default on Linux); runs point GEMINI_CLI_SYSTEM_SETTINGS_PATH at it. */
export const GEMINI_SYSTEM_SETTINGS_PATH = "/etc/gemini-cli/settings.json";

/**
 * An MCP server name that no repository defines. In 0.70.0 an empty allowlist
 * means "no limit", so the list names one server that does not exist. A
 * workspace's own `mcp.allowed` only intersects with it (and an empty
 * intersection lifts the limit), so each run also passes a random name with
 * --allowed-mcp-server-names, which settings cannot override.
 */
export const GEMINI_NO_MCP_SERVER = "pointer-allows-no-mcp-servers";

export const GEMINI_SYSTEM_SETTINGS = {
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  privacy: { usageStatisticsEnabled: false },
  telemetry: { enabled: false },
  // No .env file from the checkout (a .gemini/.env is refused before a run).
  advanced: { ignoreLocalEnv: true },
  security: {
    // Its key hidden from the commands it runs, with no variable let through.
    environmentVariableRedaction: { enabled: true, allowed: [], blocked: ["GEMINI_API_KEY"] },
    // The API key only: never the metadata server's credentials, Vertex AI or a sign-in.
    auth: { selectedType: "gemini-api-key", enforcedType: "gemini-api-key", useExternal: false },
  },
  // No MCP servers: none allowed, and no command that starts one.
  mcp: { allowed: [GEMINI_NO_MCP_SERVER], serverCommand: "" },
  // No hooks, no commands that discover or call project tools, no sandbox command.
  hooksConfig: { enabled: false },
  tools: { sandbox: false, discoveryCommand: "", callCommand: "" },
};
