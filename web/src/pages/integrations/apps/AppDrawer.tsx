import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { StackItem } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useMemo, useState } from "react";
import { BrandLogo } from "../../../components/BrandLogo";
import { ConfirmButton } from "../../../components/ConfirmButton";
import { SecretField } from "../../../components/SecretField";
import { api, errorMessage } from "../../../lib/api";
import { plural } from "../../../lib/format";
import { useConfig } from "../../../lib/state";
import { useAction } from "../../../lib/useAction";
import { FormError, StatusLine } from "../parts";
import { AccessField } from "./AccessField";
import { ClientFields } from "./AddAppDrawer";
import { AgentsField } from "./AgentsField";
import { type AppView, type CatalogApp, appAgents, appStatus, headerOf, headerValue, isSignedOut } from "./apps";

export interface AppDrawerProps {
  isOpen: boolean;
  /** The connected app; kept while the drawer animates out. */
  app: AppView | undefined;
  /** The catalog entry it was added from, when there is one. */
  preset?: CatalogApp;
  /** Where vendors send the browser back after a sign-in. */
  redirectUrl: string;
  onOpenChange: (isOpen: boolean) => void;
}

/** One connected app: its status, what it may do, its tools, its agents, its sign-in; re-check and remove. */
export function AppDrawer({ isOpen, app, preset, redirectUrl, onOpenChange }: AppDrawerProps) {
  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange} label={app?.name ?? "App"} purpose="form" width={640} experimental={{ isFullWidthOnMobile: true }}>
      {app && <AppForm key={app.id} app={app} preset={preset} redirectUrl={redirectUrl} onClose={() => onOpenChange(false)} />}
    </Drawer>
  );
}

const SIGN_IN_TEXT: Record<AppView["auth"]["type"], string> = {
  oauth: "OAuth sign-in",
  bearer: "API key",
  headers: "API key in headers",
  none: "No sign-in",
};

