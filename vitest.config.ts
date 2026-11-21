import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Agent worktrees live under .claude/; never pick up their tests.
    exclude: ["node_modules/**", "dist/**", ".claude/**"],
    // Many tests run real servers, stores and child processes: 20 s leaves room on a busy machine (the default is 5 s).
    testTimeout: 20_000,
  },
});
