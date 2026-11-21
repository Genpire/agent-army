/**
 * The statement check for Postgres sources: one statement, SELECT, WITH …
 * SELECT or EXPLAIN (without ANALYZE), and none of the words or functions
 * that write, lock, wait, or reach other servers. It reads the SQL the way
 * Postgres does (comments, '…', E'…', $tag$…$tag$, "identifiers"), so a ";"
 * or a keyword inside a string or a comment is not mistaken for code, and a
 * statement hidden behind one is not missed.
 *
 * This is a first fence with clear messages, not the security boundary: each
 * query runs in a READ ONLY transaction that is rolled back (postgres-source.ts),
 * and the owner should connect with a role that can only SELECT.
 */
import { DataSourceError } from "./common.js";

export type SqlKind = "select" | "explain";

export interface CheckedSql {
  kind: SqlKind;
  /** The statement without its trailing semicolon (and anything after it, which is only comments). */
  sql: string;
}

interface Token {
  type: "word" | "quoted" | "string" | "number" | "param" | "punct" | "op";
  /** Words lowercased; quoted identifiers as written inside the quotes. */
  value: string;
  start: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const PARAM = /^\$\d+/;

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  const fail = (what: string): never => {
    throw new DataSourceError(`The SQL has an unterminated ${what}.`);
  };
  /** Reads a '…' string from the quote at `from`; backslashes escape only in E'…' strings. */
  const readString = (from: number, backslashes: boolean): number => {
    let j = from + 1;
    for (;;) {
      if (j >= n) fail("string");
      const c = sql[j];
      if (backslashes && c === "\\") j += 2;
      else if (c === "'") {
        if (sql[j + 1] === "'") j += 2;
        else return j + 1;
      } else j++;
    }
  };
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      // Block comments nest in Postgres.
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= n) fail("comment");
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (c === "'") {
      const end = readString(i, false);
      tokens.push({ type: "string", value: "", start: i });
      i = end;
    } else if ((c === "e" || c === "E") && sql[i + 1] === "'") {
      const end = readString(i + 1, true);
      tokens.push({ type: "string", value: "", start: i });
      i = end;
    } else if ((c === "u" || c === "U") && sql[i + 1] === "&" && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      throw new DataSourceError("Unicode-escaped strings and names (U&'…') are not accepted here; write the text as it is.");
    } else if (c === '"') {
      let j = i + 1;
      let name = "";
      for (;;) {
        if (j >= n) fail("quoted name");
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            name += '"';
            j += 2;
          } else break;
        } else name += sql[j++];
      }
      tokens.push({ type: "quoted", value: name, start: i });
      i = j + 1;
    } else if (c === "$") {
      const rest = sql.slice(i);
      const tag = rest.match(DOLLAR_TAG)?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) fail("dollar-quoted string");
        tokens.push({ type: "string", value: "", start: i });
        i = close + tag.length;
      } else {
        const param = rest.match(PARAM)?.[0];
        tokens.push({ type: param ? "param" : "op", value: param ?? "$", start: i });
        i += param?.length ?? 1;
      }
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j]!)) j++;
      tokens.push({ type: "word", value: sql.slice(i, j).toLowerCase(), start: i });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(sql[j]!)) j++;
      tokens.push({ type: "number", value: sql.slice(i, j), start: i });
      i = j;
    } else if ("();,[].:".includes(c)) {
      tokens.push({ type: "punct", value: c, start: i });
      i++;
    } else {
      tokens.push({ type: "op", value: c, start: i });
      i++;
    }
  }
  return tokens;
}

/** Words that write, change settings, lock, or run other statements: never part of a read. */
const WRITING_WORDS = new Set([
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
]);

/** Functions that wait, write, take locks, change settings, read the server's files or reach other servers. */
const DENIED_FUNCTIONS = new Set([
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
]);
const DENIED_PREFIXES = [
  "pg_sleep",
  "dblink",
  "lo_",
  "pg_advisory",
  "pg_try_advisory",
  "pg_ls_",
  "pg_file_",
  "pg_logical_",
  "pg_replication_",
  "pg_create_",
  "pg_drop_",
  "pg_wal_",
  "pg_backup_",
  "pg_stat_reset",
];

