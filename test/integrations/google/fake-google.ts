/**
 * A fake of Google's APIs behind a fetch function, for the Gmail and Calendar
 * tests: Gmail's profile, threads.list and threads.get (metadata format),
 * Calendar's events.list, and the token endpoint for refreshes. No network.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConnection, AppConnectionSchema, type Config, ConfigRepo } from "../../../src/core/config.js";
import { deriveKey } from "../../../src/core/crypto.js";
import { FsStore } from "../../../src/core/store.js";
import type { GoogleEvent } from "../../../src/integrations/google/calendar.js";

export const NOW = new Date("2026-11-24T10:00:00Z");
export const OWNER = "owner@example.com";
export const HOUR = 60 * 60_000;

export interface FakeMessage {
  id: string;
  from: string;
  at: number;
  labels?: string[];
  subject?: string;
  snippet?: string;
  /** Other headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}
export interface FakeThread {
  id: string;
  messages: FakeMessage[];
}

export interface FakeGoogleOptions {
  threads?: FakeThread[];
  events?: GoogleEvent[];
  /** Calendar events per page (default: the maxResults asked for). */
  eventPageSize?: number;
  /** Access tokens the APIs accept (default: access-1); a refresh issues access-2, access-3… and accepts them. */
  valid?: string[];
  refreshRefused?: boolean;
  /** Answers a request before the fake does (rate limits, errors); undefined: the fake answers. */
  script?: (url: URL, n: number) => Response | undefined;
  /** Simulated latency of a threads.get, to count concurrent calls. */
  getDelayMs?: number;
}

export interface Call {
  method: string;
  url: URL;
  auth: string | null;
}

const gmailMessage = (m: FakeMessage) => ({
  id: m.id,
  labelIds: m.labels ?? ["INBOX", "CATEGORY_PERSONAL"],
  snippet: m.snippet ?? `Text of ${m.id}`,
  internalDate: String(m.at),
  payload: {
    headers: [
      { name: "From", value: m.from },
      { name: "Subject", value: m.subject ?? `Subject ${m.id}` },
      ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
    ],
  },
});

export function fakeGoogle(opts: FakeGoogleOptions = {}) {
  const calls: Call[] = [];
  const valid = new Set(opts.valid ?? ["access-1"]);
  let issued = 1;
  let inFlight = 0;
  let maxInFlight = 0;
  const threads = opts.threads ?? [];
  const events = opts.events ?? [];

  const handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, url, auth });
    const scripted = opts.script?.(url, calls.length);
    if (scripted) return scripted;

    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("grant_type") !== "refresh_token") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      if (opts.refreshRefused) return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
      issued++;
      valid.add(`access-${issued}`);
      return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (!auth || !valid.has(auth.replace(/^Bearer /, ""))) {
      return Response.json({ error: { code: 401, status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] } }, { status: 401 });
    }

    if (url.host === "gmail.googleapis.com") {
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      if (path === "/profile") return Response.json({ emailAddress: OWNER, messagesTotal: 10 });
      if (path === "/threads") {
        const size = Number(url.searchParams.get("maxResults") ?? 100);
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const page = threads.slice(start, start + size).map((t) => ({ id: t.id, snippet: "", historyId: "1" }));
        return Response.json({ threads: page, ...(start + size < threads.length ? { nextPageToken: String(start + size) } : {}), resultSizeEstimate: threads.length });
      }
      const id = path.match(/^\/threads\/([^/]+)$/)?.[1];
      if (id) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (opts.getDelayMs) await new Promise((r) => setTimeout(r, opts.getDelayMs));
        inFlight--;
        const t = threads.find((x) => x.id === id);
        if (!t) return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
        return Response.json({ id: t.id, messages: t.messages.map(gmailMessage) });
      }
    }

    if (url.host === "www.googleapis.com" && url.pathname === "/calendar/v3/calendars/primary/events") {
      const size = opts.eventPageSize ?? Number(url.searchParams.get("maxResults") ?? 250);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const page = events.slice(start, start + size);
      return Response.json({ items: page, ...(start + size < events.length ? { nextPageToken: String(start + size) } : {}) });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: handle as typeof fetch, calls, maxInFlight: () => maxInFlight };
}

/** A Google error body with these reason codes. */
export const googleError = (status: number, reasons: string[], headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({
      error: {
        code: status,
        message: "The details Google writes here are never shown.",
        status: status === 429 ? "RESOURCE_EXHAUSTED" : "PERMISSION_DENIED",
        errors: reasons.map((reason) => ({ reason })),
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: reasons[0] }],
      },
    }),
    { status, headers: { "Content-Type": "application/json", ...headers } },
  );

const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.modify";
const CALENDAR_SCOPES =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.events";

/** A signed-in Google app, its discovery cached (a refresh goes straight to the token endpoint). */
export function googleApp(kind: "gmail" | "google-calendar", patch: Partial<AppConnection> & { expiresAt?: number; scope?: string; accessToken?: string } = {}): AppConnection {
  const { expiresAt, scope, accessToken, ...rest } = patch;
  const host = kind === "gmail" ? "gmailmcp.googleapis.com" : "calendarmcp.googleapis.com";
  return AppConnectionSchema.parse({
    id: kind === "gmail" ? "app-gmail" : "app-google-calendar",
    name: kind === "gmail" ? "Gmail" : "Google Calendar",
    presetId: kind,
    url: `https://${host}/mcp/v1`,
    access: "read",
    auth: {
      type: "oauth",
      oauth: {
        clientInformation: { client_id: "client-1.apps.example", client_secret: "client-secret-1", entered_by_owner: true, issuer: "https://accounts.google.com" },
        tokens: { access_token: accessToken ?? "access-1", refresh_token: "refresh-1", token_type: "Bearer", scope: scope ?? (kind === "gmail" ? GMAIL_SCOPES : CALENDAR_SCOPES) },
        expiresAt: expiresAt ?? NOW.getTime() + HOUR,
        serverMetadata: {
          authorizationServerUrl: "https://accounts.google.com",
          resourceMetadata: { resource: `https://${host}/mcp/v1`, authorization_servers: ["https://accounts.google.com"] },
          authorizationServerMetadata: {
            issuer: "https://accounts.google.com",
            authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint: "https://oauth2.googleapis.com/token",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: ["authorization_code", "refresh_token"],
          },
        },
      },
    },
    ...rest,
  });
}

export async function configRepoWith(patch: (c: Config) => void): Promise<ConfigRepo> {
  const repo = new ConfigRepo(new FsStore(await mkdtemp(join(tmpdir(), "army-google-"))), deriveKey("k"), 0);
  await repo.update(patch);
  return repo;
}

export const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
