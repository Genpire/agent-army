import { describe, expect, it } from "vitest";
import { checkReadOnlySql } from "../../src/integrations/data-sources/sql-guard.js";

/**
 * The read-only statement check's word and function lists (sql-guard.ts),
 * listed here on their own so that dropping one from the code is noticed:
 * each is refused inside an otherwise readable query, and the reads next to
 * them (quoted names, longer words, harmless functions) are accepted.
 */

const refused = (sql: string) => {
  try {
    checkReadOnlySql(sql);
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
};

const WRITING_WORDS = [
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "copy",
  "into",
  "lock",
  "vacuum",
  "call",
  "do",
  "execute",
  "prepare",
  "declare",
  "listen",
  "notify",
  "refresh",
  "reindex",
  "cluster",
];

const DENIED_FUNCTIONS = [
  "set_config",
  "nextval",
  "setval",
  "pg_notify",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_stat_file",
  "pg_switch_wal",
  "pg_promote",
  "pg_import_system_collations",
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "txid_current",
  "pg_current_xact_id",
];

/** A function under each denied prefix. */
const DENIED_BY_PREFIX = [
  "pg_sleep_until",
  "dblink_connect",
  "lo_export",
  "pg_advisory_xact_lock",
  "pg_try_advisory_lock",
  "pg_ls_dir",
  "pg_file_write",
  "pg_logical_emit_message",
  "pg_replication_origin_create",
  "pg_create_restore_point",
  "pg_drop_replication_slot",
  "pg_wal_replay_pause",
  "pg_backup_start",
  "pg_stat_reset_shared",
];

describe("read-only check: the writing words", () => {
  it("refuses each one inside a WITH … SELECT, saying which", () => {
    for (const word of WRITING_WORDS) {
      expect(refused(`WITH x AS (SELECT 1 ${word} y) SELECT * FROM x`), word).toMatch(new RegExp(`^Only reading is allowed: ${word.toUpperCase()} is not`));
    }
  });

  it("accepts each one quoted, and the longer words that start with one", () => {
    for (const word of WRITING_WORDS) {
      expect(refused(`SELECT "${word}", ${word}_at, ${word}s FROM events`), word).toBeUndefined();
    }
  });

  it("refuses every locking clause, and accepts FOR in other places", () => {
    for (const clause of ["FOR UPDATE", "FOR SHARE", "FOR NO KEY UPDATE", "FOR KEY SHARE"]) {
      expect(refused(`SELECT * FROM users ${clause}`), clause).toMatch(/Locking clauses/);
    }
    expect(refused("SELECT substring(name FROM 1 FOR 3) FROM users")).toBeUndefined();
    expect(refused("SELECT overlay(name PLACING 'x' FROM 1 FOR 1) FROM users")).toBeUndefined();
  });
});

describe("read-only check: the denied functions", () => {
  it("refuses each one, by name and by prefix", () => {
    for (const fn of [...DENIED_FUNCTIONS, ...DENIED_BY_PREFIX]) {
      expect(refused(`SELECT ${fn}(1)`), fn).toBe(`${fn}() is not allowed here: it waits, writes, locks, or reaches outside this database.`);
    }
  });

  it("accepts the functions reports use", () => {
    for (const fn of ["count(*)", "now()", "date_trunc('week', created_at)", "pg_size_pretty(pg_total_relation_size('users'))", "pg_typeof(1)", "lower(name)", "coalesce(a, b)", "current_setting('TimeZone')"]) {
      expect(refused(`SELECT ${fn} FROM users`), fn).toBeUndefined();
    }
  });
});
