/**
 * Postgres data sources, read-only. Every query runs on a pooled connection
 * (at most 2 per source, closed when idle) inside
 *
 *   BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; SET LOCAL search_path = <schemas>; … ; ROLLBACK
 *
 * so nothing it does can write or outlive it, after the statement check
 * (sql-guard.ts) has accepted it. Rows come through a cursor, at most 500, so
 * a big table is never read whole. The owner should still connect with a
 * role that can only SELECT: the README and the admin page show how.
 *
 * TLS follows the connection string's sslmode the way libpq reads it
 * (disable, require = encrypted, verify-ca, verify-full = certificate and
 * host checked); without one, require for any host but this machine or a
 * container name.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";
import pg from "pg";
import type { DataSource } from "../../core/config.js";
import { DATA_LIMITS, DataSourceError, cap, errorText, plural } from "./common.js";
import { checkReadOnlySql } from "./sql-guard.js";

export interface PgField {
  name: string;
}
export interface PgResult {
  rows: unknown[];
  fields?: PgField[];
}
export interface PgQuery {
  text: string;
  values?: unknown[];
  rowMode?: "array";
  /** "extended": parsed as one statement by the server (a second one is refused). */
  queryMode?: "extended";
}
export interface PgClientLike {
  query(query: string | PgQuery): Promise<PgResult>;
  /** An error destroys the connection instead of returning it to the pool. */
  release(err?: Error): void;
}
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** false = plain; otherwise TLS with these options. */
  ssl: false | ConnectionOptions;
  sslmode: "disable" | "require" | "verify-ca" | "verify-full";
}

export type PgPoolFactory = (connection: PgConnection) => PgPoolLike;

export interface PgDeps {
  /** Test seam: makes the pool for a connection (default: pg.Pool, at most 2 connections). */
  poolFactory?: PgPoolFactory;
  timeoutMs?: number;
  maxRows?: number;
  /** The organisation's timezone (IANA): the session's, for now(), dates and date_trunc. */
  timezone?: string;
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  /** More rows than maxRows: only the first maxRows are in `rows`. */
  more: boolean;
}

const SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full", "no-verify"]);
/** Parameters that point at files on this machine or ask for things this connection does not do. */
const UNSUPPORTED_PARAMS = ["sslcert", "sslkey", "sslrootcert", "sslcrl", "sslpassword", "host", "hostaddr", "service", "passfile"];

/** This machine, or a name without dots (a container or service on the same network), where TLS is usually off. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  return isIP(h) === 0 && !h.includes(".");
}

/** The connection a Postgres URL (postgres://user:password@host:5432/db?sslmode=require) describes. Throws DataSourceError. */
export function pgConnection(connectionString: string): PgConnection {
  let u: URL;
  try {
    u = new URL(connectionString.trim());
  } catch {
    throw new DataSourceError("Give the connection string as a URL: postgres://user:password@host:5432/database?sslmode=require.");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new DataSourceError("The connection string must start with postgres:// or postgresql://.");
  if (!u.hostname) throw new DataSourceError("The connection string has no host.");
  const unsupported = UNSUPPORTED_PARAMS.find((p) => u.searchParams.has(p));
  if (unsupported) throw new DataSourceError(`The ${unsupported} option is not supported here; use sslmode=require or verify-full, and the host in the address.`);
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const user = decode(u.username);
  if (!user) throw new DataSourceError("The connection string has no user name (postgres://user:password@host/database).");
  const port = u.port ? Number(u.port) : 5432;
  const host = u.hostname.replace(/^\[|\]$/g, "");

  let mode = (u.searchParams.get("sslmode") ?? "").toLowerCase();
  const ssl = (u.searchParams.get("ssl") ?? "").toLowerCase();
  if (!mode && ["true", "1"].includes(ssl)) mode = "require";
  if (!mode && ["false", "0"].includes(ssl)) mode = "disable";
  if (mode && !SSL_MODES.has(mode)) throw new DataSourceError(`sslmode=${mode} is not one of disable, require, verify-ca or verify-full.`);
  // allow and prefer fall back to plain in libpq; here they mean the default, as no sslmode does.
  if (!mode || mode === "allow" || mode === "prefer") mode = isLocalHost(host) ? "disable" : "require";
  if (mode === "no-verify") mode = "require";
  const sslmode = mode as PgConnection["sslmode"];
  const tls: PgConnection["ssl"] =
    sslmode === "disable"
      ? false
      : sslmode === "require"
        ? { rejectUnauthorized: false }
        : sslmode === "verify-ca"
          ? { rejectUnauthorized: true, checkServerIdentity: () => undefined }
          : { rejectUnauthorized: true };
  return { host, port, user, password: decode(u.password), database: decode(u.pathname.replace(/^\//, "")) || user, ssl: tls, sslmode };
}

/**
 * Dates, times and intervals as Postgres writes them ("2026-11-21",
 * "2026-11-21 09:30:00+02"): a JS Date would shift a date to the server's
 * midnight in UTC and read a timestamp without zone in this machine's zone.
 */
const AS_TEXT = new Set([1082, 1083, 1114, 1184, 1186, 1266]);
const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    AS_TEXT.has(oid) ? (value: string) => value : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

/** The real pool: at most 2 connections, closed after 30 s idle, never keeping the process alive. */
const pgPool: PgPoolFactory = (c) => {
  const pool = new pg.Pool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    ssl: c.ssl,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    // A backstop for a server that stops answering; statement_timeout is set per transaction.
    query_timeout: DATA_LIMITS.timeoutMs + 5_000,
    application_name: "agent-army (read-only)",
    types,
  });
  // An idle connection the server closes must not crash the service; the next query reconnects.
  pool.on("error", () => undefined);
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (q) => (typeof q === "string" ? client.query(q) : client.query(q as pg.QueryArrayConfig)),
        release: (err) => client.release(err),
      };
    },
    end: () => pool.end(),
  };
};

