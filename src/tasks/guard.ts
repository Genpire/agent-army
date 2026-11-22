import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/**
 * Best-effort guard on the agents' shell. The real boundaries are the
 * per-task container, the least-privilege GitHub token and branch
 * protection; this just stops the obvious ways of stepping outside the
 * job (publishing code themselves, reading the platform's own secrets).
 * Some rules read a command's words rather than its text (see
 * simpleCommands). That is a rough reading, not a shell's.
 */

const NO_PUSH = "Agents don't push; the platform publishes the branch after review.";
const DESTRUCTIVE = "Destructive system commands are not allowed.";

const RULES: { pattern: RegExp; reason: string }[] = [
  // A git alias for push (`git config alias.p push`, `git -c alias.p=push p`, `alias.p '!git push'`). `git push` itself is found by its words (runsGitPush).
  { pattern: /\balias\.[^\s=]+(?:\s+|=)["']?(?:![^"']*\b)?push(?![\w.-])/, reason: NO_PUSH },
  { pattern: /\bgit\s+remote\s+(add|set-url)\b/, reason: "Changing git remotes is not allowed." },
  { pattern: /\bgit\s+config\b[^|;&]*\b(credential|extraheader|url\.)/i, reason: "Changing git credentials is not allowed." },
  { pattern: /(^|[\s;&|(])gh\s/, reason: "The GitHub CLI is not available to agents; the platform opens the pull request." },
  { pattern: /\/proc\/[^\s/]+\/environ/, reason: "Reading process environments is not allowed." },
  // `cd /proc/1 && cat environ` and similar split forms.
  { pattern: /\/proc\b[\s\S]*\benviron\b|\benviron\b[\s\S]*\/proc\b/, reason: "Reading process environments is not allowed." },
  { pattern: /metadata\.google\.internal|169\.254\.169\.254|Metadata-Flavor/i, reason: "The cloud metadata server is off limits." },
  // The platform's own, the AI providers' credentials the task provider puts in the environment (ai-providers.ts:
  // Bedrock's keys, Vertex's and Google Cloud's settings and key file) and the coding engines' keys (engines.ts).
  {
    pattern:
      /\b(MASTER_KEY|SETUP_TOKEN|TASK_B64|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_FOUNDRY_API_KEY|ANTHROPIC_FOUNDRY_AUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS|ANTHROPIC_VERTEX_\w+|ANTHROPIC_GOOGLE_CLOUD_\w+|AWS_BEARER_TOKEN_BEDROCK|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|OPENAI_API_KEY|CODEX_API_KEY|GEMINI_API_KEY)\b/,
    reason: "Platform secrets are off limits.",
  },
  // The Google key file itself, found without its variable (ls of the temp folder).
  { pattern: /ai-credentials-|google_application_credentials\.json/i, reason: "The AI provider's credentials file is off limits." },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/, reason: DESTRUCTIVE },
];

/** A command as it runs: its name (no path) and the words after it. */
interface Command {
  name: string;
  args: string[];
}

/** Commands refused by what runs, wherever it runs (after `;`, `&&`, `|`, in `$(…)`, behind `sudo` or `sh -c`), never by a word in their arguments. */
const COMMAND_RULES: { refuses: (c: Command) => boolean; reason: string }[] = [
  { refuses: dumpsEnvironment, reason: "Dumping the environment is not allowed." },
  { refuses: (c) => /^(shutdown|reboot|mkfs[\w.]*)$/.test(c.name), reason: DESTRUCTIVE },
];

/**
 * Commands that print the environment, best effort: `env` with nothing to
 * run (`env`, `env -0`), `printenv` or `export`, `declare` and `typeset` with
 * options only (`export -p`, `declare -x`), and `set` on its own. `printenv
 * HOME`, `export FOO=bar` and `set -e` print no secrets; a program that
 * prints its own environment is not caught.
 */
function dumpsEnvironment({ name, args }: Command): boolean {
  // commandsRun goes on to the command env runs, so env as the command has nothing to run.
  if (name === "env") return true;
  if (["printenv", "export", "declare", "typeset"].includes(name)) return args.every((a) => /^[-+]/.test(a));
  return name === "set" && args.length === 0;
}

/**
 * Commands that run the next word as a command, with their options that
 * take the word after them as a value (`sudo -u root`, `nice -n 10`): the
 * wrappers, the shells (whose -c is followed by the command), the shell's
 * own keywords, and systemctl for `systemctl reboot`. `command -v <name>`
 * only looks the name up.
 */
const WRAPPERS = new Map<string, string[]>([
  ["sudo", ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]],
  ["doas", ["-u", "-C"]],
  ["env", ["-u", "-C", "--unset", "--chdir"]],
  ["exec", ["-a"]],
  ["command", ["-v", "-V"]],
  ["nice", ["-n", "--adjustment"]],
  ["timeout", ["-s", "-k", "--signal", "--kill-after"]],
  ["xargs", ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]],
  ["watch", ["-n", "--interval"]],
  ["time", ["-f", "-o"]],
  ["sh", ["-o"]],
  ["bash", ["-o", "-O"]],
  ["zsh", ["-o"]],
  ["dash", ["-o"]],
  ["systemctl", []],
  ...["nohup", "setsid", "builtin", "eval", "if", "then", "else", "elif", "do", "while", "until", "!", "{"].map((w): [string, string[]] => [w, []]),
]);

