import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Code } from "@astryxdesign/core/Code";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { VStack } from "@astryxdesign/core/VStack";
import { CursorArrowRaysIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { useAppState } from "../../lib/state";

const styles = stylex.create({
  // A standalone screen with no app shell around it paints its own page background.
  page: { backgroundColor: colorVars["--color-background-body"] },
});

const MIN_PASSWORD = 10;

/**
 * Runs a sign-in style request: pending flag, the server's error message
 * shown in the card (not a toast, so it stays next to the fields), then
 * refresh() to move on to the console.
 */
function useAuthRequest() {
  const { refresh } = useAppState();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (path: string, body: unknown) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await api.post(path, body);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      // A 409 means someone finished setup meanwhile: refresh() shows the sign-in screen.
      await refresh();
    } finally {
      setPending(false);
    }
  };
  return { submit, pending, error };
}

/** The sign-in card, from the login-card template: brand mark, one card with the form, a footnote. */
function AuthFrame({ title, description, error, footnote, children }: { title: string; description: string; error?: string; footnote: ReactNode; children: ReactNode }) {
  return (
    <Center axis="both" padding={6} minHeight="100vh" xstyle={styles.page}>
      <VStack gap={6} hAlign="center" width="100%" maxWidth={420}>
        <HStack gap={2} vAlign="center">
          <NavIcon icon={<Icon icon={CursorArrowRaysIcon} size="sm" />} />
          <Text weight="bold" size="lg">
            Agent Army
          </Text>
        </HStack>
        <Card padding={8} width="100%">
          <VStack gap={6}>
            <VStack gap={1} hAlign="center">
              <Heading level={2} accessibilityLevel={1} justify="center">
                {title}
              </Heading>
              <Text color="secondary" justify="center">
                {description}
              </Text>
            </VStack>
            {error && <Banner status="error" title={error} collapsible={false} />}
            {children}
          </VStack>
        </Card>
        <HStack gap={2} vAlign="center" hAlign="center">
          <Icon icon={LockClosedIcon} size="xsm" color="secondary" />
          <Text type="supporting" justify="center">
            {footnote}
          </Text>
        </HStack>
      </VStack>
    </Center>
  );
}

/** First visit: create the admin account with the setup token from the deploy output or the server log. */
export function SetupScreen() {
  const { submit, pending, error } = useAuthRequest();
  const [setupToken, setSetupToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);

  const tokenError = tried && !setupToken.trim() ? "Paste the setup token." : undefined;
  const passwordError = tried && password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : undefined;
  const confirmError = tried && confirm !== password ? "The passwords do not match." : undefined;

  const create = async () => {
    setTried(true);
    if (!setupToken.trim() || password.length < MIN_PASSWORD || confirm !== password) return;
    await submit("/api/setup", { setupToken, password });
  };

  return (
    <AuthFrame
      title="Set up Agent Army"
      description="Create the admin password for this console. You need it to manage Pointer and its team."
      error={error}
      footnote="Credentials you add later are stored encrypted on this server.">
      <VStack gap={4}>
        <TextInput
          label="Setup token"
          description="Printed in the deploy output and the server log."
          value={setupToken}
          onChange={setSetupToken}
          size="lg"
          autoComplete="off"
          hasSpellCheck={false}
          hasAutoFocus
          status={tokenError ? { type: "error", message: tokenError } : undefined}
          onEnter={create}
        />
        <TextInput
          label="Admin password"
          type="password"
          description={`At least ${MIN_PASSWORD} characters. If you forget it, you can set a new one with the setup token.`}
          value={password}
          onChange={setPassword}
          size="lg"
          autoComplete="new-password"
          status={passwordError ? { type: "error", message: passwordError } : undefined}
          onEnter={create}
        />
        <TextInput
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          size="lg"
          autoComplete="new-password"
          status={confirmError ? { type: "error", message: confirmError } : undefined}
          onEnter={create}
        />
      </VStack>
      <Button label="Create admin account" variant="primary" size="lg" isLoading={pending} clickAction={create} width="100%" />
    </AuthFrame>
  );
}