const pools = new Map<string, { key: string; pool: PgPoolLike }>();

function poolFor(source: DataSource, factory: PgPoolFactory): PgPoolLike {
  const cs = source.postgres!.connectionString;
  const key = createHash("sha256").update(cs).digest("hex");
  const hit = pools.get(source.id);
  if (hit?.key === key) return hit.pool;
  if (hit) void hit.pool.end().catch(() => undefined);
  const pool = factory(pgConnection(cs));
  pools.set(source.id, { key, pool });
  return pool;
}

/** Closes a source's connections (its settings changed or it was removed). */
export async function closePool(sourceId: string): Promise<void> {
  const hit = pools.get(sourceId);
  pools.delete(sourceId);
  await hit?.pool.end().catch(() => undefined);
}

/** "analytics" → "\"analytics\"": a name Postgres reads exactly as written. */
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The statements that open every query's transaction: read-only, time-limited, on the source's schemas. */
export function readOnlyPreamble(schemas: string[], timeoutMs: number = DATA_LIMITS.timeoutMs, timezone?: string): string {
  const path = (schemas.length ? schemas : ["public"]).map(quoteIdent).join(", ");
  return [
    "BEGIN READ ONLY",
    `SET LOCAL statement_timeout = '${Math.max(1, Math.round(timeoutMs / 1000))}s'`,
    "SET LOCAL lock_timeout = '5s'",
    "SET LOCAL idle_in_transaction_session_timeout = '30s'",
    `SET LOCAL search_path = ${path}`,
    // "today" and date_trunc('week', …) in the organisation's timezone.
    ...(timezone && isTimezone(timezone) ? [`SET LOCAL TimeZone = '${timezone}'`] : []),
  ].join("; ");
}

/** An IANA timezone name ("Asia/Jerusalem", "UTC") this runtime knows, safe inside a SQL literal. */
export function isTimezone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** What a Postgres error says, with its hint, without the query text. */
function pgMessage(err: unknown): string {
  const e = err as { message?: string; hint?: string; code?: string; position?: string };
  if (e?.code === "57014") return "The query took longer than the time limit and was stopped. Narrow it (a date range, an index, an aggregate).";
  if (e?.code === "25006") return "That would write to the database; only reading is allowed.";
  const text = errorText(err);
  return e?.hint ? `${text} (hint: ${e.hint})` : text;
}

/**
 * Runs `fn` on a connection of the source inside the read-only transaction,
 * always rolled back. A connection that fails to roll back is destroyed.
 */
