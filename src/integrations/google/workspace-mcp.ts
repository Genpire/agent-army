/**
 * Google's Workspace MCP servers (gmailmcp.googleapis.com/mcp/v1 and the
 * like) and what a Google Cloud project needs for them: each product's API
 * and its MCP service, both enabled in the project that owns the OAuth
 * client, and a client marked "Use this client for an AI-powered agent"
 * (https://developers.google.com/workspace/guides/configure-mcp-servers).
 *
 * Without them the sign-in itself works (it is Google's account sign-in),
 * but the MCP server refuses every call with 401 or 403: this module turns
 * that into what to do instead of "sign in again".
 */

export interface WorkspaceMcpProduct {
  /** The product's name, as the owner knows it. */
  product: string;
  /** The product's API service, when it has one (Universal Search has none). */
  api?: string;
  /** The MCP service to enable (People serves MCP on its own API). */
  mcp: string;
}

/** By the MCP server's host. */
const WORKSPACE_MCP: Readonly<Record<string, WorkspaceMcpProduct>> = {
  "gmailmcp.googleapis.com": { product: "Gmail", api: "gmail.googleapis.com", mcp: "gmailmcp.googleapis.com" },
  "calendarmcp.googleapis.com": { product: "Google Calendar", api: "calendar-json.googleapis.com", mcp: "calendarmcp.googleapis.com" },
  "drivemcp.googleapis.com": { product: "Google Drive", api: "drive.googleapis.com", mcp: "drivemcp.googleapis.com" },
  "docsmcp.googleapis.com": { product: "Google Docs", api: "docs.googleapis.com", mcp: "docsmcp.googleapis.com" },
  "sheetsmcp.googleapis.com": { product: "Google Sheets", api: "sheets.googleapis.com", mcp: "sheetsmcp.googleapis.com" },
  "slidesmcp.googleapis.com": { product: "Google Slides", api: "slides.googleapis.com", mcp: "slidesmcp.googleapis.com" },
  "chatmcp.googleapis.com": { product: "Google Chat", api: "chat.googleapis.com", mcp: "chatmcp.googleapis.com" },
  "classroommcp.googleapis.com": { product: "Google Classroom", api: "classroom.googleapis.com", mcp: "classroommcp.googleapis.com" },
  "people.googleapis.com": { product: "People", mcp: "people.googleapis.com" },
  "workspacemcp.googleapis.com": { product: "Workspace search", mcp: "workspacemcp.googleapis.com" },
};

/** The Workspace product an MCP server address belongs to (https, a known host, a path under /mcp), else undefined. */
export function workspaceMcpProduct(url: string): WorkspaceMcpProduct | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || !/^\/mcp(\/|$)/.test(u.pathname)) return undefined;
  return WORKSPACE_MCP[u.hostname.toLowerCase().replace(/\.$/, "")];
}

/** "gmail.googleapis.com (the Gmail API) and gmailmcp.googleapis.com (its MCP service)". */
function servicesToEnable(p: WorkspaceMcpProduct): string {
  if (!p.api) return `${p.mcp} (the ${p.product} MCP service)`;
  if (p.api === p.mcp) return `${p.api} (the ${p.product} API, which serves MCP too)`;
  return `both ${p.api} (the ${p.product} API) and ${p.mcp} (its MCP service)`;
}

/**
 * What to do when a Google Workspace MCP server refuses the call (401 or
 * 403): turn on the product's API and MCP service in the project that owns
 * the OAuth client, and mark the client for an AI-powered agent. Undefined
 * for any other address. Under 600 characters (the console's error limit).
 */
export function workspaceMcpRefusal(app: { name: string; url: string; auth: { type: string } }): string | undefined {
  const p = workspaceMcpProduct(app.url);
  if (!p) return undefined;
  const signedIn = app.auth.type === "oauth";
  return (
    `${signedIn ? `The sign-in worked, but ` : ""}Google's ${p.product} MCP server refused ${app.name}'s call. ` +
    `In the Google Cloud project that owns the OAuth client, enable ${servicesToEnable(p)}, ` +
    `and check that the client has "Use this client for an AI-powered agent" selected. ` +
    `Then list the tools again${signedIn ? "; sign in again only if it still fails" : ""}.`
  );
}

/**
 * What to do when one of Google's REST APIs is not enabled in the project
 * that owns the OAuth client (a 403 SERVICE_DISABLED / accessNotConfigured).
 */
export function googleApiDisabled(product: string, api: string, mcp?: string): string {
  return (
    `${product} is signed in, but the ${product} API (${api}) is not enabled in the Google Cloud project that owns the OAuth client. ` +
    `Enable ${api}${mcp ? ` and ${mcp} (its MCP service, for the app's own tools)` : ""} there, then try again.`
  );
}
