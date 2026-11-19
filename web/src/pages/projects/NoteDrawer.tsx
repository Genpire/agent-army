import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { StackItem } from "@astryxdesign/core/Stack";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { api, errorMessage } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import type { NotesList, ProjectNotes } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { REPO_ERROR, REPO_RE, findRepo } from "./validation";

export interface NoteDrawerProps {
  isOpen: boolean;
  /** The repository whose notes to open; undefined starts notes for a new one. */
  repo: string | undefined;
  notes: NotesList["notes"];
  max: number;
  onOpenChange: (isOpen: boolean) => void;
  /** Switches the drawer to a repository that already has notes. */
  onOpenRepo: (repo: string) => void;
  /** Called after a save or delete, to reload the list. */
  onSaved: () => void | Promise<void>;
}

const notePath = (repo: string) => `/api/notes/${repo.split("/").map(encodeURIComponent).join("/")}`;

/** Reads and edits one repository's notes. Saving empty notes deletes them, after a second click. */
export function NoteDrawer({ isOpen, repo, notes, max, onOpenChange, onOpenRepo, onSaved }: NoteDrawerProps) {
  const { run } = useAction();
  const [repoInput, setRepoInput] = useState("");
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState<ProjectNotes>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [errors, setErrors] = useState<{ repo?: string; text?: string }>({});
  const [armedEmpty, setArmedEmpty] = useState(false);

  const load = useCallback(async (name: string) => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const found = await api.get<ProjectNotes>(notePath(name));
      setLoaded(found);
      setText(found.text);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setRepoInput("");
    setText("");
    setLoaded(undefined);
    setLoadError(undefined);
    setErrors({});
    setArmedEmpty(false);
    if (repo) void load(repo);
  }, [isOpen, repo, load]);

  // A second click within 4 seconds confirms saving empty notes (which deletes them).
  useEffect(() => {
    if (!armedEmpty) return;
    const t = setTimeout(() => setArmedEmpty(false), 4000);
    return () => clearTimeout(t);
  }, [armedEmpty]);

  const isNew = repo === undefined;
  const existing = isNew ? findRepo(notes.map((n) => n.repo), repoInput) : undefined;
  const isEmpty = text.trim() === "";
  const canEdit = !loading && !loadError;

  const post = async (target: string, body: string, success: string) => {
    const ok = await run(() => api.post("/api/notes", { repo: target, text: body }), { success });
    if (ok) {
      onOpenChange(false);
      await onSaved();
    }
  };

  const remove = () => (repo ? post(repo, "", `Deleted the notes for ${repo}.`) : undefined);

  const save = async () => {
    const target = repo ?? repoInput.trim();
    const found = {
      repo: isNew && !REPO_RE.test(target) ? REPO_ERROR : existing ? `${existing} already has notes. Open them instead.` : undefined,
      text:
        text.trim().length > max
          ? `Project notes are limited to ${max.toLocaleString()} characters; condense them.`
          : isNew && isEmpty
            ? "Write the notes to save."
            : undefined,
    };
    setErrors(found);
    if (found.repo || found.text) return;
    if (!isNew && isEmpty) {
      if (!armedEmpty) return setArmedEmpty(true);
      setArmedEmpty(false);
      return remove();
    }
    await post(target, text, `Saved the notes for ${target}.`);
  };

  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange} label={isNew ? "Add project notes" : `Notes for ${repo}`} purpose="form" width={640}>
      <Layout
        header={
          <DrawerHeader
            title={isNew ? "Add project notes" : repo}
            subtitle={isNew ? "Project notes" : loaded ? `Project notes · updated ${timeAgo(loaded.updatedAt)}` : "Project notes"}
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={5}>
              {isNew && (
                <TextInput
                  label="Repository"
                  value={repoInput}
                  onChange={(v) => {
                    setRepoInput(v);
                    setErrors((e) => ({ ...e, repo: undefined }));
                  }}
                  placeholder="owner/repo"
                  isRequired
                  hasAutoFocus
                  autoCapitalize="off"
                  hasAutoCorrect={false}
                  hasSpellCheck={false}
                  status={errors.repo ? { type: "error", message: errors.repo } : undefined}
                />
              )}
              {existing && (
                <Banner
                  status="info"
                  title={`${existing} already has notes`}
                  description="Open them to edit what is there."
                  collapsible={false}
                  endContent={<Button label="Open them" size="sm" onClick={() => onOpenRepo(existing)} />}
                />
              )}
              {loadError && (
                <Banner
                  status="error"
                  title="Couldn't load the notes"
                  description={loadError}
                  collapsible={false}
                  endContent={repo ? <Button label="Try again" size="sm" clickAction={() => load(repo)} /> : undefined}
                />
              )}
              <TextArea
                label="Notes"
                value={text}
                onChange={(v) => {
                  setText(v);
                  setArmedEmpty(false);
                  setErrors((e) => ({ ...e, text: undefined }));
                }}
                rows={18}
                maxLength={max}
                isLoading={loading}
                isReadOnly={!canEdit}
                hasAutoFocus={!isNew}
                placeholder={isNew ? "For example:\n- Tests: npm test (needs Node 22)\n- API routes live in src/routes/" : undefined}
                description="What the next task should know: how to build and test, conventions, layout, gotchas. Never secrets."
                status={
                  errors.text
                    ? { type: "error", message: errors.text }
                    : !isNew && isEmpty && canEdit
                      ? { type: "warning", message: "Saving empty notes deletes them." }
                      : undefined
                }
              />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <StackItem size="fill">
                {!isNew && canEdit && <ConfirmButton label="Delete notes" confirmLabel="Click again to delete" size="md" onConfirm={remove} />}
              </StackItem>
              <Button label="Cancel" variant="secondary" onClick={() => onOpenChange(false)} />
              <Button
                label={armedEmpty ? "Click again to delete the notes" : "Save"}
                variant={armedEmpty ? "destructive" : "primary"}
                isDisabled={!canEdit}
                clickAction={save}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Drawer>
  );
}
