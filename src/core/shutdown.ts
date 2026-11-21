import { constants } from "node:os";

/**
 * Stopping the web service on SIGTERM (every deploy on Render, Railway,
 * Fly.io, Cloud Run and Docker) or SIGINT. Platforms give a few seconds
 * before SIGKILL (Cloud Run and Docker 10, Render 30), so the service stops
 * taking work at once, lets the requests in flight finish within a short
 * grace period, gives the routines' lease up, and ends.
 */

/** How long requests in flight may take to finish: under the 10 s Cloud Run and Docker allow. */
export const SHUTDOWN_GRACE_MS = 8_000;

export interface ShutdownDeps {
  /** The HTTP server: closed to new connections; idle keep-alive ones are closed, open requests may finish. */
  server: { close(callback?: (err?: Error) => void): unknown; closeIdleConnections?(): void; closeAllConnections?(): void };
  /** Stop taking work: new requests are refused and no more workers start. */
  stopAccepting: () => void;
  /** Work to finish before ending, each within its own limit (the routines' lease: 3 s). */
  finish?: { run: () => Promise<unknown>; timeoutMs: number }[];
  graceMs?: number;
}

const within = (work: Promise<unknown>, ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void work.catch(() => undefined).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Stops taking work, then resolves once the requests in flight have finished
 * and `finish` is done, or after the grace period, whichever is first. Never
 * rejects. The caller ends the process (exitLikeSignal).
 */
export async function drain(deps: ShutdownDeps): Promise<void> {
  const graceMs = deps.graceMs ?? SHUTDOWN_GRACE_MS;
  deps.stopAccepting();
  const closed = new Promise<void>((resolve) => {
    try {
      deps.server.close(() => resolve());
    } catch {
      resolve();
    }
  });
  deps.server.closeIdleConnections?.();
  const finishing = (deps.finish ?? []).map((f) => within(Promise.resolve().then(f.run), f.timeoutMs));
  await within(Promise.all([closed, ...finishing]), graceMs);
  // Whatever is still open after the grace period is cut.
  deps.server.closeAllConnections?.();
}

/**
 * Ends the process as `signal` would have. Its listener is gone, so raising it
 * again takes the default action; but as PID 1 of a container (the image's
 * entrypoint execs the server) the kernel ignores a signal without a handler,
 * so the process then exits with the shell's code for it (143 for SIGTERM).
 */
export function exitLikeSignal(signal: NodeJS.Signals): void {
  const code = 128 + (constants.signals[signal] ?? constants.signals.SIGTERM);
  if (process.pid !== 1) {
    try {
      process.kill(process.pid, signal);
    } catch {
      // Exit below.
    }
  }
  // Reached as PID 1, or if the signal has not ended the process yet.
  setTimeout(() => process.exit(code), process.pid === 1 ? 0 : 100);
}
