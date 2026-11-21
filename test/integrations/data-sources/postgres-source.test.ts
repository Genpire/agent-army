import { afterEach, describe, expect, it } from "vitest";
import { type DataSource, DataSourceSchema } from "../../../src/core/config.js";
import {
  type PgConnection,
  type PgPoolFactory,
  type PgQuery,
  type PgResult,
  cellText,
  closePool,
  describeSchema,
  formatTable,
  isLocalHost,
  pgConnection,
  readOnlyPreamble,
  runSql,
  testPostgres,
} from "../../../src/integrations/data-sources/postgres-source.js";

const CS = "postgres://pointer_ro:s3cret%2Fpass@db.example.com:6543/app?sslmode=require";

const source = (id = "ds-pg", connectionString = CS, schemas = ["public", "analytics"]): DataSource =>
  DataSourceSchema.parse({ id, name: "Product DB", kind: "postgres", postgres: { connectionString, schemas } });

interface Call {
  text: string;
  query: string | PgQuery;
}

/** A fake pool: records every statement, answers with `respond`, and counts connections, releases and pools. */
function fakePg(respond: (text: string, q: string | PgQuery) => PgResult | Error = () => ({ rows: [], fields: [] })) {
  const calls: Call[] = [];
  const released: (Error | undefined)[] = [];
  const pools: PgConnection[] = [];
  let ended = 0;
  const poolFactory: PgPoolFactory = (connection) => {
    pools.push(connection);
    return {
      connect: async () => ({
        query: async (q) => {
          const text = typeof q === "string" ? q : q.text;
          calls.push({ text, query: q });
          const r = respond(text, q);
          if (r instanceof Error) throw r;
          return r;
        },
        release: (err) => released.push(err),
      }),
      end: async () => {
        ended++;
      },
    };
  };
  return { poolFactory, calls, released, pools, ended: () => ended, texts: () => calls.map((c) => c.text) };
}

const PREAMBLE =
  "BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '30s'; " +
  'SET LOCAL search_path = "public", "analytics"';

afterEach(async () => {
  for (const id of ["ds-pg", "ds-pg-2", "ds-pg-3", "ds-pg-4", "ds-pg-5", "ds-pg-6", "ds-pg-7"]) await closePool(id);
});

