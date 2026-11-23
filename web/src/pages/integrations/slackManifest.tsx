/**
 * The Slack app's two manifests as the Slack card loads them: the bot's (to
 * create or update the app) and the one for the owner's own account (Your
 * Slack account: the bot's plus user scopes and events). With the parts both
 * sections show: a table of scopes and the manifest to paste.
 */
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Table, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useState } from "react";
import type { buildAccountManifest, buildManifest } from "../../../../src/slack/slack.js";
import { api, errorMessage } from "../../lib/api";

export type BotManifest = ReturnType<typeof buildManifest>;
export type AccountManifest = ReturnType<typeof buildAccountManifest>;

/** GET /api/slack/manifest, and with ?account=1 the account's. */
interface ManifestResponse<M> {
  manifest: M;
  /** Slack's "create from manifest" page with this deployment's manifest filled in. */
  createUrl: string;
}

/** A manifest, loaded once per pane. */
function useManifest<M>(path: string) {
  const [data, setData] = useState<ManifestResponse<M>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api
      .get<ManifestResponse<M>>(path)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [path]);
  return { data, error };
}

/** The bot's manifest: no user scopes or events, so the app never asks for anyone's own account. */
export const useBotManifest = () => useManifest<BotManifest>("/api/slack/manifest");
/** The manifest for the owner's own account, for the Your Slack account section only. */
export const useAccountManifest = () => useManifest<AccountManifest>("/api/slack/manifest?account=1");

interface ScopeRow extends Record<string, unknown> {
  scope: string;
  use: string;
}

/** Scopes and what each is for; a scope missing from `uses` is listed without a reason. */
export function ScopeTable({ scopes, uses }: { scopes: string[]; uses: Record<string, string> }) {
  return (
    <Table<ScopeRow>
      data={scopes.map((scope) => ({ scope, use: uses[scope] ?? "" }))}
      idKey="scope"
      density="compact"
      columns={[
        { key: "scope", header: "Scope", width: proportional(1, { minWidth: 130 }), renderCell: (r) => <Code size="inherit">{r.scope}</Code> },
        { key: "use", header: "What it is for", width: proportional(2, { minWidth: 150 }) },
      ]}
    />
  );
}

/** The manifest's JSON to paste in Slack, folded. */
export function ManifestCode({ label, manifest, error }: { label: string; manifest: object | undefined; error: string | undefined }) {
  return (
    <Collapsible trigger={<Text weight="semibold">{label}</Text>} defaultIsOpen={false}>
      {manifest ? (
        <CodeBlock code={JSON.stringify(manifest, null, 2)} language="json" title="manifest.json" width="100%" maxHeight={360} size="sm" />
      ) : (
        <Text color="secondary">{error ? `Couldn't load the manifest: ${error}` : "Loading the manifest…"}</Text>
      )}
    </Collapsible>
  );
}
