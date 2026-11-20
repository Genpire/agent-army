import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReport } from "../src/agents.js";
import { ConfigRepo, ConfigSchema, publicView } from "../src/config.js";
import { decrypt, deriveKey, encrypt, hashPassword, signSession, verifyPassword, verifySession } from "../src/crypto.js";
import { checkBashCommand } from "../src/guard.js";
import { ATTACHMENT_LIMITS } from "../src/attachments.js";
import {
  buildManifest,
  downloadSlackFile,
  fetchConversation,
  react,
  slackFileRefs,
  toMrkdwn,
  unreact,
  verifySlackSignature,
} from "../src/slack.js";
import { FsStore } from "../src/store.js";
import { type Conversation, pendingMilestones, taskResultMarkdown } from "../src/conversations.js";
import { type Task, decodeTaskPayload, encodeTaskPayload, newTaskId } from "../src/tasks.js";
import { GITHUB_REPO_RE, REPO_FORMAT_HINT, REPO_RE } from "../src/repo-id.js";
import { helpText, isRepoAllowed, messageText, parseCommand, repoFromToken, resolveRepo } from "../src/targeting.js";
import { branchName, makeRedactor } from "../src/worker.js";
import {
  GITHUB_REPO_RE as WEB_GITHUB_REPO_RE,
  REPO_ERROR,
  REPO_RE as WEB_REPO_RE,
  allowListRepos,
} from "../web/src/pages/projects/validation.js";

