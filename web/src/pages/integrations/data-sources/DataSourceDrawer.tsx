import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { type ReactNode, useState } from "react";
import { ConfirmButton } from "../../../components/ConfirmButton";
import { CopyField } from "../../../components/CopyField";
import { SecretField } from "../../../components/SecretField";
import { api, errorMessage } from "../../../lib/api";
import { useConfig } from "../../../lib/state";
import { useAction } from "../../../lib/useAction";
import { FormError } from "../parts";
import { TestOutcome, useSourceTest } from "./TestOutcome";
import {
  AUTH_CHOICES,
  type DataSourceView,
  type FormProblems,
  type HttpAuthChoice,
  SOURCE_CHOICES,
  type SourceForm,
  formOf,
  formProblems,
  readOnlyRoleSql,
  requestBody,
  savedSecret,
  splitList,
} from "./sources";

export interface DataSourceDrawerProps {
  isOpen: boolean;
  /** The source to edit; undefined adds one. */
  sourceId: string | undefined;
  /** Changes each time the drawer is opened, so the form starts afresh. */
  session: number;
  onOpenChange: (isOpen: boolean) => void;
}

/** Adds or edits one company data source, then tests it: kind, address and sign-in, what Pointer may read, and what it holds. */
export function DataSourceDrawer({ isOpen, sourceId, session, onOpenChange }: DataSourceDrawerProps) {
  const { config } = useConfig();
  const name = config.dataSources.find((d) => d.id === sourceId)?.name;
  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange} label={name ?? "Add a source"} purpose="form" width={600} experimental={{ isFullWidthOnMobile: true }}>
      <SourceFormView key={session} initialId={sourceId} onClose={() => onOpenChange(false)} />
    </Drawer>
  );
}

function SourceFormView({ initialId, onClose }: { initialId: string | undefined; onClose: () => void }) {
  const { config, refresh } = useConfig();
  const lead = config.team.pointer.name;
  // A new source keeps its id once added, so the next save updates it.
  const [id, setId] = useState(initialId);
  const source = config.dataSources.find((d) => d.id === id);
  const [form, setForm] = useState<SourceForm>(() => formOf(source));
  const [saved, setSaved] = useState<string>(() => JSON.stringify(formOf(source)));
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string>();
  const { run } = useAction();
  const test = useSourceTest();

  const isNew = !source;
  const dirty = isNew || JSON.stringify(form) !== saved;
  const problems = formProblems(form, source);
  const invalid = Object.values(problems).some(Boolean);
  const status = (key: keyof FormProblems) => (tried && problems[key] ? { type: "error" as const, message: problems[key] } : undefined);
  const set = <K extends keyof SourceForm>(key: K) => (value: SourceForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(undefined);
  };
  const keptNote = savedSecret(source, form);

  const saveAndTest = async () => {
    setTried(true);
    if (invalid) return;
    let failure: string | undefined;
    let savedId: string | undefined;
    const ok = await run(async () => {
      try {
        const r = source
          ? await api.post<{ source: DataSourceView }>(`/api/data-sources/${encodeURIComponent(source.id)}`, requestBody(form, false))
          : await api.post<{ source: DataSourceView }>("/api/data-sources", requestBody(form, true));
        savedId = r.source.id;
        await refresh();
      } catch (err) {
        failure = errorMessage(err);
        throw err;
      }
    });
    if (!ok || !savedId) return setError(failure);
    // Credentials are not shown again: the form now keeps the saved ones.
    const cleared = { ...form, token: "", password: "", headerValue: "", loginPassword: "", connectionString: "" };
    setForm(cleared);
    setSaved(JSON.stringify(cleared));
    setTried(false);
    setId(savedId);
    await test.run(savedId, form.name.trim());
  };

  const testSaved = async () => {
    if (source) await test.run(source.id, source.name);
  };

  const remove = async () => {
    if (!source) return;
    const ok = await run(
      async () => {
        await api.post(`/api/data-sources/${encodeURIComponent(source.id)}/delete`, {});
        await refresh();
      },
      { success: `${source.name} removed.` },
    );
    if (ok) onClose();
  };

  const choices = isNew ? SOURCE_CHOICES : SOURCE_CHOICES.filter((c) => (form.choice === "postgres" ? c.value === "postgres" : c.value !== "postgres"));

  return (
    <Layout
      header={<DrawerHeader title={source ? source.name : "Add a source"} subtitle="Company data, read-only" onOpenChange={(open) => !open && onClose()} />}
      content={
        <LayoutContent>
          <VStack gap={5}>
            {choices.length > 1 ? (
              <RadioList label="What it is" value={form.choice} onChange={(v) => set("choice")(v as SourceForm["choice"])}>
                {choices.map((c) => (
                  <RadioListItem key={c.value} value={c.value} label={c.label} description={c.description} align="first-line" />
                ))}
              </RadioList>
            ) : (
              <Text color="secondary">{SOURCE_CHOICES.find((c) => c.value === form.choice)?.description}</Text>
            )}

            <TextInput label="Name" value={form.name} onChange={set("name")} placeholder={form.choice === "postgres" ? "Product database" : "Product API"} status={status("name")} isRequired />
            <TextArea
              label="What's in it"
              value={form.description}
              onChange={set("description")}
              rows={3}
              maxLength={2000}
              placeholder={form.choice === "postgres" ? "Users (users), subscriptions (subscriptions, with plan and status), orders and payments." : "Sign-ups, active users and subscriptions: /api/stats/signups?from=&to=, /api/users?created_after="}
              description={`${lead} reads this to know when to use the source and where to look: name the tables or endpoints that matter.`}
              isOptional
            />

            <Divider />
            {form.choice === "postgres" ? (
              <PostgresFields form={form} set={set} source={source} status={status} lead={lead} />
            ) : (
              <HttpFields form={form} set={set} keptNote={keptNote} status={status} lead={lead} />
            )}

            <Divider />
            <Switch
              label="On"
              description={`Off keeps the source and its settings, but ${lead} does not read it.`}
              value={form.enabled}
              onChange={set("enabled")}
              labelPosition="start"
              labelSpacing="spread"
            />
            <FormError message={error} />
            <TestOutcome state={test.state} lead={lead} />
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter hasDivider>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StackItem size="fill">{source && <ConfirmButton label="Remove" confirmLabel={`Click again to remove ${source.name}`} size="md" onConfirm={remove} />}</StackItem>
            <Button label="Close" variant="secondary" onClick={onClose} />
            {dirty ? (
              <Button label={isNew ? "Add and test" : "Save and test"} variant="primary" clickAction={saveAndTest} />
            ) : (
              <Button label="Test" variant="primary" clickAction={testSaved} />
            )}
          </HStack>
        </LayoutFooter>
      }
    />
  );
}

