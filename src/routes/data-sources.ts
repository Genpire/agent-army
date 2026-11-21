/**
 * Company data admin routes (/api/data-sources/…), all admin only: list the
 * sources, add one, update one (an empty credential keeps the saved one, as
 * long as it would go to the same address), test one (a sample GET, or the
 * connection, its role and its tables) with a short preview, and remove one.
 * Credentials are never sent back; every message is redacted.
 */
import { randomBytes } from "node:crypto";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { type Config, DATA_SOURCE_ID_RE, type DataSource, DataSourceSchema, publicView } from "../core/config.js";
import { DATA_LIMITS, DataSourceError, cap, errorText, flat, sourceSecrets } from "../integrations/data-sources/common.js";
import { forgetDataSource } from "../integrations/data-sources/data-sources.js";
import {
  baseUrlProblem,
  formatHttpResult,
  httpGet,
  loginSecrets,
  loginUrlOf,
  loginUrlProblem,
  normalizeAllowedPath,
  normalizeBaseUrl,
} from "../integrations/data-sources/http-source.js";
import { pgConnection, testPostgres } from "../integrations/data-sources/postgres-source.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import type { IntegrationRouteDeps } from "./types.js";

export const MAX_DATA_SOURCES = 30;

const HEADER_NAME = z.string().trim().regex(/^[A-Za-z0-9-]{1,100}$/, "Header names use letters, digits and dashes.");
/** A credential as the console sends it: "" keeps the saved one. */
const SECRET = z.string().trim().max(10_000, "That credential is too long.").default("");
const FIELD = z.string().trim().regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, "Field names use letters, digits, _ and -, with dots for nested fields (user.email).").max(60);
const SCHEMA = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/, "Schema names use letters, digits and _, and start with a letter.");

const AUTH = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("bearer"), token: SECRET }),
    z.object({ type: z.literal("basic"), username: z.string().trim().min(1, "Give the user name.").max(200), password: SECRET }),
    z.object({ type: z.literal("header"), name: HEADER_NAME, value: SECRET }),
    z.object({
      type: z.literal("login"),
      loginUrl: z.string().trim().min(1, "Give the sign-in address.").max(500, "That sign-in address is too long."),
      username: z.string().trim().min(1, "Give the user name or email to sign in with.").max(200),
      password: SECRET,
      usernameField: FIELD.default("email"),
      passwordField: FIELD.default("password"),
      tokenPath: FIELD.default("token"),
      headerName: HEADER_NAME.default("Authorization"),
      headerPrefix: z
        .string()
        .max(40)
        .refine((s) => !/[\r\n]/.test(s), "The prefix must be on one line.")
        .default("Bearer "),
    }),
  ],
  { error: "Choose how the API signs in: none, bearer, basic, header or login." },
);
type AuthInput = z.infer<typeof AUTH>;

const HTTP = z.object({
  baseUrl: z.string().trim().min(1, "Give the API's address.").max(500, "That address is too long."),
  internal: z.boolean().default(false),
  auth: AUTH.default({ type: "none" }),
  allowedPaths: z.array(z.string().max(300, "That path is too long.")).max(50, "Allow at most 50 paths.").default([]),
});

const POSTGRES = z.object({
  connectionString: z.string().trim().max(2000, "That connection string is too long.").default(""),
  schemas: z.array(SCHEMA).min(1, "Give at least one schema, e.g. public.").max(20, "Give at most 20 schemas.").default(["public"]),
});

const NAME = z.string().trim().min(1, "Give the source a name.").max(60, "Use at most 60 characters for the name.");
const DESCRIPTION = z.string().trim().max(2000, "Use at most 2,000 characters to describe it.");

const ADD = z.object({
  name: NAME,
  description: DESCRIPTION.default(""),
  kind: z.enum(["http", "postgres"], { error: "Choose HTTP or Postgres." }),
  enabled: z.boolean().default(true),
  http: HTTP.optional(),
  postgres: POSTGRES.optional(),
});

const UPDATE = z.object({
  name: NAME.optional(),
  description: DESCRIPTION.optional(),
  enabled: z.boolean().optional(),
  http: HTTP.optional(),
  postgres: POSTGRES.optional(),
});

const TEST = z.object({ path: z.string().trim().max(2_000).optional() });

/** "Product API" → "ds-product-api", unique among `taken`. */
export function newSourceId(name: string, taken: Set<string>): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  if (slug.length < 2) slug = `${slug || "x"}-source`.replace(/^-/, "");
  for (let n = 1; n <= 50; n++) {
    const id = n === 1 ? `ds-${slug}` : `ds-${slug}-${n}`;
    if (!taken.has(id) && DATA_SOURCE_ID_RE.test(id)) return id;
  }
  return `ds-${randomBytes(4).toString("hex")}`;
}

type HttpSettings = NonNullable<DataSource["http"]>;
type StoredAuth = HttpSettings["auth"];

