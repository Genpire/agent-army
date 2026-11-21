import { describe, expect, it } from "vitest";
import { UsageError, isValidHost, isValidName, normalizeDomain, parseArguments } from "../../packages/create-agent-army/src/args.js";
import { run } from "./helpers.js";

describe("create-agent-army: argument parsing", () => {
  it("has defaults for everything", () => {
    expect(parseArguments([])).toEqual({
      provider: undefined,
      name: undefined,
      region: undefined,
      org: undefined,
      project: undefined,
      host: undefined,
      domain: undefined,
      image: "ghcr.io/genpire/agent-army:latest",
      port: 8080,
      timeout: 15,
      yes: false,
      dryRun: false,
      open: true,
      help: false,
      version: false,
    });
  });

  it("reads the non-interactive flags", () => {
    const options = parseArguments(["--provider", "fly", "--name", "my-army", "--region", "iad", "--yes"]);
    expect(options).toMatchObject({ provider: "fly", name: "my-army", region: "iad", yes: true, dryRun: false });
  });

  it("takes short flags, the name as an argument, and every other option", () => {
    const options = parseArguments([
      "my-army",
      "-p",
      "vm",
      "-y",
      "--dry-run",
      "--no-open",
      "--host",
      "root@203.0.113.7",
      "--domain",
      "https://Army.Example.com/",
      "--image",
      "ghcr.io/someone/agent-army:sha-1234567",
      "--port",
      "9090",
      "--timeout",
      "30",
      "--org",
      "my-org",
      "--project",
      "example-project",
    ]);
    expect(options).toMatchObject({
      name: "my-army",
      provider: "vm",
      yes: true,
      dryRun: true,
      open: false,
      host: "root@203.0.113.7",
      domain: "army.example.com",
      image: "ghcr.io/someone/agent-army:sha-1234567",
      port: 9090,
      timeout: 30,
      org: "my-org",
      project: "example-project",
    });
  });

  it("accepts provider aliases", () => {
    expect(parseArguments(["--provider", "gcp"]).provider).toBe("gcloud");
    expect(parseArguments(["--provider", "cloudrun"]).provider).toBe("gcloud");
    expect(parseArguments(["--provider", "Fly.io"]).provider).toBe("fly");
    expect(parseArguments(["--provider", "RAILWAY"]).provider).toBe("railway");
  });

  it.each([
    [["--provider", "heroku"], /Unknown provider "heroku"/],
    [["--name", "My_Army"], /not a valid name/],
    [["--name", "ab"], /not a valid name/],
    [["--name", "my--army"], /not a valid name/],
    [["--name", "a".repeat(41)], /not a valid name/],
    [["one", "two"], /at most one name/],
    [["one", "--name", "two"], /Give the name once/],
    [["--region", "Not A Region"], /not a region id/],
    [["--domain", "localhost"], /not a domain name/],
    [["--host=-oProxyCommand=evil"], /not an ssh target/],
    [["--host", "-oProxyCommand=evil"], /ambiguous/],
    [["--host", "root@host; rm -rf /"], /not an ssh target/],
    [["--image", "ghcr.io/x/y; echo"], /not an image reference/],
    [["--port", "0"], /--port must be a whole number from 1 to 65535/],
    [["--timeout", "abc"], /--timeout must be a whole number/],
    [["--unknown"], /Unknown option/],
    [["--name"], /argument missing|requires a value|argument/i],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArguments(argv)).toThrow(UsageError);
    expect(() => parseArguments(argv)).toThrow(message);
  });

  it("validates names, hosts and domains", () => {
    expect(isValidName("my-army")).toBe(true);
    expect(isValidName("agent-army-3f9c")).toBe(true);
    expect(isValidName("1army")).toBe(false);
    expect(isValidName("army-")).toBe(false);
    expect(isValidHost("ubuntu@army.example.com")).toBe(true);
    expect(isValidHost("root@[2001:db8::1]")).toBe(true);
    expect(isValidHost("-p")).toBe(false);
    expect(normalizeDomain("http://army.example.com/setup")).toBe("army.example.com");
    expect(normalizeDomain("army")).toBeUndefined();
    expect(normalizeDomain("bad_name.example.com")).toBeUndefined();
  });

  it("exits with 2 and a hint on a bad flag, and shows help and the version", async () => {
    const bad = await run(["--provider", "nope"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('Unknown provider "nope"');
    expect(bad.stdout).toContain("--help");
    expect(bad.calls).toEqual([]);

    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--provider <id>");
    expect(help.stdout).toContain("--dry-run");

    const version = await run(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe("0.1.0");
  });
});
