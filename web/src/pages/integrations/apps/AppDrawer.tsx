import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { StackItem } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { type ReactNode, useState } from "react";
import { BrandLogo } from "../../../components/BrandLogo";
import { ConfirmButton } from "../../../components/ConfirmButton";
import { SecretField } from "../../../components/SecretField";
import { plural } from "../../../lib/format";
import { useConfig } from "../../../lib/state";
import { FormError, StatusLine } from "../parts";
import { AccessField } from "./AccessField";
import { ClientFields, needsClientSecret } from "./AddAppDrawer";
import { AgentsField } from "./AgentsField";
import { AppSignInPanel, AppToolList, useAppSettings } from "./AppSettings";
import { type AppView, type CatalogApp, appStatus, headerOf, headerValue } from "./apps";

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

function AppForm({ app, preset, redirectUrl, onClose }: { app: AppView; preset?: CatalogApp; redirectUrl: string; onClose: () => void }) {
  const { config } = useConfig();
  const lead = config.team.pointer.name;
  const settings = useAppSettings(app);
  const [name, setName] = useState(app.name);
  const [enabled, setEnabled] = useState(app.enabled);
  const [ownerOnly, setOwnerOnly] = useState(app.ownerOnly);
  const [token, setToken] = useState("");
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const status = appStatus(app);
  // A catalog header with a template ("Token token={key}") is replaced by pasting the key only.
  const template = preset && app.auth.type === "headers" && app.auth.headerNames.length === 1 && headerOf(preset.auth) === app.auth.headerNames[0] ? preset.valueTemplate : undefined;

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
    if (!name.trim()) return settings.setError("Give the app a name.");
    const auth = credentials();
    // Sent only when changed, so a personal Google app left as it is keeps following the default.
    const owner = ownerOnly !== app.ownerOnly ? { ownerOnly } : {};
    if (!(await settings.submit({ name: name.trim(), enabled, ...owner, ...(auth ? { auth } : {}) }))) return;
    if (auth && app.auth.type === "oauth") return settings.signIn();
    onClose();
  };

  const remove = async () => {
    if (await settings.remove()) onClose();
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
              <AppSignInPanel app={app} preset={preset} settings={settings} lead={lead} />
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
            <Switch
              label="Only for me"
              description={`Only you can use it: in the console and your DM with ${lead}. Colleagues talking to ${lead} and team members never get it.`}
              value={ownerOnly}
              onChange={setOwnerOnly}
              labelPosition="start"
              labelSpacing="spread"
            />
            <AccessField value={settings.access} onChange={settings.setAccess} appName={app.name} lead={lead} />
            <AgentsField value={settings.agentIds} onChange={settings.setAgentIds} agents={config.team.agents} lead={lead} ownerOnly={ownerOnly} />

            <Divider />
            <Section title="Tools" description={`${plural(settings.usable, "tool")} of ${app.tools.length} can be used. Turn off any you don't want used.`}>
              <AppToolList app={app} settings={settings} />
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
                    <ClientFields
                      appName={app.name}
                      redirectUrl={redirectUrl}
                      clientId={clientId}
                      clientSecret={clientSecret}
                      onClientId={setClientId}
                      onClientSecret={setClientSecret}
                      secretRequired={needsClientSecret(app.url)}
                    />
                  )}
                </Section>
              </>
            )}
            <FormError message={settings.error} />
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
            <Button label="Save" variant="primary" isLoading={settings.saving} clickAction={submit} />
          </HStack>
        </LayoutFooter>
      }
    />
  );
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
