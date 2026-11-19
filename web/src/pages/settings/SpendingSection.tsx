import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { useConfig } from "../../lib/state";
import type { PublicConfig } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { CAP_VARIANT, type CapStatus, type UsageView, capLine, useSpending } from "../overview/spending";
import { AddRow } from "../projects/components/AddRow";
import { CHANNEL_ERROR, REPO_ERROR, REPO_RE, findRepo, parseChannelId } from "../projects/validation";
import { SaveRow, SettingsSection } from "./parts";

type Budget = PublicConfig["budget"];

/** Mirrors BudgetSchema (src/config.ts); the server checks again. */
const CAP_MAX = 100_000;
const CAP_ERROR = `Use an amount from 0 (no cap) to ${CAP_MAX.toLocaleString()}.`;
const capError = (n: number) => (!Number.isFinite(n) || n < 0 || n > CAP_MAX ? CAP_ERROR : undefined);
const percentError = (n: number) => (!Number.isInteger(n) || n < 10 || n > 100 ? "Use a whole percent from 10 to 100." : undefined);

/**
 * Settings → Spending: the monthly Claude budget, when to alert and where,
 * and caps for single repositories. Everything here is checked before a task
 * or a chat reply starts; running tasks finish within their own budget.
 */
export function SpendingSection({ saved, pointer }: { saved: Budget; pointer: string }) {
  const usage = useSpending();
  const formKey = JSON.stringify([saved.monthlyUsd, saved.alertPercent, saved.alertChannel]);
  return (
    <SettingsSection
      title="Spending"
      description={`Caps on what Claude may cost per calendar month (UTC). When one is used up, new repo tasks are refused with a message that says so, and so are ${pointer}'s chat replies for the monthly cap; running tasks finish within their own budget. A task never gets a bigger budget than what is left. 0 means no cap.`}>
      <CapsForm key={formKey} saved={saved} usage={usage.data} reload={usage.reload} />
      <RepoCaps saved={saved.perRepoUsd} usage={usage.data} reload={usage.reload} />
    </SettingsSection>
  );
}

function CapsForm({ saved, usage, reload }: { saved: Budget; usage: UsageView | undefined; reload: () => Promise<void> }) {
  const { refresh } = useConfig();
  const { run, pending } = useAction();
  const [monthlyUsd, setMonthlyUsd] = useState(saved.monthlyUsd);
  const [alertPercent, setAlertPercent] = useState(saved.alertPercent);
  const [channel, setChannel] = useState(saved.alertChannel);
  const channelId = channel.trim() ? parseChannelId(channel) : "";
  const errors = {
    monthlyUsd: capError(monthlyUsd),
    alertPercent: percentError(alertPercent),
    channel: channelId === undefined ? CHANNEL_ERROR : undefined,
  };
  const isDirty = monthlyUsd !== saved.monthlyUsd || alertPercent !== saved.alertPercent || (channelId ?? channel) !== saved.alertChannel;
  const save = () =>
    void run(
      async () => {
        await api.post("/api/budget", { monthlyUsd, alertPercent, alertChannel: channelId ?? "" });
        await Promise.all([refresh(), reload()]);
      },
      { success: monthlyUsd > 0 ? `Monthly budget set to ${usd(monthlyUsd)}.` : "Spending settings saved. There is no monthly cap." },
    );
  const monthly = usage?.budget.monthly;
  const spent = usage ? `${usd(usage.totalUsd)} spent so far this month${monthly ? ` (${monthly.percent}% of the saved cap)` : ""}.` : "";
  return (
    <VStack gap={5}>
      <NumberInput
        label="Monthly budget"
        description={`Chat replies and repo tasks together. ${spent}`.trim()}
        value={monthlyUsd}
        onChange={setMonthlyUsd}
        min={0}
        max={CAP_MAX}
        step={5}
        units="USD"
        hasNumberSteppers
        status={errors.monthlyUsd ? { type: "error", message: errors.monthlyUsd } : undefined}
      />
      <NumberInput
        label="Alert at"
        description="Warns when a cap is this far used, and again when it is used up: on the Overview page, and in Slack when a channel is set."
        value={alertPercent}
        onChange={setAlertPercent}
        min={10}
        max={100}
        step={5}
        units="%"
        isIntegerOnly
        hasNumberSteppers
        status={errors.alertPercent ? { type: "error", message: errors.alertPercent } : undefined}
      />
      <TextInput
        label="Alert channel"
        description="The Slack channel ID for spending alerts (invite the app there); a channel link works too. Each alert is posted once a month. Empty: alerts show only here."
        value={channel}
        onChange={setChannel}
        placeholder="C012ABCDEF"
        isOptional
        autoCapitalize="characters"
        hasAutoCorrect={false}
        hasSpellCheck={false}
        status={errors.channel ? { type: "error", message: errors.channel } : undefined}
        onEnter={save}
      />
      <SaveRow label="Save spending" isDirty={isDirty} isInvalid={Object.values(errors).some(Boolean)} pending={pending} onSave={save} />
    </VStack>
  );
}

