import { Banner } from "@astryxdesign/core/Banner";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useCallback, useState } from "react";
import { errorMessage } from "../../../lib/api";
import { useConfig } from "../../../lib/state";
import { type TestResult, testSource } from "./sources";

export type TestState = { status: "idle" } | { status: "running"; name: string } | { status: "ok"; name: string; result: TestResult } | { status: "failed"; name: string; error: string };

/** Runs a saved source's test (a sample request, or the database's connection and role) and keeps its outcome. */
export function useSourceTest() {
  const { refresh } = useConfig();
  const [state, setState] = useState<TestState>({ status: "idle" });
  const run = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      setState({ status: "running", name });
      let ok = false;
      try {
        const result = await testSource(id);
        setState({ status: "ok", name, result });
        ok = true;
      } catch (err) {
        setState({ status: "failed", name, error: errorMessage(err) });
      }
      // The source's "tested" time changed.
      await refresh();
      return ok;
    },
    [refresh],
  );
  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset };
}

/** A test's outcome: what the source answered (the start of it, without credentials), any warning, or why it failed. */
export function TestOutcome({ state, lead }: { state: TestState; lead: string }) {
  if (state.status === "idle") return null;
  if (state.status === "running") {
    return (
      <HStack gap={2} vAlign="center">
        <Spinner size="sm" />
        <Text color="secondary">Testing {state.name}…</Text>
      </HStack>
    );
  }
  if (state.status === "failed") return <Banner status="error" title={`${state.name}: the test failed`} description={state.error} collapsible={false} />;
  return (
    <VStack gap={3}>
      <Banner status="success" title={`${state.name} answered`} description={`The start of what ${lead} reads from it:`} collapsible={false}>
        <CodeBlock code={state.result.preview} language="plaintext" isWrapped maxHeight={260} width="100%" size="sm" />
      </Banner>
      {state.result.warnings.map((w) => (
        <Banner key={w} status="warning" title={w} collapsible={false} />
      ))}
    </VStack>
  );
}
