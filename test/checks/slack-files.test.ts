import { describe, expect, it } from "vitest";
import { downloadSlackFile } from "../../src/slack/slack.js";

/**
 * The bot token goes only to https://files.slack.com itself: no other port,
 * no user or password in the address, also after a redirect. The plain
 * Slack address gets it.
 */

const TOKEN = "xoxb-acme-placeholder-file-token";
const noInfo = { files: { info: async () => Promise.reject(new Error("files.info is not used here")) } };
const zip = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);

function recordingFetch(...answers: Array<() => Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  let i = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return answers[Math.min(i++, answers.length - 1)]!();
  };
  return { fn: fn as typeof fetch, calls };
}
const file = () => new Response(zip, { status: 200, headers: { "content-type": "application/zip" } });
const redirectTo = (location: string) => () => new Response(null, { status: 302, headers: { location } });

describe("the Slack file download address", () => {
  it("refuses a Slack address with another port, a user or a password, before any request", async () => {
    for (const url of ["https://files.slack.com:8443/files-pri/T1-F1/x.zip", "https://:pw@files.slack.com/files-pri/T1-F1/x.zip", "https://octo-dev@files.slack.com/files-pri/T1-F1/x.zip"]) {
      const f = recordingFetch(file);
      await expect(downloadSlackFile(noInfo as never, TOKEN, { id: "F1", name: "x.zip", url_private: url }, f.fn), url).rejects.toThrow("not a file stored on Slack");
      expect(f.calls, url).toEqual([]);
    }
  });

  it("sends the token to files.slack.com, and not after a redirect to another port or with a password", async () => {
    for (const next of ["https://files.slack.com:8443/files-tmb/T1-F1/x.zip", "https://:pw@files.slack.com/files-tmb/T1-F1/x.zip"]) {
      const f = recordingFetch(redirectTo(next), file);
      const got = await downloadSlackFile(noInfo as never, TOKEN, { id: "F1", name: "x.zip", url_private_download: "https://files.slack.com/files-pri/T1-F1/download/x.zip" }, f.fn);
      expect(got.bytes.byteLength).toBe(zip.byteLength);
      expect(f.calls.map((c) => c.auth)).toEqual([`Bearer ${TOKEN}`, null]);
    }
  });
});
