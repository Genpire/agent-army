/**
 * The deployment's public address: where Slack, GitHub, GitLab, Bitbucket,
 * Jira and monday.com send their webhooks, and what links back to the console
 * start with. PUBLIC_URL wins; otherwise the hosting platform's own variables
 * name it (each platform documents its variable); otherwise the web service
 * takes it from each request (Cloud Run, ECS, a VM: deploy/gcp.sh and the
 * installers set PUBLIC_URL there).
 *
 * With a custom domain the platform variable still names the platform's own
 * address, which keeps working; set PUBLIC_URL to use the custom one.
 */

/**
 * The origin of an http(s) address without a path, query, fragment or
 * credentials ("https://army.example.com", "http://localhost:8080"); a
 * trailing slash is fine. Undefined for anything else, empty included.
 */
export function publicOrigin(value: string | undefined): string | undefined {
  const text = value?.trim().replace(/\/+$/, "");
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url.origin;
}

/** A host name some platforms give without a scheme ("my-app.up.railway.app"): served over HTTPS. */
const fromHost = (host: string | undefined): string | undefined => {
  const text = host?.trim();
  if (!text) return undefined;
  return publicOrigin(/^https?:\/\//i.test(text) ? text : `https://${text}`);
};

/** Where each platform says its public address is, in order. */
const SOURCES: { name: string; url: (env: NodeJS.ProcessEnv) => string | undefined }[] = [
  { name: "PUBLIC_URL", url: (env) => publicOrigin(env.PUBLIC_URL) },
  // Render: the full URL, https://my-app.onrender.com.
  { name: "RENDER_EXTERNAL_URL", url: (env) => publicOrigin(env.RENDER_EXTERNAL_URL) },
  // Railway: the host only, when the service has a public domain.
  { name: "RAILWAY_PUBLIC_DOMAIN", url: (env) => fromHost(env.RAILWAY_PUBLIC_DOMAIN) },
  // Fly.io: every app is served at <app>.fly.dev.
  { name: "FLY_APP_NAME", url: (env) => (env.FLY_APP_NAME?.trim() ? fromHost(`${env.FLY_APP_NAME.trim()}.fly.dev`) : undefined) },
  // Koyeb: the host only.
  { name: "KOYEB_PUBLIC_DOMAIN", url: (env) => fromHost(env.KOYEB_PUBLIC_DOMAIN) },
  // Azure Container Apps: <app>.<environment's DNS suffix>.
  {
    name: "CONTAINER_APP_NAME",
    url: (env) => {
      const app = env.CONTAINER_APP_NAME?.trim();
      const suffix = env.CONTAINER_APP_ENV_DNS_SUFFIX?.trim();
      return app && suffix ? fromHost(`${app}.${suffix}`) : undefined;
    },
  },
];

/**
 * The deployment's public address from PUBLIC_URL or the platform's
 * variables, as an origin without a trailing slash; undefined when none is
 * set (or none is a valid address): use the request's own address then.
 */
export function detectPublicUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const source of SOURCES) {
    const url = source.url(env);
    if (url) return url;
  }
  return undefined;
}

/** A line for the log when PUBLIC_URL is set but is not an address Agent Army can use; undefined when it is fine or unset. */
export function publicUrlWarning(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.PUBLIC_URL?.trim() || publicOrigin(env.PUBLIC_URL)) return undefined;
  const used = detectPublicUrl(env);
  return (
    "PUBLIC_URL is not an http(s) address without a path (like https://army.example.com), so it is ignored; " +
    (used ? `using ${used} instead.` : "each request's own address is used instead.")
  );
}
