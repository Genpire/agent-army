import { describe, expect, it } from "vitest";
import { checkBashCommand } from "../../src/tasks/guard.js";

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
  "destructive commands": ["shutdown -h now", "reboot", "mkfs.ext4 /dev/sda1", "rm -rf /", "rm -fr /"],
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
