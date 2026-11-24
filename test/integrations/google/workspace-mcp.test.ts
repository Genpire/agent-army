import { describe, expect, it } from "vitest";
import { catalogApp } from "../../../src/integrations/apps/apps-catalog.js";
import { listAppTools } from "../../../src/integrations/apps/apps.js";
import { AppConnectionSchema } from "../../../src/core/config.js";
import { googleApiDisabled, workspaceMcpProduct, workspaceMcpRefusal } from "../../../src/integrations/google/workspace-mcp.js";
import { googleApp } from "./fake-google.js";

const oauth = { type: "oauth" };

describe("Google Workspace MCP servers", () => {
  it("knows each Workspace server's API and MCP service, and nothing else", () => {
    expect(workspaceMcpProduct("https://gmailmcp.googleapis.com/mcp/v1")).toEqual({ product: "Gmail", api: "gmail.googleapis.com", mcp: "gmailmcp.googleapis.com" });
    expect(workspaceMcpProduct("https://calendarmcp.googleapis.com/mcp/v1")).toMatchObject({ api: "calendar-json.googleapis.com", mcp: "calendarmcp.googleapis.com" });
    expect(workspaceMcpProduct("https://drivemcp.googleapis.com/mcp/v1")).toMatchObject({ api: "drive.googleapis.com", mcp: "drivemcp.googleapis.com" });
    expect(workspaceMcpProduct("https://people.googleapis.com/mcp/v1")).toMatchObject({ mcp: "people.googleapis.com" });
    for (const url of [
      "https://bigquery.googleapis.com/mcp",
      "https://gmail.googleapis.com/gmail/v1",
      "https://gmailmcp.googleapis.com/other",
      "http://gmailmcp.googleapis.com/mcp/v1",
      "https://gmailmcp.googleapis.com.evil.example/mcp/v1",
      "https://mcp.linear.app/mcp",
      "not a url",
    ]) {
      expect(workspaceMcpProduct(url), url).toBeUndefined();
    }
  });

  it("says what to enable when a signed-in Workspace app is refused, instead of asking for a new sign-in", () => {
    const gmail = workspaceMcpRefusal({ name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", auth: oauth })!;
    expect(gmail).toBe(
      "The sign-in worked, but Google's Gmail MCP server refused Gmail's call. In the Google Cloud project that owns the OAuth client, enable both gmail.googleapis.com (the Gmail API) and gmailmcp.googleapis.com (its MCP service), " +
        'and check that the client has "Use this client for an AI-powered agent" selected. Then list the tools again; sign in again only if it still fails.',
    );
    const calendar = workspaceMcpRefusal({ name: "Calendar", url: "https://calendarmcp.googleapis.com/mcp/v1", auth: oauth })!;
    expect(calendar).toContain("both calendar-json.googleapis.com (the Google Calendar API) and calendarmcp.googleapis.com (its MCP service)");
    const drive = workspaceMcpRefusal({ name: "Drive", url: "https://drivemcp.googleapis.com/mcp/v1", auth: oauth })!;
    expect(drive).toContain("both drive.googleapis.com (the Google Drive API) and drivemcp.googleapis.com (its MCP service)");
    expect(workspaceMcpRefusal({ name: "Search", url: "https://workspacemcp.googleapis.com/mcp/v1", auth: oauth })).toContain("enable workspacemcp.googleapis.com (the Workspace search MCP service)");
    expect(workspaceMcpRefusal({ name: "People", url: "https://people.googleapis.com/mcp/v1", auth: { type: "bearer" } })).toMatch(/^Google's People MCP server refused People's call\. .*enable people\.googleapis\.com .*list the tools again\.$/);
    for (const text of [gmail, calendar, drive]) expect(text.length).toBeLessThan(600);
    expect(workspaceMcpRefusal({ name: "Linear", url: "https://mcp.linear.app/mcp", auth: oauth })).toBeUndefined();
    expect(googleApiDisabled("Gmail", "gmail.googleapis.com", "gmailmcp.googleapis.com")).toContain("Enable gmail.googleapis.com and gmailmcp.googleapis.com");
  });

  it("listing a Workspace app's tools that Google refuses gives that help; other apps keep theirs", async () => {
    const refusing = (status: number) => async () => new Response(JSON.stringify({ error: { code: status, status: "PERMISSION_DENIED" } }), { status, headers: { "Content-Type": "application/json" } });
    // listAppTools uses the real clock: tokens valid for an hour from now.
    const valid = { expiresAt: Date.now() + 3_600_000 };
    for (const status of [401, 403]) {
      const message = await listAppTools(googleApp("gmail", valid), { fetch: refusing(status), timeoutMs: 5_000 }).catch((e: Error) => e.message);
      expect(message, String(status)).toContain("enable both gmail.googleapis.com (the Gmail API) and gmailmcp.googleapis.com (its MCP service)");
      expect(message).toContain("Use this client for an AI-powered agent");
      expect(message).not.toBe("Gmail refused the sign-in. Sign in again.");
    }
    const calendar = await listAppTools(googleApp("google-calendar", valid), { fetch: refusing(403), timeoutMs: 5_000 }).catch((e: Error) => e.message);
    expect(calendar).toContain("calendar-json.googleapis.com");
    const linear = AppConnectionSchema.parse({ id: "app-linear", name: "Linear", url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: "lin_api_secret_key_123456" } });
    expect(await listAppTools(linear, { fetch: refusing(401), timeoutMs: 5_000 }).catch((e: Error) => e.message)).toBe("Linear refused the sign-in. Check the key, and that it may use the MCP server.");
  });

  it("names both services and the AI-agent client in the catalog's Gmail, Calendar and Drive entries", () => {
    const expected: Record<string, string[]> = {
      gmail: ["gmail.googleapis.com", "gmailmcp.googleapis.com"],
      "google-calendar": ["calendar-json.googleapis.com", "calendarmcp.googleapis.com"],
      "google-drive": ["drive.googleapis.com", "drivemcp.googleapis.com"],
    };
    for (const [id, services] of Object.entries(expected)) {
      const entry = catalogApp(id)!;
      for (const field of [entry.keyHelp ?? "", entry.notes ?? ""]) {
        for (const service of services) expect(field, `${id}: ${service}`).toContain(service);
        expect(field).toContain("Use this client for an AI-powered agent");
      }
    }
  });
});
