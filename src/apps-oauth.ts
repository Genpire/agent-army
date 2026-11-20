/**
 * OAuth for apps whose MCP servers sign in with it (the MCP authorization
 * spec): discovery, client registration (a client metadata document,
 * dynamic registration, or a client the owner registered by hand), PKCE,
 * the code exchange and refreshes, all through the MCP SDK's auth() with a
 * provider backed by the app's config.apps[i].auth.oauth.
 *
 * The sign-in runs in the owner's browser: startAppSignIn returns the
 * vendor's authorization URL and keeps the PKCE verifier and a random state
 * (single-use, valid for 10 minutes); the vendor sends the browser back to
 * /api/apps/oauth/callback, and completeAppSignIn exchanges the code.
 * Access tokens are refreshed shortly before they expire (freshAccessToken);
 * when that fails for good the app needs signing in again.
 */
import { type OAuthClientProvider, type OAuthDiscoveryState, auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { type FetchLike, type LookupFn, AppUrlError, guardedFetch, privateAppUrlsAllowed } from "./apps-net.js";
import type { AppAuth, AppConnection, ConfigRepo } from "./config.js";
import { randomToken, safeEqual } from "./crypto.js";

export type AppOAuth = Extract<AppAuth, { type: "oauth" }>["oauth"];

export const OAUTH_CALLBACK_PATH = "/api/apps/oauth/callback";
/** This deployment's OAuth client metadata document (a client id that is a URL), for servers that accept one. */
export const OAUTH_CLIENT_METADATA_PATH = "/api/apps/oauth/client-metadata.json";
/** How long a started sign-in may take. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Chat refreshes an access token with less than this left. */
export const CHAT_TOKEN_MARGIN_MS = 2 * 60_000;

/**
 * Set in clientInformation when the owner entered the client (registered by
 * hand with the vendor): the SDK then never registers one dynamically, and
 * a refused client is reported instead of being replaced.
 */
export const OWNER_CLIENT_FLAG = "entered_by_owner";

/** The app's sign-in is gone or expired: the owner signs in again on the Integrations page. */
export class AppSignInError extends Error {}

/** Why a callback failed: "invalid" (unknown or used state), "expired", "denied" (no code: the vendor refused), "failed" (the exchange). */
export class SignInCallbackError extends Error {
  constructor(
    readonly reason: "invalid" | "expired" | "denied" | "failed",
    message: string,
    readonly appId?: string,
  ) {
    super(message);
  }
}

export interface OAuthDeps {
  configRepo: ConfigRepo;
  /** This deployment's public address, without a trailing slash. */
  baseUrl: string;
  /** Pointer's name, shown by the vendor on its consent screen. */
  clientName?: string;
  fetch?: FetchLike;
  lookup?: LookupFn;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export const oauthRedirectUrl = (baseUrl: string) => `${baseUrl}${OAUTH_CALLBACK_PATH}`;

/** A client id that is a URL needs an https address the vendor can fetch. */
const clientMetadataUrl = (baseUrl: string) => (baseUrl.startsWith("https://") ? `${baseUrl}${OAUTH_CLIENT_METADATA_PATH}` : undefined);

function clientMetadata(baseUrl: string, clientName: string): OAuthClientMetadata {
  return {
    client_name: clientName,
    redirect_uris: [oauthRedirectUrl(baseUrl)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // A public client with PKCE; a client registered by hand may carry a secret.
    token_endpoint_auth_method: "none",
  };
}

/** The document served at OAUTH_CLIENT_METADATA_PATH: its own address is the client id. */
export function clientMetadataDocument(baseUrl: string, clientName: string): OAuthClientMetadata & { client_id: string } {
  return { client_id: `${baseUrl}${OAUTH_CLIENT_METADATA_PATH}`, ...clientMetadata(baseUrl, clientName), client_uri: baseUrl };
}

type Mode = "start" | "callback" | "refresh";

/**
 * The MCP SDK's view of one app's OAuth state. It works on a copy (`data`)
 * that the caller saves once auth() is done. "start" hides the saved tokens
 * and discovery so a fresh sign-in begins; the other modes never start one
 * (they throw AppSignInError instead).
 */
class AppOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  readonly clientMetadataUrl: string | undefined;

  constructor(
    readonly data: AppOAuth,
    private readonly opts: { mode: Mode; baseUrl: string; clientName: string; appName: string; state?: string; now: () => number },
  ) {
    // Only a new sign-in registers this deployment as a client.
    this.clientMetadataUrl = opts.mode === "start" ? clientMetadataUrl(opts.baseUrl) : undefined;
  }

  get redirectUrl() {
    return oauthRedirectUrl(this.opts.baseUrl);
  }

  get clientMetadata() {
    return clientMetadata(this.opts.baseUrl, this.opts.clientName);
  }

  state() {
    return this.opts.state ?? randomToken(24);
  }

  clientInformation() {
    return this.data.clientInformation as OAuthClientInformationMixed | undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    this.data.clientInformation = { ...info };
  }

  tokens() {
    return this.opts.mode === "start" ? undefined : (this.data.tokens as OAuthTokens | undefined);
  }

  saveTokens(tokens: OAuthTokens) {
    this.data.tokens = { ...tokens };
    this.data.expiresAt = typeof tokens.expires_in === "number" ? this.opts.now() + tokens.expires_in * 1000 : undefined;
  }

  redirectToAuthorization(url: URL) {
    if (this.opts.mode !== "start") throw new AppSignInError(`${this.opts.appName}: the sign-in expired. Sign in again on the Integrations page.`);
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    if (this.opts.mode === "start") this.data.codeVerifier = verifier;
  }

  codeVerifier() {
    if (!this.data.codeVerifier) throw new AppSignInError(`${this.opts.appName}: the sign-in was not started here. Start it again.`);
    return this.data.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const ownersClient = this.data.clientInformation?.[OWNER_CLIENT_FLAG] === true;
    if ((scope === "all" || scope === "client") && !ownersClient) this.data.clientInformation = undefined;
    if (scope === "all" || scope === "tokens") {
      this.data.tokens = undefined;
      this.data.expiresAt = undefined;
    }
    if (scope === "all" || scope === "verifier") this.data.codeVerifier = undefined;
    if (scope === "all" || scope === "discovery") this.data.serverMetadata = undefined;
  }

  discoveryState() {
    return this.opts.mode === "start" ? undefined : (this.data.serverMetadata as OAuthDiscoveryState | undefined);
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.data.serverMetadata = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  }
}

/** Replaces an app's OAuth state, when it still exists and still signs in with OAuth. `next` returning undefined changes nothing. */
async function saveOAuth(configRepo: ConfigRepo, appId: string, next: (current: AppOAuth) => AppOAuth | undefined): Promise<void> {
  await configRepo.update((c) => {
    const app = c.apps.find((a) => a.id === appId);
    if (app?.auth.type !== "oauth") return;
    const value = next(app.auth.oauth);
    if (value) app.auth.oauth = value;
  });
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What went wrong with a sign-in, in the owner's words. */
function signInProblem(app: Pick<AppConnection, "name">, err: unknown, baseUrl: string): string {
  const message = messageOf(err);
  if (err instanceof AppUrlError || err instanceof AppSignInError) return message;
  if (err instanceof InvalidClientError || err instanceof UnauthorizedClientError) {
    return `${app.name} refused the client ID${message ? ` (${message})` : ""}. Check the client ID and secret, and that the OAuth app allows ${oauthRedirectUrl(baseUrl)}.`.slice(0, 500);
  }
  if (/dynamic client registration/i.test(message)) {
    return `${app.name} does not register clients automatically. Register an OAuth app with ${app.name} that redirects to ${oauthRedirectUrl(baseUrl)}, then enter its client ID and secret here.`;
  }
  if (/abort|timeout/i.test(message)) return `${app.name} did not answer in time. Try again.`;
  return `The sign-in with ${app.name} failed: ${message}`.slice(0, 500);
}

async function oauthApp(configRepo: ConfigRepo, appId: string) {
  const app = (await configRepo.load(true)).apps.find((a) => a.id === appId);
  if (!app) throw new Error("That app is not connected.");
  if (app.auth.type !== "oauth") throw new Error(`${app.name} does not sign in with OAuth.`);
  return { app, oauth: app.auth.oauth };
}

/** A stored state is "<random>:<started at, ms>". */
const STATE_RE = /^([A-Za-z0-9_-]{20,100}):(\d{10,16})$/;
const parseState = (stored: string | undefined) => {
  const m = stored?.match(STATE_RE);
  return m ? { random: m[1]!, startedAt: Number(m[2]) } : undefined;
};

/**
 * Starts a sign-in: discovers the app's authorization server, registers this
 * deployment as a client when needed, and returns the URL to open. The app's
 * current tokens stay in use until the sign-in completes.
 */
export async function startAppSignIn(appId: string, deps: OAuthDeps): Promise<string> {
  const now = deps.now ?? Date.now;
  const { app, oauth } = await oauthApp(deps.configRepo, appId);
  const data = structuredClone(oauth);
  const state = randomToken(24);
  const provider = new AppOAuthProvider(data, { mode: "start", baseUrl: deps.baseUrl, clientName: deps.clientName ?? "Pointer", appName: app.name, state, now });
  try {
    await auth(provider, { serverUrl: app.url, fetchFn: guardedFetch(deps) });
  } catch (err) {
    throw new Error(signInProblem(app, err, deps.baseUrl));
  }
  const url = provider.authorizationUrl;
  if (!url) throw new Error(`${app.name} did not ask for a sign-in.`);
  if (url.protocol !== "https:" && !privateAppUrlsAllowed(deps.env)) throw new Error(`${app.name}'s sign-in page is not on an https:// address.`);
  // Only what the start changed, onto the app as it is now (an admin may have edited it meanwhile).
  await saveOAuth(deps.configRepo, appId, (current) => ({
    ...current,
    clientInformation: data.clientInformation,
    serverMetadata: data.serverMetadata,
    codeVerifier: data.codeVerifier,
    state: `${state}:${now()}`,
  }));
  return url.href;
}

/**
 * Completes a sign-in from the vendor's redirect: finds the app by its state
 * (compared in constant time), uses the state once, and exchanges the code
 * for tokens. Without a code (the vendor reported an error) the state is
 * used up all the same. Returns the app's id; throws SignInCallbackError
 * with the reason (and the app's id when it is known).
 */
export async function completeAppSignIn(input: { state: string; code?: string }, deps: OAuthDeps): Promise<{ appId: string }> {
  const now = deps.now ?? Date.now;
  const config = await deps.configRepo.load(true);
  const match = config.apps.find((a) => {
    const stored = a.auth.type === "oauth" ? parseState(a.auth.oauth.state) : undefined;
    return Boolean(stored && safeEqual(stored.random, input.state));
  });
  if (match?.auth.type !== "oauth") throw new SignInCallbackError("invalid", "This sign-in link is not valid or was already used. Start the sign-in again.");
  const appId = match.id;
  const { codeVerifier, state, ...rest } = match.auth.oauth;
  const startedAt = parseState(state)?.startedAt ?? 0;
  // Single use: the state and the verifier are cleared before anything else happens.
  await saveOAuth(deps.configRepo, appId, (current) => ({ ...current, state: undefined, codeVerifier: undefined }));
  if (now() - startedAt > OAUTH_STATE_TTL_MS) throw new SignInCallbackError("expired", "The sign-in took too long. Start it again.", appId);
  if (!input.code) throw new SignInCallbackError("denied", `${match.name} did not complete the sign-in.`, appId);

  const provider = new AppOAuthProvider(
    { ...structuredClone(rest), codeVerifier },
    { mode: "callback", baseUrl: deps.baseUrl, clientName: deps.clientName ?? "Pointer", appName: match.name, now },
  );
  try {
    await auth(provider, { serverUrl: match.url, authorizationCode: input.code, fetchFn: guardedFetch(deps) });
  } catch (err) {
    throw new SignInCallbackError("failed", signInProblem(match, err, deps.baseUrl), appId);
  }
  if (!provider.data.tokens) throw new SignInCallbackError("failed", `${match.name} sent no tokens.`, appId);
  const signedIn = provider.data;
  await saveOAuth(deps.configRepo, appId, (current) => ({ ...current, ...issued(signedIn, current), codeVerifier: undefined, state: undefined }));
  return { appId };
}

/** What a token exchange or refresh changed: the tokens, and the client and discovery the SDK may have stamped. */
const issued = (data: AppOAuth, current: AppOAuth): Partial<AppOAuth> => ({
  tokens: data.tokens,
  expiresAt: data.expiresAt,
  clientInformation: data.clientInformation ?? current.clientInformation,
  serverMetadata: data.serverMetadata ?? current.serverMetadata,
});

// Refreshes run one at a time in this process (the web service; repo tasks never refresh), and one per app:
// a second refresh with the same refresh token could be refused, and a provider that rotates them may revoke the grant.
const refreshing = new Map<string, Promise<string>>();
let refreshQueue: Promise<unknown> = Promise.resolve();

const accessTokenOf = (oauth: AppOAuth) => (typeof oauth.tokens?.access_token === "string" ? oauth.tokens.access_token : undefined);
const refreshTokenOf = (oauth: AppOAuth) => (typeof oauth.tokens?.refresh_token === "string" ? oauth.tokens.refresh_token : undefined);

export type FreshTokenDeps = Omit<OAuthDeps, "configRepo" | "baseUrl"> & {
  /** Where a refreshed token is kept; without it the stored token is used while it is valid. */
  configRepo?: ConfigRepo;
  baseUrl?: string;
  /** Refresh when the token expires within this. */
  marginMs?: number;
};

/**
 * The app's access token, refreshed first when it expires within `marginMs`.
 * Throws AppSignInError when the app must be signed in again.
 */
export async function freshAccessToken(app: AppConnection, deps: FreshTokenDeps = {}): Promise<string> {
  if (app.auth.type !== "oauth") throw new Error(`${app.name} does not sign in with OAuth.`);
  const now = deps.now ?? Date.now;
  const margin = deps.marginMs ?? CHAT_TOKEN_MARGIN_MS;
  const oauth = app.auth.oauth;
  const token = accessTokenOf(oauth);
  if (!token) throw new AppSignInError(`${app.name} is not signed in. Sign in on the Integrations page.`);
  const expiresAt = oauth.expiresAt;
  if (expiresAt === undefined || expiresAt - now() > margin) return token;
  if (!refreshTokenOf(oauth) || !deps.configRepo) {
    if (expiresAt <= now()) throw new AppSignInError(`${app.name}: the sign-in expired. Sign in again on the Integrations page.`);
    return token;
  }
  const running = refreshing.get(app.id);
  if (running) return running;
  const configRepo = deps.configRepo;
  const run = refreshQueue.then(() => refresh(app, { ...deps, configRepo, now, margin })).finally(() => refreshing.delete(app.id));
  refreshQueue = run.catch(() => undefined);
  refreshing.set(app.id, run);
  return run;
}

async function refresh(app: AppConnection, deps: FreshTokenDeps & { configRepo: ConfigRepo; now: () => number; margin: number }): Promise<string> {
  // Another process (the web service, a repo task) may have refreshed it already.
  const { oauth: latest } = await oauthApp(deps.configRepo, app.id);
  const latestToken = accessTokenOf(latest);
  if (latestToken && latest.expiresAt !== undefined && latest.expiresAt - deps.now() > deps.margin) return latestToken;
  const tried = refreshTokenOf(latest);
  if (!tried) throw new AppSignInError(`${app.name}: the sign-in expired. Sign in again on the Integrations page.`);
  // A client bound to another authorization server than the one discovered would make the SDK register
  // a new client; a refresh never does that: it asks for a new sign-in instead.
  const boundTo = latest.clientInformation?.issuer;
  const discovered = latest.serverMetadata?.authorizationServerUrl;
  if (!latest.clientInformation || (typeof boundTo === "string" && typeof discovered === "string" && boundTo !== discovered)) {
    throw new AppSignInError(`${app.name}: the sign-in must be renewed. Sign in again on the Integrations page.`);
  }

  // The redirect address is not used by a refresh; a placeholder keeps the provider interactive-shaped.
  const provider = new AppOAuthProvider(structuredClone(latest), {
    mode: "refresh",
    baseUrl: deps.baseUrl ?? "https://localhost",
    clientName: deps.clientName ?? "Pointer",
    appName: app.name,
    now: deps.now,
  });
  let failure: unknown;
  try {
    await auth(provider, { serverUrl: app.url, fetchFn: guardedFetch(deps) });
  } catch (err) {
    failure = err;
  }
  const refreshed = accessTokenOf(provider.data);
  if (!failure && refreshed) {
    // Only the tokens, onto the app as it is now; not over a new sign-in made meanwhile.
    const renewed = provider.data;
    await saveOAuth(deps.configRepo, app.id, (current) => (refreshTokenOf(current) === tried ? { ...current, ...issued(renewed, current) } : undefined));
    return refreshed;
  }
  if (!provider.data.tokens || failure instanceof InvalidGrantError) {
    // The refresh token was refused: forget the tokens, unless another process refreshed meanwhile.
    await saveOAuth(deps.configRepo, app.id, (current) =>
      refreshTokenOf(current) === tried ? { ...current, tokens: undefined, expiresAt: undefined } : undefined,
    );
  }
  if (failure instanceof AppSignInError) throw failure;
  throw new AppSignInError(`${app.name}: the sign-in could not be renewed (${messageOf(failure ?? "no token")}). Sign in again on the Integrations page.`.slice(0, 400));
}
