import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { SecretField } from "../../components/SecretField";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { GitHubConnectionView } from "../../lib/types";
import { allowListError, parseList } from "./catalog";
import { FormActions, FormError, PaneSection, useSave } from "./parts";

/** Mirrors MAX_EXTRA_GITHUB in src/server.ts. */
const MAX_CONNECTIONS = 10;

interface ConnectionRow extends Record<string, unknown> {
  id: string;
  conn: GitHubConnectionView;
}

/** Up to ten more tokens, each with its own allow list: for repos the primary token cannot reach. */
export function GitHubConnections() {
  const { config } = useConfig();
  const extra = config.github.extra;
  const rows: ConnectionRow[] = extra.map((conn) => ({ id: conn.id, conn }));
  const isNarrow = useMediaQuery("(max-width: 640px)");

  return (
    <PaneSection
      title="Other connections"
      description={
        <>
          For repos outside your organisation, such as a private repo on someone's personal account. Fine-grained tokens cover one owner, so add a token that
          can reach that repo (a fine-grained token made by the repo's owner, or a classic token with the <Code size="inherit">repo</Code> scope) and limit it to the exact
          repo. For each repo, the most specific allow list wins.
        </>
      }>
      {rows.length > 0 ? (
        <Table<ConnectionRow>
          data={rows}
          idKey="id"
          verticalAlign="top"
          columns={[
            {
              key: "user",
              header: "GitHub user",
              width: proportional(1, { minWidth: isNarrow ? 120 : 150 }),
              renderCell: ({ conn }) => (
                <VStack gap={0.5} hAlign="start">
                  <Text weight="semibold">{conn.login ?? "Unknown user"}</Text>
                  {conn.key && <Text type="supporting">Token {conn.key}</Text>}
                  {isNarrow && <RemoveButton conn={conn} />}
                </VStack>
              ),
            },
            { key: "allowed", header: "Allowed owners or repos", width: proportional(2, { minWidth: isNarrow ? 200 : 260 }), renderCell: ({ conn }) => <AllowListCell conn={conn} /> },
            // On a phone the Remove button sits under the user, so the table fits without scrolling sideways.
            ...(isNarrow
              ? []
              : [{ key: "remove", header: "", width: pixel(176), resizable: false, align: "end" as const, renderCell: ({ conn }: ConnectionRow) => (
                    <HStack hAlign="end">
                      <RemoveButton conn={conn} />
                    </HStack>
                  ),
                },
              ]),
          ]}
        />
      ) : (
        <Text color="secondary">None yet.</Text>
      )}
      <AddConnection full={extra.length >= MAX_CONNECTIONS} />
    </PaneSection>
  );
}

/** A connection's allow list, edited in place; Save appears once it changes. */
function AllowListCell({ conn }: { conn: GitHubConnectionView }) {
  const saved = conn.allowed.join(", ");
  const [value, setValue] = useState(saved);
  const { save, error, edit } = useSave();
  const entries = parseList(value);
  const listError = allowListError(entries);
  const changed = entries.join(",") !== conn.allowed.join(",");
  const who = conn.login ?? "this connection";

  return (
    <VStack gap={2}>
      <TextInput
        label={`Allowed owners or repos for ${who}`}
        isLabelHidden
        size="sm"
        value={value}
        onChange={edit(setValue)}
        placeholder="Any repository the token can reach"
        status={listError ? { type: "error", message: listError } : undefined}
        statusVariant="detached"
      />
      {changed && (
        <FormActions>
          <Button
            label="Save"
            size="sm"
            variant="primary"
            isDisabled={Boolean(listError)}
            clickAction={async () => {
              const ok = await save(() => api.post("/api/github/connections/update", { id: conn.id, allowed: entries }), {
                invalid: listError,
                success: `Saved the allow list for ${who}.`,
              });
              if (ok) setValue(entries.join(", "));
            }}
          />
          <Button label="Undo" size="sm" variant="ghost" onClick={edit(() => setValue(saved))} />
        </FormActions>
      )}
      <FormError message={error} />
    </VStack>
  );
}

function RemoveButton({ conn }: { conn: GitHubConnectionView }) {
  const { save } = useSave();
  return (
    <ConfirmButton
      label="Remove"
      confirmLabel="Click again to remove"
      onConfirm={async () => {
        await save(() => api.post("/api/github/connections/delete", { id: conn.id }), { success: `Removed the connection for ${conn.login ?? "the token"}.` });
      }}
    />
  );
}

function AddConnection({ full }: { full: boolean }) {
  const [token, setToken] = useState("");
  const [allowed, setAllowed] = useState("");
  const { save, error, edit } = useSave();
  const entries = parseList(allowed);
  const listError = allowListError(entries);

  const submit = async () => {
    const t = token.trim();
    const invalid = !t ? "Paste a GitHub token." : t.length < 20 ? "That doesn't look like a GitHub token." : listError;
    const ok = await save(() => api.post<{ login?: string }>("/api/github/connections", { token: t, allowed: entries }), {
      invalid,
      success: (r) => {
        const login = r.login;
        return login ? `Connection added for ${login}.` : "Connection added.";
      },
    });
    if (ok) {
      setToken("");
      setAllowed("");
    }
  };

  return (
    <VStack gap={4}>
      <Heading level={4}>Add a connection</Heading>
      {full ? (
        <Text color="secondary">You have {MAX_CONNECTIONS} connections, the most there can be. Remove one to add another.</Text>
      ) : (
        <>
          <FormLayout>
            <SecretField label="GitHub token" value={token} onChange={edit(setToken)} placeholder="github_pat_… or ghp_…" isRequired />
            <TextInput
              label="Allowed owners or repos"
              value={allowed}
              onChange={edit(setAllowed)}
              placeholder="someone/some-repo"
              description="Each exact repo is checked with the token before saving. Empty means any repository the token can reach."
              status={listError ? { type: "error", message: listError } : undefined}
              isOptional
            />
          </FormLayout>
          <FormError message={error} />
          <FormActions>
            <Button label="Verify and add" variant="primary" isDisabled={Boolean(listError)} clickAction={submit} />
          </FormActions>
        </>
      )}
    </VStack>
  );
}
