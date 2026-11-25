import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { BrandLogo } from "../../../components/BrandLogo";
import { CopyField } from "../../../components/CopyField";
import { SecretField } from "../../../components/SecretField";
import { api, errorMessage } from "../../../lib/api";
import { useConfig } from "../../../lib/state";
import { useAction } from "../../../lib/useAction";
import { FormError } from "../parts";
import { AccessField } from "./AccessField";
import { AgentsField } from "./AgentsField";
import {
  type AddAppResult,
  type AppAuthKind,
  type AppSource,
  type AppView,
  type CatalogApp,
  HEADER_NAME_RE,
  authLabel,
  fillUrl,
  headerOf,
  headerValue,
  urlError,
  urlFieldsOf,
  urlValueError,
} from "./apps";

type AuthChoice = "oauth" | "bearer" | "headers" | "none";
interface HeaderRow {
  name: string;
  value: string;
}

const choiceOf = (kind: AppAuthKind): AuthChoice =>
  kind === "bearer"
    ? "bearer"
    : kind === "none"
      ? "none"
      : kind.startsWith("header:")
        ? "headers"
        : "oauth";
const ALL_CHOICES: AuthChoice[] = ["oauth", "bearer", "headers", "none"];
const CHOICE_TEXT: Record<AuthChoice, { label: string; description: string }> =
  {
    oauth: {
      label: "Sign in (OAuth)",
      description:
        "You sign in at the app in this browser; the console keeps the sign-in and renews it.",
    },
    bearer: {
      label: "API key",
      description: "Sent as Authorization: Bearer <key>.",
    },
    headers: {
      label: "API key in a header",
      description: "Sent in the header the app names, e.g. X-API-Key.",
    },
    none: {
      label: "No sign-in",
      description: "A public server, e.g. documentation search.",
    },
  };

/** The sign-ins a catalog entry offers, first its main one; any of them for registry and custom apps. */
const choicesFor = (preset: CatalogApp | undefined): AuthChoice[] =>
  preset
    ? [
        ...new Set([
          choiceOf(preset.auth),
          ...(preset.altAuth ? [choiceOf(preset.altAuth)] : []),
        ]),
      ]
    : ALL_CHOICES;

/** The header a catalog sign-in names, for the chosen way to sign in. */
const presetHeader = (preset: CatalogApp | undefined): string | undefined =>
  preset
    ? (headerOf(preset.auth) ??
      (preset.altAuth ? headerOf(preset.altAuth) : undefined))
    : undefined;

export interface AddAppDrawerProps {
  isOpen: boolean;
  /** What to connect; kept while the drawer animates out. */
  source: AppSource | undefined;
  /** Where vendors send the browser back after a sign-in (GET /api/apps/catalog). */
  redirectUrl: string;
  onOpenChange: (isOpen: boolean) => void;
  /** After an app with a key (or none) is added. OAuth apps leave the page to sign in instead. */
  onAdded?: (app: AppView) => void;
}

/**
 * Connects one app: a catalog entry, a server from the MCP Registry or a
 * custom one. OAuth apps are added and the browser goes to the vendor's
 * sign-in; apps with a key are checked by listing their tools first.
 */
export function AddAppDrawer({
  isOpen,
  source,
  redirectUrl,
  onOpenChange,
  onAdded,
}: AddAppDrawerProps) {
  const title =
    !source || source.kind === "custom"
      ? "Custom app"
      : `Connect ${source.app.name}`;
  return (
    <Drawer
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      label={title}
      purpose="form"
      width={600}
      experimental={{ isFullWidthOnMobile: true }}
    >
      {source && (
        <AddAppForm
          key={
            source.kind === "custom"
              ? "custom"
              : `${source.kind}:${source.app.id}`
          }
          source={source}
          title={title}
          redirectUrl={redirectUrl}
          onClose={() => onOpenChange(false)}
          onAdded={onAdded}
        />
      )}
    </Drawer>
  );
}

