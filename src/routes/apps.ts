/**
 * Apps admin routes (/api/apps/…): the curated catalog and a search of the
 * MCP Registry; add an app (from the catalog or custom), update it, re-list
 * its tools, sign in with OAuth, remove it. The OAuth callback is reached by
 * the browser coming back from the vendor's sign-in: it has no session
 * cookie (SameSite=Strict) and is protected by the single-use state instead.
 * The client metadata document is public: vendors fetch it to identify this
 * deployment.
 */
import { randomBytes } from "node:crypto";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { APP_CATALOG, APP_CATEGORIES, catalogApp } from "../apps-catalog.js";
import { appUrlProblem, assertPublicUrl } from "../apps-net.js";
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_CLIENT_METADATA_PATH,
  OWNER_CLIENT_FLAG,
  type OAuthDeps,
  SignInCallbackError,
  clientMetadataDocument,
  completeAppSignIn,
  oauthRedirectUrl,
  startAppSignIn,
} from "../apps-oauth.js";
import { REGISTRY_MIN_QUERY, searchRegistry } from "../apps-registry.js";
import { listAppTools, removeApp, setAppAgents } from "../apps.js";
import { APP_HEADER_RE, APP_ID_RE, type AppAuth, type AppConnection, AppConnectionSchema, type Config, MAX_APPS, publicView } from "../config.js";
import { configSecrets, makeRedactor } from "../worker.js";
import type { IntegrationRouteDeps } from "./types.js";

const HEADER_NAME = z.string().regex(APP_HEADER_RE, "Header names use letters, digits and dashes.");

/**
 * Credentials as the console sends them. An empty key or header value keeps
 * the saved one (on update); OAuth takes an optional client registered by
 * hand with the vendor.
 */
const AUTH_INPUT = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("bearer"), token: z.string().trim().max(10_000) }),
    z.object({
      type: z.literal("headers"),
      headers: z.record(HEADER_NAME, z.string().trim().max(10_000)).refine((h) => Object.keys(h).length >= 1 && Object.keys(h).length <= 10, "Give between 1 and 10 headers."),
    }),
    z.object({
      type: z.literal("oauth"),
      clientId: z
        .string()
        .trim()
        .max(500)
        // A browser's autofill puts the owner's email here; no OAuth client id looks like one.
        .refine((id) => !/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(id), "That is an email address, not a client ID. Copy the client ID from the OAuth app you registered.")
        .optional(),
      clientSecret: z.string().trim().max(2000).optional(),
      /** Forget the owner's own OAuth client (and its sign-in): the next sign-in registers automatically. */
      automatic: z.literal(true).optional(),
    }),
  ],
  { error: "Choose how the app signs in: none, bearer, headers or oauth." },
);
type AuthInput = z.infer<typeof AUTH_INPUT>;

const AGENT_IDS = z.array(z.string().max(31)).max(30, "A team has at most 30 agents.");

const ADD = z.object({
  presetId: z.string().max(60).optional(),
  name: z.string().trim().min(1, "Give the app a name.").max(60, "Use at most 60 characters for the name."),
  url: z.string().trim().min(1, "Give the MCP server's address.").max(500, "That address is too long."),
  transport: z.enum(["http", "sse"]).default("http"),
  auth: AUTH_INPUT,
  access: z.enum(["read", "write"]).default("read"),
  agentIds: AGENT_IDS.default([]),
});

const UPDATE = z.object({
  name: z.string().trim().min(1, "Give the app a name.").max(60, "Use at most 60 characters for the name.").optional(),
  access: z.enum(["read", "write"]).optional(),
  disabledTools: z.array(z.string().max(128)).max(500).optional(),
  agentIds: AGENT_IDS.optional(),
  enabled: z.boolean().optional(),
  auth: AUTH_INPUT.optional(),
});

const CALLBACK = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(4000).optional(),
  error: z.string().max(200).optional(),
});

/** "Linear" → "app-linear", unique among `taken`. */
export function newAppId(name: string, taken: Set<string>): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  if (slug.length < 2) slug = `${slug || "x"}-app`.replace(/^-/, "");
  for (let n = 1; ; n++) {
    const id = n === 1 ? `app-${slug}` : `app-${slug}-${n}`;
    if (!taken.has(id) && APP_ID_RE.test(id)) return id;
    if (n > 50) return `app-${randomBytes(4).toString("hex")}`;
  }
}