/** A setting before a command or a wrapper's own setting: `FOO=1`. */
const SETTING = /^[A-Za-z_]\w*=/;

/** What a wrapper takes before its command: an option, a number (`timeout 5`) or a setting. */
const WRAPPER_ARG = /^-|^\d|^[A-Za-z_]\w*=/;

/**
 * How deep commands inside commands are read: `$(…)`, quoted commands
 * (`sh -c 'cd x && env'`) and quoted texts (`ssh host 'git push'`). Deeper
 * than that, a text is only split into words.
 */
const MAX_DEPTH = 4;

/** The commands of a text nested past MAX_DEPTH: split at the separators, and into words at spaces, quotes and `$`. */
const flatCommands = (text: string): string[][] =>
  text
    .split(/[;&|()`\n]/)
    .map((s) => s.split(/[\s"'$\\<>]+/).filter(Boolean))
    .filter((w) => w.length > 0);

/** What a `$(…)` or `` `…` `` outside quotes leaves in its word: its output is only known when it runs. */
const SUBSTITUTED = "$…";

/** A word that holds more than one word or a command of its own: it came from quotes. */
const holdsLine = (word: string) => /[\s;&|()`]/.test(word);

/** Where a quote that opens at `from - 1` closes; the end of the text when it does not. */
function closingQuote(text: string, quote: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

/** Where the `$(` that opens at `from - 2` closes, counting the parentheses inside; the end of the text when it does not. */
function closingParen(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && depth-- === 0) return i;
  }
  return text.length;
}

/**
 * The simple commands in a shell line, as their words, quotes taken off:
 * split at ; & | ( ) and new lines outside quotes. What runs in `$(…)` and
 * `` `…` ``, inside double quotes too, comes out as commands of its own
 * (outside quotes it adds nothing to its word). Redirections and their files
 * (`> out.txt`, `2>&1`, `<<EOF`) are left out. Best effort: a guard's
 * reading, not a shell's.
 */
