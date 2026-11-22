import { describe, expect, it } from "vitest";
import {
  AppUrlError,
  type FetchLike,
  appUrlProblem,
  assertPublicUrl,
  guardedFetch,
  guardedLookup,
  isBlockedAddress,
} from "../../src/integrations/apps/apps-net.js";

/**
 * The app network guard (apps-net.ts) on both sides: every blocked range
 * refuses an address inside it and lets the public address beside it
 * through, and the redirect and lookup rules hold at their limits.
 */

describe("app network guard: the blocked ranges", () => {
  it("blocks an address in every private, loopback, link-local and reserved range", () => {
    for (const address of [
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::10.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::a00:1",
      "64:ff9b:1::1",
      "100::1",
      "2001:db8::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "febf::1",
      "fec0::1",
      "ff02::1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("lets public addresses through, the ones just outside each range included", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "11.0.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "126.255.255.255",
      "128.0.0.1",
      "169.253.255.255",
      "169.255.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.0.1.1",
      "192.167.255.255",
      "192.169.0.1",
      "198.17.255.255",
      "198.20.0.1",
      "203.0.114.1",
      "223.255.255.255",
      "2606:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
    ]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("treats anything that is not an IP address as blocked", () => {
    for (const value of ["", "localhost", "example.com", "10.0.0.1.nip.io", "999.1.1.1"]) {
      expect(isBlockedAddress(value), value).toBe(true);
    }
  });
});

describe("app network guard: lookups", () => {
  it("refuses a name that resolves to no address, and passes one that resolves to a public address", async () => {
    await expect(assertPublicUrl("https://empty.example.com/mcp", { env: {}, lookup: async () => [] })).rejects.toBeInstanceOf(AppUrlError);
    await expect(assertPublicUrl("https://ok.example.com/mcp", { env: {}, lookup: async () => ["93.184.216.34"] })).resolves.toBeInstanceOf(URL);
  });

  it("refuses at connect time a name with no address, or with an answer that is not an IP address", async () => {
    const resolveWith = (addresses: string[]) =>
      new Promise<{ err: NodeJS.ErrnoException | null; addresses: unknown }>((resolve) =>
        guardedLookup(async () => addresses)("x.example.com", { all: true }, (err, found) => resolve({ err, addresses: found })),
      );
    for (const answer of [[], ["not-an-address"]]) {
      const { err } = await resolveWith(answer);
      expect(err?.code, JSON.stringify(answer)).toBe("EAPPBLOCKED");
    }
    const ok = await resolveWith(["93.184.216.34"]);
    expect(ok.err).toBeNull();
    expect(ok.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("connects only to the address it checked: a second answer that is private is refused", async () => {
    // No fetch passed in: the real, pinned one. The first lookup (the check) is public, the second (the connection) private.
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    let calls = 0;
    const lookup = async () => answers[Math.min(calls++, answers.length - 1)]!;
    const fetch = guardedFetch({ env: {}, lookup, timeoutMs: 3_000 });
    await expect(fetch("https://rebind.invalid/mcp")).rejects.toThrow(/private network/);
    expect(calls).toBe(2);
  });
});

describe("app network guard: redirects", () => {
  const lookup = async () => ["93.184.216.34"];
  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

  it("follows at most five redirects, then returns the last one", async () => {
    const hops: string[] = [];
    const fetch: FetchLike = async (url) => {
      hops.push(String(url));
      if (hops.length > 10) throw new Error("followed too many redirects");
      return redirectTo(`https://a.example.com/hop-${hops.length}`);
    };
    const res = await guardedFetch({ env: {}, lookup, fetch })("https://a.example.com/start");
    expect(res.status).toBe(302);
    expect(hops).toHaveLength(6);
  });

  it("follows a redirect when asked to, and throws instead when the caller asks for an error", async () => {
    const hops: string[] = [];
    const fetch: FetchLike = async (url) => {
      hops.push(String(url));
      return String(url).endsWith("/start") ? redirectTo("/next") : new Response("ok");
    };
    expect((await guardedFetch({ env: {}, lookup, fetch })("https://a.example.com/start")).status).toBe(200);
    expect(hops).toEqual(["https://a.example.com/start", "https://a.example.com/next"]);

    hops.length = 0;
    await expect(guardedFetch({ env: {}, lookup, fetch })("https://a.example.com/start", { redirect: "error" })).rejects.toThrow(/Redirected from a\.example\.com/);
    expect(hops).toEqual(["https://a.example.com/start"]);
  });
});

describe("app network guard: the local development switch", () => {
  it("allows private addresses only when ALLOW_PRIVATE_APP_URLS is exactly 1", () => {
    for (const value of ["0", "true", "yes", " 1", ""]) {
      expect(appUrlProblem("https://127.0.0.1/mcp", { ALLOW_PRIVATE_APP_URLS: value }), value).toBeTruthy();
    }
    expect(appUrlProblem("https://127.0.0.1/mcp", { ALLOW_PRIVATE_APP_URLS: "1" })).toBeUndefined();
    expect(appUrlProblem("https://127.0.0.1/mcp", { NODE_ENV: "production" })).toBeTruthy();
  });
});
