import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { RepoSetupView } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import {
  REPO_ERROR,
  REPO_RE,
  REPO_SETUP_MAX_ENV,
  SETUP_COMMAND_MAX,
  START_COMMAND_MAX,
  appUrlError,
  findRepo,
  joinErrors,
  parseEnvLines,
} from "./validation";

export interface RepoSetupDrawerProps {
  isOpen: boolean;
  /** The saved repository to edit; undefined adds a new one. */
  repo: string | undefined;
  setups: Record<string, RepoSetupView>;
  onOpenChange: (isOpen: boolean) => void;
  /** Switches the drawer to editing a saved repository (when the one typed is already set up). */
  onOpenRepo: (repo: string) => void;
}

interface FieldErrors {
  repo?: string;
  setupCommand?: string;
  startCommand?: string;
  appUrl?: string;
  env?: string;
  form?: string;
}

/**
 * Adds or edits one repository's setup. Variable values are write-only: the
 * server sends names only, and the NAME=value text is cleared after saving and
 * whenever the drawer closes, so no value stays in the page.
 */
export function RepoSetupDrawer({ isOpen, repo, setups, onOpenChange, onOpenRepo }: RepoSetupDrawerProps) {
  const { refresh } = useConfig();
  const { run } = useAction();
  const [repoInput, setRepoInput] = useState("");
  const [setupCommand, setSetupCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const [envText, setEnvText] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  // Fill the form when the drawer opens (not when the config refreshes behind it).
  useEffect(() => {
    if (!isOpen) {
      setEnvText("");
      return;
    }
    const saved = repo ? setups[repo] : undefined;
    setRepoInput(repo ?? "");
    setSetupCommand(saved?.setupCommand ?? "");
    setStartCommand(saved?.startCommand ?? "");
    setAppUrl(saved?.appUrl ?? "");
    setEnvText("");
    setErrors({});
    // `setups` is left out on purpose: a refresh after removing a variable must not reset what is typed.
  }, [isOpen, repo]);

  const isNew = repo === undefined;
  const saved = repo ? setups[repo] : undefined;
  const alreadySetUp = isNew ? findRepo(Object.keys(setups), repoInput) : undefined;
  const savedKeys = saved?.envKeys ?? [];
  const title = isNew ? "Add a repository" : repo;

  const clear = (field: keyof FieldErrors) => setErrors((e) => (e[field] || e.form ? { ...e, [field]: undefined, form: undefined } : e));

  const save = async () => {
    const target = repo ?? repoInput.trim();
    const setup = setupCommand.trim();
    const start = startCommand.trim();
    const url = appUrl.trim();
    const { env, errors: envErrors } = parseEnvLines(envText);
    const names = Object.keys(env);
    const found: FieldErrors = {
      repo: !REPO_RE.test(target) ? REPO_ERROR : alreadySetUp ? `${alreadySetUp} is already set up. Edit it instead.` : undefined,
      setupCommand: setup.length > SETUP_COMMAND_MAX ? `The setup command is limited to ${SETUP_COMMAND_MAX.toLocaleString()} characters.` : undefined,
      startCommand: start.length > START_COMMAND_MAX ? `The start command is limited to ${START_COMMAND_MAX} characters.` : undefined,
      appUrl: appUrlError(url),
      env: envErrors.length
        ? joinErrors(envErrors)
        : new Set([...savedKeys, ...names]).size > REPO_SETUP_MAX_ENV
          ? `At most ${REPO_SETUP_MAX_ENV} variables per repository.`
          : undefined,
    };
    if (isNew && !setup && !start && !url && !names.length && !Object.values(found).some(Boolean)) {
      found.form = "Enter a setup command, a start command, an app URL or a variable to save.";
    }
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    const changed = names.length ? ` ${names.length === 1 ? "The variable's value is" : "Variable values are"} stored encrypted and not shown again.` : "";
    const ok = await run(
      async () => {
        await api.post("/api/repo-setup", { repo: target, setupCommand: setup, startCommand: start, appUrl: url, ...(names.length ? { env } : {}) });
        await refresh();
      },
      { success: `Saved the setup of ${target}.${changed}` },
    );
    if (ok) {
      setEnvText("");
      onOpenChange(false);
    }
  };

  const removeVariable = async (name: string) => {
    await run(
      async () => {
        await api.post("/api/repo-setup", { repo, env: { [name]: null } });
        await refresh();
      },
      { success: `Removed ${name} from ${repo}.` },
    );
  };

  const removeSetup = async () => {
    const ok = await run(
      async () => {
        await api.post("/api/repo-setup/delete", { repo });
        await refresh();
      },
      { success: `Removed the setup of ${repo}.` },
    );
    if (ok) onOpenChange(false);
  };

  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange} label={isNew ? "Add a repository setup" : `Setup of ${repo}`} purpose="form" width={560}>
      <Layout
        header={
          <DrawerHeader
            title={title}
            subtitle="Repo setup"
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
                    clear("repo");
                  }}
                  placeholder="owner/repo"
                  description="The GitHub repository, as owner/repo."
                  isRequired
                  hasAutoFocus
                  autoCapitalize="off"
                  hasAutoCorrect={false}
                  hasSpellCheck={false}
                  status={errors.repo ? { type: "error", message: errors.repo } : undefined}
                />
              )}
              {alreadySetUp && (
                <Banner
                  status="info"
                  title={`${alreadySetUp} is already set up`}
                  description="Open it to change its commands and variables."
                  collapsible={false}
                  endContent={<Button label="Edit it" size="sm" onClick={() => onOpenRepo(alreadySetUp)} />}
                />
              )}
              <TextInput
                label="Setup command"
                value={setupCommand}
                onChange={(v) => {
                  setSetupCommand(v);
                  clear("setupCommand");
                }}
                placeholder="e.g. npm ci"
                description="Runs once with bash in the checkout after the clone, before the team starts. The team sees whether it worked and the end of its output."
                isOptional
                autoCapitalize="off"
                hasAutoCorrect={false}
                hasSpellCheck={false}
                status={errors.setupCommand ? { type: "error", message: errors.setupCommand } : undefined}
              />
              <TextInput
                label="Start command"
                value={startCommand}
                onChange={(v) => {
                  setStartCommand(v);
                  clear("startCommand");
                }}
                placeholder="e.g. npm run dev"
                description="How the agents start the app for browser checks. Empty: the project's own dev script."
                isOptional
                autoCapitalize="off"
                hasAutoCorrect={false}
                hasSpellCheck={false}
                status={errors.startCommand ? { type: "error", message: errors.startCommand } : undefined}
              />
              <TextInput
                label="App URL"
                type="url"
                value={appUrl}
                onChange={(v) => {
                  setAppUrl(v);
                  clear("appUrl");
                }}
                placeholder="e.g. http://localhost:3000"
                description="Where the started app answers, for browser checks."
                isOptional
                autoCapitalize="off"
                hasAutoCorrect={false}
                hasSpellCheck={false}
                status={errors.appUrl ? { type: "error", message: errors.appUrl } : undefined}
              />
              <Divider />
              <VStack gap={1}>
                <Heading level={3}>Environment variables</Heading>
                <Text type="supporting" color="secondary">
                  Set in the agents' shell and for the setup command. Values are stored encrypted, never shown again, and hidden from Slack and pull
                  request text. Use development or test credentials: the agents can read them.
                </Text>
              </VStack>
              {savedKeys.length > 0 && (
                <List density="compact" hasDividers edge="flush" header={<Text type="label">{`Saved variables (${savedKeys.length})`}</Text>}>
                  {savedKeys.map((name) => (
                    <ListItem
                      key={name}
                      label={<Code>{name}</Code>}
                      endContent={<ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={() => removeVariable(name)} />}
                    />
                  ))}
                </List>
              )}
              <TextArea
                label={savedKeys.length ? "Add or change variables" : "Variables"}
                value={envText}
                onChange={(v) => {
                  setEnvText(v);
                  clear("env");
                }}
                rows={5}
                placeholder="e.g. DATABASE_URL=postgres://localhost:5432/app"
                description={
                  savedKeys.length
                    ? "One NAME=value per line. Enter a saved name again to change its value; names you leave out keep theirs."
                    : "One NAME=value per line, as in a .env file."
                }
                isOptional
                autoComplete="off"
                autoCapitalize="off"
                hasAutoCorrect={false}
                hasSpellCheck={false}
                status={errors.env ? { type: "error", message: errors.env } : undefined}
              />
              {errors.form && <Banner status="error" title={errors.form} collapsible={false} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <StackItem size="fill">
                {!isNew && <ConfirmButton label="Remove setup" confirmLabel="Click again to remove the setup" size="md" onConfirm={removeSetup} />}
              </StackItem>
              <Button label="Cancel" variant="secondary" onClick={() => onOpenChange(false)} />
              <Button label="Save" variant="primary" clickAction={save} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Drawer>
  );
}
