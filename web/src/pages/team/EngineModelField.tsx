import { ModelPicker } from "../../components/ModelPicker";
import { ENGINE_NAME, type EngineId } from "../../lib/engines";
import { useConfig } from "../../lib/state";
import { engineModelSpecials } from "./team";

export interface EngineModelFieldProps {
  engine: EngineId;
  /** The model id; "" runs the engine's own (its Integrations pane). */
  value: string;
  onChange: (model: string) => void;
  /** Default: "<engine> model". */
  label?: string;
  /** Default: what the model is for on the agent's own engine. */
  description?: string;
}

/** The model a coding agent CLI runs for an agent (--model), from the engine's list; empty runs the engine's own. */
export function EngineModelField({ engine, value, onChange, label, description }: EngineModelFieldProps) {
  const { config } = useConfig();
  const name = ENGINE_NAME[engine];
  return (
    <ModelPicker
      label={label ?? `${name} model`}
      source={{ kind: "engine", id: engine }}
      value={value}
      onChange={onChange}
      specials={engineModelSpecials(name, config.engines[engine].model)}
      description={description ?? `The model ${name} runs for this agent. Agents on ${name} can each run a different one.`}
      isOptional
    />
  );
}