describe("targeting", () => {
  it("parses commands, with or without a mention", () => {
    expect(parseCommand("<@U1> help")).toEqual({ kind: "help" });
    expect(parseCommand("?")).toEqual({ kind: "help" });
    expect(parseCommand("HELP")).toEqual({ kind: "help" });
    expect(parseCommand("<@U1> status")).toEqual({ kind: "status" });
    expect(parseCommand("unbind")).toEqual({ kind: "unbind" });
    expect(parseCommand("<@U1> bind acme/web")).toEqual({ kind: "bind", repo: "acme/web" });
    expect(parseCommand("bind <https://github.com/acme/web|acme/web>")).toEqual({ kind: "bind", repo: "acme/web" });
    expect(parseCommand("<@U1> listen here")).toEqual({ kind: "listen" });
    expect(parseCommand("Listen")).toEqual({ kind: "listen" });
    expect(parseCommand("stop listening.")).toEqual({ kind: "unlisten" });
    expect(parseCommand("unlisten")).toEqual({ kind: "unlisten" });
  });
  it("leaves everything else to the brain", () => {
    expect(parseCommand("<@U1>")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("bind nonsense")).toBeNull();
    expect(parseCommand("<@U1> in acme/web: fix login")).toBeNull();
    expect(parseCommand("fix the flaky checkout test")).toBeNull();
    expect(parseCommand("help me write a release note")).toBeNull();
    expect(parseCommand("listen to this idea")).toBeNull();
  });
  it("reads a repo from a name or a GitHub URL", () => {
    expect(repoFromToken("acme/web")).toBe("acme/web");
    expect(repoFromToken("acme/web.git")).toBe("acme/web");
    expect(repoFromToken("https://github.com/acme/web/pull/3")).toBe("acme/web");
    expect(repoFromToken("nonsense")).toBeNull();
  });
  it("reads GitLab and Bitbucket ids and URLs, a self-managed GitLab's included", () => {
    expect(repoFromToken("gitlab:acme/platform/web")).toBe("gitlab:acme/platform/web");
    expect(repoFromToken("bitbucket:acme-ws/api.")).toBe("bitbucket:acme-ws/api");
    expect(repoFromToken("https://gitlab.com/acme/platform/web/-/merge_requests/3")).toBe("gitlab:acme/platform/web");
    expect(repoFromToken("https://bitbucket.org/acme-ws/api/pull-requests/4")).toBe("bitbucket:acme-ws/api");
    expect(repoFromToken("https://git.acme.test/acme/web")).toBeNull();
    expect(repoFromToken("https://git.acme.test/acme/web", "https://git.acme.test")).toBe("gitlab:acme/web");
    expect(repoFromToken("https://git.acme.test/gitlab/acme/web/-/tree/main", "https://git.acme.test/gitlab")).toBe("gitlab:acme/web");
    expect(repoFromToken("https://git.acme.test:8443/acme/web", "https://git.acme.test:8443")).toBe("gitlab:acme/web");
    expect(repoFromToken("https://gitlab.com/acme/web", "https://git.acme.test")).toBe("gitlab:acme/web");
    expect(repoFromToken("gitlab:acme")).toBeNull();
    expect(repoFromToken("gitlab:acme/../web")).toBeNull();
    expect(repoFromToken("bitbucket:acme/web/extra")).toBeNull();
  });
  it("binds GitLab and Bitbucket repositories by id or link", () => {
    expect(parseCommand("<@U1> bind gitlab:acme/platform/web")).toEqual({ kind: "bind", repo: "gitlab:acme/platform/web" });
    expect(parseCommand("bind bitbucket:acme-ws/api")).toEqual({ kind: "bind", repo: "bitbucket:acme-ws/api" });
    expect(parseCommand("bind <https://gitlab.com/acme/web|gitlab.com/acme/web>")).toEqual({ kind: "bind", repo: "gitlab:acme/web" });
    expect(parseCommand("bind <https://bitbucket.org/acme-ws/api/src/main/|bitbucket.org/acme-ws/api>")).toEqual({ kind: "bind", repo: "bitbucket:acme-ws/api" });
    expect(parseCommand("bind <https://git.acme.test/acme/web>", "https://git.acme.test")).toEqual({ kind: "bind", repo: "gitlab:acme/web" });
    expect(parseCommand("bind <https://git.acme.test/acme/web>")).toBeNull();
    expect(parseCommand("bind gitlab:acme")).toBeNull();
  });
  it("keeps other people's mentions in the text for Pointer", () => {
    expect(messageText("<@UBOT> ask <@U2> about <https://x.y/a|the doc>", "UBOT")).toBe("ask <@U2> about https://x.y/a");
    expect(messageText("<@UBOT>", "UBOT")).toBe("");
  });
  it("writes help with Pointer's name and the commands", () => {
    const help = helpText("Pointer");
    expect(help).toContain("Pointer");
    for (const cmd of ["bind owner/repo", "unbind", "status", "listen here", "stop listening"]) expect(help).toContain(cmd);
    expect(help).toMatch(/pull request/i);
    expect(help).toContain("bind gitlab:group/project");
    expect(help).toContain("bind bitbucket:workspace/repo");
  });
  it("checks repositories in the console the way the server does", () => {
    const ids = [
      "acme/web",
      "Acme/web.app",
      "gitlab:acme/web",
      "gitlab:acme/platform/team/web",
      "bitbucket:acme-ws/api",
      "acme",
      "acme/web/x",
      "../x",
      "acme/..",
      "gitlab:acme",
      "gitlab:acme/../web",
      "bitbucket:acme/api/x",
      "github:acme/web",
      "GitLab:acme/web",
      "gitlab:acme/~web",
    ];
    for (const id of ids) {
      expect(WEB_REPO_RE.test(id), id).toBe(REPO_RE.test(id));
      expect(WEB_GITHUB_REPO_RE.test(id), id).toBe(GITHUB_REPO_RE.test(id));
    }
    expect(REPO_ERROR).toBe(REPO_FORMAT_HINT);
  });
  it("suggests the exact repositories of every code host's allow list", () => {
    const view = publicView(
      ConfigSchema.parse({
        github: { token: "t", allowedOwners: ["acme", "acme/web"], extra: [{ id: "gh-abc123", token: "ghp_extra_connection_0000000000", allowed: ["Partner-Co/Acme"] }] },
        gitlab: { token: "t", allowed: ["acme", "acme/platform/web"] },
        bitbucket: { token: "t", allowed: ["acme-ws", "acme-ws/api"] },
      }),
    );
    expect(allowListRepos(view)).toEqual(["acme/web", "Partner-Co/Acme", "gitlab:acme/platform/web", "bitbucket:acme-ws/api"]);
  });
  it("resolves precedence: explicit > thread > channel", () => {
    expect(resolveRepo({ override: "a/a", threadRepo: "b/b", channelRepo: "c/c" })).toBe("a/a");
    expect(resolveRepo({ threadRepo: "b/b", channelRepo: "c/c" })).toBe("b/b");
    expect(resolveRepo({ channelRepo: "c/c" })).toBe("c/c");
    expect(resolveRepo({})).toBeUndefined();
  });
  it("enforces the owner allowlist", () => {
    expect(isRepoAllowed("Acme/web", ["acme"])).toBe(true);
    expect(isRepoAllowed("other/web", ["acme"])).toBe(false);
    expect(isRepoAllowed("other/web", [])).toBe(true);
  });
});