type SetField = <K extends keyof SourceForm>(key: K) => (value: SourceForm[K]) => void;
type Status = (key: keyof FormProblems) => { type: "error"; message: string | undefined } | undefined;

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={3}>{title}</Heading>
        {description && (
          <Text type="supporting" color="secondary">
            {description}
          </Text>
        )}
      </VStack>
      {children}
    </VStack>
  );
}

function HttpFields({ form, set, keptNote, status, lead }: { form: SourceForm; set: SetField; keptNote: string | null; status: Status; lead: string }) {
  const login = form.choice === "login";
  return (
    <VStack gap={5}>
      <Section title="Address" description={`${lead} only sends GET requests, to this address and the paths below.`}>
        <TextInput
          type="url"
          label="Base address"
          value={form.baseUrl}
          onChange={set("baseUrl")}
          placeholder={login ? "https://cms.example.com/api" : "https://api.example.com/v1"}
          description="Each request is this address plus a path, e.g. …/v1/stats/signups."
          status={status("baseUrl")}
          autoCapitalize="off"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          isRequired
        />
        <TextArea
          label="Allowed paths"
          value={form.allowedPaths}
          onChange={set("allowedPaths")}
          rows={3}
          placeholder={"/stats\n/users"}
          description={`Path prefixes under the base address ${lead} may read, one per line; any query is allowed under them. Empty means every path: list only what reports need.`}
          status={status("allowedPaths")}
          isOptional
        />
        <Switch
          label="Internal address"
          description="Allow a private address (10.x, 192.168.x, a VPC or container name). Off, only public https addresses are used. On, the requests can reach whatever this name points to on the network this service runs in: turn it on only for your own API."
          value={form.internal}
          onChange={set("internal")}
          labelPosition="start"
          labelSpacing="spread"
        />
      </Section>

      {login ? (
        <Section title="Sign-in" description={`${lead} signs in with these, keeps the token it gets in memory, and signs in again when the API answers 401. Use an account that can only read.`}>
          <TextInput
            label="Sign-in address"
            value={form.loginUrl}
            onChange={set("loginUrl")}
            placeholder="/auth/login or https://cms.example.com/api/auth/login"
            description="Where the user name and password are posted as JSON. A path is on the base address's host."
            status={status("loginUrl")}
            autoCapitalize="off"
            hasAutoCorrect={false}
            hasSpellCheck={false}
            isRequired
          />
          <TextInput label="User name or email" value={form.loginUsername} onChange={set("loginUsername")} autoComplete="off" status={status("username")} isRequired />
          <SecretField label="Password" value={form.loginPassword} onChange={set("loginPassword")} saved={keptNote} isRequired />
          {status("credential") && <FormError message={status("credential")?.message} />}
          <Collapsible trigger={<Text type="supporting">How the sign-in works: field names and where the token is</Text>} defaultIsOpen={false}>
            <VStack gap={3}>
              <HStack gap={3} wrap="wrap">
                <StackItem size="fill">
                  <TextInput label="User name field" value={form.usernameField} onChange={set("usernameField")} description="In the JSON posted, e.g. email or user.email." />
                </StackItem>
                <StackItem size="fill">
                  <TextInput label="Password field" value={form.passwordField} onChange={set("passwordField")} />
                </StackItem>
              </HStack>
              <TextInput label="Token path" value={form.tokenPath} onChange={set("tokenPath")} description="Where the token is in the answer, e.g. token, accessToken or data.token." />
              <HStack gap={3} wrap="wrap">
                <StackItem size="fill">
                  <TextInput label="Sent in header" value={form.tokenHeader} onChange={set("tokenHeader")} />
                </StackItem>
                <StackItem size="fill">
                  <TextInput label="Before the token" value={form.tokenPrefix} onChange={set("tokenPrefix")} description='Usually "Bearer " (with the space); empty for the token alone.' />
                </StackItem>
              </HStack>
            </VStack>
          </Collapsible>
        </Section>
      ) : (
        <Section title="How it signs in" description="Stored encrypted and never shown again. Use a key that can only read.">
          <Selector
            label="Sign-in"
            options={AUTH_CHOICES.map((c) => ({ value: c.value, label: c.label, description: c.description }))}
            value={form.auth}
            onChange={(v) => set("auth")(v as HttpAuthChoice)}
          />
          {form.auth === "bearer" && <SecretField label="API token" value={form.token} onChange={set("token")} saved={keptNote} isRequired />}
          {form.auth === "basic" && (
            <>
              <TextInput label="User name" value={form.username} onChange={set("username")} autoComplete="off" status={status("username")} isRequired />
              <SecretField label="Password" value={form.password} onChange={set("password")} saved={keptNote} isRequired />
            </>
          )}
          {form.auth === "header" && (
            <HStack gap={3} vAlign="end" wrap="wrap">
              <StackItem size="fill">
                <TextInput label="Header" value={form.headerName} onChange={set("headerName")} placeholder="X-API-Key" autoCapitalize="off" hasAutoCorrect={false} hasSpellCheck={false} />
              </StackItem>
              <StackItem size="fill">
                <SecretField label="Value" value={form.headerValue} onChange={set("headerValue")} saved={keptNote} isRequired />
              </StackItem>
            </HStack>
          )}
          {status("credential") && <FormError message={status("credential")?.message} />}
        </Section>
      )}
    </VStack>
  );
}

