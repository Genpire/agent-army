import { useToast } from "@astryxdesign/core/Toast";
import { useCallback, useState } from "react";
import { errorMessage } from "./api";

/**
 * Runs an async action (usually an API call) with a pending flag and a toast:
 * an error toast with the server's message on failure, `success` as an info
 * toast when given. Returns whether it succeeded, so callers can close a
 * drawer or reset a form only then.
 */
export function useAction() {
  const showToast = useToast();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (action: () => Promise<unknown>, opts: { success?: string } = {}): Promise<boolean> => {
      setPending(true);
      try {
        await action();
        if (opts.success) showToast({ body: opts.success, type: "info", uniqueID: opts.success });
        return true;
      } catch (err) {
        showToast({ body: errorMessage(err), type: "error" });
        return false;
      } finally {
        setPending(false);
      }
    },
    [showToast],
  );

  return { run, pending };
}