function simpleCommands(line: string, depth: number): string[][] {
  if (depth >= MAX_DEPTH) return flatCommands(line);
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  // The next word is a redirection's file, or a here-string's text (`<<< "git push"`), which is read as a line.
  let target = false;
  let hereString = false;
  const endWord = () => {
    if (inWord && hereString) commands.push(...simpleCommands(word, depth + 1));
    else if (inWord && !target) words.push(word);
    if (inWord) {
      target = false;
      hereString = false;
    }
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
    target = false;
    hereString = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") {
      word += line[i + 1] ?? "";
      inWord = true;
      i++;
    } else if ((c === "$" && line[i + 1] === "(") || c === "`") {
      const start = c === "`" ? i + 1 : i + 2;
      const end = c === "`" ? closingQuote(line, "`", start) : closingParen(line, start);
      commands.push(...simpleCommands(line.slice(start, end), depth + 1));
      // Its word is only known when it runs: marked, so a rule can refuse what it cannot read (`git $(echo push)`).
      word += SUBSTITUTED;
      inWord = true;
      i = end;
    } else if (c === "'" || c === '"') {
      const end = closingQuote(line, c, i + 1);
      const text = line.slice(i + 1, end);
      if (c === '"') for (const m of text.matchAll(/\$\(([^)]*)\)?|`([^`]*)`?/g)) commands.push(...simpleCommands(m[1] ?? m[2] ?? "", depth + 1));
      word += text;
      inWord = true;
      i = end;
    } else if (c === "<" || c === ">") {
      // The descriptor in `2>` belongs to the redirection.
      if (/^\d+$/.test(word)) inWord = false;
      endWord();
      const here = line.startsWith("<<<", i);
      while (line[i + 1] === "<" || line[i + 1] === ">") i++;
      target = true;
      hereString = here;
    } else if (/[;&|()\n]/.test(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const commandName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/**
 * What one simple command runs: past its settings (`FOO=1`) and its wrappers
 * (`sudo -u root`, `timeout 5`, `sh -c`), and the commands inside a quoted
 * command (`sh -c 'cd x && reboot'`).
 */
function commandsRun(words: string[], depth: number): Command[] {
  let i = 0;
  while (i < words.length && SETTING.test(words[i]!)) i++;
  while (i < words.length) {
    const word = words[i]!;
    if (holdsLine(word)) return commandsIn(word, depth + 1);
    const name = commandName(word);
    if (name === "find") return [{ name, args: words.slice(i + 1) }, ...findRuns(words.slice(i + 1), depth)];
    const takesValue = WRAPPERS.get(name);
    if (!takesValue) return [{ name, args: words.slice(i + 1) }];
    let next = i + 1;
    while (next < words.length && WRAPPER_ARG.test(words[next]!)) next += takesValue.includes(words[next]!) ? 2 : 1;
    // A wrapper with nothing to run is the command itself (`env`, `env -0`).
    if (next >= words.length) return [{ name, args: words.slice(i + 1) }];
    i = next;
  }
  return [];
}

/** What `find … -exec <command> ;` (or -execdir, -ok, -okdir) runs, each up to its `;` or `+`. */
function findRuns(args: string[], depth: number): Command[] {
  const runs: Command[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i]!)) continue;
    let end = i + 1;
    while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
    runs.push(...commandsRun(args.slice(i + 1, end), depth));
    i = end;
  }
  return runs;
}

/** Every command a line runs (see commandsRun). */
const commandsIn = (line: string, depth = 0): Command[] => simpleCommands(line, depth).flatMap((words) => commandsRun(words, depth));

/** Every simple command in a line, with each quoted text read as a line too (`ssh host 'git push'`), for rules about a word anywhere. */
function wordLists(line: string, depth = 0): string[][] {
  return simpleCommands(line, depth).flatMap((words) => [words, ...words.filter(holdsLine).flatMap((w) => wordLists(w, depth + 1))]);
}

/** git's own options that take the next word as their value, before the subcommand (`git -C <path> push`). */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);

/** git subcommands with a push of their own to a remote (`git lfs push`, `git subtree push`). */
const PUSHING_SUBCOMMANDS = new Set(["lfs", "subtree", "annex"]);

/**
 * Whether the words after a `git` run its push: the subcommand after git's
 * own options is push. `git stash push`, `git log --grep push` and a
 * message that says push are other subcommands. A quoted "git push" (in a
 * search, say) is read as one, like `sh -c 'git push'`. A subcommand known
 * only when it runs (`git $(echo push)`, `git push$IFS`, `git "$cmd"`) is
 * refused too: the guard cannot tell it is not push.
 */
function runsGitPush(words: string[], from: number): boolean {
  let i = from;
  while (words[i]?.startsWith("-")) i += GIT_VALUE_OPTIONS.has(words[i]!) ? 2 : 1;
  const sub = words[i];
  if (sub === undefined) return false;
  if (sub === "" || sub.includes("$") || sub.includes("`")) return true;
  return sub === "push" || (PUSHING_SUBCOMMANDS.has(sub) && words.slice(i + 1).some((w) => w === "push" || w.includes("$")));
}

/** git anywhere in a line, behind any wrapper (`command git push`, `sudo -E git push`, `find … -exec git push`). */
const pushes = (line: string) => wordLists(line).some((words) => words.some((w, i) => commandName(w) === "git" && runsGitPush(words, i + 1)));

/** A pipe into a shell that reads its commands from the pipe (`… | sh`, `… | sudo bash -s`), not one running a script or -c. */
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:ba|z|da|k)?sh(?:\s+-[a-zA-Z]*s[a-zA-Z]*)?\s*(?:$|[;&|)])/;

/** Lines a pipe into a shell runs: what echo and printf print before it (`echo env | sh`, `printf 'env\\n' | bash`), best effort. */
const pipedLines = (line: string): string[] =>
  PIPE_TO_SHELL.test(line)
    ? simpleCommands(line, 0)
        .filter((w) => /^(?:echo|printf)$/.test(commandName(w[0] ?? "")))
        .map((w) => w.slice(1).join(" ").replace(/\\n/g, "\n"))
    : [];

export function checkBashCommand(command: string, protectedPaths: string[] = [], depth = 0): string | null {
  // A backslash at the end of a line joins it to the next, as the shell does.
  const line = command.replace(/\\\r?\n/g, "");
  for (const rule of RULES) {
    if (rule.pattern.test(line)) return rule.reason;
  }
  if (pushes(line)) return NO_PUSH;
  for (const c of commandsIn(line)) {
    for (const rule of COMMAND_RULES) if (rule.refuses(c)) return rule.reason;
  }
  for (const path of protectedPaths) {
    if (path && line.includes(path)) return "The platform's data directory is off limits.";
  }
  if (depth < MAX_DEPTH) {
    for (const piped of pipedLines(line)) {
      const reason = checkBashCommand(piped, protectedPaths, depth + 1);
      if (reason) return reason;
    }
  }
  return null;
}

/** The PreToolUse hook that runs each Bash command through checkBashCommand and denies a refused one with the reason. */
export function bashGuardHook(protectedPaths: string[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const command = String((input.tool_input as { command?: unknown })?.command ?? "");
    const reason = checkBashCommand(command, protectedPaths);
    if (!reason) return {};
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  };
}