/** Where a credential is sent: the sign-in address's origin for a sign-in, the API's otherwise. */
function credentialTarget(baseUrl: string, auth: StoredAuth): string {
  try {
    return auth.type === "login" ? loginUrlOf({ baseUrl }, auth).origin : new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

const MOVED = "The address changed: enter the credential again (a saved one is only sent where it was sent before).";

/**
 * The stored auth for what the console sent. A credential left empty keeps
 * the saved one, when the auth type is the same and it would be sent to the
 * same origin. Returns the reason instead when one is missing.
 */
function buildAuth(input: AuthInput, baseUrl: string, current: HttpSettings | undefined): StoredAuth | string {
  const saved = current?.auth;
  /** The saved auth of the same type, when its credential may be reused for `next`. */
  const reusable = <T extends StoredAuth["type"]>(next: Extract<StoredAuth, { type: T }>): Extract<StoredAuth, { type: T }> | string | undefined => {
    if (!current || saved?.type !== next.type) return undefined;
    return credentialTarget(current.baseUrl, saved) === credentialTarget(baseUrl, next) ? (saved as Extract<StoredAuth, { type: T }>) : MOVED;
  };
  switch (input.type) {
    case "none":
      return { type: "none" };
    case "bearer": {
      if (input.token) return { type: "bearer", token: input.token };
      const kept = reusable({ type: "bearer", token: "" });
      return kept ?? "Paste the API token.";
    }
    case "basic": {
      const next = { type: "basic" as const, username: input.username, password: input.password };
      if (input.password) return next;
      const kept = reusable(next);
      return typeof kept === "object" ? { ...next, password: kept.password } : (kept ?? "Give the password.");
    }
    case "header": {
      const next = { type: "header" as const, name: input.name, value: input.value };
      if (input.value) return next;
      const kept = reusable(next);
      return typeof kept === "object" ? { ...next, value: kept.value } : (kept ?? `Give the value of the ${input.name} header.`);
    }
    case "login": {
      const next = { ...input };
      if (input.password) return next;
      const kept = reusable(next);
      return typeof kept === "object" ? { ...next, password: kept.password } : (kept ?? "Give the password to sign in with.");
    }
  }
}

/** A source's HTTP settings from the console's input, checked; the reason instead when they cannot be used. */
function buildHttp(input: z.infer<typeof HTTP>, current: DataSource["http"]): NonNullable<DataSource["http"]> | string {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const problem = baseUrlProblem(baseUrl, input.internal);
  if (problem) return problem;
  const allowedPaths: string[] = [];
  for (const raw of input.allowedPaths) {
    if (!raw.trim()) continue;
    const p = normalizeAllowedPath(raw);
    if ("error" in p) return p.error;
    if (!allowedPaths.includes(p.path)) allowedPaths.push(p.path);
  }
  if (input.auth.type === "login") {
    const loginProblem = loginUrlProblem(input.auth.loginUrl, input.internal);
    if (loginProblem) return `Sign-in address: ${loginProblem}`;
  }
  const auth = buildAuth(input.auth, baseUrl, current);
  if (typeof auth === "string") return auth;
  return { baseUrl, internal: input.internal, auth, allowedPaths };
}

/** A source's Postgres settings, checked; an empty connection string keeps the saved one. */
function buildPostgres(input: z.infer<typeof POSTGRES>, current: DataSource["postgres"]): NonNullable<DataSource["postgres"]> | string {
  const connectionString = input.connectionString || current?.connectionString || "";
  if (!connectionString) return "Paste the connection string.";
  try {
    pgConnection(connectionString);
  } catch (err) {
    return errorText(err);
  }
  return { connectionString, schemas: [...new Set(input.schemas)] };
}

const view = (c: Config, id: string) => publicView(c).dataSources.find((d) => d.id === id);

export function dataSourcesRoutes(deps: IntegrationRouteDeps): Router {
  const { configRepo, requireAdmin } = deps;
  const router = Router();

  const parse = <T extends z.ZodType>(schema: T, value: unknown, res: Response): z.infer<T> | undefined => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
      return undefined;
    }
    return parsed.data;
  };
  const idParam = (req: Request, res: Response): string | undefined => {
    const id = String(req.params.id ?? "");
    if (DATA_SOURCE_ID_RE.test(id)) return id;
    res.status(404).json({ error: "No such source." });
    return undefined;
  };
  /** Redacts every credential the configuration holds, those just entered, and the sign-in token. */
  const redactorFor = (config: Config, extra: DataSource[] = []) =>
    makeRedactor([...configSecrets(config), ...extra.flatMap((d) => [...sourceSecrets(d), ...loginSecrets(d.id)])]);

  router.get("/api/data-sources", requireAdmin, async (_req, res) => {
    res.json({ sources: publicView(await configRepo.load(true)).dataSources, max: MAX_DATA_SOURCES });
  });

  // Adds a source. Nothing is called here: Test does that.
  router.post("/api/data-sources", requireAdmin, async (req, res) => {
    const input = parse(ADD, req.body, res);
    if (!input) return;
    const config = await configRepo.load(true);
    if (config.dataSources.length >= MAX_DATA_SOURCES) return void res.status(400).json({ error: `At most ${MAX_DATA_SOURCES} sources can be added. Remove one first.` });
    let settings: Pick<DataSource, "http" | "postgres">;
    if (input.kind === "http") {
      if (!input.http) return void res.status(400).json({ error: "Give the API's address." });
      const http = buildHttp(input.http, undefined);
      if (typeof http === "string") return void res.status(400).json({ error: http });
      settings = { http };
    } else {
      if (!input.postgres) return void res.status(400).json({ error: "Paste the connection string." });
      const postgres = buildPostgres(input.postgres, undefined);
      if (typeof postgres === "string") return void res.status(400).json({ error: redactorFor(config)(postgres) });
      settings = { postgres };
    }
    const id = newSourceId(input.name, new Set(config.dataSources.map((d) => d.id)));
    const source = DataSourceSchema.parse({ id, name: input.name, description: input.description, kind: input.kind, enabled: input.enabled, ...settings });
    const updated = await configRepo.update((c) => {
      if (c.dataSources.length >= MAX_DATA_SOURCES) throw new Error(`At most ${MAX_DATA_SOURCES} sources can be added.`);
      c.dataSources.push(source);
    });
    res.json({ ok: true, source: view(updated, id) });
  });

  // Updates a source: its name, description, on/off, and its settings (an empty credential keeps the saved one).
  router.post("/api/data-sources/:id", requireAdmin, async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const input = parse(UPDATE, req.body, res);
    if (!input) return;
    const config = await configRepo.load(true);
    const current = config.dataSources.find((d) => d.id === id);
    if (!current) return void res.status(404).json({ error: "No such source." });
    let settings: Partial<Pick<DataSource, "http" | "postgres">> = {};
    if (input.http) {
      if (current.kind !== "http") return void res.status(400).json({ error: `${current.name} is a Postgres source.` });
      const http = buildHttp(input.http, current.http);
      if (typeof http === "string") return void res.status(400).json({ error: http });
      settings = { http };
    }
    if (input.postgres) {
      if (current.kind !== "postgres") return void res.status(400).json({ error: `${current.name} is an HTTP source.` });
      const postgres = buildPostgres(input.postgres, current.postgres);
      if (typeof postgres === "string") return void res.status(400).json({ error: redactorFor(config)(postgres) });
      settings = { postgres };
    }
    const changed = Boolean(settings.http || settings.postgres) && JSON.stringify(settings.http ?? settings.postgres) !== JSON.stringify(current.http ?? current.postgres);
    const updated = await configRepo.update((c) => {
      const d = c.dataSources.find((x) => x.id === id);
      if (!d) return;
      if (input.name !== undefined) d.name = input.name;
      if (input.description !== undefined) d.description = input.description;
      if (input.enabled !== undefined) d.enabled = input.enabled;
      if (settings.http) d.http = settings.http;
      if (settings.postgres) d.postgres = settings.postgres;
      // New settings have not been tested yet.
      if (changed) d.checkedAt = undefined;
    });
    if (changed) await forgetDataSource(id);
    res.json({ ok: true, source: view(updated, id) });
  });

  // Tries the saved source: a GET of `path` (default: its first allowed path, or /), or the connection,
  // its role and its tables. Answers a short preview, never a credential.
  router.post("/api/data-sources/:id/test", requireAdmin, async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const input = parse(TEST, req.body ?? {}, res);
    if (!input) return;
    const config = await configRepo.load(true);
    const source = config.dataSources.find((d) => d.id === id);
    if (!source) return void res.status(404).json({ error: "No such source." });
    const redact = () => redactorFor(config, [source]);
    try {
      let preview: string;
      let warnings: string[] = [];
      if (source.kind === "http") {
        const path = input.path || source.http?.allowedPaths[0] || "/";
        const r = await httpGet(source, path);
        if (r.status >= 400) {
          const detail = flat(r.contentType.includes("html") ? "" : r.text, 300);
          return void res.status(400).json({ error: redact()(`The API answered HTTP ${r.status} for ${r.path}${detail ? `: ${detail}` : "."}`) });
        }
        preview = formatHttpResult(r, DATA_LIMITS.previewChars);
      } else {
        ({ preview, warnings } = await testPostgres(source));
      }
      const checkedAt = new Date().toISOString();
      await configRepo.update((c) => {
        const d = c.dataSources.find((x) => x.id === id);
        if (d) d.checkedAt = checkedAt;
      });
      res.json({ ok: true, preview: cap(redact()(preview), DATA_LIMITS.previewChars), warnings: warnings.map((w) => redact()(w)), checkedAt });
    } catch (err) {
      const message = err instanceof DataSourceError ? err.message : `The test failed: ${errorText(err)}`;
      res.status(400).json({ error: cap(redact()(message), 600) });
    }
  });

  // Removes the source and forgets its connections and sign-in.
  router.post("/api/data-sources/:id/delete", requireAdmin, async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const config = await configRepo.load(true);
    if (!config.dataSources.some((d) => d.id === id)) return void res.status(404).json({ error: "No such source." });
    await configRepo.update((c) => {
      c.dataSources = c.dataSources.filter((d) => d.id !== id);
    });
    await forgetDataSource(id);
    res.json({ ok: true });
  });

  return router;
}
