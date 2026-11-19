import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Typeahead, type SearchSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { DirectTaskStarted } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { useRecentTasks } from "./hooks";
import { REPO_PATTERN, knownRepos } from "./labels";

const INSTRUCTION_MAX = 8000;

export interface NewTaskDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Called with the new task's conversation once the server accepted it. */
  onStarted: (conversationId: string) => void;
}

/** Suggests the known repositories, and offers whatever owner/repo is typed. */
function repoSource(repos: string[]): SearchSource {
  const items = repos.map((r): SearchableItem => ({ id: r, label: r }));
  return {
    search: (query) => {
      const q = query.trim().toLowerCase();
      const matches = items.filter((i) => i.label.toLowerCase().includes(q));
      const typed = query.trim();
      const exact = matches.some((i) => i.label.toLowerCase() === q);
      return REPO_PATTERN.test(typed) && !exact ? [{ id: typed, label: typed }, ...matches] : matches;
    },
    bootstrap: () => items.slice(0, 10),
  };
}

/**
 * Starts a repo task straight away, without asking Pointer: the team works on
 * the repository and opens a pull request. The task gets its own conversation.
 */
export function NewTaskDialog({ isOpen, onOpenChange, onStarted }: NewTaskDialogProps) {
  const { config } = useConfig();
  const recent = useRecentTasks(isOpen);
  const repos = useMemo(() => knownRepos(config, recent), [config, recent]);
  const source = useMemo(() => repoSource(repos), [repos]);
  const [repo, setRepo] = useState<SearchableItem | null>(null);
  const [query, setQuery] = useState("");
  const [instruction, setInstruction] = useState("");
  const { run, pending } = useAction();

  const target = (repo?.label ?? query).trim();
  const repoValid = REPO_PATTERN.test(target);
  const tooLong = instruction.length > INSTRUCTION_MAX;
  const canStart = repoValid && instruction.trim().length > 0 && !tooLong;

  const close = () => onOpenChange(false);
  const start = async () => {
    if (!canStart) return;
    let started: DirectTaskStarted | undefined;
    const ok = await run(async () => {
      started = await api.post<DirectTaskStarted>("/api/tasks", { repo: target, instruction: instruction.trim() });
    });
    if (!ok || !started) return;
    setInstruction("");
    setRepo(null);
    setQuery("");
    close();
    onStarted(started.conversationId);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={560}>
      <Layout
        header={
          <DialogHeader
            title="New repo task"
            subtitle="The team works on the repository and opens a pull request. Follow it live in its conversation."
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Typeahead
                label="Repository"
                description={repos.length ? "Pick a known repository or type owner/repo." : "Type owner/repo."}
                placeholder="owner/repo"
                searchSource={source}
                value={repo}
                onChange={setRepo}
                onChangeQuery={setQuery}
                hasEntriesOnFocus
                minQueryLength={0}
                debounceMs={0}
                isRequired
                width="100%"
                status={target.includes("/") && !repoValid ? { type: "error", message: "Repositories look like owner/repo." } : undefined}
              />
              <TextArea
                label="What should the team do?"
                description="A complete request with what done looks like. It becomes the pull request's work."
                value={instruction}
                onChange={setInstruction}
                rows={6}
                maxLength={INSTRUCTION_MAX}
                isRequired
                width="100%"
                placeholder="Add a dark mode toggle to the settings page, remembered per user. Done when it switches instantly and survives a reload."
              />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={close} />
              <Button label="Start the task" variant="primary" isDisabled={!canStart} isLoading={pending} clickAction={start} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