/** Every credential a stored or new auth carries, for redaction. */
function authSecrets(auth: AppAuth | undefined): string[] {
  if (!auth) return [];
  if (auth.type === "bearer") return [auth.token];
  if (auth.type === "headers") return Object.values(auth.headers);
  if (auth.type === "oauth") {
    const secret = auth.oauth.clientInformation?.client_secret;
    return typeof secret === "string" ? [secret] : [];
  }
  return [];
}

/**
 * The stored auth for what the console sent, keeping saved secrets where it
 * sent none. Returns the reason instead when something is missing.
 */
function buildAuth(input: AuthInput, current: AppAuth | undefined): AppAuth | string {
  switch (input.type) {
    case "none":
      return { type: "none" };
    case "bearer": {
      if (input.token) return { type: "bearer", token: input.token };
      return current?.type === "bearer" ? current : "Paste the API key.";
    }
    case "headers": {
      const saved = current?.type === "headers" ? current.headers : {};
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.headers)) {
        const kept = value || saved[name];
        if (!kept) return `Fill in the ${name} header.`;
        headers[name] = kept;
      }
      return { type: "headers", headers };
    }
    case "oauth": {
      const previous = current?.type === "oauth" ? current.oauth : {};
      if (input.automatic) return { type: "oauth", oauth: {} };
      if (!input.clientId) return { type: "oauth", oauth: previous };
      const savedSecret = previous.clientInformation?.client_id === input.clientId ? previous.clientInformation.client_secret : undefined;
      const secret = input.clientSecret || (typeof savedSecret === "string" ? savedSecret : undefined);
      const sameClient = previous.clientInformation?.client_id === input.clientId && secret === savedSecret;
      // A new client starts a new sign-in: tokens issued to the old client are dropped.
      return {
        type: "oauth",
        oauth: sameClient
          ? previous
          : { clientInformation: { client_id: input.clientId, ...(secret ? { client_secret: secret } : {}), [OWNER_CLIENT_FLAG]: true } },
      };
    }
  }
}

const sameAuth = (a: AppAuth, b: AppAuth) => JSON.stringify(a) === JSON.stringify(b);
const skipValidation = () => process.env.SKIP_VALIDATION === "1";
const appView = (c: Config, id: string) => publicView(c).apps.find((a) => a.id === id);

