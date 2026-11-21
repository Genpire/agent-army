/**
 * Company data sources on the admin page: what the server shows of one (no
 * credentials), the form that adds or edits one and the request it sends,
 * the checks run before sending, and the read-only role to create in Postgres.
 */
import { api } from "../../../lib/api";
import { timeAgo } from "../../../lib/format";
import type { PublicConfig } from "../../../lib/types";
import type { StatusTone } from "../catalog";

export type DataSourceView = PublicConfig["dataSources"][number];

/** What the owner picks first: an API with a key (or none), an admin panel that signs in, or a database. */
export type SourceChoice = "http" | "login" | "postgres";
export type HttpAuthChoice = "none" | "bearer" | "basic" | "header";

export const SOURCE_CHOICES: { value: SourceChoice; label: string; description: string }[] = [
  { value: "http", label: "HTTP API", description: "Your own API, read with GET. Signs in with an API token, a user and password, a header, or not at all." },
  { value: "login", label: "Admin or CMS sign-in", description: "An admin panel's API that signs in with a user name and password and gives back a token." },
  { value: "postgres", label: "Postgres database", description: "Read with SELECT queries in read-only transactions." },
];

export const AUTH_CHOICES: { value: HttpAuthChoice; label: string; description: string }[] = [
  { value: "bearer", label: "API token", description: "Sent as Authorization: Bearer <token>." },
  { value: "header", label: "API key in a header", description: "Sent in the header the API names, e.g. X-API-Key." },
  { value: "basic", label: "User name and password (Basic)", description: "Sent as Authorization: Basic." },
  { value: "none", label: "No sign-in", description: "A public API." },
];

export const KIND_LABEL: Record<DataSourceView["kind"], string> = { http: "HTTP API", postgres: "Postgres" };

export const choiceOf = (d: DataSourceView): SourceChoice => (d.kind === "postgres" ? "postgres" : d.http?.auth.type === "login" ? "login" : "http");

/** Where it is: the API's address, or the database's user@host:port/database. */
export const sourceAddress = (d: DataSourceView): string => (d.kind === "http" ? (d.http?.baseUrl ?? "") : d.postgres?.address || "Database");

export function sourceStatus(d: DataSourceView): { tone: StatusTone; text: string } {
  if (!d.enabled) return { tone: "neutral", text: "Off" };
  if (d.checkedAt) return { tone: "success", text: `On · tested ${timeAgo(d.checkedAt)}` };
  return { tone: "warning", text: "On · not tested yet" };
}

/** What Pointer may read in it, in a few words. */
export function sourceScope(d: DataSourceView): string {
  if (d.kind === "http") return d.http?.allowedPaths.length ? d.http.allowedPaths.join(", ") : "Any path";
  return `Schemas: ${(d.postgres?.schemas ?? ["public"]).join(", ")}`;
}

export interface SourceForm {
  choice: SourceChoice;
  name: string;
  description: string;
  enabled: boolean;
  baseUrl: string;
  internal: boolean;
  /** One path per line (commas work too). */
  allowedPaths: string;
  auth: HttpAuthChoice;
  token: string;
  username: string;
  password: string;
  headerName: string;
  headerValue: string;
  loginUrl: string;
  loginUsername: string;
  loginPassword: string;
  usernameField: string;
  passwordField: string;
  tokenPath: string;
  tokenHeader: string;
  tokenPrefix: string;
  connectionString: string;
  /** Comma separated. */
  schemas: string;
}

export const EMPTY_FORM: SourceForm = {
  choice: "http",
  name: "",
  description: "",
  enabled: true,
  baseUrl: "",
  internal: false,
  allowedPaths: "",
  auth: "bearer",
  token: "",
  username: "",
  password: "",
  headerName: "X-API-Key",
  headerValue: "",
  loginUrl: "",
  loginUsername: "",
  loginPassword: "",
  usernameField: "email",
  passwordField: "password",
  tokenPath: "token",
  tokenHeader: "Authorization",
  tokenPrefix: "Bearer ",
  connectionString: "",
  schemas: "public",
};

