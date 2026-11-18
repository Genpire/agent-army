import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Agent worktrees live under .claude/; never pick up their tests.
    exclude: ["node_modules/**", "dist/**", ".claude/**"],
  },
});
