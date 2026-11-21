// Waiting for a new deployment to answer GET /healthz with "ok".

/** @typedef {(url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean, text(): Promise<string> }>} FetchLike */

/** @param {string} url */
export const healthUrl = (url) => `${url.replace(/\/+$/, "")}/healthz`;

/**
 * Polls <url>/healthz until it answers "ok" or the time is up.
 * @param {string} url
 * @param {{
 *   timeoutMs: number,
 *   intervalMs?: number,
 *   fetch?: FetchLike,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   onWaiting?: (elapsedMs: number) => void,
 * }} options
 * @returns {Promise<boolean>}
 */
export async function waitForHealthy(url, options) {
  const fetchImpl = options.fetch ?? /** @type {FetchLike} */ (globalThis.fetch);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? 5_000;
  const start = now();
  let lastReport = start;
  for (;;) {
    try {
      const res = await fetchImpl(healthUrl(url), { signal: AbortSignal.timeout(10_000) });
      if (res.ok && (await res.text()).trim() === "ok") return true;
    } catch {
      // not up yet (DNS, TLS certificate, connection refused, 502 from the proxy...)
    }
    const elapsed = now() - start;
    if (elapsed >= options.timeoutMs) return false;
    if (now() - lastReport >= 30_000) {
      lastReport = now();
      options.onWaiting?.(elapsed);
    }
    await sleep(interval);
  }
}
