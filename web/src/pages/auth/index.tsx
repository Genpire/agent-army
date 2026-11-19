import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useState } from "react";
import { api } from "../../lib/api";
import { useAppState } from "../../lib/state";
import { useAction } from "../../lib/useAction";

/** First visit: create the admin account with the setup token from the deploy output or the server log. */
export function SetupScreen() {
  const { refresh } = useAppState();
  const { run, pending } = useAction();
  const [setupToken, setSetupToken] = useState("");
  const [password, setPassword] = useState("");
  const submit = async () => {
    await run(async () => {
      await api.post("/api/setup", { setupToken, password });
      await refresh();
    });
  };
  return (
    <Center height="100vh" padding={4}>
      <Card width={420} padding={6}>
        <VStack gap={5}>
          <VStack gap={1}>
            <Heading level={1}>Set up Agent Army</Heading>
            <Text type="supporting">Create the admin account. The setup token is in the deploy output or the server log.</Text>
          </VStack>
          <TextInput label="Setup token" value={setupToken} onChange={setSetupToken} isRequired hasAutoFocus />
          <TextInput label="Admin password" type="password" value={password} onChange={setPassword} description="At least 10 characters." isRequired onEnter={submit} />
          <Button label="Create account" variant="primary" isLoading={pending} clickAction={submit} width="100%" />
        </VStack>
      </Card>
    </Center>
  );
}

export function LoginScreen() {
  const { refresh } = useAppState();
  const { run, pending } = useAction();
  const [password, setPassword] = useState("");
  const submit = async () => {
    await run(async () => {
      await api.post("/api/login", { password });
      await refresh();
    });
  };
  return (
    <Center height="100vh" padding={4}>
      <Card width={380} padding={6}>
        <VStack gap={5}>
          <VStack gap={1}>
            <Heading level={1}>Agent Army</Heading>
            <Text type="supporting">Sign in to manage Pointer and its team.</Text>
          </VStack>
          <TextInput label="Admin password" type="password" value={password} onChange={setPassword} hasAutoFocus onEnter={submit} />
          <Button label="Sign in" variant="primary" isLoading={pending} clickAction={submit} width="100%" />
        </VStack>
      </Card>
    </Center>
  );
}
