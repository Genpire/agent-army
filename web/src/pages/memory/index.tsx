import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { LightBulbIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "../../components/ConfirmButton";
import { PageFrame } from "../../components/PageFrame";
import { api, errorMessage } from "../../lib/api";
import { useConfig } from "../../lib/state";
import type { MemoryFact, MemoryList } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { SectionHeader } from "../projects/components/SectionHeader";

/** Memory: the facts Pointer carries into every conversation, with their date and a delete. */
export default function MemoryPage() {
  const { config } = useConfig();
  const pointer = config.team.pointer.name;
  const { run } = useAction();
  const [data, setData] = useState<MemoryList>();
  const [loadError, setLoadError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      setData(await api.get<MemoryList>("/api/memory"));
      setLoadError(undefined);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const facts: MemoryFact[] = [...(data?.facts ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const max = data?.max ?? 100;

  const remove = async (fact: MemoryFact) => {
    if (await run(() => api.post("/api/memory/delete", { id: fact.id }), { success: "Deleted the fact. Later conversations no longer see it." })) {
      await reload();
    }
  };

  const full = facts.length >= max;
  return (
    <PageFrame title="Memory" description={`Facts ${pointer} carries into every conversation.`}>
      <VStack gap={6}>
        <Banner
          status="warning"
          title="Memory is shared across all conversations"
          description={`Every conversation sees every fact, including those in public channels. Don't keep secrets or personal data here; delete anything that shouldn't be shared.`}
          collapsible={false}
        />
        <VStack gap={4}>
          <SectionHeader
            title="Saved facts"
            description={
              <>
                To add one, ask {pointer} in Slack: <Code size="inherit">remember that deploys happen on Tuesdays</Code>. To remove one, ask it to forget, or
                delete it here.
              </>
            }
            actions={
              data && (
                <VStack width={200}>
                  <ProgressBar
                    label="Memory used"
                    value={facts.length}
                    max={max}
                    hasValueLabel
                    formatValueLabel={(v, m) => `${v} of ${m}`}
                    variant={full ? "error" : facts.length >= max * 0.9 ? "warning" : "accent"}
                  />
                </VStack>
              )
            }
          />
          {full && (
            <Banner
              status="error"
              title="Memory is full"
              description={`${pointer} can't remember anything new until you delete a fact.`}
              collapsible={false}
            />
          )}
          {loadError ? (
            <Banner
              status="error"
              title="Couldn't load memory"
              description={loadError}
              collapsible={false}
              endContent={<Button label="Try again" size="sm" clickAction={reload} />}
            />
          ) : (
            <>
              {facts.length > 0 && (
                <List hasDividers edge="flush" header={<VisuallyHidden>Saved facts</VisuallyHidden>}>
                  {facts.map((f) => (
                    <ListItem
                      key={f.id}
                      label={<Text>{f.text}</Text>}
                      description={
                        <Text type="supporting" color="secondary">
                          Saved <Timestamp value={f.createdAt} format="auto" type="inherit" color="inherit" />
                          {f.by && (
                            <>
                              {" · asked by "}
                              <Code size="inherit" color="inherit">
                                {f.by}
                              </Code>
                            </>
                          )}
                        </Text>
                      }
                      endContent={<ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={() => remove(f)} />}
                    />
                  ))}
                </List>
              )}
              {data && facts.length === 0 && (
                <EmptyState
                  title="Nothing remembered yet"
                  description={`${pointer} saves a fact when someone asks it to remember something, for example: @${pointer} remember that our staging site is staging.acme.dev.`}
                  icon={<Icon icon={LightBulbIcon} size="lg" />}
                />
              )}
              {!data && <Spinner label="Loading memory" />}
            </>
          )}
        </VStack>
      </VStack>
    </PageFrame>
  );
}
