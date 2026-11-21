import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { CopyField } from "../../components/CopyField";
import { api, errorMessage } from "../../lib/api";
import { useAction } from "../../lib/useAction";
import { ROUTINES_PATH, type TickInfo } from "./model";

/** The tick URL, its header and secret for an external scheduler, and rotating the secret. */
export function TickSection() {
  const [info, setInfo] = useState<TickInfo>();
  const [error, setError] = useState<string>();
  const rotate = useAction();

  const load = useCallback(async () => {
    try {
      setInfo(await api.get<TickInfo>(`${ROUTINES_PATH}/tick`));
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner status="error" title="Couldn't load the wake-up address" description={error} collapsible={false} endContent={<Button label="Try again" size="sm" clickAction={load} />} />;
  if (!info) return <Spinner size="sm" label="Loading" />;

  const example = `curl -X POST "${info.url}" -H "${info.header}: <secret>"`;
  return (
    <VStack gap={4}>
      <CopyField label="URL" value={info.url} description="Called with POST. The request lasts until the routines it starts have finished: give the scheduler a deadline of about 10 minutes." />
      <CopyField label="Header" value={info.header} />
      <CopyField label="Secret" value={info.secret} description="The header's value. Keep it private: anyone with it can make the service check for due routines (nothing else)." />
      <VStack gap={2}>
        <Text type="supporting">
          For example with Cloud Scheduler: schedule <Code size="inherit">* * * * *</Code>, target HTTP, method POST, and the header above. Or from any machine:
        </Text>
        <CodeBlock code={example} language="bash" />
      </VStack>
      <HStack gap={2} vAlign="center">
        <ConfirmButton
          label="New secret"
          confirmLabel="Click again: the old secret stops working"
          size="md"
          onConfirm={() =>
            void rotate.run(
              async () => {
                setInfo(await api.post<TickInfo>(`${ROUTINES_PATH}/tick/rotate`));
              },
              { success: "New secret made. Update it in your scheduler." },
            )
          }
        />
      </HStack>
    </VStack>
  );
}
