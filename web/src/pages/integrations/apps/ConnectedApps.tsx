import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { BrandLogo } from "../../../components/BrandLogo";
import { href } from "../../../lib/router";
import type { AgentSpec } from "../../../lib/types";
import { StatusLine } from "../parts";
import { type AppView, appAgents, appStatus } from "./apps";

export interface ConnectedAppsProps {
  apps: AppView[];
  agents: Pick<AgentSpec, "id" | "name" | "apps">[];
  /** Pointer's name. */
  lead: string;
  selectedId?: string;
}

/** The connected apps, one row each: status, what it may do, and who has it. A row opens the app (#/integrations/apps/<id>). */
export function ConnectedApps({ apps, agents, lead, selectedId }: ConnectedAppsProps) {
  return (
    <List hasDividers density="spacious">
      {apps.map((app) => {
        const status = appStatus(app);
        const holders = appAgents(agents, app.id).map((a) => a.name);
        return (
          <ListItem
            key={app.id}
            href={href("integrations", "apps", app.id)}
            isSelected={app.id === selectedId}
            align="start"
            startContent={<BrandLogo id={app.presetId ?? undefined} name={app.name} size="md" />}
            label={<Text weight="semibold">{app.name}</Text>}
            description={
              <VStack gap={1}>
                <StatusLine tone={status.tone} text={status.text} />
                <Text type="supporting">{holders.length ? `${lead} and ${holders.join(", ")}` : `${lead} only`}</Text>
              </VStack>
            }
            endContent={<Icon icon={ChevronRightIcon} size="sm" color="secondary" />}
          />
        );
      })}
    </List>
  );
}