function PostgresFields({ form, set, source, status, lead }: { form: SourceForm; set: SetField; source: DataSourceView | undefined; status: Status; lead: string }) {
  const address = source?.postgres?.address;
  return (
    <VStack gap={5}>
      <Section title="Connection" description="Stored encrypted and never shown again; the password in it is never shown.">
        <SecretField
          label="Connection string"
          value={form.connectionString}
          onChange={set("connectionString")}
          saved={source?.postgres ? address || "••••" : null}
          placeholder={source?.postgres ? undefined : "postgres://pointer_readonly:password@db.example.com:5432/app?sslmode=require"}
          description="TLS is required unless the host is this machine or a container name; add sslmode=verify-full to check the server's certificate, or sslmode=disable to turn it off."
          isRequired
        />
        {status("connectionString") && <FormError message={status("connectionString")?.message} />}
        <TextInput
          label="Schemas"
          value={form.schemas}
          onChange={set("schemas")}
          placeholder="public"
          description={`Where ${lead} looks for tables, comma separated. The role's grants decide what it can read.`}
          status={status("schemas")}
          autoCapitalize="off"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          isRequired
        />
      </Section>
      <Section
        title="Create a read-only role"
        description={`Every query runs in a read-only transaction that is rolled back, and only SELECT, WITH and EXPLAIN are accepted. The real guarantee is a role that can only read: run this as the database's owner, then connect ${lead} as it.`}>
        <CopyField label="SQL for a read-only role" value={readOnlyRoleSql(splitList(form.schemas), address)} description="Replace the password; the default privileges also cover tables the owner adds later." />
      </Section>
    </VStack>
  );
}