export async function withReadOnly<T>(source: DataSource, fn: (client: PgClientLike) => Promise<T>, deps: PgDeps = {}): Promise<T> {
  if (source.kind !== "postgres" || !source.postgres) throw new DataSourceError(`${source.name} is not a Postgres source.`);
  const pool = poolFor(source, deps.poolFactory ?? pgPool);
  let client: PgClientLike;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new DataSourceError(`Couldn't connect to the database: ${errorText(err)}`);
  }
  let broken: Error | undefined;
  try {
    await client.query(readOnlyPreamble(source.postgres.schemas, deps.timeoutMs, deps.timezone));
    return await fn(client);
  } catch (err) {
    throw err instanceof DataSourceError ? err : new DataSourceError(pgMessage(err));
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (err) {
      broken = err instanceof Error ? err : new Error(String(err));
    }
    client.release(broken);
  }
}

const CURSOR = "pointer_rows";

/**
 * Runs one read-only statement (checked by sql-guard first) and returns at
 * most maxRows rows. Throws DataSourceError with what Postgres said.
 */
export async function runSql(source: DataSource, sql: string, deps: PgDeps = {}): Promise<SqlResult> {
  const checked = checkReadOnlySql(sql);
  const max = deps.maxRows ?? DATA_LIMITS.maxRows;
  return withReadOnly(
    source,
    async (client) => {
      let r: PgResult;
      if (checked.kind === "explain") {
        r = await client.query({ text: checked.sql, rowMode: "array", queryMode: "extended" });
      } else {
        // A cursor: Postgres produces only the rows fetched, and accepts only a query here.
        await client.query({ text: `DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${checked.sql}`, queryMode: "extended" });
        r = await client.query({ text: `FETCH FORWARD ${max + 1} FROM ${CURSOR}`, rowMode: "array" });
      }
      const rows = (r.rows as unknown[][]).slice(0, max);
      return { columns: (r.fields ?? []).map((f) => f.name), rows, more: r.rows.length > max };
    },
    deps,
  );
}

