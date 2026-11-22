import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/core/config.js";
import { bashGuardHook, checkBashCommand } from "../../src/tasks/guard.js";
import { orchestratorPrompt } from "../../src/team/agents.js";
import { defaultTeam } from "../../src/team/team.js";

/**
 * The agents' shell guard (guard.ts), rule by rule: each rule refuses the
 * commands it is for, and the ordinary commands next to them go through.
 * Every rule has a case here that no other rule refuses (the /proc/<pid>/environ
 * rule excepted: the split-form rule refuses all of its cases too), so
 * dropping any one of them is noticed.
 */

const DATA_DIR = "/var/lib/acme-army";

const refused: Record<string, string[]> = {
  "git push": ["git push", "git push origin army/x", "git -C /w/repo push --force", "cd repo && git push"],
  "a git alias for push": ["git config alias.p push", "git -c alias.p=push p", "git config alias.pa 'push --all'"],
  "git remotes": ["git remote add evil https://evil.example.com/x.git", "git remote set-url origin https://evil.example.com/x.git"],
  "git credentials": [
    "git config credential.helper store",
    "git config --global credential.helper '!f() { cat; }; f'",
    "git config http.https://github.com/.extraheader 'Authorization: Basic x'",
    'git config url."https://evil.example.com/".insteadOf https://github.com/',
  ],
  "GitHub CLI": ["gh pr create", "gh auth token", "cd repo; gh api user"],
  "process environments": ["cat /proc/1/environ", "tr '\\0' '\\n' < /proc/self/environ", "cd /proc/1 && cat environ"],
  "metadata server": ["curl http://169.254.169.254/latest/meta-data", "curl -H 'Metadata-Flavor: Google' http://metadata.google.internal/"],
  "platform secrets": ["echo $MASTER_KEY", "echo $SETUP_TOKEN", "echo $TASK_B64 | base64 -d", "echo $ANTHROPIC_AUTH_TOKEN", "echo $ANTHROPIC_CUSTOM_HEADERS"],
  "credentials file": ["ls /tmp/ai-credentials-1/", "cat google_application_credentials.json"],
  "environment dump": ["env", "printenv", "env | grep TOKEN", "printenv > /tmp/x"],
  "destructive commands": ["shutdown -h now", "reboot", "mkfs.ext4 /dev/sda1"],
  "rm -rf /": ["rm -rf /", "rm -fr /"],
  "data directory": [`cat ${DATA_DIR}/config.enc`, `ls ${DATA_DIR}`, `tar czf /tmp/x.tgz ${DATA_DIR}/tasks`],
};

const allowed = [
  "npm test",
  "npx vitest run test/app.test.ts",
  "git status && git diff --stat",
  "git add -A && git commit -m 'Fix the login redirect'",
  "git log --oneline -5",
  "git remote -v",
  "git config user.name 'Pointer'",
  "git config --get user.email",
  "ls -la /proc/cpuinfo",
  "cat /proc/meminfo",
  "curl -s https://registry.npmjs.org/react",
  "echo $HOME $PATH $NODE_ENV",
  "NODE_ENV=test npm run build",
  "ls /tmp",
  "rm -rf dist node_modules/.cache",
  "rm -rf ./build/",
  "grep -rn 'environment' docs/",
  "cat .env.example",
  "ls /var/lib",
];

describe("bash guard, rule by rule", () => {
  for (const [rule, commands] of Object.entries(refused)) {
    it(`refuses: ${rule}`, () => {
      for (const cmd of commands) expect(checkBashCommand(cmd, [DATA_DIR]), cmd).not.toBeNull();
    });
  }

  it("lets the ordinary commands next to them through", () => {
    for (const cmd of allowed) expect(checkBashCommand(cmd, [DATA_DIR]), cmd).toBeNull();
  });

  it("ignores an empty protected path instead of refusing everything", () => {
    expect(checkBashCommand("npm test", [""])).toBeNull();
    expect(checkBashCommand(`cat ${DATA_DIR}/config.enc`, ["", DATA_DIR])).not.toBeNull();
  });
});

const NO_PUSH = "Agents don't push; the platform publishes the branch after review.";
const DUMP = "Dumping the environment is not allowed.";
const DESTRUCTIVE = "Destructive system commands are not allowed.";

