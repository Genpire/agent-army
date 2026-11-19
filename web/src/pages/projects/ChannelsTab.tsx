import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import type { TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { InformationCircleIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import { AddRow } from "./components/AddRow";
import { SectionHeader } from "./components/SectionHeader";
import { CHANNEL_ERROR, REPO_ERROR, REPO_RE, parseChannelId } from "./validation";

const MAX_POINTER_CHANNELS = 100;

interface BindingRow extends Record<string, unknown> {
  channel: string;
  repo: string;
}

interface PointerChannelRow extends Record<string, unknown> {
  channel: string;
  /** The channel's default repository, when it has one. */
  repo: string | undefined;
}

/** Channels: each channel's default repository, and the channels where Pointer answers every message. */
export function ChannelsTab() {
  const { config } = useConfig();
  const pointer = config.team.pointer.name;
  return (
    <VStack gap={8}>
      <BindingsSection bindings={config.bindings} pointer={pointer} />
      <Divider />
      <PointerChannelsSection channels={config.slack.pointerChannels} bindings={config.bindings} pointer={pointer} />
      <HStack gap={2} vAlign="start">
        <Icon icon={InformationCircleIcon} size="sm" color="secondary" />
        <Text type="supporting" color="secondary">
          To find a channel ID in Slack, open the channel, click its name at the top and copy the ID at the bottom of the About tab. Pasting the
          channel's link works too.
        </Text>
      </HStack>
    </VStack>
  );
}

function BindingsSection({ bindings, pointer }: { bindings: Record<string, string>; pointer: string }) {
  const { refresh } = useConfig();
  const { run } = useAction();
  const [channel, setChannel] = useState("");
  const [repo, setRepo] = useState("");
  const [errors, setErrors] = useState<{ channel?: string; repo?: string }>({});

  const rows: BindingRow[] = Object.entries(bindings)
    .map(([c, r]) => ({ channel: c, repo: r }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.channel.localeCompare(b.channel));

  const save = (next: Record<string, string>, success: string) =>
    run(
      async () => {
        await api.post("/api/settings", { bindings: next });
        await refresh();
      },
      { success },
    );

  const add = async () => {
    const id = parseChannelId(channel);
    const target = repo.trim();
    const found = {
      channel: id ? undefined : CHANNEL_ERROR,
      repo: REPO_RE.test(target) ? undefined : REPO_ERROR,
    };
    if (id && found.repo === undefined && bindings[id]?.toLowerCase() === target.toLowerCase()) {
      found.channel = `${id} already works on ${bindings[id]}.`;
    }
    setErrors(found);
    if (!id || found.channel || found.repo) return;
    const replaced = bindings[id];
    const ok = await save(
      { ...bindings, [id]: target },
      replaced ? `${id} now works on ${target} instead of ${replaced}.` : `${id} now works on ${target} by default.`,
    );
    if (ok) {
      setChannel("");
      setRepo("");
    }
  };

  const remove = async (row: BindingRow) => {
    const next = { ...bindings };
    delete next[row.channel];
    await save(next, `${row.channel} no longer has a default repository.`);
  };

  const columns: TableColumn<BindingRow>[] = [
    { key: "channel", header: "Channel", width: proportional(1, { minWidth: 180 }), renderCell: (r) => <Code>{r.channel}</Code> },
    { key: "repo", header: "Repository", width: proportional(2, { minWidth: 160 }), renderCell: (r) => <Text weight="medium">{r.repo}</Text> },
    {
      key: "actions",
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: pixel(152),
      align: "end",
      renderCell: (r) => <ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={() => remove(r)} />,
    },
  ];

  return (
    <VStack gap={4}>
      <SectionHeader
        title="Default repository per channel"
        description={
          <>
            A request in one of these channels that names no repository works on this one. In Slack you can also type{" "}
            <Code size="inherit">@{pointer} bind owner/repo</Code> or <Code size="inherit">unbind</Code> in the channel.
          </>
        }
      />
      <Table<BindingRow>
        data={rows}
        columns={columns}
        idKey="channel"
        density="balanced"
        hasHover
        textOverflow="truncate"
        emptyState={
          <EmptyState
            isCompact
            title="No channel has a default repository"
            description={`Without one, name the repository in the request: @${pointer} in owner/repo: fix the login bug.`}
          />
        }
      />
      <AddRow error={errors.channel ?? errors.repo}>
        <TextInput
          label="Channel ID"
          value={channel}
          onChange={(v) => {
            setChannel(v);
            setErrors((e) => ({ ...e, channel: undefined }));
          }}
          placeholder="C012ABCDEF"
          width={220}
          autoCapitalize="characters"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          status={errors.channel ? { type: "error" } : undefined}
          onEnter={add}
        />
        <TextInput
          label="Repository"
          value={repo}
          onChange={(v) => {
            setRepo(v);
            setErrors((e) => ({ ...e, repo: undefined }));
          }}
          placeholder="owner/repo"
          width={260}
          autoCapitalize="off"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          status={errors.repo ? { type: "error" } : undefined}
          onEnter={add}
        />
        <Button label="Add channel" icon={<Icon icon={PlusIcon} />} clickAction={add} />
      </AddRow>
    </VStack>
  );
}

function PointerChannelsSection({ channels, bindings, pointer }: { channels: string[]; bindings: Record<string, string>; pointer: string }) {
  const { refresh } = useConfig();
  const { run } = useAction();
  const [channel, setChannel] = useState("");
  const [error, setError] = useState<string>();

  const rows: PointerChannelRow[] = channels.map((c) => ({ channel: c, repo: bindings[c] }));

  const save = (next: string[], success: string) =>
    run(
      async () => {
        await api.post("/api/settings", { pointerChannels: next });
        await refresh();
      },
      { success },
    );

  const add = async () => {
    const id = parseChannelId(channel);
    const problem = !id
      ? CHANNEL_ERROR
      : channels.includes(id)
        ? `${pointer} already answers every message in ${id}.`
        : channels.length >= MAX_POINTER_CHANNELS
          ? `At most ${MAX_POINTER_CHANNELS} ${pointer} channels.`
          : undefined;
    setError(problem);
    if (!id || problem) return;
    if (await save([...channels, id], `${pointer} now answers every message in ${id}.`)) {
      setChannel("");
    }
  };

  const remove = async (row: PointerChannelRow) => {
    await save(
      channels.filter((c) => c !== row.channel),
      `${pointer} now answers in ${row.channel} only when mentioned.`,
    );
  };

  const columns: TableColumn<PointerChannelRow>[] = [
    { key: "channel", header: "Channel", width: proportional(1, { minWidth: 180 }), renderCell: (r) => <Code>{r.channel}</Code> },
    {
      key: "repo",
      header: "Default repository",
      width: proportional(2, { minWidth: 160 }),
      renderCell: (r) => (r.repo ? <Text>{r.repo}</Text> : <Text color="secondary">None</Text>),
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
    <VStack gap={4}>
      <SectionHeader
        title={`${pointer} channels`}
        description={
          <>
            {pointer} answers every message in these channels, no mention needed. Invite it first with <Code size="inherit">/invite @{pointer}</Code>; typing{" "}
            <Code size="inherit">listen here</Code> or <Code size="inherit">stop listening</Code> in a channel works too.
          </>
        }
      />
      <Table<PointerChannelRow>
        data={rows}
        columns={columns}
        idKey="channel"
        density="balanced"
        hasHover
        textOverflow="truncate"
        emptyState={
          <EmptyState
            isCompact
            title={`No ${pointer} channels yet`}
            description={`Elsewhere ${pointer} answers when mentioned, in DMs, and in threads it has posted in.`}
          />
        }
      />
      <AddRow error={error}>
        <TextInput
          label="Channel ID"
          value={channel}
          onChange={(v) => {
            setChannel(v);
            setError(undefined);
          }}
          placeholder="C012ABCDEF"
          width={220}
          autoCapitalize="characters"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          status={error ? { type: "error" } : undefined}
          onEnter={add}
        />
        <Button label={`Add ${pointer} channel`} icon={<Icon icon={PlusIcon} />} clickAction={add} />
      </AddRow>
    </VStack>
  );
}