/** One value as table text: NULL, dates as ISO, bytes as hex, JSON compact; one line, at most 300 characters. */
export function cellText(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = "NULL";
  else if (v instanceof Date) s = Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  else if (Buffer.isBuffer(v)) s = `\\x${v.subarray(0, 32).toString("hex")}${v.length > 32 ? "…" : ""}`;
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  s = s.replace(/\r?\n/g, "\\n").replace(/\|/g, "\\|");
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

/** Rows as a compact table: a summary line, a header, then "a | b | c" per row, cut to `maxChars`. */
export function formatTable(result: SqlResult, maxChars: number = DATA_LIMITS.maxOutputChars, maxRows: number = DATA_LIMITS.maxRows): string {
  const { columns, rows, more } = result;
  if (columns.length === 0) return "The query returned no columns.";
  const count = more ? `More than ${plural(maxRows, "row")}: the first ${maxRows} are shown. Use COUNT(*), SUM or GROUP BY for totals, or LIMIT and OFFSET to page.` : plural(rows.length, "row");
  const lines = [count, columns.map(cellText).join(" | ")];
  let used = lines.join("\n").length;
  let shown = 0;
  for (const row of rows) {
    const line = row.map(cellText).join(" | ");
    if (used + line.length + 1 > maxChars - 120) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < rows.length) lines.push(`… ${rows.length - shown} more rows not shown (output size limit). Select fewer columns or aggregate.`);
  return cap(lines.join("\n"), maxChars);
}

/** "timestamp with time zone" → "timestamptz": shorter type names for the schema outline. */
const shortType = (t: string) =>
  t
    .replace("timestamp with time zone", "timestamptz")
    .replace("timestamp without time zone", "timestamp")
    .replace("time with time zone", "timetz")
    .replace("time without time zone", "time")
    .replace("character varying", "varchar")
    .replace("double precision", "float8");

const MAX_SCHEMA_TABLES = 300;
const MAX_TABLE_COLUMNS = 60;

/**
 * The tables and views of the source's schemas that its role can see, with
 * their columns and an estimate of their rows, as an outline for the model.
 */
export async function describeSchema(source: DataSource, deps: PgDeps = {}, maxChars: number = DATA_LIMITS.maxOutputChars): Promise<string> {
  const schemas = source.postgres?.schemas.length ? source.postgres.schemas : ["public"];
  const { columns, relations } = await withReadOnly(
    source,
    async (client) => ({
      columns: await client.query({
        text:
          "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns " +
          "WHERE table_schema = ANY($1::text[]) ORDER BY table_schema, table_name, ordinal_position LIMIT 20000",
        values: [schemas],
        rowMode: "array",
      }),
      relations: await client.query({
        text:
          "SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint FROM pg_catalog.pg_class c " +
          "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
          "WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')",
        values: [schemas],
        rowMode: "array",
      }),
    }),
    deps,
  );
  const info = new Map<string, { kind: string; estimate: number }>();
  for (const [schema, name, kind, estimate] of relations.rows as [string, string, string, string | number][]) {
    info.set(`${schema}.${name}`, { kind, estimate: Number(estimate) });
  }
  const tables = new Map<string, { schema: string; name: string; columns: string[] }>();
  for (const [schema, table, column, type] of columns.rows as [string, string, string, string][]) {
    const key = `${schema}.${table}`;
    const t = tables.get(key) ?? tables.set(key, { schema, name: table, columns: [] }).get(key)!;
    t.columns.push(`${column} ${shortType(type)}`);
  }
  if (tables.size === 0) {
    return `No tables or views in ${schemas.join(", ")} that this database user can read. Check the schemas set for the source and the role's grants.`;
  }
  const kindName: Record<string, string> = { r: "table", p: "table", v: "view", m: "materialized view", f: "foreign table" };
  const lines = [`Tables and views in ${schemas.join(", ")} (${plural(tables.size, "relation")}; row counts are the planner's estimates):`];
  let n = 0;
  for (const t of tables.values()) {
    if (n++ >= MAX_SCHEMA_TABLES) {
      lines.push(`… ${tables.size - MAX_SCHEMA_TABLES} more not listed.`);
      break;
    }
    const meta = info.get(`${t.schema}.${t.name}`);
    const kind = meta ? (kindName[meta.kind] ?? "table") : "table";
    const estimate = meta && meta.estimate >= 0 && kind !== "view" ? `, ~${meta.estimate.toLocaleString("en-US")} rows` : "";
    const name = schemas.length > 1 || t.schema !== "public" ? `${t.schema}.${t.name}` : t.name;
    const cols = t.columns.slice(0, MAX_TABLE_COLUMNS).join(", ") + (t.columns.length > MAX_TABLE_COLUMNS ? `, … ${t.columns.length - MAX_TABLE_COLUMNS} more` : "");
    lines.push(`- ${name} (${kind}${estimate}): ${cols}`);
  }
  return cap(lines.join("\n"), maxChars);
}

/** What the admin page's test shows: who it connects as, the server, whether the role can write, how many tables it sees. */
export async function testPostgres(source: DataSource, deps: PgDeps = {}): Promise<{ preview: string; warnings: string[] }> {
  const schemas = source.postgres?.schemas.length ? source.postgres.schemas : ["public"];
  return withReadOnly(
    source,
    async (client) => {
      const who = await client.query({
        text:
          "SELECT current_user, current_database(), current_setting('server_version'), current_setting('transaction_read_only'), " +
          "COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false)",
        rowMode: "array",
      });
      const tables = await client.query({
        text:
          "SELECT count(*)::int, COALESCE(bool_or(has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')), false) " +
          "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
          "WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege(c.oid, 'SELECT')",
        values: [schemas],
        rowMode: "array",
      });
      const [user, database, version, readOnly, superuser] = (who.rows[0] ?? []) as [string, string, string, string, boolean];
      const [count, canWrite] = (tables.rows[0] ?? [0, false]) as [number, boolean];
      const warnings: string[] = [];
      if (superuser) warnings.push(`${user} is a superuser. Connect with a role that can only read (see "Create a read-only role").`);
      else if (canWrite) warnings.push(`${user} can change some of these tables. Queries run read-only anyway, but a role that can only SELECT is safer.`);
      const sslmode = pgConnection(source.postgres!.connectionString).sslmode;
      const preview = [
        `Connected as ${user} to ${database} (PostgreSQL ${version}), ${sslmode === "disable" ? "without TLS" : `TLS ${sslmode}`}.`,
        `Transaction read-only: ${readOnly === "on" ? "yes" : readOnly}.`,
        `${plural(count, "table or view", "tables and views")} readable in ${schemas.join(", ")}.`,
      ].join("\n");
      return { preview, warnings };
    },
    deps,
  );
}