describe("bash guard", () => {
  it("blocks publishing and secret access", () => {
    for (const cmd of [
      "git push origin main",
      "git -C repo push",
      "cd x && git push --force",
      "git remote set-url origin https://evil",
      "gh pr create",
      "cat /proc/1/environ",
      "echo $ANTHROPIC_API_KEY",
      "env",
      "printenv | grep KEY",
      "cat /data/config.enc",
      "rm -rf /",
    ]) {
      expect(checkBashCommand(cmd, ["/data"]), cmd).not.toBeNull();
    }
  });
  it("allows normal development commands", () => {
    for (const cmd of [
      "npm test",
      "git status && git diff",
      "git commit -am 'fix'",
      "pnpm lint --fix",
      "pytest -q",
      "NODE_ENV=test npm run build",
      "rm -rf node_modules/.cache",
      "grep -r 'push(' src",
    ]) {
      expect(checkBashCommand(cmd, ["/data"]), cmd).toBeNull();
    }
  });
});

describe("crypto", () => {
  const key = deriveKey("test-master-key");
  it("round-trips and rejects tampering or the wrong key", () => {
    const blob = encrypt(key, "secret config");
    expect(decrypt(key, blob)).toBe("secret config");
    expect(blob.toString("utf8")).not.toContain("secret config");
    expect(() => decrypt(deriveKey("other"), blob)).toThrow();
    blob[blob.length - 1]! ^= 1;
    expect(() => decrypt(key, blob)).toThrow();
  });
  it("hashes passwords", () => {
    const hash = hashPassword("correct horse");
    expect(verifyPassword("correct horse", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });
  it("signs sessions that expire and cannot be forged", () => {
    const token = signSession(key, 1000, 1_000_000);
    expect(verifySession(key, token, 1_000_500)).toBe(true);
    expect(verifySession(key, token, 1_002_000)).toBe(false);
    expect(verifySession(key, `9999999999999.${token.split(".")[1]}`, 1_000_500)).toBe(false);
    expect(verifySession(deriveKey("other"), token, 1_000_500)).toBe(false);
    expect(verifySession(key, undefined)).toBe(false);
  });
});

describe("slack", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const body = JSON.stringify({ type: "event_callback" });
  const sign = (ts: string) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  it("verifies signatures and the replay window", () => {
    const ts = "1700000000";
    const base = { signingSecret: secret, timestamp: ts, rawBody: body, nowSec: 1700000010 };
    expect(verifySlackSignature({ ...base, signature: sign(ts) })).toBe(true);
    expect(verifySlackSignature({ ...base, signature: sign(ts), rawBody: body + " " })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: sign(ts), nowSec: 1700000000 + 301 })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: undefined })).toBe(false);
    expect(verifySlackSignature({ ...base, signingSecret: "wrong", signature: sign(ts) })).toBe(false);
  });
  it("converts markdown to Slack mrkdwn", () => {
    expect(toMrkdwn("## Done\n**bold** [pr](https://x.y/1)")).toBe("*Done*\n*bold* <https://x.y/1|pr>");
  });
  it("builds a manifest that listens to channels and DMs", () => {
    const m = buildManifest("https://army.example", "Pointer");
    expect(m.display_information.name).toBe("Pointer");
    expect(m.features.bot_user.display_name).toBe("Pointer");
    expect(m.settings.event_subscriptions.request_url).toBe("https://army.example/slack/events");
    expect(m.settings.event_subscriptions.bot_events).toEqual(["app_mention", "message.channels", "message.groups", "message.im"]);
    expect(m.oauth_config.scopes.bot).toEqual([
      "app_mentions:read",
      "chat:write",
      "channels:history",
      "groups:history",
      "im:history",
      "users:read",
      "reactions:write",
      "files:read",
      "files:write",
    ]);
    expect(m.features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
  });
  it("fetches a thread oldest first, before the new message, with names", async () => {
    const calls: string[] = [];
    const client = {
      conversations: {
        replies: async (a: { ts: string }) => (
          calls.push(`replies:${a.ts}`),
          {
            messages: [
              { ts: "10.1", user: "UA1", text: "can you <https://x.y|look>?" },
              { ts: "10.2", user: "UBOT", bot_id: "B1", text: "Sure." },
              { ts: "10.3", user: "UA2", text: "" },
              { ts: "10.4", user: "UA2", text: "the new one" },
              { ts: "10.5", user: "UA1", text: "later" },
            ],
          }
        ),
      },
      users: {
        info: async (a: { user: string }) => (
          calls.push(`users:${a.user}`),
          { user: a.user === "UA1" ? { profile: { display_name: "Ann" } } : { real_name: "Bo Real", profile: { display_name: "" } } }
        ),
      },
    };
    const got = await fetchConversation(client as never, {
      channel: "C1",
      threadTs: "10.1",
      isDm: false,
      beforeTs: "10.4",
      limit: 50,
      botUserId: "UBOT",
      pointerName: "Pointer",
    });
    expect(got).toEqual([
      { ts: "10.1", userId: "UA1", name: "Ann", text: "can you https://x.y?", isPointer: false },
      { ts: "10.2", userId: "UBOT", name: "Pointer", text: "Sure.", isPointer: true },
    ]);
    expect(calls).toContain("replies:10.1");
  });
  it("keeps the thread's first message and the latest ones when the thread is long", async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ ts: `${100 + i}.0`, user: "UA1", text: `m${i}` }));
    const client = {
      conversations: { replies: async () => ({ messages }) },
      users: { info: async () => ({ user: { profile: { display_name: "Ann" } } }) },
    };
    const got = await fetchConversation(client as never, { channel: "C1", threadTs: "100.0", isDm: false, beforeTs: "200.0", limit: 5 });
    expect(got.map((m) => m.text)).toEqual(["m0", "m26", "m27", "m28", "m29"]);
  });
  it("reads recent DM history oldest first, marking bot messages when the bot id is unknown", async () => {
    let args: Record<string, unknown> = {};
    const client = {
      conversations: {
        history: async (a: Record<string, unknown>) => (
          (args = a),
          { messages: [{ ts: "5.3", bot_id: "B1", text: "hi there" }, { ts: "5.2", user: "UA1", text: "hello" }] }
        ),
      },
      users: { info: async () => ({ user: { profile: { display_name: "Ann" } } }) },
    };
    const got = await fetchConversation(client as never, { channel: "D1", isDm: true, beforeTs: "5.4", limit: 15 });
    expect(args).toMatchObject({ channel: "D1", latest: "5.4", inclusive: false, limit: 15 });
    expect(got.map((m) => [m.text, m.isPointer, m.name])).toEqual([
      ["hello", false, "Ann"],
      ["hi there", true, "Pointer"],
    ]);
  });
  it("returns no history for a top-level channel message or on errors", async () => {
    const failing = {
      conversations: {
        replies: async () => Promise.reject(new Error("missing_scope")),
        history: async () => Promise.reject(new Error("missing_scope")),
      },
    };
    expect(await fetchConversation(failing as never, { channel: "C1", isDm: false, beforeTs: "1.1", limit: 50 })).toEqual([]);
    expect(await fetchConversation(failing as never, { channel: "C1", threadTs: "1.0", isDm: false, beforeTs: "1.1", limit: 50 })).toEqual([]);
    expect(await fetchConversation(failing as never, { channel: "D1", isDm: true, beforeTs: "1.1", limit: 15 })).toEqual([]);
  });
  it("reacts on a best-effort basis", async () => {
    const seen: string[] = [];
    const ok = {
      reactions: {
        add: async (a: { name: string; timestamp: string }) => void seen.push(`+${a.name}@${a.timestamp}`),
        remove: async (a: { name: string; timestamp: string }) => void seen.push(`-${a.name}@${a.timestamp}`),
      },
    };
    await react(ok as never, "C1", "1.1", "eyes");
    await unreact(ok as never, "C1", "1.1", "eyes");
    expect(seen).toEqual(["+eyes@1.1", "-eyes@1.1"]);
    const failing = { reactions: { add: async () => Promise.reject(new Error("missing_scope")), remove: async () => Promise.reject(new Error("x")) } };
    await expect(react(failing as never, "C1", "1.1", "eyes")).resolves.toBeUndefined();
    await expect(unreact(failing as never, "C1", "1.1", "eyes")).resolves.toBeUndefined();
  });
});