/** The form for a saved source: its settings, and every credential empty (empty keeps the saved one). */
export function formOf(d: DataSourceView | undefined): SourceForm {
  if (!d) return EMPTY_FORM;
  const form: SourceForm = { ...EMPTY_FORM, choice: choiceOf(d), name: d.name, description: d.description, enabled: d.enabled };
  if (d.http) {
    const a = d.http.auth;
    Object.assign(form, { baseUrl: d.http.baseUrl, internal: d.http.internal, allowedPaths: d.http.allowedPaths.join("\n") });
    if (a.type === "login") {
      Object.assign(form, {
        loginUrl: a.loginUrl,
        loginUsername: a.username,
        usernameField: a.usernameField,
        passwordField: a.passwordField,
        tokenPath: a.tokenPath,
        tokenHeader: a.headerName,
        tokenPrefix: a.headerPrefix,
      });
    } else {
      form.auth = a.type;
      if (a.type === "basic") form.username = a.username;
      if (a.type === "header") form.headerName = a.name;
    }
  }
  if (d.postgres) form.schemas = d.postgres.schemas.join(", ");
  return form;
}

export const splitList = (s: string) =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The saved credential's mask for the form's current choice, or null when none is saved for it. */
export function savedSecret(d: DataSourceView | undefined, form: SourceForm): string | null {
  const a = d?.http?.auth;
  if (!a) return null;
  if (form.choice === "login") return a.type === "login" ? a.password : null;
  if (form.auth === "bearer" && a.type === "bearer") return a.token;
  if (form.auth === "basic" && a.type === "basic") return a.password;
  if (form.auth === "header" && a.type === "header") return a.value;
  return null;
}

/** What the form would send (POST /api/data-sources or /api/data-sources/:id). */
export function requestBody(form: SourceForm, isNew: boolean): Record<string, unknown> {
  const common = { name: form.name.trim(), description: form.description.trim(), enabled: form.enabled };
  if (form.choice === "postgres") {
    return {
      ...common,
      ...(isNew ? { kind: "postgres" } : {}),
      postgres: { connectionString: form.connectionString.trim(), schemas: splitList(form.schemas) },
    };
  }
  const auth =
    form.choice === "login"
      ? {
          type: "login",
          loginUrl: form.loginUrl.trim(),
          username: form.loginUsername.trim(),
          password: form.loginPassword,
          usernameField: form.usernameField.trim() || "email",
          passwordField: form.passwordField.trim() || "password",
          tokenPath: form.tokenPath.trim() || "token",
          headerName: form.tokenHeader.trim() || "Authorization",
          headerPrefix: form.tokenPrefix,
        }
      : form.auth === "bearer"
        ? { type: "bearer", token: form.token.trim() }
        : form.auth === "basic"
          ? { type: "basic", username: form.username.trim(), password: form.password }
          : form.auth === "header"
            ? { type: "header", name: form.headerName.trim(), value: form.headerValue.trim() }
            : { type: "none" };
  return {
    ...common,
    ...(isNew ? { kind: "http" } : {}),
    http: { baseUrl: form.baseUrl.trim(), internal: form.internal, auth, allowedPaths: splitList(form.allowedPaths) },
  };
}

export interface FormProblems {
  name?: string;
  baseUrl?: string;
  allowedPaths?: string;
  credential?: string;
  loginUrl?: string;
  username?: string;
  connectionString?: string;
  schemas?: string;
}

