/**
 * What the company data sources share (http-source.ts, postgres-source.ts,
 * data-sources.ts and the admin routes): the limits on what one read may
 * take and return, the error a problem with the request raises, and every
 * credential a source carries in every form it can be printed, for redaction.
 */
import type { DataSource } from "../../core/config.js";

export const DATA_LIMITS = {
  /** One HTTP request (with its redirects) or one SQL statement. */
  timeoutMs: 15_000,
  /** Bytes of an HTTP response read; the rest is dropped. */
  maxResponseBytes: 200 * 1024,
  /** Rows one SQL query returns. */
  maxRows: 500,
  /** Characters of a tool result: it goes into the model's context. */
  maxOutputChars: 20_000,
  /** Characters of a test preview on the admin page. */
  previewChars: 1_200,
} as const;

/** A problem with what was asked (a path outside the allow list, a statement that writes): shown to the model or the owner as is. */
export class DataSourceError extends Error {}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Text cut to `max` characters, saying so. */
export function cap(text: string, max: number = DATA_LIMITS.maxOutputChars, note = "\n… (output cut)"): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - note.length)) + note;
}

/** One line of text, at most `max` characters. */
export const flat = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The password in a Postgres connection string, as written and decoded. */
function connectionPassword(connectionString: string | undefined): string[] {
  if (!connectionString) return [];
  try {
    const raw = new URL(connectionString).password;
    if (!raw) return [];
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // Not percent-encoded: the raw form is the password.
    }
    return [raw, decoded];
  } catch {
    return [];
  }
}

/**
 * Every credential of a source, in each form it can travel in: the token, the
 * Basic header's encoded value, the password inside a connection string. Not
 * the login token the source signs in for (http-source.ts adds that).
 */
export function sourceSecrets(d: DataSource): string[] {
  const a = d.http?.auth;
  const http = !a
    ? []
    : a.type === "bearer"
      ? [a.token]
      : a.type === "basic"
        ? [a.password, Buffer.from(`${a.username}:${a.password}`).toString("base64")]
        : a.type === "header"
          ? [a.value]
          : a.type === "login"
            ? [a.password, JSON.stringify(a.password).slice(1, -1)]
            : [];
  const pg = d.postgres ? [d.postgres.connectionString, ...connectionPassword(d.postgres.connectionString)] : [];
  return [...http, ...pg].filter((s) => s.length > 0);
}