/** Where the setup token is, for the password reset: Secret Manager on Cloud Run, the log elsewhere. */
function SetupTokenHelp() {
  return (
    <VStack gap={2}>
      <Text type="supporting">
        On Google Cloud Run, print it on your computer with <Code>gcloud secrets versions access latest --secret agent-army-setup-token</Code> (add{" "}
        <Code>--project</Code> with your project; the secret is named after the deployment).
      </Text>
      <Text type="supporting">
        With Docker, it is in the server log: <Code>docker logs agent-army 2&gt;&amp;1 | grep setup</Code>.
      </Text>
    </VStack>
  );
}

/** Forgot the password: the setup token sets a new one and signs out every other session. */
function ResetPassword({ onBack }: { onBack: () => void }) {
  const { submit, pending, error } = useAuthRequest();
  const [setupToken, setSetupToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);

  const tokenError = tried && !setupToken.trim() ? "Paste the setup token." : undefined;
  const passwordError = tried && password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : undefined;
  const confirmError = tried && confirm !== password ? "The passwords do not match." : undefined;

  const reset = async () => {
    setTried(true);
    if (!setupToken.trim() || password.length < MIN_PASSWORD || confirm !== password) return;
    await submit("/api/reset-password", { setupToken, password });
  };

  return (
    <AuthFrame
      title="Set a new password"
      description="Use the deployment's setup token to choose a new admin password. Everyone signed in with the old one is signed out."
      error={error}
      footnote="Only someone who can read this deployment's secrets or logs has the setup token.">
      <VStack gap={4}>
        <TextInput
          label="Setup token"
          value={setupToken}
          onChange={setSetupToken}
          size="lg"
          autoComplete="off"
          hasSpellCheck={false}
          hasAutoFocus
          status={tokenError ? { type: "error", message: tokenError } : undefined}
          onEnter={reset}
        />
        <SetupTokenHelp />
        <TextInput
          label="New password"
          type="password"
          description={`At least ${MIN_PASSWORD} characters.`}
          value={password}
          onChange={setPassword}
          size="lg"
          autoComplete="new-password"
          status={passwordError ? { type: "error", message: passwordError } : undefined}
          onEnter={reset}
        />
        <TextInput
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          size="lg"
          autoComplete="new-password"
          status={confirmError ? { type: "error", message: confirmError } : undefined}
          onEnter={reset}
        />
      </VStack>
      <VStack gap={2}>
        <Button label="Set new password and sign in" variant="primary" size="lg" isLoading={pending} clickAction={reset} width="100%" />
        <Button label="Back to sign in" variant="ghost" size="lg" onClick={onBack} width="100%" />
      </VStack>
    </AuthFrame>
  );
}

export function LoginScreen() {
  const { submit, pending, error } = useAuthRequest();
  const [password, setPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const signIn = async () => {
    if (!password) return;
    await submit("/api/login", { password });
  };
  if (resetting) return <ResetPassword onBack={() => setResetting(false)} />;
  return (
    <AuthFrame
      title="Sign in"
      description="Manage Pointer, its team and their integrations."
      error={error}
      footnote="Only the admin of this deployment can sign in.">
      <TextInput
        label="Admin password"
        type="password"
        value={password}
        onChange={setPassword}
        size="lg"
        autoComplete="current-password"
        hasAutoFocus
        onEnter={signIn}
      />
      <VStack gap={2}>
        <Button label="Sign in" variant="primary" size="lg" isLoading={pending} isDisabled={!password} clickAction={signIn} width="100%" />
        <Button label="Forgot your password?" variant="ghost" size="lg" onClick={() => setResetting(true)} width="100%" />
      </VStack>
    </AuthFrame>
  );
}