const HEADER_RE = /^[A-Za-z0-9-]{1,100}$/;
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** What is missing or malformed before anything is sent (the server checks everything again). */
export function formProblems(form: SourceForm, saved: DataSourceView | undefined): FormProblems {
  const p: FormProblems = {};
  if (!form.name.trim()) p.name = "Give the source a name.";
  if (form.choice === "postgres") {
    const cs = form.connectionString.trim();
    if (!cs && !saved?.postgres) p.connectionString = "Paste the connection string.";
    else if (cs && !/^postgres(ql)?:\/\/[^/]+/.test(cs)) p.connectionString = "Use a URL: postgres://user:password@host:5432/database?sslmode=require.";
    const schemas = splitList(form.schemas);
    if (schemas.length === 0) p.schemas = "Give at least one schema, e.g. public.";
    else if (schemas.some((s) => !SCHEMA_RE.test(s))) p.schemas = "Schema names use letters, digits and _, and start with a letter.";
    return p;
  }
  const url = form.baseUrl.trim();
  if (!url) p.baseUrl = "Give the API's address.";
  else if (!/^https:\/\/[^/?#]+/i.test(url)) p.baseUrl = "Use the API's https:// address, e.g. https://api.example.com.";
  else if (/[?#]/.test(url)) p.baseUrl = "Leave the query and fragment out of the base address.";
  const paths = splitList(form.allowedPaths);
  if (paths.some((x) => /^[a-z]+:|^\/\//i.test(x))) p.allowedPaths = "Give paths under the base address (/api/stats), not full addresses.";
  else if (paths.some((x) => x.split("/").includes(".."))) p.allowedPaths = 'Paths may not contain "..".';
  const kept = savedSecret(saved, form) !== null;
  if (form.choice === "login") {
    if (!form.loginUrl.trim()) p.loginUrl = "Give the sign-in address, or its path on the base address (/api/auth/login).";
    if (!form.loginUsername.trim()) p.username = "Give the user name or email to sign in with.";
    if (!form.loginPassword && !kept) p.credential = "Give the password to sign in with.";
    if (form.tokenHeader.trim() && !HEADER_RE.test(form.tokenHeader.trim())) p.credential = "Header names use letters, digits and dashes.";
  } else if (form.auth === "bearer" && !form.token.trim() && !kept) p.credential = "Paste the API token.";
  else if (form.auth === "basic") {
    if (!form.username.trim()) p.username = "Give the user name.";
    if (!form.password && !kept) p.credential = "Give the password.";
  } else if (form.auth === "header") {
    if (!HEADER_RE.test(form.headerName.trim())) p.credential = "Header names use letters, digits and dashes.";
    else if (!form.headerValue.trim() && !kept) p.credential = `Give the value of the ${form.headerName.trim()} header.`;
  }
  return p;
}

/** POST /api/data-sources/:id/test */
export interface TestResult {
  ok: true;
  preview: string;
  warnings: string[];
  checkedAt: string;
}

export const testSource = (id: string, path?: string) => api.post<TestResult>(`/api/data-sources/${encodeURIComponent(id)}/test`, path ? { path } : {});

const ROLE = "pointer_readonly";

/** The database name of a source's address (user@host:5432/app → app), for the role snippet. */
const databaseOf = (address: string | undefined) => address?.split("/")[1] || "your_database";

/**
 * SQL that creates a role that can only read the given schemas, on one line
 * so it pastes anywhere (psql, a console's query editor). Run it as the
 * database's owner; the default privileges cover tables that owner adds later.
 */
export function readOnlyRoleSql(schemas: string[], address?: string): string {
  const list = (schemas.length ? schemas : ["public"]).filter((s) => SCHEMA_RE.test(s));
  const each = (sql: (s: string) => string) => list.map(sql).join(" ");
  return [
    `CREATE ROLE ${ROLE} LOGIN PASSWORD 'choose-a-long-password';`,
    `GRANT CONNECT ON DATABASE ${databaseOf(address)} TO ${ROLE};`,
    each((s) => `GRANT USAGE ON SCHEMA ${s} TO ${ROLE};`),
    each((s) => `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${ROLE};`),
    each((s) => `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT ON TABLES TO ${ROLE};`),
    `ALTER ROLE ${ROLE} SET default_transaction_read_only = on;`,
  ].join(" ");
}