export function appsRoutes(deps: IntegrationRouteDeps): Router {
  const { configRepo, requireAdmin } = deps;
  const router = Router();

  const oauthDeps = (req: Request, config: Config): OAuthDeps => ({ configRepo, baseUrl: deps.baseUrl(req), clientName: config.team.pointer.name });
  const fail = (res: Response, config: Config, err: unknown, extra: string[] = [], status = 400) => {
    const redact = makeRedactor([...configSecrets(config), ...extra]);
    res.status(status).json({ error: redact(err instanceof Error ? err.message : String(err)).slice(0, 600) });
  };
  const parse = <T extends z.ZodType>(schema: T, value: unknown, res: Response): z.infer<T> | undefined => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
      return undefined;
    }
    return parsed.data;
  };
  const appParam = (req: Request, res: Response): string | undefined => {
    const id = String(req.params.id ?? "");
    if (APP_ID_RE.test(id)) return id;
    res.status(404).json({ error: "No such app." });
    return undefined;
  };
  const unknownAgent = (config: Config, ids: string[]) => ids.find((id) => !config.team.agents.some((a) => a.id === id));

  // ---------- Catalog and registry: static data and a cached search; nothing here calls a vendor ----------

  router.get("/api/apps/catalog", requireAdmin, (req, res) => {
    res.set("Cache-Control", "private, max-age=3600");
    res.json({ apps: APP_CATALOG, categories: APP_CATEGORIES, redirectUrl: oauthRedirectUrl(deps.baseUrl(req)) });
  });

  router.get("/api/apps/registry", requireAdmin, async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    if (search.length < REGISTRY_MIN_QUERY) return void res.json({ apps: [] });
    try {
      const apps = await searchRegistry(search);
      res.set("Cache-Control", "private, max-age=600");
      res.json({ apps });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Couldn't search the MCP Registry." });
    }
  });

  // ---------- OAuth: the client metadata document and the vendor's redirect back ----------

  router.get(OAUTH_CLIENT_METADATA_PATH, async (req, res) => {
    const config = await configRepo.load();
    res.set("Cache-Control", "public, max-age=300");
    res.json(clientMetadataDocument(deps.baseUrl(req), config.team.pointer.name));
  });

  // Not behind the shared throttle (10 tries per 10 minutes, with sign-ins to the console): an owner
  // connecting several apps in a row would hit it, and the state it checks (24 random bytes, single use,
  // 10 minutes) cannot be guessed.
  router.get(OAUTH_CALLBACK_PATH, async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    const back = (appId: string | undefined, flags: string) =>
      res.redirect(303, `/#/integrations/apps${appId && APP_ID_RE.test(appId) ? `/${appId}` : ""}?${flags}`);
    const q = CALLBACK.safeParse(req.query);
    const config = await configRepo.load(true);
    const redact = makeRedactor(configSecrets(config));
    if (!q.success || !q.data.state) return back(undefined, "signin=error&reason=invalid");
    const { state, code, error } = q.data;
    try {
      // A refusal (or any error) comes instead of a code: the state is used up all the same.
      const { appId } = await completeAppSignIn({ state, ...(code && !error ? { code } : {}) }, oauthDeps(req, config));
      // Signed in: list the tools right away, so the app is ready to use.
      const fresh = await configRepo.load(true);
      const app = fresh.apps.find((a) => a.id === appId);
      let checked = true;
      if (app && !skipValidation()) {
        try {
          const tools = await listAppTools(app, { configRepo, baseUrl: deps.baseUrl(req) });
          await configRepo.update((c) => {
            const target = c.apps.find((a) => a.id === appId);
            if (target) Object.assign(target, { tools, checkedAt: new Date().toISOString() });
          });
        } catch (err) {
          checked = false;
          console.warn(`[apps] ${app.name}: listing tools after sign-in failed:`, redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
        }
      }
      back(appId, checked ? "signin=ok" : "signin=ok&check=failed");
    } catch (err) {
      const reason = err instanceof SignInCallbackError ? err.reason : "failed";
      console.warn("[apps] sign-in callback failed:", redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
      back(err instanceof SignInCallbackError ? err.appId : undefined, `signin=error&reason=${reason}`);
    }
  });

  // ---------- Admin ----------

  // Adds an app. Its tools are listed first (unless SKIP_VALIDATION=1), except for OAuth apps,
  // which answer with the sign-in address instead: their tools are listed after the sign-in.
  router.post("/api/apps", requireAdmin, async (req, res) => {
    const input = parse(ADD, req.body, res);
    if (!input) return;
    const config = await configRepo.load(true);
    if (config.apps.length >= MAX_APPS) return void res.status(400).json({ error: `At most ${MAX_APPS} apps can be connected. Remove one first.` });
    if (input.presetId && !catalogApp(input.presetId)) return void res.status(400).json({ error: "That app is not in the catalog." });
    if (input.url.includes("{")) return void res.status(400).json({ error: "Replace the {placeholder} in the address first." });
    const urlProblem = appUrlProblem(input.url);
    if (urlProblem) return void res.status(400).json({ error: urlProblem });
    const agentProblem = unknownAgent(config, input.agentIds);
    if (agentProblem) return void res.status(400).json({ error: `There is no agent "${agentProblem}" on the team.` });
    const auth = buildAuth(input.auth, undefined);
    if (typeof auth === "string") return void res.status(400).json({ error: auth });
    const secrets = authSecrets(auth);

    const id = newAppId(input.name, new Set(config.apps.map((a) => a.id)));
    const app: AppConnection = AppConnectionSchema.parse({
      id,
      name: input.name,
      ...(input.presetId ? { presetId: input.presetId } : {}),
      url: input.url,
      transport: input.transport,
      auth,
      access: input.access,
    });
    try {
      await assertPublicUrl(app.url);
      if (auth.type !== "oauth" && !skipValidation()) {
        app.tools = await listAppTools(app);
        app.checkedAt = new Date().toISOString();
      }
    } catch (err) {
      return fail(res, config, err, secrets);
    }

    await configRepo.update((c) => {
      if (c.apps.length >= MAX_APPS) throw new Error(`At most ${MAX_APPS} apps can be connected.`);
      c.apps.push(app);
      setAppAgents(c, id, input.agentIds);
    });
    let signInUrl: string | undefined;
    if (auth.type === "oauth") {
      try {
        signInUrl = await startAppSignIn(id, oauthDeps(req, config));
      } catch (err) {
        // Nothing half-added: the owner fixes the input (e.g. a client ID) and adds again.
        await configRepo.update((c) => removeApp(c, id));
        return fail(res, config, err, secrets);
      }
    }
    res.json({ ok: true, app: appView(await configRepo.load(true), id), ...(signInUrl ? { signInUrl } : {}) });
  });

  // Updates an app: name, access, disabled tools, agents, on/off, credentials. New credentials
  // (a key or headers) are checked by listing the tools again, unless SKIP_VALIDATION=1.
  router.post("/api/apps/:id", requireAdmin, async (req, res) => {
    const id = appParam(req, res);
    if (!id) return;
    const input = parse(UPDATE, req.body, res);
    if (!input) return;
    const config = await configRepo.load(true);
    const current = config.apps.find((a) => a.id === id);
    if (!current) return void res.status(404).json({ error: "No such app." });
    if (input.agentIds) {
      const agentProblem = unknownAgent(config, input.agentIds);
      if (agentProblem) return void res.status(400).json({ error: `There is no agent "${agentProblem}" on the team.` });
    }
    const auth = input.auth ? buildAuth(input.auth, current.auth) : current.auth;
    if (typeof auth === "string") return void res.status(400).json({ error: auth });
    const secrets = authSecrets(auth);
    const changed = !sameAuth(auth, current.auth);

    let tools: Pick<AppConnection, "tools" | "checkedAt"> | undefined;
    if (changed && auth.type !== "oauth" && !skipValidation()) {
      try {
        tools = { tools: await listAppTools({ ...current, auth }), checkedAt: new Date().toISOString() };
      } catch (err) {
        return fail(res, config, err, secrets);
      }
    }
    const updated = await configRepo.update((c) => {
      const app = c.apps.find((a) => a.id === id);
      if (!app) return;
      if (input.name !== undefined) app.name = input.name;
      if (input.access !== undefined) app.access = input.access;
      if (input.disabledTools !== undefined) app.disabledTools = [...new Set(input.disabledTools)];
      if (input.enabled !== undefined) app.enabled = input.enabled;
      if (changed) app.auth = auth;
      if (tools) Object.assign(app, tools);
      if (input.agentIds) setAppAgents(c, id, input.agentIds);
    });
    res.json({ ok: true, app: appView(updated, id) });
  });

  // Lists the app's tools again and keeps them (disabled tools stay disabled).
  router.post("/api/apps/:id/check", requireAdmin, async (req, res) => {
    const id = appParam(req, res);
    if (!id) return;
    const config = await configRepo.load(true);
    const app = config.apps.find((a) => a.id === id);
    if (!app) return void res.status(404).json({ error: "No such app." });
    let tools;
    try {
      tools = await listAppTools(app, { configRepo, baseUrl: deps.baseUrl(req) });
    } catch (err) {
      return fail(res, await configRepo.load(true), err);
    }
    const updated = await configRepo.update((c) => {
      const target = c.apps.find((a) => a.id === id);
      if (target) Object.assign(target, { tools, checkedAt: new Date().toISOString() });
    });
    res.json({ ok: true, app: appView(updated, id) });
  });

  // Starts (or restarts) the OAuth sign-in: the browser opens the returned address.
  router.post("/api/apps/:id/oauth/start", requireAdmin, async (req, res) => {
    const id = appParam(req, res);
    if (!id) return;
    const config = await configRepo.load(true);
    if (!config.apps.some((a) => a.id === id)) return void res.status(404).json({ error: "No such app." });
    try {
      res.json({ url: await startAppSignIn(id, oauthDeps(req, config)) });
    } catch (err) {
      fail(res, config, err);
    }
  });

  // Removes the app and takes it off every agent.
  router.post("/api/apps/:id/delete", requireAdmin, async (req, res) => {
    const id = appParam(req, res);
    if (!id) return;
    const config = await configRepo.load(true);
    if (!config.apps.some((a) => a.id === id)) return void res.status(404).json({ error: "No such app." });
    await configRepo.update((c) => removeApp(c, id));
    res.json({ ok: true });
  });

  return router;
}