describe("Postgres connections", () => {
  it("reads the connection string, with libpq's sslmode", () => {
    expect(pgConnection(CS)).toEqual({
      host: "db.example.com",
      port: 6543,
      user: "pointer_ro",
      password: "s3cret/pass",
      database: "app",
      ssl: { rejectUnauthorized: false },
      sslmode: "require",
    });
    // No sslmode: TLS for a remote host, none for this machine or a container name.
    expect(pgConnection("postgres://u:p@db.example.com/app")).toMatchObject({ sslmode: "require", ssl: { rejectUnauthorized: false }, port: 5432 });
    expect(pgConnection("postgresql://u:p@localhost/app")).toMatchObject({ sslmode: "disable", ssl: false });
    expect(pgConnection("postgres://u:p@127.0.0.1:5433/app")).toMatchObject({ sslmode: "disable", ssl: false });
    expect(pgConnection("postgres://u:p@postgres/app")).toMatchObject({ sslmode: "disable", ssl: false });
    expect(pgConnection("postgres://u:p@db.example.com/app?sslmode=prefer")).toMatchObject({ sslmode: "require" });
    expect(pgConnection("postgres://u:p@db.example.com/app?sslmode=disable")).toMatchObject({ sslmode: "disable", ssl: false });
    expect(pgConnection("postgres://u:p@localhost/app?sslmode=require")).toMatchObject({ sslmode: "require" });
    expect(pgConnection("postgres://u:p@db.example.com/app?sslmode=verify-full")).toMatchObject({ sslmode: "verify-full", ssl: { rejectUnauthorized: true } });
    const ca = pgConnection("postgres://u:p@db.example.com/app?sslmode=verify-ca").ssl;
    expect(ca).toMatchObject({ rejectUnauthorized: true });
    expect(ca && ca.checkServerIdentity?.("db.example.com", {} as never)).toBeUndefined();
    expect(pgConnection("postgres://u:p@db.example.com/app?ssl=true")).toMatchObject({ sslmode: "require" });
    // No database: the user's.
    expect(pgConnection("postgres://reader:p@db.example.com")).toMatchObject({ database: "reader" });
  });

  it("refuses connection strings it cannot use", () => {
    const error = (cs: string) => {
      try {
        pgConnection(cs);
      } catch (err) {
        return (err as Error).message;
      }
      return "accepted";
    };
    expect(error("host=db user=x")).toMatch(/as a URL/);
    expect(error("mysql://u:p@db/app")).toMatch(/postgres:\/\//);
    expect(error("postgres://db.example.com/app")).toMatch(/no user name/);
    expect(error("postgres://u:p@db.example.com/app?sslmode=sometimes")).toMatch(/sslmode=sometimes/);
    expect(error("postgres://u:p@db.example.com/app?sslrootcert=/etc/ca.pem")).toMatch(/sslrootcert option is not supported/);
    expect(error("postgres://u:p@db.example.com/app?host=/var/run/postgresql")).toMatch(/host option/);
  });

  it("knows local hosts", () => {
    expect(["localhost", "127.0.0.1", "::1", "[::1]", "db", "app.localhost"].every(isLocalHost)).toBe(true);
    expect(["db.example.com", "10.0.0.5", "2001:db8::1", "rds.amazonaws.com"].some(isLocalHost)).toBe(false);
  });

  it("keeps one pool per source, at the source's settings, until they change", async () => {
    const pg = fakePg();
    await runSql(source(), "SELECT 1", { poolFactory: pg.poolFactory });
    await runSql(source(), "SELECT 2", { poolFactory: pg.poolFactory });
    expect(pg.pools).toHaveLength(1);
    expect(pg.pools[0]).toMatchObject({ host: "db.example.com", database: "app" });
    await runSql(source("ds-pg", CS.replace("6543", "6544")), "SELECT 3", { poolFactory: pg.poolFactory });
    expect(pg.pools).toHaveLength(2);
    expect(pg.ended()).toBe(1);
    await closePool("ds-pg");
    expect(pg.ended()).toBe(2);
  });
});

describe("read-only queries", () => {
  it("runs each query inside BEGIN READ ONLY … ROLLBACK, through a cursor, as one server-parsed statement", async () => {
    const pg = fakePg((text) => (text.startsWith("FETCH") ? { rows: [[1, "a@example.com"]], fields: [{ name: "id" }, { name: "email" }] } : { rows: [] }));
    const r = await runSql(source("ds-pg-2"), "SELECT id, email FROM users ORDER BY id;", { poolFactory: pg.poolFactory });
    expect(r).toEqual({ columns: ["id", "email"], rows: [[1, "a@example.com"]], more: false });
    expect(pg.texts()).toEqual([PREAMBLE, "DECLARE pointer_rows NO SCROLL CURSOR FOR SELECT id, email FROM users ORDER BY id", "FETCH FORWARD 501 FROM pointer_rows", "ROLLBACK"]);
    expect(pg.calls[1]!.query).toMatchObject({ queryMode: "extended" });
    expect(pg.calls[2]!.query).toMatchObject({ rowMode: "array" });
    expect(pg.released).toEqual([undefined]);
  });

  it("sets the organisation's timezone for the transaction, and only a real one", () => {
    expect(readOnlyPreamble(["public"], 15_000, "Asia/Jerusalem")).toContain("SET LOCAL TimeZone = 'Asia/Jerusalem'");
    expect(readOnlyPreamble(["public"], 15_000, "UTC")).toContain("SET LOCAL TimeZone = 'UTC'");
    expect(readOnlyPreamble(["public"], 15_000, "Nowhere/Land")).not.toContain("TimeZone");
    expect(readOnlyPreamble(["public"], 15_000, "UTC'; DROP TABLE x; --")).not.toContain("TimeZone");
    expect(readOnlyPreamble(['we"ird'], 5_000)).toContain(`statement_timeout = '5s'`);
    expect(readOnlyPreamble(['we"ird'], 5_000)).toContain(`search_path = "we""ird"`);
  });

  it("runs EXPLAIN directly, without a cursor", async () => {
    const pg = fakePg((text) => (text.startsWith("EXPLAIN") ? { rows: [["Seq Scan on users"]], fields: [{ name: "QUERY PLAN" }] } : { rows: [] }));
    const r = await runSql(source("ds-pg-3"), "EXPLAIN SELECT * FROM users", { poolFactory: pg.poolFactory });
    expect(r.rows).toEqual([["Seq Scan on users"]]);
    expect(pg.texts()).toEqual([PREAMBLE, "EXPLAIN SELECT * FROM users", "ROLLBACK"]);
    expect(pg.calls[1]!.query).toMatchObject({ queryMode: "extended", rowMode: "array" });
  });

  it("returns at most 500 rows and says there are more", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => [i + 1]);
    const pg = fakePg((text) => (text.startsWith("FETCH") ? { rows, fields: [{ name: "n" }] } : { rows: [] }));
    const r = await runSql(source("ds-pg-4"), "SELECT n FROM big", { poolFactory: pg.poolFactory });
    expect(r.rows).toHaveLength(500);
    expect(r.more).toBe(true);
    const table = formatTable(r);
    expect(table.split("\n")[0]).toBe("More than 500 rows: the first 500 are shown. Use COUNT(*), SUM or GROUP BY for totals, or LIMIT and OFFSET to page.");
    expect(table).toContain("\n500");
    expect(table).not.toContain("\n501");
  });

  it("refuses a statement that is not a read before connecting", async () => {
    const pg = fakePg();
    await expect(runSql(source("ds-pg-5"), "DELETE FROM users", { poolFactory: pg.poolFactory })).rejects.toThrow(/not DELETE/);
    await expect(runSql(source("ds-pg-5"), "SELECT 1; SELECT 2", { poolFactory: pg.poolFactory })).rejects.toThrow(/one statement/);
    expect(pg.calls).toEqual([]);
  });

  it("rolls back after an error, says what Postgres said, and drops a connection that cannot roll back", async () => {
    const pg = fakePg((text) =>
      text.startsWith("DECLARE") ? Object.assign(new Error('relation "nope" does not exist'), { code: "42P01", hint: "Check the schema." }) : { rows: [] },
    );
    await expect(runSql(source("ds-pg-6"), "SELECT * FROM nope", { poolFactory: pg.poolFactory })).rejects.toThrow('relation "nope" does not exist (hint: Check the schema.)');
    expect(pg.texts().at(-1)).toBe("ROLLBACK");
    expect(pg.released).toEqual([undefined]);

    const timeout = fakePg((text) => (text.startsWith("FETCH") ? Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) : { rows: [] }));
    await expect(runSql(source("ds-pg-7"), "SELECT pg_class.* FROM pg_class", { poolFactory: timeout.poolFactory })).rejects.toThrow(/took longer than the time limit/);

    const broken = fakePg((text) => (text === "ROLLBACK" ? new Error("connection terminated") : text.startsWith("FETCH") ? { rows: [[1]], fields: [{ name: "x" }] } : { rows: [] }));
    await closePool("ds-pg-7");
    const r = await runSql(source("ds-pg-7"), "SELECT 1 AS x", { poolFactory: broken.poolFactory });
    expect(r.rows).toEqual([[1]]);
    expect(broken.released[0]).toBeInstanceOf(Error);
  });

  it("maps a refused write to a plain message", async () => {
    const pg = fakePg((text) =>
      text.startsWith("DECLARE") ? Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" }) : { rows: [] },
    );
    await expect(runSql(source("ds-pg-2"), "SELECT write_something()", { poolFactory: pg.poolFactory })).rejects.toThrow("That would write to the database; only reading is allowed.");
  });
});