describe("slack files", () => {
  const TOKEN = "xoxb-file-token";
  const URL_DL = "https://files.slack.com/files-pri/T1-F1/download/design.zip";
  const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);

  /** A fake fetch that records each request and answers from a list (or one response for all). */
  function fakeFetch(...responses: Array<() => Response>) {
    const calls: Array<{ url: string; auth: string | null; redirect?: string }> = [];
    let i = 0;
    const fn = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get("authorization"), redirect: init?.redirect });
      const make = responses[Math.min(i++, responses.length - 1)]!;
      return make();
    };
    return { fn: fn as typeof fetch, calls };
  }
  const ok = (bytes: Uint8Array, type = "application/zip") => () => new Response(bytes, { status: 200, headers: { "content-type": type } });
  const noInfo = { files: { info: async () => Promise.reject(new Error("files.info should not be called")) } };

  it("downloads with the bot token, preferring the download URL", async () => {
    const f = fakeFetch(ok(zipBytes));
    const got = await downloadSlackFile(
      noInfo as never,
      TOKEN,
      { id: "F1", name: "design.zip", mimetype: "application/zip", size: zipBytes.length, url_private: "https://files.slack.com/files-pri/T1-F1/design.zip", url_private_download: URL_DL },
      f.fn,
    );
    expect(got.name).toBe("design.zip");
    expect(got.mime).toBe("application/zip");
    expect([...got.bytes]).toEqual([...zipBytes]);
    expect(f.calls).toEqual([{ url: URL_DL, auth: `Bearer ${TOKEN}`, redirect: "manual" }]);
  });

  it("asks files.info when Slack leaves the URLs out", async () => {
    const infoCalls: string[] = [];
    const client = {
      files: {
        info: async (a: { file: string }) => (
          infoCalls.push(a.file),
          { ok: true, file: { id: "F2", name: "image.png", mimetype: "image/png", size: 3, url_private_download: "https://files.slack.com/files-pri/T1-F2/download/image.png" } }
        ),
      },
    };
    const f = fakeFetch(ok(new Uint8Array([1, 2, 3]), "image/png"));
    const got = await downloadSlackFile(client as never, TOKEN, { id: "F2", file_access: "check_file_info" }, f.fn);
    expect(infoCalls).toEqual(["F2"]);
    expect(got).toMatchObject({ name: "image.png", mime: "image/png" });
    expect(f.calls[0]).toMatchObject({ url: "https://files.slack.com/files-pri/T1-F2/download/image.png", auth: `Bearer ${TOKEN}` });

    const missing = { files: { info: async () => Promise.reject(Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } })) } };
    await expect(downloadSlackFile(missing as never, TOKEN, { id: "F3", name: "a.png" }, f.fn)).rejects.toThrow(
      "missing files:read permission (reinstall the Slack app)",
    );
  });

  it("only sends the token to files.slack.com", async () => {
    const f = fakeFetch(ok(zipBytes));
    for (const url of [
      "https://evil.example/files-pri/x",
      "http://files.slack.com/files-pri/x",
      "https://files.slack.com.evil.example/x",
      "https://user@files.slack.com/x",
      "not a url",
    ]) {
      await expect(downloadSlackFile(noInfo as never, TOKEN, { id: "F1", name: "x.zip", url_private: url }, f.fn), url).rejects.toThrow(/Slack/);
    }
    expect(f.calls).toEqual([]);

    // A redirect to another host is followed without the token.
    const r = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "https://files.slack.com/files-tmb/T1-F1/design.zip" } }),
      () => new Response(null, { status: 302, headers: { location: "https://cdn.example/signed/design.zip" } }),
      ok(zipBytes),
    );
    const got = await downloadSlackFile(noInfo as never, TOKEN, { id: "F1", name: "design.zip", url_private_download: URL_DL }, r.fn);
    expect(got.bytes.length).toBe(zipBytes.length);
    expect(r.calls.map((c) => [c.url, c.auth])).toEqual([
      [URL_DL, `Bearer ${TOKEN}`],
      ["https://files.slack.com/files-tmb/T1-F1/design.zip", `Bearer ${TOKEN}`],
      ["https://cdn.example/signed/design.zip", null],
    ]);
  });

  it("refuses files over the size limit, before and after downloading", async () => {
    const f = fakeFetch(ok(zipBytes));
    const max = ATTACHMENT_LIMITS.maxFileBytes;
    await expect(downloadSlackFile(noInfo as never, TOKEN, { id: "F1", name: "big.zip", size: max + 1, url_private_download: URL_DL }, f.fn)).rejects.toThrow(
      /larger than 20 MB/,
    );
    expect(f.calls).toEqual([]);

    const big = fakeFetch(ok(new Uint8Array(max + 1)));
    await expect(downloadSlackFile(noInfo as never, TOKEN, { id: "F1", name: "big.zip", url_private_download: URL_DL }, big.fn)).rejects.toThrow(
      /larger than 20 MB/,
    );
  });

  it("recognises Slack's login page as a missing files:read scope", async () => {
    const login = new TextEncoder().encode("<!DOCTYPE html><html><title>Slack</title></html>");
    const f = fakeFetch(ok(login, "text/html; charset=utf-8"));
    await expect(
      downloadSlackFile(noInfo as never, TOKEN, { id: "F1", name: "design.zip", mimetype: "application/zip", url_private_download: URL_DL }, f.fn),
    ).rejects.toThrow("missing files:read permission (reinstall the Slack app)");
    // An HTML file is HTML, unless its size does not match what Slack reported.
    const page = new TextEncoder().encode("<h1>Chat</h1>");
    const html = fakeFetch(ok(page, "text/html"));
    const got = await downloadSlackFile(
      noInfo as never,
      TOKEN,
      { id: "F2", name: "Chat Section.html", mimetype: "text/html", size: page.length, url_private_download: URL_DL },
      html.fn,
    );
    expect(new TextDecoder().decode(got.bytes)).toBe("<h1>Chat</h1>");
    const wrongSize = fakeFetch(ok(login, "text/html"));
    await expect(
      downloadSlackFile(noInfo as never, TOKEN, { id: "F2", name: "Chat Section.html", mimetype: "text/html", size: 13, url_private_download: URL_DL }, wrongSize.fn),
    ).rejects.toThrow(/files:read/);
  });

  it("reports HTTP errors briefly, without the token", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 404 }));
    const err = await downloadSlackFile(noInfo as never, TOKEN, { id: "F1", name: "x.zip", url_private_download: URL_DL }, f.fn).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/404/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("keeps the useful fields of Slack file objects and drops deleted files", () => {
    expect(
      slackFileRefs([
        { id: "F1", name: "a.html", mimetype: "text/html", size: 5, url_private: "https://files.slack.com/a", thumb_64: "x", user: "U1" },
        { id: "F2", mode: "tombstone" },
        { name: "no id" },
        "junk",
        { id: "F3", file_access: "check_file_info", mode: "file_access" },
      ]),
    ).toEqual([
      { id: "F1", name: "a.html", mimetype: "text/html", size: 5, url_private: "https://files.slack.com/a" },
      { id: "F3", file_access: "check_file_info" },
    ]);
    expect(slackFileRefs(undefined)).toEqual([]);
  });

  it("returns each message's files, including messages that are only files", async () => {
    const client = {
      conversations: {
        replies: async () => ({
          messages: [
            { ts: "10.1", user: "UA1", text: "here are the designs", files: [{ id: "F1", name: "Chat Section.html", mimetype: "text/html" }] },
            { ts: "10.2", user: "UA1", text: "", files: [{ id: "F2", name: "image.png" }] },
            { ts: "10.3", user: "UA1", text: "", files: [{ id: "F9", mode: "tombstone" }] },
          ],
        }),
      },
      users: { info: async () => ({ user: { profile: { display_name: "Ann" } } }) },
    };
    const got = await fetchConversation(client as never, { channel: "C1", threadTs: "10.1", isDm: false, beforeTs: "10.9", limit: 50 });
    expect(got).toEqual([
      { ts: "10.1", userId: "UA1", name: "Ann", text: "here are the designs", isPointer: false, files: [{ id: "F1", name: "Chat Section.html", mimetype: "text/html" }] },
      { ts: "10.2", userId: "UA1", name: "Ann", text: "", isPointer: false, files: [{ id: "F2", name: "image.png" }] },
    ]);
  });
});

