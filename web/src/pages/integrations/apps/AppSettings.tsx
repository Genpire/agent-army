/**
 * A connected app's settings, shared by the app drawer and the built-in
 * integrations that are an app underneath (GenpirePane): what it may do, its
 * tools and agents (useAppSettings), its sign-in and what was last listed
 * (AppSignInPanel), and its tools, each on or off (AppToolList).
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { api, errorMessage } from "../../../lib/api";
import { useConfig } from "../../../lib/state";
import { useAction } from "../../../lib/useAction";
import { type AppView, type CatalogApp, appAgents, isSignedOut } from "./apps";

const SIGN_IN_TEXT: Record<AppView["auth"]["type"], string> = {
  oauth: "OAuth sign-in",
  bearer: "API key",
  headers: "API key in headers",
  none: "No sign-in",
};

/** What the console may change on a connected app (POST /api/apps/:id), besides what the settings below hold. */
export interface AppUpdate {
  name?: string;
  enabled?: boolean;
  /** "Only for me": only the owner may use it; team members never get it. */
  ownerOnly?: boolean;
  auth?: object;
}

/**
 * A connected app's settings as edited before saving (access, tools turned
 * off, agents), and what can be done to it: save, list its tools again, sign
 * in (again, or with automatic sign-in), remove it. Keep one per app (key the
 * component by its id).
 */
export function useAppSettings(app: AppView) {
  const { config, refresh } = useConfig();
  const [access, setAccess] = useState(app.access);
  const [disabled, setDisabled] = useState(() => new Set(app.disabledTools));
  const [agentIds, setAgentIds] = useState(() => appAgents(config.team.agents, app.id).map((a) => a.id));
  const [error, setError] = useState<string>();
  const save = useAction();
  const action = useAction();
  const path = `/api/apps/${encodeURIComponent(app.id)}`;

  const usable = app.tools.filter((t) => !disabled.has(t.name) && (access === "write" || t.readOnly)).length;

  /** Saves the settings with `update` (the drawer's name, on/off and credentials). Returns whether it saved; the reason shows in `error`. */
  const submit = async (update: AppUpdate = {}, success = `${update.name ?? app.name} saved.`): Promise<boolean> => {
    let failure: string | undefined;
    const ok = await save.run(
      async () => {
        try {
          await api.post(path, { access, disabledTools: [...disabled], agentIds, ...update });
          await refresh();
        } catch (err) {
          failure = errorMessage(err);
          throw err;
        }
      },
      { success },
    );
    setError(ok ? undefined : failure);
    return ok;
  };

  const recheck = async () => {
    await action.run(
      async () => {
        await api.post(`${path}/check`);
        await refresh();
        setError(undefined);
      },
      { success: `Listed ${app.name}'s tools again.` },
    );
  };

  const signIn = async () => {
    await action.run(async () => {
      const { url } = await api.post<{ url: string }>(`${path}/oauth/start`);
      window.location.assign(url);
    });
  };

  /** Forgets the owner's own OAuth client and signs in with automatic registration instead. */
  const signInAutomatically = async () => {
    await action.run(async () => {
      await api.post(path, { auth: { type: "oauth", automatic: true } });
      const { url } = await api.post<{ url: string }>(`${path}/oauth/start`);
      window.location.assign(url);
    });
  };

  /** Removes the app (and takes it off every agent). Returns whether it was removed. */
  const remove = (success = `${app.name} removed. Agents no longer have it.`) =>
    action.run(
      async () => {
        await api.post(`${path}/delete`);
        await refresh();
      },
      { success },
    );

  const toggle = (tool: string, on: boolean) => {
    setDisabled((d) => {
      const next = new Set(d);
      if (on) next.delete(tool);
      else next.add(tool);
      return next;
    });
  };

  return { access, setAccess, disabled, toggle, agentIds, setAgentIds, usable, error, setError, saving: save.pending, submit, recheck, signIn, signInAutomatically, remove };
}

export type AppSettings = ReturnType<typeof useAppSettings>;

export interface AppSignInPanelProps {
  app: AppView;
  /** The catalog entry it was added from: its guide, and whether automatic sign-in is offered. */
  preset?: CatalogApp;
  settings: AppSettings;
  /** Pointer's name. */
  lead: string;
}

