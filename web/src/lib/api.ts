/**
 * The admin API client. Every route answers JSON; errors are `{ error }` with
 * a 4xx status. A 401 means the session ended: listeners (the app) go back to
 * the sign-in screen.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Called whenever the server answers 401 (signed out or the session expired). */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) {
    if (res.status === 401) unauthorizedListeners.forEach((l) => l());
    const message = typeof data.error === "string" && data.error ? data.error : `The server answered ${res.status}.`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T = { ok: true }>(path: string, body: unknown = {}) => request<T>("POST", path, body),
};

/** The message to show for any error thrown by an API call or a handler. */
export const errorMessage = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : "Something went wrong. Try again.";