interface CapRow extends Record<string, unknown> {
  repo: string;
  capUsd: number;
  status: CapStatus | undefined;
}

function RepoCaps({ saved, usage, reload }: { saved: Record<string, number>; usage: UsageView | undefined; reload: () => Promise<void> }) {
  const { refresh } = useConfig();
  const { run } = useAction();
  const [repo, setRepo] = useState("");
  const [cap, setCap] = useState(10);
  const [errors, setErrors] = useState<{ repo?: string; cap?: string }>({});

  const statusOf = (name: string) => usage?.budget.repos.find((r) => r.repo.toLowerCase() === name.toLowerCase());
  const rows: CapRow[] = Object.entries(saved)
    .map(([name, capUsd]) => ({ repo: name, capUsd, status: statusOf(name) }))
    .sort((a, b) => a.repo.localeCompare(b.repo));

  const save = (next: Record<string, number>, success: string) =>
    run(
      async () => {
        await api.post("/api/budget", { perRepoUsd: next });
        await Promise.all([refresh(), reload()]);
      },
      { success },
    );

  const add = async () => {
    const target = repo.trim();
    const found = { repo: REPO_RE.test(target) ? undefined : REPO_ERROR, cap: cap > 0 ? capError(cap) : "Use an amount above 0; remove the row for no cap." };
    setErrors(found);
    if (found.repo || found.cap) return;
    const existing = findRepo(Object.keys(saved), target);
    const next = { ...saved };
    if (existing) delete next[existing];
    next[existing ?? target] = cap;
    const ok = await save(next, existing ? `${existing} is now capped at ${usd(cap)} a month.` : `Repo tasks on ${target} are now capped at ${usd(cap)} a month.`);
    if (ok) setRepo("");
  };

  const remove = async (row: CapRow) => {
    const next = { ...saved };
    delete next[row.repo];
    await save(next, `${row.repo} no longer has its own cap.`);
  };

  const columns: TableColumn<CapRow>[] = [
    { key: "repo", header: "Repository", width: proportional(2, { minWidth: 160 }), renderCell: (r) => <Text weight="medium">{r.repo}</Text> },
    {
      key: "used",
      header: "This month",
      width: proportional(2, { minWidth: 180 }),
      renderCell: (r) => (
        <VStack gap={1}>
          <ProgressBar
            label={`Spent on ${r.repo} this month`}
            isLabelHidden
            value={Math.min(r.status?.usedUsd ?? 0, r.capUsd)}
            max={r.capUsd}
            variant={CAP_VARIANT[r.status?.level ?? "ok"]}
          />
          <Text type="supporting" hasTabularNumbers>
            {capLine(r.status ?? { usedUsd: 0, capUsd: r.capUsd, percent: 0 })}
          </Text>
        </VStack>
      ),
    },
    {
      key: "actions",
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: pixel(152),
      align: "end",
      renderCell: (r) => <ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={() => remove(r)} />,
    },
  ];

  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={4} accessibilityLevel={3}>
          Caps per repository
        </Heading>
        <Text type="supporting">Repo tasks on one repository per month (chat is not counted). A new task there is refused once its cap is used up. Saved as you add or remove one.</Text>
      </VStack>
      <Table<CapRow>
        data={rows}
        columns={columns}
        idKey="repo"
        density="balanced"
        hasHover
        textOverflow="truncate"
        emptyState={<EmptyState isCompact title="No repository has its own cap" description="Repo tasks on every repository count only toward the monthly budget." />}
      />
      <AddRow error={errors.repo ?? errors.cap}>
        <TextInput
          label="Repository"
          value={repo}
          onChange={(v) => {
            setRepo(v);
            setErrors((e) => ({ ...e, repo: undefined }));
          }}
          placeholder="owner/repo"
          width={240}
          autoCapitalize="off"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          status={errors.repo ? { type: "error" } : undefined}
          onEnter={add}
        />
        <NumberInput
          label="Monthly cap"
          value={cap}
          onChange={(v) => {
            setCap(v);
            setErrors((e) => ({ ...e, cap: undefined }));
          }}
          min={0}
          max={CAP_MAX}
          step={5}
          units="USD"
          width={160}
          status={errors.cap ? { type: "error" } : undefined}
          onEnter={add}
        />
        <Button label="Add cap" icon={<Icon icon={PlusIcon} />} clickAction={add} />
      </AddRow>
    </VStack>
  );
}
