/**
 * The Genpire pane: what Pointer and the team can do in Genpire and what they
 * can't; connecting in one click (an app connection from the catalog's
 * "genpire" preset, signed in on Genpire's own page); once connected, the
 * sign-in, what Pointer may do, the agents and the tools Genpire lists live
 * (the same parts as any app's drawer: apps/AppSettings.tsx); and what to ask.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { CheckCircleIcon, SwatchIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { errorMessage } from "../../lib/api";
import { plural } from "../../lib/format";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import { AccessField, type AccessChoice } from "./apps/AccessField";
import { AgentsField } from "./apps/AgentsField";
import { AppSignInPanel, AppToolList, useAppSettings } from "./apps/AppSettings";
import { type AppCatalogData, type AppView, type CatalogApp, useAppCatalog } from "./apps/apps";
import type { IntegrationSummary } from "./catalog";
import { GENPIRE_EXAMPLES, GENPIRE_PRESET_ID, connectGenpire, genpireApp } from "./genpire/genpire";
import { Examples, FormActions, FormError, PaneHeader, PaneSection } from "./parts";

export function GenpirePane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  const { config } = useConfig();
  const name = config.team.pointer.name;
  const catalog = useAppCatalog();
  const app = genpireApp(config.apps);
  const preset = catalog.data?.apps.find((c) => c.id === GENPIRE_PRESET_ID);

  return (
    <VStack gap={6}>
      <PaneHeader
        icon={SwatchIcon}
        title={summary.name}
        tone={summary.tone}
        status={summary.status}
        description={`Lets ${name} and the team work in your Genpire account from Slack and Chat: look up your products, design new ones in your brand style, make tech packs and print files, and prepare factory quote requests. What Genpire makes comes back as links to it in Genpire.`}
        onBack={onBack}
      />
      <GenpireAbilities lead={name} />
      {app ? <GenpireConnection key={app.id} app={app} preset={preset} /> : <GenpireConnect catalog={catalog} preset={preset} />}
      <Examples
        title="What to ask"
        description={`Mention ${name} in Slack or write in Chat. Say "in Genpire" when it could mean another tool.`}
        examples={GENPIRE_EXAMPLES}
      />
    </VStack>
  );
}

/** What Pointer can and can't do in Genpire, whatever the tools are called today. */
function GenpireAbilities({ lead }: { lead: string }) {
  const can = [
    "Read your products, brand styles, tech packs and usage.",
    "Create and edit products, with your brand style. This uses your Genpire plan.",
    "Prepare a factory quote request for a product.",
  ];
  return (
    <PaneSection title={`What ${lead} can do`} description={`Genpire asks you on its own page what ${lead} may do, and you can keep it to looking only here.`}>
      <List density="compact">
        {can.map((text) => (
          <ListItem key={text} align="first-line" startContent={<Icon icon={CheckCircleIcon} size="sm" color="success" />} label={<Text>{text}</Text>} />
        ))}
        <ListItem
          align="first-line"
          startContent={<Icon icon={XCircleIcon} size="sm" color="secondary" />}
          label={<Text>Send a quote to a factory. You send it in Genpire itself.</Text>}
        />
      </List>
    </PaneSection>
  );
}

/** Not connected yet: one click adds the connection and opens Genpire's sign-in page. */
function GenpireConnect({ catalog, preset }: { catalog: { data?: AppCatalogData; error?: string }; preset?: CatalogApp }) {
  const { config } = useConfig();
  const lead = config.team.pointer.name;
  const { run } = useAction();
  const [error, setError] = useState<string>();

  const connect = async () => {
    setError(undefined);
    await run(async () => {
      try {
        await connectGenpire(catalog.data?.apps);
      } catch (err) {
        setError(errorMessage(err));
        throw err;
      }
    });
  };

  return (
    <PaneSection
      title="Connect Genpire"
      description={`Sign in on Genpire's own page: it shows "${lead} wants to use your Genpire account" and asks what ${lead} may do. Then you come back here. ${lead} starts able to design; you can make it look only afterwards.`}>
      {catalog.error && <Banner status="error" title={`Couldn't load the app catalog: ${catalog.error}`} collapsible={false} />}
      <FormError message={error} />
      <FormActions>
        <Button label="Connect Genpire" variant="primary" clickAction={connect} isDisabled={!preset} />
      </FormActions>
      {preset?.notes && <Text type="supporting">{preset.notes}</Text>}
    </PaneSection>
  );
}

/** Connected: the sign-in, what Pointer may do, the agents, the live tools; save and disconnect. */
function GenpireConnection({ app, preset }: { app: AppView; preset?: CatalogApp }) {
  const { config } = useConfig();
  const lead = config.team.pointer.name;
  const settings = useAppSettings(app);
  const choices: { read: AccessChoice; write: AccessChoice } = {
    read: { label: "Look only", description: "Read products, brand styles, tech packs and usage. Nothing is designed, so your Genpire plan is not used." },
    write: {
      label: "Design too",
      description: `Also create and edit products and prepare quote requests, which uses your Genpire plan. ${lead} designs only when asked; agents in Slack conversations still only look.`,
    },
  };
  const save = async () => {
    await settings.submit();
  };
  const turnOn = async () => {
    await settings.submit({ enabled: true }, "Genpire is on again.");
  };
  // Deletes the connection; the pane then offers "Connect Genpire" again.
  const disconnect = async () => {
    await settings.remove("Genpire disconnected. Agents no longer have it.");
  };

  return (
    <>
      <PaneSection title="Sign-in" description={`${lead} works as the Genpire account that signed in, with what it allowed on Genpire's page. Sign in again to change that.`}>
        {!app.enabled && (
          <Banner
            status="warning"
            title="Genpire is turned off"
            description={`${lead} and the agents don't use it until it is on again.`}
            endContent={<Button label="Turn on" variant="secondary" size="sm" clickAction={turnOn} />}
            collapsible={false}
          />
        )}
        <AppSignInPanel app={app} preset={preset} settings={settings} lead={lead} />
      </PaneSection>

      <PaneSection title="Access" description={`What ${lead} and the agents may do in Genpire.`}>
        <AccessField value={settings.access} onChange={settings.setAccess} appName="Genpire" lead={lead} choices={choices} />
        <AgentsField value={settings.agentIds} onChange={settings.setAgentIds} agents={config.team.agents} lead={lead} />
      </PaneSection>

      <PaneSection
        title="Tools"
        description={
          app.tools.length
            ? `The tools Genpire lists today: ${plural(settings.usable, "tool")} of ${app.tools.length} can be used. Turn off any you don't want used.`
            : "The tools Genpire lists, once it is signed in."
        }>
        <AppToolList app={app} settings={settings} writeLabel={choices.write.label} />
      </PaneSection>

      <FormError message={settings.error} />
      <FormActions>
        <Button label="Save" variant="primary" isLoading={settings.saving} clickAction={save} />
        <ConfirmButton label="Disconnect" confirmLabel="Click again to disconnect" size="md" onConfirm={disconnect} />
      </FormActions>
    </>
  );
}