const isDeniedFunction = (name: string) => DENIED_FUNCTIONS.has(name) || DENIED_PREFIXES.some((p) => name.startsWith(p));

const isOpen = (t: Token | undefined) => t?.type === "punct" && t.value === "(";

/**
 * Checks that `sql` is one read-only statement and returns it without its
 * trailing semicolon. Throws DataSourceError saying what is not allowed.
 */
export function checkReadOnlySql(sql: string): CheckedSql {
  if (sql.length > 20_000) throw new DataSourceError("The query is too long (at most 20,000 characters).");
  const tokens = tokenize(sql);

  // One statement: a semicolon only at the very end.
  const semis = tokens.flatMap((t, i) => (t.type === "punct" && t.value === ";" ? [i] : []));
  const last = semis[semis.length - 1];
  if (semis.length > 1 || (last !== undefined && last !== tokens.length - 1)) {
    throw new DataSourceError("Run one statement at a time: a ; may only end the query.");
  }
  const end = last ?? tokens.length;
  const body = tokens.slice(0, end);
  if (body.length === 0) throw new DataSourceError("Write a SELECT query.");

  const leadAt = body.findIndex((t) => !isOpen(t));
  const first = body[leadAt];
  const lead = first?.type === "word" ? first.value : "";
  let kind: SqlKind;
  if (lead === "select" || lead === "with") kind = "select";
  else if (lead === "explain") kind = "explain";
  else {
    const shown = first ? (first.type === "word" ? first.value.toUpperCase() : sql.slice(first.start, first.start + 20).trim()) : "";
    throw new DataSourceError(`Only SELECT, WITH … SELECT and EXPLAIN are allowed here (read-only)${shown ? `, not ${shown}` : ""}.`);
  }

  for (let i = 0; i < body.length; i++) {
    const t = body[i]!;
    if (t.type !== "word" && t.type !== "quoted") continue;
    const name = t.type === "quoted" ? t.value.toLowerCase() : t.value;
    if (isDeniedFunction(name)) throw new DataSourceError(`${name}() is not allowed here: it waits, writes, locks, or reaches outside this database.`);
    if (t.type !== "word") continue;
    if (WRITING_WORDS.has(name)) {
      throw new DataSourceError(`Only reading is allowed: ${name.toUpperCase()} is not. (A column with that name can be written quoted, e.g. "${name}".)`);
    }
    const next = body[i + 1];
    if (name === "for" && next?.type === "word" && ["update", "share", "no", "key"].includes(next.value)) {
      throw new DataSourceError("Locking clauses (FOR UPDATE, FOR SHARE…) are not allowed: they hold rows other work may need.");
    }
    if (kind === "explain" && (name === "analyze" || name === "analyse")) {
      throw new DataSourceError("EXPLAIN ANALYZE runs the statement; use EXPLAIN without ANALYZE.");
    }
  }

  if (kind === "explain") {
    // EXPLAIN [ (options) ] [ VERBOSE ] then the statement, which must be a read.
    let j = leadAt + 1;
    if (isOpen(body[j])) {
      let depth = 0;
      for (; j < body.length; j++) {
        const v = body[j]!;
        if (isOpen(v)) depth++;
        else if (v.type === "punct" && v.value === ")" && --depth === 0) {
          j++;
          break;
        }
      }
    }
    while (body[j]?.type === "word" && body[j]!.value === "verbose") j++;
    const target = body.slice(j).find((t) => !isOpen(t));
    if (!target || target.type !== "word" || (target.value !== "select" && target.value !== "with")) {
      throw new DataSourceError("EXPLAIN only a SELECT or WITH … SELECT query.");
    }
  }

  return { kind, sql: (last !== undefined ? sql.slice(0, tokens[last]!.start) : sql).trim() };
}