/** Whether the app is signed in (a banner when not), where it is, when its tools were listed, and the buttons to sign in and list them again. */
export function AppSignInPanel({ app, preset, settings, lead }: AppSignInPanelProps) {
  const signedOut = isSignedOut(app);
  return (
    <VStack gap={3}>
      {signedOut && (
        <Banner
          status="warning"
          title={`${app.name} is not signed in`}
          description={`Sign in to let ${lead} and the agents use it. Until then it is left out of chat and tasks.`}
          collapsible={false}
        />
      )}
      <MetadataList>
        <MetadataListItem label="Address">
          <Text maxLines={1}>{app.url}</Text>
        </MetadataListItem>
        <MetadataListItem label="Sign-in">
          <Text>{signInText(app)}</Text>
        </MetadataListItem>
        <MetadataListItem label="Tools listed">
          <Text>{app.checkedAt ? <Timestamp value={app.checkedAt} format="relative" type="inherit" color="inherit" /> : "Not yet"}</Text>
        </MetadataListItem>
        {preset && (
          <MetadataListItem label="Guide">
            <Link href={preset.docsUrl} isExternalLink>
              {preset.name}'s MCP server
            </Link>
          </MetadataListItem>
        )}
      </MetadataList>
      <HStack gap={2} wrap="wrap">
        {app.auth.type === "oauth" && (
          <Button label={signedOut ? `Sign in with ${app.name}` : "Sign in again"} variant={signedOut ? "primary" : "secondary"} size="sm" clickAction={settings.signIn} />
        )}
        {app.auth.type === "oauth" && app.auth.ownClient && preset?.clientRegistration !== "manual" && (
          <Button label="Use automatic sign-in" variant="secondary" size="sm" clickAction={settings.signInAutomatically} />
        )}
        <Button label="List tools again" variant="secondary" size="sm" clickAction={settings.recheck} isDisabled={signedOut} />
      </HStack>
    </VStack>
  );
}

export interface AppToolListProps {
  app: AppView;
  settings: AppSettings;
  /** The access choice that allows tools that change things, as AccessField names it. */
  writeLabel?: string;
}

/** The app's tools as its server listed them, each with whether it changes things and a switch to turn it off. */
export function AppToolList({ app, settings, writeLabel = "Change things too" }: AppToolListProps) {
  const [query, setQuery] = useState("");
  const tools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? app.tools.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q)) : app.tools;
  }, [app.tools, query]);

  if (app.tools.length === 0) {
    return <Text color="secondary">{isSignedOut(app) ? "Its tools are listed once you sign in." : "No tools listed yet. List them again once the app is reachable."}</Text>;
  }
  return (
    <VStack gap={3}>
      {app.tools.length > 12 && (
        <TextInput type="search" label="Search tools" isLabelHidden placeholder="Search tools" startIcon={MagnifyingGlassIcon} value={query} onChange={setQuery} width="100%" />
      )}
      <List density="compact" hasDividers>
        {tools.map((t) => {
          const blocked = settings.access === "read" && !t.readOnly;
          return (
            <ListItem
              key={t.name}
              align="first-line"
              label={
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Text weight="semibold">{t.name}</Text>
                  <Token label={t.readOnly ? "Looks only" : "Changes things"} size="sm" color={t.readOnly ? "default" : "orange"} />
                </HStack>
              }
              description={t.description ? <Text type="supporting" maxLines={2}>{t.description}</Text> : undefined}
              endContent={
                <Switch
                  label={`Use ${t.name}`}
                  isLabelHidden
                  value={!blocked && !settings.disabled.has(t.name)}
                  onChange={(on) => settings.toggle(t.name, on)}
                  isDisabled={blocked}
                  disabledMessage={`Choose "${writeLabel}" to use tools that change things.`}
                  size="sm"
                />
              }
            />
          );
        })}
      </List>
    </VStack>
  );
}

function signInText(app: AppView): string {
  const kind = SIGN_IN_TEXT[app.auth.type];
  if (app.auth.type === "oauth") return `${kind} · ${app.auth.signedIn ? "signed in" : "not signed in"}`;
  if (app.auth.type === "bearer") return `${kind} ${app.auth.key ?? ""}`.trim();
  if (app.auth.type === "headers") return `${kind}: ${app.auth.headerNames.join(", ")}`;
  return kind;
}
