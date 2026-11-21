import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

/** The bodies of the installer's `put <path> <mode> <<'EOF'` here-documents, by the path they write. */
function hereDocuments(script: string): Map<string, string[]> {
  const docs = new Map<string, string[]>();
  for (const match of script.matchAll(/^\s*put "\$DIR\/([^"]+)" \d+ <<'EOF'\n([\s\S]*?)^EOF$/gm)) {
    docs.set(match[1], [...(docs.get(match[1]) ?? []), match[2]]);
  }
  return docs;
}

describe("deploy/install.sh", () => {
  const docs = hereDocuments(read("deploy/install.sh"));

  it("writes deploy/compose/compose.yaml as it is", () => {
    expect(docs.get("compose.yaml")).toEqual([read("deploy/compose/compose.yaml")]);
  });

  it("writes caddy/Caddyfile as one of the repo's two Caddyfiles (IP mode first)", () => {
    expect(docs.get("caddy/Caddyfile")).toEqual([read("deploy/compose/caddy/Caddyfile.ip"), read("deploy/compose/caddy/Caddyfile")]);
  });
});
