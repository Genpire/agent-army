/**
 * Best-effort guard on the agents' shell. The real boundaries are the
 * per-task container, the least-privilege GitHub token and branch
 * protection; this just stops the obvious ways of stepping outside the
 * job (publishing code themselves, reading the platform's own secrets).
 */
const RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+(?:[^|;&]*\s)?push\b/, reason: "Agents don't push; the platform publishes the branch after review." },
  { pattern: /\bgit\s+remote\s+(add|set-url)\b/, reason: "Changing git remotes is not allowed." },
  { pattern: /\bgit\s+config\b[^|;&]*\b(credential|extraheader|url\.)/i, reason: "Changing git credentials is not allowed." },
  { pattern: /(^|[\s;&|(])gh\s/, reason: "The GitHub CLI is not available to agents; the platform opens the pull request." },
  { pattern: /\/proc\/[^\s/]+\/environ/, reason: "Reading process environments is not allowed." },
  // `cd /proc/1 && cat environ` and similar split forms.
  { pattern: /\/proc\b[\s\S]*\benviron\b|\benviron\b[\s\S]*\/proc\b/, reason: "Reading process environments is not allowed." },
  { pattern: /metadata\.google\.internal|169\.254\.169\.254|Metadata-Flavor/i, reason: "The cloud metadata server is off limits." },
  // The platform's own, and the AI providers' credentials the task provider puts in the environment (ai-providers.ts).
  {
    pattern: /\b(MASTER_KEY|SETUP_TOKEN|TASK_B64|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_FOUNDRY_API_KEY|ANTHROPIC_CUSTOM_HEADERS|AWS_BEARER_TOKEN_BEDROCK)\b/,
    reason: "Platform secrets are off limits.",
  },
  { pattern: /(^|[\s;&|(])(printenv|env)\s*($|[|;&>])/, reason: "Dumping the environment is not allowed." },
  { pattern: /\b(shutdown|reboot|mkfs\w*)\b|\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/, reason: "Destructive system commands are not allowed." },
];

export function checkBashCommand(command: string, protectedPaths: string[] = []): string | null {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) return rule.reason;
  }
  for (const path of protectedPaths) {
    if (path && command.includes(path)) return "The platform's data directory is off limits.";
  }
  return null;
}