function initialHeaders(source: AppSource): HeaderRow[] {
  if (source.kind === "registry" && source.app.headerNames)
    return source.app.headerNames.map((name) => ({ name, value: "" }));
  const named =
    source.kind === "catalog"
      ? presetHeader(source.app)
      : source.kind === "registry"
        ? headerOf(source.app.auth)
        : undefined;
  return [{ name: named ?? "", value: "" }];
}

function AddAppForm({
  source,
  title,
  redirectUrl,
  onClose,
  onAdded,
}: {
  source: AppSource;
  title: string;
  redirectUrl: string;
  onClose: () => void;
  onAdded?: (app: AppView) => void;
}) {
  const { config, refresh } = useConfig();
  const lead = config.team.pointer.name;
  const preset = source.kind === "catalog" ? source.app : undefined;
  const found = source.kind === "custom" ? undefined : source.app;
  const choices = choicesFor(preset);
  const urlFields = preset ? urlFieldsOf(preset) : [];

  const [name, setName] = useState(found?.name ?? "");
  const [url, setUrl] = useState(found?.url ?? "");
  const [urlValues, setUrlValues] = useState<Record<string, string>>({});
  const [transport, setTransport] = useState<"http" | "sse">(
    found?.transport ?? "http",
  );
  const [choice, setChoice] = useState<AuthChoice>(
    found ? choiceOf(found.auth) : "oauth",
  );
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>(() =>
    initialHeaders(source),
  );
  const [clientId, setClientId] = useState("");
  /** The owner chose to use an OAuth app they registered (always so when the app has no automatic registration). */
  const [ownClient, setOwnClient] = useState(false);
  const [clientSecret, setClientSecret] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [tried, setTried] = useState(false);
  const { run, pending } = useAction();

  // A catalog header (PagerDuty's "Authorization: Token token={key}") asks only for the key.
  const fixedHeader = choice === "headers" ? presetHeader(preset) : undefined;
  const template = fixedHeader ? preset?.valueTemplate : undefined;
  const manualClient = preset?.clientRegistration === "manual";
  const address = urlFields.length ? fillUrl(url, urlValues) : url.trim();
  const problems = {
    name: name.trim() ? undefined : "Give the app a name.",
    url: urlFields.length ? undefined : urlError(url),
    urlValues: Object.fromEntries(
      urlFields.map((f) => [f.key, urlValueError(urlValues[f.key] ?? "")]),
    ) as Record<string, string | undefined>,
    token:
      choice === "bearer" && !token.trim() ? "Paste the API key." : undefined,
    headers:
      choice !== "headers"
        ? undefined
        : headers.some((h) => !HEADER_NAME_RE.test(h.name.trim()))
          ? "Header names use letters, digits and dashes."
          : headers.some((h) => !h.value.trim())
            ? fixedHeader
              ? "Paste the API key."
              : "Fill in every header."
            : undefined,
    clientId:
      choice === "oauth" && (manualClient || ownClient)
        ? !clientId.trim()
          ? `Paste the client ID of the OAuth app you registered with ${name.trim() || "the app"}.`
          : looksLikeEmail(clientId)
            ? "That is an email address, not a client ID. Copy the client ID from the OAuth app you registered."
            : undefined
        : undefined,
    clientSecret:
      choice === "oauth" && (manualClient || ownClient) && needsClientSecret(address) && !clientSecret.trim()
        ? `Paste the client secret too: ${name.trim() || "Google"} refuses the sign-in without it.`
        : undefined,
  };
  const invalid =
    Boolean(
      problems.name ||
      problems.url ||
      problems.token ||
      problems.headers ||
      problems.clientId ||
      problems.clientSecret,
    ) || Object.values(problems.urlValues).some(Boolean);
  const status = (message: string | undefined) =>
    tried && message ? { type: "error" as const, message } : undefined;
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setError(undefined);
    };
  const setHeader = (i: number, patch: Partial<HeaderRow>) =>
    setHeaders((rows) =>
      rows.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    );

  const submit = async () => {
    setTried(true);
    if (invalid) return;
    const auth =
      choice === "bearer"
        ? { type: "bearer", token: token.trim() }
        : choice === "headers"
          ? {
              type: "headers",
              headers: Object.fromEntries(
                headers.map((h) => [
                  h.name.trim(),
                  headerValue(template, h.value.trim()),
                ]),
              ),
            }
          : choice === "oauth"
            ? {
                type: "oauth",
                // Only an OAuth app the owner chose to use: anything else signs in with automatic registration.
                ...((manualClient || ownClient) && clientId.trim()
                  ? {
                      clientId: clientId.trim(),
                      ...(clientSecret.trim()
                        ? { clientSecret: clientSecret.trim() }
                        : {}),
                    }
                  : {}),
              }
            : { type: "none" };
    let failure: string | undefined;
    let leaving = false;
    const ok = await run(async () => {
      try {
        const result = await api.post<AddAppResult>("/api/apps", {
          ...(preset ? { presetId: preset.id } : {}),
          name: name.trim(),
          url: address,
          transport,
          auth,
          access,
          agentIds,
        });
        if (result.signInUrl) {
          // The vendor's sign-in page; it sends the browser back to this console.
          leaving = true;
          window.location.assign(result.signInUrl);
          return;
        }
        await refresh();
        onAdded?.(result.app);
      } catch (err) {
        failure = errorMessage(err);
        throw err;
      }
    });
    if (!ok) return setError(failure);
    if (!leaving) onClose();
  };

  const primaryLabel =
    choice === "oauth"
      ? `Sign in with ${name.trim() || "the app"}`
      : "Check and add";
  const keyLabel = fixedHeader ? "API key" : "Value";

  return (
    <Layout
      header={
        <DrawerHeader
          title={title}
          subtitle={
            source.kind === "registry"
              ? `From the MCP Registry · ${source.app.publisher}`
              : preset
                ? preset.category
                : "Any app with a remote MCP server"
          }
          startContent={
            found && <BrandLogo id={preset?.id} name={found.name} size="md" />
          }
          onOpenChange={(open) => !open && onClose()}
        />
      }
      content={
        <LayoutContent>
          <VStack gap={5}>
            {preset && (
              <VStack gap={2}>
                <Text>{preset.description}</Text>
                <Text type="supporting" color="secondary">
                  For example: {preset.examples.map((e) => `“${e}”`).join(", ")}
                  .{" "}
                  <Link href={preset.docsUrl} isExternalLink>
                    {preset.name}'s guide
                  </Link>
                </Text>
              </VStack>
            )}
            {source.kind === "registry" && (
              <Banner
                status="info"
                title={
                  source.app.onPublisherDomain
                    ? `Published by ${source.app.publisher}, on its own domain`
                    : "Published by someone else"
                }
                description={`${source.app.publisher} published this server in the MCP Registry. Connect it only if you trust them: ${lead} sends it what you ask about.`}
                collapsible={false}
              />
            )}
            {preset?.notes && (
              <Banner status="info" title={preset.notes} collapsible={false} />
            )}

            <TextInput
              label="Name"
              value={name}
              onChange={edit(setName)}
              placeholder="Linear"
              description={`How ${lead} and the agents call it.`}
              status={status(problems.name)}
              isRequired
            />
            {urlFields.length ? (
              <VStack gap={3}>
                {urlFields.map((f) => (
                  <TextInput
                    key={f.key}
                    label={f.label}
                    value={urlValues[f.key] ?? ""}
                    onChange={edit((v: string) =>
                      setUrlValues((vals) => ({ ...vals, [f.key]: v })),
                    )}
                    placeholder={f.placeholder}
                    description={f.help}
                    status={status(problems.urlValues[f.key])}
                    autoCapitalize="off"
                    hasAutoCorrect={false}
                    hasSpellCheck={false}
                    isRequired
                  />
                ))}
                <Text type="supporting" color="secondary">
                  Address: {address}
                </Text>
              </VStack>
            ) : (
              <TextInput
                type="url"
                label="MCP server address"
                value={url}
                onChange={edit(setUrl)}
                placeholder="https://mcp.example.com/mcp"
                description={
                  preset?.urlHint ??
                  (preset
                    ? undefined
                    : "The server's remote (Streamable HTTP or SSE) endpoint, from the app's documentation.")
                }
                status={status(problems.url)}
                autoCapitalize="off"
                hasAutoCorrect={false}
                hasSpellCheck={false}
                isRequired
              />
            )}
            {!preset && (
              <Selector
                label="Transport"
                options={[
                  {
                    value: "http",
                    label: "Streamable HTTP",
                    description:
                      "Most servers; the address often ends in /mcp.",
                  },
                  {
                    value: "sse",
                    label: "SSE",
                    description:
                      "Older servers; the address often ends in /sse.",
                  },
                ]}
                value={transport}
                onChange={(v) => setTransport(v === "sse" ? "sse" : "http")}
              />
            )}

            <Divider />
            <VStack gap={3}>
              <Text weight="semibold">How it signs in</Text>
              {choices.length > 1 ? (
                <RadioList
                  label="How it signs in"
                  isLabelHidden
                  value={choice}
                  onChange={(v) => edit(setChoice)(v as AuthChoice)}
                >
                  {choices.map((c) => (
                    <RadioListItem
                      key={c}
                      value={c}
                      label={
                        c === "oauth"
                          ? authLabel("oauth", name.trim() || "the app")
                          : CHOICE_TEXT[c].label
                      }
                      description={CHOICE_TEXT[c].description}
                      align="first-line"
                    />
                  ))}
                </RadioList>
              ) : (
                <Text color="secondary">{CHOICE_TEXT[choice].description}</Text>
              )}

              {choice === "bearer" && (
                <SecretField
                  label="API key"
                  value={token}
                  onChange={edit(setToken)}
                  description={preset?.keyHelp}
                  isRequired
                />
              )}
              {choice === "bearer" && status(problems.token) && (
                <FormError message={problems.token} />
              )}

              {choice === "headers" && (
                <VStack gap={3}>
                  {fixedHeader && (
                    <Text type="supporting" color="secondary">
                      {[
                        preset?.keyHelp,
                        `Sent as ${fixedHeader}: ${headerValue(template, "<key>")}.`,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    </Text>
                  )}
                  {headers.map((h, i) => (
                    <HStack key={i} gap={2} vAlign="end" wrap="wrap">
                      {!fixedHeader && (
                        <StackItem size="fill">
                          <TextInput
                            label="Header"
                            value={h.name}
                            onChange={edit((v: string) =>
                              setHeader(i, { name: v }),
                            )}
                            placeholder="X-API-Key"
                            autoCapitalize="off"
                            hasAutoCorrect={false}
                            hasSpellCheck={false}
                          />
                        </StackItem>
                      )}
                      <StackItem size="fill">
                        <SecretField
                          label={keyLabel}
                          value={h.value}
                          onChange={edit((v: string) =>
                            setHeader(i, { value: v }),
                          )}
                          isRequired
                        />
                      </StackItem>
                      {!fixedHeader && headers.length > 1 && (
                        <IconButton
                          label={`Remove the ${h.name || "header"} header`}
                          variant="ghost"
                          icon={<Icon icon={XMarkIcon} />}
                          onClick={() =>
                            setHeaders((rows) => rows.filter((_, j) => j !== i))
                          }
                        />
                      )}
                    </HStack>
                  ))}
                  {!fixedHeader && headers.length < 10 && (
                    <HStack>
                      <Button
                        label="Add a header"
                        variant="ghost"
                        size="sm"
                        icon={<Icon icon={PlusIcon} size="sm" />}
                        onClick={() =>
                          setHeaders((rows) => [
                            ...rows,
                            { name: "", value: "" },
                          ])
                        }
                      />
                    </HStack>
                  )}
                  {status(problems.headers) && (
                    <FormError message={problems.headers} />
                  )}
                </VStack>
              )}

              {choice === "oauth" &&
                (manualClient ? (
                  <ClientFields
                    appName={name.trim() || "the app"}
                    redirectUrl={redirectUrl}
                    clientId={clientId}
                    clientSecret={clientSecret}
                    onClientId={edit(setClientId)}
                    onClientSecret={edit(setClientSecret)}
                    error={status(problems.clientId)?.message}
                    secretRequired={needsClientSecret(address)}
                    secretError={status(problems.clientSecret)?.message}
                  />
                ) : (
                  <Collapsible
                    trigger={
                      <Text type="supporting">
                        Use an OAuth app you registered yourself
                      </Text>
                    }
                    isOpen={ownClient}
                    onOpenChange={setOwnClient}
                  >
                    {ownClient && (
                      <ClientFields
                        appName={name.trim() || "the app"}
                        redirectUrl={redirectUrl}
                        clientId={clientId}
                        clientSecret={clientSecret}
                        onClientId={edit(setClientId)}
                        onClientSecret={edit(setClientSecret)}
                        secretRequired={needsClientSecret(address)}
                        secretError={status(problems.clientSecret)?.message}
                      />
                    )}
                  </Collapsible>
                ))}
            </VStack>

            <Divider />
            <AccessField
              value={access}
              onChange={setAccess}
              appName={name.trim() || "the app"}
              lead={lead}
            />
            <AgentsField
              value={agentIds}
              onChange={setAgentIds}
              agents={config.team.agents}
              lead={lead}
            />
            <Text type="supporting" color="secondary">
              {choice === "oauth"
                ? "After you sign in, its tools are listed and you can turn any of them off."
                : "Its tools are listed when you add it; you can turn any of them off afterwards."}
            </Text>
            <FormError message={error} />
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter hasDivider>
          <HStack gap={2} hAlign="end" vAlign="center" wrap="wrap">
            <Button label="Cancel" variant="secondary" onClick={onClose} />
            <Button
              label={primaryLabel}
              variant="primary"
              isLoading={pending}
              clickAction={submit}
            />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}

export interface ClientFieldsProps {
  appName: string;
  redirectUrl: string;
  clientId: string;
  clientSecret: string;
  onClientId: (v: string) => void;
  onClientSecret: (v: string) => void;
  /** The client's secret is saved (an app being edited): shown by its mask. */
  savedSecret?: string | null;
  error?: string;
  /** The vendor always asks for the secret (Google): no public-client option. */
  secretRequired?: boolean;
  secretError?: string;
}

/**
 * Google's servers (Gmail, Calendar, Drive and the other Workspace MCP servers)
 * always ask for the client secret when the sign-in finishes: without it the
 * sign-in fails at the last step ("client_secret is missing").
 */
export const needsClientSecret = (address: string): boolean => /^https:\/\/[a-z0-9-]+\.googleapis\.com\//i.test(address.trim());

/** A client registered by hand with the vendor (when it has no automatic registration), and the redirect address it must allow. */
export function ClientFields({
  appName,
  redirectUrl,
  clientId,
  clientSecret,
  onClientId,
  onClientSecret,
  savedSecret,
  error,
  secretRequired,
  secretError,
}: ClientFieldsProps) {
  return (
    <VStack gap={3}>
      <CopyField
        label="Redirect address"
        value={redirectUrl}
        description={`Allow this address in the OAuth app you register with ${appName}.`}
      />
      <TextInput
        label="Client ID"
        value={clientId}
        onChange={onClientId}
        // Not a user name: a browser must never fill in a saved email here.
        autoComplete="off"
        status={error ? { type: "error", message: error } : undefined}
        autoCapitalize="off"
        hasAutoCorrect={false}
        hasSpellCheck={false}
      />
      <SecretField
        label="Client secret"
        value={clientSecret}
        onChange={onClientSecret}
        saved={savedSecret}
        description={
          secretRequired
            ? "Required: Google always asks for it. In Google Cloud, Google Auth Platform → Clients → your client → Add secret, and copy it straight away (Google shows it once)."
            : "Leave empty for a public client (PKCE only)."
        }
        isRequired={secretRequired}
        status={secretError ? { type: "error" as const, message: secretError } : undefined}
      />
    </VStack>
  );
}

/** A client ID is never an email address; a browser's autofill puts one there. */
export const looksLikeEmail = (value: string): boolean =>
  /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(value.trim());
