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