describe("the no-push rule refuses git's push only", () => {
  it("refuses push after git's own options, behind wrappers and inside quoted commands", () => {
    for (const cmd of [
      "git -c http.extraheader=x push",
      "git --git-dir=.git --work-tree=. push",
      "git --git-dir .git --namespace x push origin main",
      "git --no-pager -P push",
      'git -C "/my repo" push',
      "git -C $(pwd) push",
      "command git push",
      "sudo -E git push origin main",
      "env GIT_TRACE=1 git push",
      "GIT_DIR=.git git push",
      "/usr/bin/git push",
      "bash -c 'git push'",
      'sh -c "cd repo && git push origin main"',
      "echo x | xargs git push",
      "timeout 60 git push",
      "find . -maxdepth 0 -exec git push \\;",
      "echo `git push`",
      // A line continuation, and a subcommand put together from quotes.
      "git \\\n  push origin main",
      "git 'push'",
      "git pu''sh",
      // Subcommands that publish to a remote with a push of their own.
      "git subtree push --prefix=lib origin main",
      "git lfs push origin main",
    ]) {
      expect(checkBashCommand(cmd), cmd).toBe(NO_PUSH);
    }
  });

  it("lets the other subcommands through, push in their arguments or messages included", () => {
    for (const cmd of [
      "git stash push",
      "git stash push -u -- src/login.ts src/new-file.ts",
      "git -C repo stash push -u -- src/login.ts",
      "git stash push -m 'before push' && git stash pop",
      "git log --grep push",
      "git log --oneline --grep=push -5",
      "git commit -m 'Fix push notifications'",
      'git commit -am "Retry push on a timeout"',
      "git -c push.default=current status",
      "git config --get push.default",
      "git help push",
      "grep -rn 'push(' src",
      "cat docs/push.md",
    ]) {
      expect(checkBashCommand(cmd), cmd).toBeNull();
    }
  });
});

describe("what the guard cannot read is not let through", () => {
  it("refuses a git subcommand known only when it runs, here-strings, find -exec and pipes into a shell", () => {
    for (const cmd of [
      "git $(echo push)",
      "git `echo push`",
      'git "$(echo push)"',
      "git push$IFS",
      "git push${IFS}origin main",
      'git "$cmd" origin main',
      "git lfs $(echo push) origin",
      'bash <<< "git push"',
      "sh <<< 'git push origin main'",
      "echo 'git push' | sh",
      "printf 'git push\\n' | bash -s",
      "git config alias.p '!git push'",
      "git -c alias.p='!f() { git push; }; f' p",
    ]) {
      expect(checkBashCommand(cmd), cmd).toBe(NO_PUSH);
    }
    for (const cmd of ["find / -exec reboot \\;", "echo reboot | sh", "bash <<< reboot", "echo 'shutdown -h now' | sudo bash"]) {
      expect(checkBashCommand(cmd), cmd).toBe(DESTRUCTIVE);
    }
    for (const cmd of ["echo env | sh", "echo printenv | bash", "bash <<< env", "sh <<< printenv", "find . -maxdepth 0 -exec env \\;", "find . -maxdepth 0 -execdir printenv \\;"]) {
      expect(checkBashCommand(cmd), cmd).toBe(DUMP);
    }
  });

  it("lets the ordinary forms of the same things through", () => {
    for (const cmd of [
      'git -C "$DIR" status',
      "git -C $(pwd) status",
      'git log -1 --format="%H $(date)"',
      "git config alias.st status",
      'grep -c x <<< "hello"',
      "echo env",
      "echo reboot > notes.txt",
      "find . -name '*.ts' -exec grep -l env {} +",
      "find src -type f -exec wc -l {} \\;",
      "cat setup.sh | sh",
    ]) {
      expect(checkBashCommand(cmd), cmd).toBeNull();
    }
  });
});

describe("destructive system commands are refused only as the command", () => {
  it("refuses them at the start, after a separator, inside $( ) or ( ), and behind a wrapper", () => {
    for (const cmd of [
      "ls && reboot",
      "true || shutdown -r now",
      "echo x | xargs reboot",
      "x=$(reboot)",
      "(shutdown -r now)",
      "/sbin/shutdown -r now",
      "sudo reboot",
      "sudo -u root reboot",
      "env FOO=1 reboot",
      "exec reboot",
      "nohup reboot &",
      "timeout 5 reboot",
      "nice -n 10 mkfs.ext4 /dev/sda1",
      "bash -c 'reboot'",
      "bash -lc 'sleep 1 && reboot'",
      "if true; then reboot; fi",
      "systemctl reboot",
    ]) {
      expect(checkBashCommand(cmd), cmd).toBe(DESTRUCTIVE);
    }
  });

  it("lets the words through as arguments and inside file names", () => {
    for (const cmd of [
      "grep -rn reboot src",
      "grep -rn 'shutdown' src",
      "cat docs/shutdown.md",
      "ls scripts/reboot-staging.sh",
      "./scripts/reboot-staging.sh",
      "npm run shutdown",
      "make mkfs-image",
      "command -v reboot",
      'git commit -m "Fix (shutdown) ordering"',
      'grep -E "(reboot|shutdown)" docs',
    ]) {
      expect(checkBashCommand(cmd), cmd).toBeNull();
    }
  });
});

