import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useState } from "react";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import { CAP_MAX, CAP_VARIANT, type ProviderSpendView, type UsageView, capError, capsFor, spendAgainstCap, tokenCount } from "../overview/spending";
import { SaveRow } from "./parts";

interface ProviderRow extends Record<string, unknown> {
  provider: string;
  view: ProviderSpendView;
}

/** What a provider's spend is made of, in one line. */
function spendDetail(p: ProviderSpendView): string {
  const work = [p.tasks ? plural(p.tasks, "repo task") : "", p.chats ? plural(p.chats, "chat reply", "chat replies") : ""].filter(Boolean).join(" · ");
  if (p.kind === "engine") {
    const model = p.model || "the CLI's default model";
    const tokens = p.tokens ? `${tokenCount(p.tokens)} this month` : "No runs this month";
    return p.priced === false
      ? `${tokens}. Tokens only: ${model} has no price here, so there is no dollar figure and its cap cannot stop runs.`
      : `${tokens}, estimated at ${model}'s list price (the CLIs report tokens, not dollars).`;
  }
  return work || "Nothing spent this month";
}

/**
 * Monthly caps per AI provider (what chat and repo tasks run on) and per coding agent CLI.
 * At a provider's cap, new repo tasks and chat replies on it are refused; at an engine's,
 * the agents that work through it are left out of new repo tasks.
 */
export function ProviderCaps({ saved, usage, reload }: { saved: Record<string, number>; usage: UsageView | undefined; reload: () => Promise<void> }) {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  const [draft, setDraft] = useState<Record<string, number>>(saved);
  const providers = usage?.providers ?? [];
  const ids = providers.map((p) => p.provider);
  const capOf = (id: string, caps: Record<string, number>) => caps[id] ?? 0;
  const isDirty = ids.some((id) => capOf(id, draft) !== capOf(id, saved));
  const invalid = ids.some((id) => capError(capOf(id, draft)));

  const save = () =>
    void run(
      async () => {
        await api.post("/api/budget", { perProviderUsd: capsFor({ ...saved, ...draft }, [...ids, ...Object.keys(saved)]) });
        await Promise.all([refresh(), reload()]);
      },
      { success: "Provider caps saved." },
    );

  const columns: TableColumn<ProviderRow>[] = [
    {
      key: "provider",
      header: "Provider",
      width: proportional(1.2, { minWidth: 140 }),
      renderCell: ({ view }) => (
        <VStack gap={0.5}>
          <Text weight="medium">{view.name}</Text>
          <Text type="supporting">{`${view.kind === "engine" ? "Coding agent CLI" : "AI provider"}${view.configured ? "" : " · not connected"}`}</Text>
        </VStack>
      ),
    },
    {
      key: "used",
      header: "This month",
      width: proportional(2, { minWidth: 200 }),
      renderCell: ({ view }) => (
        <VStack gap={1}>
          {view.capUsd ? (
            <ProgressBar label={`${view.name} this month`} isLabelHidden value={Math.min(view.usd, view.capUsd)} max={view.capUsd} variant={CAP_VARIANT[view.level]} />
          ) : null}
          <Text hasTabularNumbers>{spendAgainstCap(view)}</Text>
          <Text type="supporting">{spendDetail(view)}</Text>
        </VStack>
      ),
    },
    {
      key: "cap",
      header: "Monthly cap",
      width: pixel(148),
      renderCell: ({ provider, view }) => {
        const value = capOf(provider, draft);
        const error = capError(value);
        return (
          <NumberInput
            label={`Monthly cap for ${view.name}`}
            isLabelHidden
            value={value}
            onChange={(v) => setDraft((d) => ({ ...d, [provider]: v }))}
            min={0}
            max={CAP_MAX}
            step={5}
            units="USD"
            width={132}
            isWheelEnabled={false}
            status={error ? { type: "error", message: error } : undefined}
            statusVariant="tooltip"
          />
        );
      },
    },
  ];

  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={4} accessibilityLevel={3}>
          Per AI provider
        </Heading>
        <Text type="supporting">
          What each provider and coding agent CLI may cost per month. At a provider's cap, new repo tasks and chat replies on it are refused; at a CLI's cap, the agents that work through it sit out new repo tasks. Codex and Gemini CLI report tokens, so their dollars are estimates. 0 means no cap.
        </Text>
      </VStack>
      <Table<ProviderRow>
        data={providers.map((view) => ({ provider: view.provider, view }))}
        columns={columns}
        idKey="provider"
        density="balanced"
        textOverflow="wrap"
        emptyState={<EmptyState isCompact title={usage ? "No provider connected" : "Loading"} description={usage ? "Connect an AI provider under Integrations." : "Reading this month's spend."} />}
      />
      <SaveRow label="Save provider caps" isDirty={isDirty} isInvalid={invalid} pending={pending} onSave={save} />
    </VStack>
  );
}