describe("tables and schema", () => {
  it("formats values on one line each", () => {
    expect(cellText(null)).toBe("NULL");
    expect(cellText(new Date("2026-11-21T08:00:00Z"))).toBe("2026-11-21T08:00:00.000Z");
    expect(cellText(Buffer.from([1, 2, 255]))).toBe("\\x0102ff");
    expect(cellText({ plan: "pro" })).toBe('{"plan":"pro"}');
    expect(cellText("two\nlines | pipe")).toBe("two\\nlines \\| pipe");
    expect(cellText("x".repeat(400))).toHaveLength(300);
    expect(formatTable({ columns: ["day", "signups"], rows: [["2026-11-16", "42"], ["2026-11-17", "51"]], more: false })).toBe(
      "2 rows\nday | signups\n2026-11-16 | 42\n2026-11-17 | 51",
    );
    const wide = formatTable({ columns: ["t"], rows: Array.from({ length: 200 }, () => ["y".repeat(290)]), more: false }, 5_000);
    expect(wide.length).toBeLessThanOrEqual(5_000);
    expect(wide).toMatch(/more rows not shown \(output size limit\)/);
  });

  it("describes the tables and columns of the source's schemas", async () => {
    const pg = fakePg((text) => {
      if (text.includes("information_schema.columns")) {
        return {
          rows: [
            ["public", "users", "id", "bigint"],
            ["public", "users", "created_at", "timestamp with time zone"],
            ["analytics", "daily_signups", "day", "date"],
          ],
        };
      }
      if (text.includes("pg_class")) {
        return {
          rows: [
            ["public", "users", "r", "10234"],
            ["analytics", "daily_signups", "v", "-1"],
          ],
        };
      }
      return { rows: [] };
    });
    const out = await describeSchema(source(), { poolFactory: pg.poolFactory });
    expect(out).toBe(
      [
        "Tables and views in public, analytics (2 relations; row counts are the planner's estimates):",
        "- public.users (table, ~10,234 rows): id bigint, created_at timestamptz",
        "- analytics.daily_signups (view): day date",
      ].join("\n"),
    );
    // Inside the read-only transaction, with the schemas as a parameter.
    expect(pg.texts()[0]).toBe(PREAMBLE);
    expect(pg.calls[1]!.query).toMatchObject({ values: [["public", "analytics"]] });
    expect(pg.texts().at(-1)).toBe("ROLLBACK");
  });

  it("tests the connection: who, where, read-only, and whether the role could write", async () => {
    const pg = fakePg((text) => {
      if (text.includes("current_user")) return { rows: [["pointer_ro", "app", "16.4", "on", false]] };
      if (text.includes("has_table_privilege")) return { rows: [[12, true]] };
      return { rows: [] };
    });
    const r = await testPostgres(source("ds-pg-3"), { poolFactory: pg.poolFactory });
    expect(r.preview).toBe("Connected as pointer_ro to app (PostgreSQL 16.4), TLS require.\nTransaction read-only: yes.\n12 tables and views readable in public, analytics.");
    expect(r.warnings).toEqual(["pointer_ro can change some of these tables. Queries run read-only anyway, but a role that can only SELECT is safer."]);
    expect(r.preview).not.toContain("s3cret");
  });
});
