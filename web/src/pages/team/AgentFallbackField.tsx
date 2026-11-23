import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector, type SelectorOptionData } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { PlusIcon } from "@heroicons/react/24/outline";
import { OrderControls } from "../../components/OrderControls";
import {
  AGENT_ENGINE_OPTIONS,
  type AgentEngine,
  type AgentFallback,
  ENGINE_DESCRIPTION,
  ENGINE_NAME,
  engineReady,
  isAgentEngine,
  nextFallbackEngine,
} from "../../lib/engines";
import { moveItem, removeAt } from "../../lib/order";
import { href } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { AGENT_FALLBACK_MAX } from "../../lib/types";
import { EngineModelField } from "./EngineModelField";

export interface AgentFallbackFieldProps {
  /** The agent's own engine: never one of its fallbacks. */
  engine: AgentEngine;
  value: AgentFallback[];
  onChange: (fallback: AgentFallback[]) => void;
}

/**
 * Who takes over an agent's repo-task work, in order, when its engine cannot
 * do it (AgentSpec.fallback): up to AGENT_FALLBACK_MAX engines, each with the
 * model its CLI runs. Claude is always offered; a CLI that is not connected
 * can be chosen and is skipped until it is.
 */
/** Claude is the last resort: nothing comes after it (the server refuses that), so it is kept last. */
const claudeLast = (fallback: AgentFallback[]): AgentFallback[] => [...fallback.filter((f) => f.engine !== "claude"), ...fallback.filter((f) => f.engine === "claude")];

export function AgentFallbackField({ engine, value, onChange: change }: AgentFallbackFieldProps) {
  const onChange = (fallback: AgentFallback[]) => change(claudeLast(fallback));
  const { config } = useConfig();
  const ready = (e: AgentEngine) => engineReady(config, e);
  const taken = value.map((f) => f.engine);
  const next = value.length < AGENT_FALLBACK_MAX ? nextFallbackEngine(engine, taken, ready) : undefined;
  const notConnected = [...new Set(taken.filter((e) => !ready(e)))].map((e) => ENGINE_NAME[e]);
  const setAt = (i: number, f: AgentFallback) => onChange(value.map((x, j) => (j === i ? f : x)));

  /** Every engine, without the agent's own and the ones the other rows have. */
  const options = (i: number): SelectorOptionData[] =>
    AGENT_ENGINE_OPTIONS.map((e) => {
      const own = e === engine;
      const elsewhere = taken.some((t, j) => t === e && j !== i);
      return {
        value: e,
        label: ENGINE_NAME[e],
        description: own ? "Its own engine" : elsewhere ? "Already in the list" : ready(e) ? ENGINE_DESCRIPTION[e] : "Not connected: skipped until it is",
        disabled: own || elsewhere,
      };
    });

  return (
    <VStack gap={3}>
      {value.length > 0 && (
        <List listStyle="decimal" density="compact">
          {value.map((f, i) => (
            <ListItem
              // Rows are edited in place (another engine keeps the row), so their place is their identity.
              key={i}
              align="start"
              label={
                <VStack gap={3}>
                  {/* Another engine has other models: its model starts over at the engine's own. */}
                  <Selector
                    label={`Fallback ${i + 1}: engine`}
                    isLabelHidden
                    options={options(i)}
                    value={f.engine}
                    onChange={(v) => isAgentEngine(v) && setAt(i, { engine: v, model: v === f.engine ? f.model : "" })}
                    width="100%"
                  />
                  {f.engine !== "claude" && (
                    <EngineModelField
                      engine={f.engine}
                      value={f.model}
                      onChange={(model) => setAt(i, { ...f, model })}
                      description={`The model ${ENGINE_NAME[f.engine]} runs when it takes over.`}
                    />
                  )}
                </VStack>
              }
              endContent={
                <OrderControls
                  name={ENGINE_NAME[f.engine]}
                  index={i}
                  count={value.length}
                  onMove={(delta) => onChange(moveItem(value, i, delta))}
                  onRemove={() => onChange(removeAt(value, i))}
                />
              }
            />
          ))}
        </List>
      )}
      {next ? (
        <HStack>
          <Button label="Add a fallback" variant="secondary" size="sm" icon={<Icon icon={PlusIcon} />} onClick={() => onChange([...value, { engine: next, model: "" }])} />
        </HStack>
      ) : (
        value.length >= AGENT_FALLBACK_MAX && <Text type="supporting">At most {AGENT_FALLBACK_MAX} engines take over.</Text>
      )}
      {notConnected.length > 0 && (
        <Text type="supporting">
          {notConnected.join(" and ")} {notConnected.length === 1 ? "is" : "are"} skipped until connected on the{" "}
          <Link href={href("integrations")} isStandalone>
            Integrations page
          </Link>
          .
        </Text>
      )}
    </VStack>
  );
}
