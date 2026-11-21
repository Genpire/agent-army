import { describe, expect, it } from "vitest";
import { CommandError, createRunner, formatCommand, spawnLaunch } from "../../packages/create-agent-army/src/exec.js";
import { createOutput } from "../../packages/create-agent-army/src/output.js";
import { Redactor } from "../../packages/create-agent-army/src/secrets.js";

const SECRET = "c2VjcmV0LXZhbHVlLWZvci10ZXN0cw==";

function setup(dryRun = false) {
  let shown = "";
  const commandRedactor = new Redactor();
  commandRedactor.add(SECRET, "<MASTER_KEY>");
  const screenRedactor = new Redactor();
  screenRedactor.add(SECRET, "<MASTER_KEY hidden>");
  const out = createOutput({
    stdout: { write: (t) => void (shown += t) },
    stderr: { write: (t) => void (shown += t) },
    redactor: screenRedactor,
  });
  const runner = createRunner({ launch: spawnLaunch, out, redactor: commandRedactor, dryRun });
  return { runner, shown: () => shown };
}

describe("create-agent-army: running commands", () => {
  it("quotes commands so they can be copied", () => {
    expect(formatCommand("railway", ["variable", "set", "A=1", "PUBLIC_URL=https://x.up.railway.app"])).toBe(
      "railway variable set A=1 PUBLIC_URL=https://x.up.railway.app",
    );
    expect(formatCommand("echo", ["it's", "", "a b", "value(status.url)"])).toBe(`echo 'it'\\''s' '' 'a b' 'value(status.url)'`);
  });

  it("passes stdin and the environment to a real child, and redacts what it prints", async () => {
    const { runner, shown } = setup();
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('got '+s.trim());console.log('env '+process.env.MASTER_KEY)})";
    const result = await runner.run(process.execPath, ["-e", script], { input: SECRET, env: { MASTER_KEY: SECRET } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`got ${SECRET}`);
    expect(shown()).toContain("got <MASTER_KEY hidden>");
    expect(shown()).toContain("env <MASTER_KEY hidden>");
    expect(shown()).not.toContain(SECRET);
  });

  it("throws on failure with the captured output's end, redacted on screen", async () => {
    const { runner } = setup();
    const failing = runner.run(process.execPath, ["-e", `console.error('bad ${SECRET}');process.exit(3)`], { capture: true });
    await expect(failing).rejects.toBeInstanceOf(CommandError);
    await expect(failing).rejects.toMatchObject({ code: 3 });
    const allowed = await runner.run(process.execPath, ["-e", "process.exit(4)"], { allowFailure: true, capture: true });
    expect(allowed.code).toBe(4);
  });

  it("says when a program is not installed", async () => {
    const { runner } = setup();
    await expect(runner.run("definitely-not-a-real-cli-4f2a", ["--version"])).rejects.toThrow("is not installed");
    expect((await runner.probe("definitely-not-a-real-cli-4f2a", ["--version"])).notFound).toBe(true);
  });

  it("prints instead of running in a dry run, but still runs probes", async () => {
    const { runner, shown } = setup(true);
    const result = await runner.run(process.execPath, ["-e", "process.exit(9)"], { dryRunStdout: "{}" });
    expect(result).toEqual({ code: 0, stdout: "{}", stderr: "" });
    expect(shown()).toContain("process.exit(9)");
    const probe = await runner.probe(process.execPath, ["-e", "console.log('probed')"]);
    expect(probe.stdout.trim()).toBe("probed");
  });
});