function AppForm({ app, preset, redirectUrl, onClose }: { app: AppView; preset?: CatalogApp; redirectUrl: string; onClose: () => void }) {
  const { config, refresh } = useConfig();
  const lead = config.team.pointer.name;
  const [name, setName] = useState(app.name);
  const [access, setAccess] = useState(app.access);
  const [enabled, setEnabled] = useState(app.enabled);
  const [disabled, setDisabled] = useState(() => new Set(app.disabledTools));
  const [agentIds, setAgentIds] = useState(() => appAgents(config.team.agents, app.id).map((a) => a.id));
  const [token, setToken] = useState("");
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [toolQuery, setToolQuery] = useState("");
  const [error, setError] = useState<string>();
  const save = useAction();
  const action = useAction();

  const status = appStatus(app);
  const signedOut = isSignedOut(app);
  // A catalog header with a template ("Token token={key}") is replaced by pasting the key only.
  const template = preset && app.auth.type === "headers" && app.auth.headerNames.length === 1 && headerOf(preset.auth) === app.auth.headerNames[0] ? preset.valueTemplate : undefined;
  const tools = useMemo(() => {
    const q = toolQuery.trim().toLowerCase();
    return q ? app.tools.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q)) : app.tools;
  }, [app.tools, toolQuery]);
  const usable = app.tools.filter((t) => !disabled.has(t.name) && (access === "write" || t.readOnly)).length;

  const credentials = (): object | undefined => {
    if (app.auth.type === "bearer" && token.trim()) return { type: "bearer", token: token.trim() };
    if (app.auth.type === "headers" && Object.values(headerValues).some((v) => v.trim())) {
      return {
        type: "headers",
        headers: Object.fromEntries(app.auth.headerNames.map((h) => [h, headerValues[h]?.trim() ? headerValue(template, headerValues[h].trim()) : ""])),
      };
    }
    if (app.auth.type === "oauth" && clientId.trim()) return { type: "oauth", clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) };
    return undefined;
  };

  const submit = async () => {
    if (!name.trim()) return setError("Give the app a name.");
    let failure: string | undefined;
    const auth = credentials();
    const ok = await save.run(
      async () => {
        try {
          await api.post(`/api/apps/${encodeURIComponent(app.id)}`, { name: name.trim(), access, enabled, disabledTools: [...disabled], agentIds, ...(auth ? { auth } : {}) });
          await refresh();
        } catch (err) {
          failure = errorMessage(err);
          throw err;
        }
      },
      { success: `${name.trim()} saved.` },
    );
    if (!ok) return setError(failure);
    if (auth && app.auth.type === "oauth") return signIn();
    onClose();
  };

  const recheck = async () => {
    await action.run(
      async () => {
        await api.post(`/api/apps/${encodeURIComponent(app.id)}/check`);
        await refresh();
        setError(undefined);
      },
      { success: `Listed ${app.name}'s tools again.` },
    );
  };

  const signIn = async () => {
    await action.run(async () => {
      const { url } = await api.post<{ url: string }>(`/api/apps/${encodeURIComponent(app.id)}/oauth/start`);
      window.location.assign(url);
    });
  };

  /** Forgets the owner's own OAuth client and signs in with automatic registration instead. */
  const signInAutomatically = async () => {
    await action.run(async () => {
      await api.post(`/api/apps/${encodeURIComponent(app.id)}`, { auth: { type: "oauth", automatic: true } });
      const { url } = await api.post<{ url: string }>(`/api/apps/${encodeURIComponent(app.id)}/oauth/start`);
      window.location.assign(url);
    });
  };

  const remove = async () => {
    const ok = await action.run(
      async () => {
        await api.post(`/api/apps/${encodeURIComponent(app.id)}/delete`);
        await refresh();
      },
      { success: `${app.name} removed. Agents no longer have it.` },
    );
    if (ok) onClose();
  };

  const toggle = (tool: string, on: boolean) => {
    setDisabled((d) => {
      const next = new Set(d);
      if (on) next.delete(tool);
      else next.add(tool);
      return next;
    });
  };

  return (
    <Layout
      header={
        <DrawerHeader
          title={app.name}
          subtitle={preset ? preset.category : app.url}
          startContent={<BrandLogo id={app.presetId ?? undefined} name={app.name} size="md" />}
          onOpenChange={(open) => !open && onClose()}
        />
      }
      content={
        <LayoutContent>
          <VStack gap={6}>
            <VStack gap={3}>
              <StatusLine tone={status.tone} text={status.text} />
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
                {app.auth.type === "oauth" && <Button label={signedOut ? `Sign in with ${app.name}` : "Sign in again"} variant={signedOut ? "primary" : "secondary"} size="sm" clickAction={signIn} />}
                {app.auth.type === "oauth" && app.auth.ownClient && preset?.clientRegistration !== "manual" && (
                  <Button label="Use automatic sign-in" variant="secondary" size="sm" clickAction={signInAutomatically} />
                )}
                <Button label="List tools again" variant="secondary" size="sm" clickAction={recheck} isDisabled={signedOut} />
              </HStack>
            </VStack>

            <Divider />
            <TextInput label="Name" value={name} onChange={setName} isRequired />
            <Switch
              label="On"
              description={`Off keeps the app and its settings, but ${lead} and the agents do not use it.`}
              value={enabled}
              onChange={setEnabled}
              labelPosition="start"
              labelSpacing="spread"
            />
            <AccessField value={access} onChange={setAccess} appName={app.name} lead={lead} />
            <AgentsField value={agentIds} onChange={setAgentIds} agents={config.team.agents} lead={lead} />

            <Divider />
            <Section title="Tools" description={`${plural(usable, "tool")} of ${app.tools.length} can be used. Turn off any you don't want used.`}>
              {app.tools.length > 12 && (
                <TextInput type="search" label="Search tools" isLabelHidden placeholder="Search tools" startIcon={MagnifyingGlassIcon} value={toolQuery} onChange={setToolQuery} width="100%" />
              )}
              {app.tools.length === 0 ? (
                <Text color="secondary">{signedOut ? "Its tools are listed once you sign in." : "No tools listed yet. List them again once the app is reachable."}</Text>
              ) : (
                <List density="compact" hasDividers>
                  {tools.map((t) => {
                    const blocked = access === "read" && !t.readOnly;
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
                            value={!blocked && !disabled.has(t.name)}
                            onChange={(on) => toggle(t.name, on)}
                            isDisabled={blocked}
                            disabledMessage={`Choose "Change things too" to use tools that change things.`}
                            size="sm"
                          />
                        }
                      />
                    );
                  })}
                </List>
              )}
            </Section>

            {app.auth.type !== "none" && (
              <>
                <Divider />
                <Section title="Credentials" description="Stored encrypted and never shown again. Leave empty to keep the saved ones.">
                  {app.auth.type === "bearer" && <SecretField label="API key" value={token} onChange={setToken} saved={app.auth.key} description={preset?.keyHelp} />}
                  {app.auth.type === "headers" &&
                    app.auth.headerNames.map((h) => (
                      <SecretField
                        key={h}
                        label={template ? "API key" : h}
                        value={headerValues[h] ?? ""}
                        onChange={(v) => setHeaderValues((vals) => ({ ...vals, [h]: v }))}
                        saved="••••"
                        description={template ? `Sent as ${h}: ${headerValue(template, "<key>")}.` : undefined}
                      />
                    ))}
                  {app.auth.type === "oauth" && (
                    <ClientFields appName={app.name} redirectUrl={redirectUrl} clientId={clientId} clientSecret={clientSecret} onClientId={setClientId} onClientSecret={setClientSecret} />
                  )}
                </Section>
              </>
            )}
            <FormError message={error} />
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter hasDivider>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StackItem size="fill">
              <ConfirmButton label="Remove" confirmLabel={`Click again to remove ${app.name}`} size="md" onConfirm={remove} />
            </StackItem>
            <Button label="Cancel" variant="secondary" onClick={onClose} />
            <Button label="Save" variant="primary" isLoading={save.pending} clickAction={submit} />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}

function signInText(app: AppView): string {
  const kind = SIGN_IN_TEXT[app.auth.type];
  if (app.auth.type === "oauth") return `${kind} · ${app.auth.signedIn ? "signed in" : "not signed in"}`;
  if (app.auth.type === "bearer") return `${kind} ${app.auth.key ?? ""}`.trim();
  if (app.auth.type === "headers") return `${kind}: ${app.auth.headerNames.join(", ")}`;
  return kind;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={3}>{title}</Heading>
        {description && <Text type="supporting">{description}</Text>}
      </VStack>
      {children}
    </VStack>
  );
}