describe("config", () => {
  it("stores encrypted and never exposes secrets to the browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-test-"));
    const store = new FsStore(dir);
    const repo = new ConfigRepo(store, deriveKey("k"), 0);
    await repo.update((c) => {
      c.anthropic.apiKey = "sk-ant-supersecret-1234";
      c.github.token = "github_pat_supersecret";
      c.bindings["C123"] = "acme/web";
    });
    const onDisk = (await store.get("config.enc"))!.toString("latin1");
    expect(onDisk).not.toContain("supersecret");
    const loaded = await new ConfigRepo(store, deriveKey("k"), 0).load();
    expect(loaded.anthropic.apiKey).toBe("sk-ant-supersecret-1234");
    const view = JSON.stringify(publicView(loaded));
    expect(view).not.toContain("supersecret");
    expect(view).toContain("1234");
    await expect(repo.update((c) => void (c.bindings["C9"] = "not a repo"))).rejects.toThrow();
  });
});

describe("worker helpers", () => {
  it("builds safe branch names", () => {
    const id = newTaskId();
    expect(branchName("Fix the POM column/row reversal in PDF!!", id)).toMatch(/^army\/fix-the-pom-column-row-reversal-in-pdf-[a-f0-9]{6}$/);
    expect(branchName("؟؟؟", id)).toMatch(/^army\/task-[a-f0-9]{6}$/);
  });
  it("redacts credentials from error text", () => {
    const redact = makeRedactor(["ghp_abcdef123456", undefined, ""]);
    expect(redact("fatal: https://x:ghp_abcdef123456@github.com")).toBe("fatal: https://x:[redacted]@github.com");
  });
  it("round-trips task payloads and rejects junk", () => {
    const id = newTaskId();
    expect(decodeTaskPayload(encodeTaskPayload(id)).taskId).toBe(id);
    expect(() => decodeTaskPayload(Buffer.from('{"taskId":"../../etc"}').toString("base64"))).toThrow();
  });
  it("parses the team's report with a fallback", () => {
    expect(parseReport({ kind: "change", title: "t", summary: "s", verification: "v", risks: "" }, "x").kind).toBe("change");
    expect(parseReport(undefined, "plain answer")).toMatchObject({ kind: "answer", summary: "plain answer" });
  });
});