describe("environment dumps", () => {
  it("refuses env and printenv in substitutions and subshells, env's own options, and the shell's own listings", () => {
    for (const cmd of [
      'echo "$(env)"',
      "echo $(printenv)",
      "(env)",
      "echo `env`",
      "cat <(env)",
      "{ env; }",
      "env -0",
      "env -0 | tr '\\0' '\\n'",
      "env -u PATH",
      "env FOO=bar",
      "sudo env",
      "bash -c 'env | grep KEY'",
      "printenv 2>&1 | grep KEY",
      "printenv -0",
      "export -p",
      "export",
      "declare -x",
      "declare -p",
      "typeset -x",
      "set",
      "set | grep KEY",
    ]) {
      expect(checkBashCommand(cmd), cmd).toBe(DUMP);
    }
  });

  it("lets ordinary uses through", () => {
    for (const cmd of [
      "env NODE_ENV=test npm test",
      "env -i PATH=/usr/bin npm test",
      "env -u FOO npm test",
      "printenv HOME",
      "export FOO=bar",
      "export -n FOO",
      "declare -A seen",
      "set -e",
      "set -o pipefail",
      "set -euo pipefail",
      "which env",
      "echo 'set'",
      'git commit -m "Read the port from env (PORT)"',
    ]) {
      expect(checkBashCommand(cmd), cmd).toBeNull();
    }
  });
});

describe("the red/green proof the prompts ask for", () => {
  /** The git commands in a text's code spans, with their placeholders filled in. */
  const gitCommands = (text: string) =>
    [...text.matchAll(/`(git [^`]+)`/g)].map((m) => m[1]!.replace("<base>", "main").replace(/<[^>]+>/g, "src/login.ts src/new-file.ts"));

  it("gets through the shell guard, every command of it", () => {
    const proof = orchestratorPrompt(ConfigSchema.parse({})).split("\n").find((l) => l.includes("- Test proof:")) ?? "";
    const qa = defaultTeam().agents.find((a) => a.id === "qa")!.instructions;
    for (const text of [proof, qa]) {
      const commands = gitCommands(text);
      expect(commands).toContain("git stash push -u -m red-green-proof -- src/login.ts src/new-file.ts");
      expect(commands).toContain("git stash pop");
      expect(commands).toContain("git checkout main -- src/login.ts src/new-file.ts");
      for (const cmd of commands) expect(checkBashCommand(cmd, [DATA_DIR]), cmd).toBeNull();
    }
  });
});

describe("the hook the worker gives the agents' shell", () => {
  const hook = bashGuardHook([DATA_DIR]);
  const call = (input: Record<string, unknown>) =>
    hook({ hook_event_name: "PreToolUse", session_id: "s", transcript_path: "t", cwd: "/w", ...input } as never, "tool-1", {
      signal: new AbortController().signal,
    });
  const denial = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

  it("denies a refused Bash command with the reason, the protected paths included", async () => {
    expect(await call({ tool_name: "Bash", tool_input: { command: "git push origin main" } })).toEqual(denial(NO_PUSH));
    expect(await call({ tool_name: "Bash", tool_input: { command: `cat ${DATA_DIR}/config.enc` } })).toEqual(
      denial("The platform's data directory is off limits."),
    );
  });

  it("lets the rest through: allowed commands, other tools and other events", async () => {
    expect(await call({ tool_name: "Bash", tool_input: { command: "git stash push -u -- src/login.ts" } })).toEqual({});
    expect(await call({ tool_name: "Bash", tool_input: {} })).toEqual({});
    expect(await call({ tool_name: "Read", tool_input: { command: "git push" } })).toEqual({});
    expect(await call({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push" } })).toEqual({});
  });
});
