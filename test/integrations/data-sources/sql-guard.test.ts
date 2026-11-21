import { describe, expect, it } from "vitest";
import { checkReadOnlySql } from "../../../src/integrations/data-sources/sql-guard.js";

const refused = (sql: string) => {
  try {
    checkReadOnlySql(sql);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`accepted: ${sql}`);
};

describe("the read-only statement check", () => {
  it("accepts one SELECT, WITH … SELECT or EXPLAIN, without its trailing semicolon", () => {
    expect(checkReadOnlySql("SELECT 1")).toEqual({ kind: "select", sql: "SELECT 1" });
    expect(checkReadOnlySql("  select count(*) from users where created_at >= now() - interval '7 days';  ")).toEqual({
      kind: "select",
      sql: "select count(*) from users where created_at >= now() - interval '7 days'",
    });
    expect(checkReadOnlySql("SELECT 1; -- done")).toEqual({ kind: "select", sql: "SELECT 1" });
    expect(checkReadOnlySql("(SELECT 1) UNION ALL (SELECT 2)").kind).toBe("select");
    expect(checkReadOnlySql("WITH s AS (SELECT plan, count(*) n FROM subscriptions GROUP BY plan) SELECT * FROM s ORDER BY n DESC").kind).toBe("select");
    expect(checkReadOnlySql("EXPLAIN SELECT * FROM users").kind).toBe("explain");
    expect(checkReadOnlySql("EXPLAIN (FORMAT JSON, COSTS false) WITH x AS (SELECT 1) SELECT * FROM x").kind).toBe("explain");
    expect(checkReadOnlySql("EXPLAIN VERBOSE SELECT 1").kind).toBe("explain");
  });

  it("does not read code in strings, comments or quoted names", () => {
    expect(checkReadOnlySql("SELECT 'a; DROP TABLE users; --' AS t").kind).toBe("select");
    expect(checkReadOnlySql("SELECT E'it\\'s; delete' AS t").kind).toBe("select");
    expect(checkReadOnlySql("SELECT $$; insert into x$$, $tag$ update $tag$").kind).toBe("select");
    expect(checkReadOnlySql("SELECT 1 /* ; delete /* nested */ still a comment */ AS one").kind).toBe("select");
    expect(checkReadOnlySql('SELECT "update", "into" FROM events -- ; drop').kind).toBe("select");
    expect(checkReadOnlySql("SELECT note FROM reviews WHERE note LIKE '%copy%' AND note <> 'pg_sleep'").kind).toBe("select");
    expect(checkReadOnlySql("SELECT created_at, updated_at, deleted_at, comment FROM posts").kind).toBe("select");
  });

  it("refuses chained statements, wherever the second one hides", () => {
    expect(refused("SELECT 1; SELECT 2")).toBe("Run one statement at a time: a ; may only end the query.");
    expect(refused("SELECT 1;; ")).toMatch(/one statement/);
    expect(refused("SELECT 'x'; DELETE FROM users")).toMatch(/one statement/);
    // A backslash does not escape in a standard string: the string ends, and the rest is code.
    expect(refused("SELECT 'a\\'; DROP TABLE users; --'")).toMatch(/one statement/);
    expect(refused("SELECT 1 /* */; UPDATE users SET x = 1")).toMatch(/one statement/);
  });

  it("refuses anything that is not a read", () => {
    expect(refused("DELETE FROM users")).toBe("Only SELECT, WITH … SELECT and EXPLAIN are allowed here (read-only), not DELETE.");
    expect(refused("COPY users TO STDOUT")).toMatch(/not COPY/);
    expect(refused("copy (select 1) to program 'id'")).toMatch(/not COPY/);
    expect(refused("SET ROLE admin")).toMatch(/not SET/);
    expect(refused("BEGIN")).toMatch(/not BEGIN/);
    expect(refused("DO $$ BEGIN PERFORM 1; END $$")).toMatch(/not DO/);
    expect(refused("VALUES (1)")).toMatch(/not VALUES/);
    expect(refused("")).toBe("Write a SELECT query.");
    expect(refused("  -- only a comment")).toBe("Write a SELECT query.");
    expect(refused(";")).toBe("Write a SELECT query.");
  });

  it("refuses writing CTEs, SELECT INTO and locking clauses", () => {
    expect(refused("WITH d AS (DELETE FROM users RETURNING *) SELECT count(*) FROM d")).toMatch(/^Only reading is allowed: DELETE is not/);
    expect(refused("WITH i AS (INSERT INTO log VALUES (1) RETURNING 1) SELECT 1")).toMatch(/INSERT is not/);
    expect(refused("SELECT * INTO backup FROM users")).toMatch(/INTO is not/);
    expect(refused("SELECT * FROM users FOR UPDATE")).toMatch(/Locking clauses/);
    expect(refused("SELECT * FROM users FOR NO KEY UPDATE")).toMatch(/Locking clauses/);
    expect(refused("SELECT * FROM users FOR SHARE")).toMatch(/Locking clauses/);
  });

  it("refuses functions that wait, write, lock or reach other servers, however they are written", () => {
    expect(refused("SELECT pg_sleep(60)")).toBe("pg_sleep() is not allowed here: it waits, writes, locks, or reaches outside this database.");
    expect(refused("SELECT pg_catalog.pg_sleep_for('1 minute')")).toMatch(/^pg_sleep_for\(\)/);
    expect(refused('SELECT "pg_sleep"(1)')).toMatch(/^pg_sleep\(\)/);
    expect(refused("SELECT PG_SLEEP /* x */ (1)")).toMatch(/^pg_sleep\(\)/);
    expect(refused("SELECT * FROM dblink('host=10.0.0.1', 'select 1') AS t(x int)")).toMatch(/^dblink\(\)/);
    expect(refused("SELECT dblink_exec ('drop table users')")).toMatch(/^dblink_exec\(\)/);
    expect(refused("SELECT set_config('transaction_read_only', 'off', true)")).toMatch(/^set_config\(\)/);
    expect(refused("SELECT nextval('users_id_seq')")).toMatch(/^nextval\(\)/);
    expect(refused("SELECT lo_import('/etc/passwd')")).toMatch(/^lo_import\(\)/);
    expect(refused("SELECT pg_read_file('/etc/passwd')")).toMatch(/^pg_read_file\(\)/);
    expect(refused("SELECT pg_advisory_lock(1)")).toMatch(/^pg_advisory_lock\(\)/);
    expect(refused("SELECT pg_terminate_backend(123)")).toMatch(/^pg_terminate_backend\(\)/);
    expect(refused("SELECT query_to_xml('delete from users', true, false, '')")).toMatch(/^query_to_xml\(\)/);
  });

  it("refuses EXPLAIN ANALYZE and EXPLAIN of anything but a read", () => {
    expect(refused("EXPLAIN ANALYZE SELECT 1")).toBe("EXPLAIN ANALYZE runs the statement; use EXPLAIN without ANALYZE.");
    expect(refused("EXPLAIN (ANALYZE, BUFFERS) SELECT 1")).toMatch(/EXPLAIN ANALYZE/);
    expect(refused("explain analyse select 1")).toMatch(/EXPLAIN ANALYZE/);
    expect(refused("EXPLAIN DELETE FROM users")).toMatch(/DELETE is not/);
    expect(refused("EXPLAIN (FORMAT JSON)")).toBe("EXPLAIN only a SELECT or WITH … SELECT query.");
  });

  it("refuses SQL it cannot read safely", () => {
    expect(refused("SELECT 'unterminated")).toBe("The SQL has an unterminated string.");
    expect(refused("SELECT 1 /* open")).toBe("The SQL has an unterminated comment.");
    expect(refused("SELECT $a$ open")).toBe("The SQL has an unterminated dollar-quoted string.");
    expect(refused('SELECT "open')).toBe("The SQL has an unterminated quoted name.");
    expect(refused("SELECT U&'d\\0061ta'")).toMatch(/Unicode-escaped/);
    expect(refused(`SELECT ${"1,".repeat(10_001)}1`)).toMatch(/too long/);
  });
});