describe("console milestones on any code host", () => {
  const task = (repo: string, prUrl: string, over: Partial<Task> = {}): Task => ({
    id: "t-0001",
    createdAt: "2026-11-19T10:00:00Z",
    updatedAt: "2026-11-19T10:30:00Z",
    status: "done",
    repo,
    channel: "web",
    threadTs: "c-1",
    userId: "admin",
    instruction: "Collapse the sidebar",
    kind: "change",
    prUrl,
    report: { title: "Collapse the sidebar", summary: "Done.", verification: "", risks: "" },
    ...over,
  });
  const conversation = (t: Task): Conversation => ({
    id: "c-1",
    title: "Sidebar",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    pending: false,
    messages: [],
    taskIds: [t.id],
  });

  it("links GitHub pull requests as before", () => {
    const t = task("acme/web", "https://github.com/acme/web/pull/3");
    expect(taskResultMarkdown(t)).toContain("— [review the pull request](https://github.com/acme/web/pull/3)");
    const running = task("acme/web", "https://github.com/acme/web/pull/3", { status: "running", fixRound: { round: 1, rounds: 2, failing: ["test"], at: t.updatedAt } });
    const texts = pendingMilestones(conversation(running), [running]).map((m) => m.text);
    expect(texts).toEqual([
      "Opened [pull request #3](https://github.com/acme/web/pull/3): **Collapse the sidebar**. Waiting for its checks…",
      "The pull request's checks failed: test. The team is fixing them (round 1 of 2)…",
    ]);
  });

  it("calls GitLab's a merge request with its !number, and reads Bitbucket's number", () => {
    const mr = "https://gitlab.example.com/acme/web/-/merge_requests/12";
    expect(taskResultMarkdown(task("gitlab:acme/web", mr))).toContain(`— [review the merge request](${mr})`);
    const stopped = task("gitlab:acme/web", mr, { status: "failed", error: "Timed out.", prDraft: true });
    expect(taskResultMarkdown(stopped)).toContain(`saved in a draft merge request: [!12](${mr})`);
    const running = task("gitlab:acme/web", mr, { status: "running", fixRound: { round: 1, rounds: 2, failing: ["test"], at: "2026-11-19T10:30:00Z" } });
    expect(pendingMilestones(conversation(running), [running]).map((m) => m.text)).toEqual([
      `Opened [merge request !12](${mr}): **Collapse the sidebar**. Waiting for its checks…`,
      "The merge request's checks failed: test. The team is fixing them (round 1 of 2)…",
    ]);

    const pr = "https://bitbucket.org/acme/web/pull-requests/5";
    const bb = task("bitbucket:acme/web", pr, { status: "running" });
    expect(pendingMilestones(conversation(bb), [bb])[0]!.text).toContain(`Opened [pull request #5](${pr})`);
  });
});
