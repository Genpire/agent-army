/**
 * "Who does what" in the AI model pane: each kind of work's providers in
 * order (config.ai.routes). The first that can run does the work; when it
 * fails for its own reasons or its monthly cap is used up, the next takes
 * over. Each change saves that kind's route at once (POST /api/ai/routes);
 * "Use the default" saves an empty one.
 */
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { PlusIcon } from "@heroicons/react/24/outline";
import { OrderControls } from "../../components/OrderControls";
import { ProviderLogo } from "../../components/ProviderLogo";
import { providerById } from "../../lib/aiProviders";
import { ROUTE_EXPLANATION, addableProviders, routeBase, routeSavedText, routesOf, stepProblem, workKindInfo } from "../../lib/aiRoutes";
import { api } from "../../lib/api";
import { moveItem, removeAt } from "../../lib/order";
import { useConfig } from "../../lib/state";
import { type AiProviderId, type AiProvidersView, ROUTE_MAX, type RouteSaved, type RouteView, WORK_KIND_OPTIONS, type WorkKind } from "../../lib/types";
import { FormError, PaneSection, StatusLine, useSave } from "./parts";

export interface AiRoutesProps {
  view: AiProvidersView;
  /** Re-reads the providers: a saved route moves the providers chat and repo tasks run on. */
  reload: () => Promise<void>;
}

/** The four kinds of work, each with its providers in order. */
export function AiRoutes({ view, reload }: AiRoutesProps) {
  const { config } = useConfig();
  const routes = routesOf(config);
  const info = workKindInfo(config.team.pointer.name);
  return (
    <PaneSection title="Who does what" description={ROUTE_EXPLANATION}>
      <VStack gap={5}>
        {WORK_KIND_OPTIONS.map((kind) => (
          <RouteEditor key={kind} kind={kind} {...info[kind]} route={routes[kind]} view={view} reload={reload} />
        ))}
      </VStack>
    </PaneSection>
  );
}

interface RouteEditorProps extends AiRoutesProps {
  kind: WorkKind;
  label: string;
  description: string;
  /** What runs while the owner has not set this kind's route. */
  byDefault: string;
  route: RouteView;
}

/** One kind of work: its providers as a numbered list to reorder, add to and remove from, and back to the default. */
function RouteEditor({ kind, label, description, byDefault, route, view, reload }: RouteEditorProps) {
  const { save, pending, error } = useSave();
  const providers = route.steps.map((s) => s.provider);
  // What an added provider joins: a default route's step that cannot run is left out of the owner's new route.
  const base = routeBase(route);
  const addable = addableProviders(view, providers);
  const isFull = providers.length >= ROUTE_MAX;

  const saveRoute = async (next: AiProviderId[]) => {
    const ok = await save(() => api.post<RouteSaved>("/api/ai/routes", { kind, providers: next }), {
      success: (r) => routeSavedText(label, r.routes?.[kind], next.length === 0),
    });
    if (ok) await reload();
  };

  const addTooltip = isFull
    ? `A route has at most ${ROUTE_MAX} providers.`
    : addable.length === 0
      ? "Every connected provider is in it. Connect another under Set up a provider."
      : undefined;

  return (
    <VStack gap={2}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <VStack gap={1}>
            <Heading level={4}>{label}</Heading>
            <Text color="secondary">{description}</Text>
          </VStack>
        </StackItem>
        <HStack gap={1} vAlign="center">
          {route.custom && <Button label="Use the default" size="sm" variant="ghost" isDisabled={pending} clickAction={() => saveRoute([])} />}
          <DropdownMenu
            button={{
              label: "Add",
              size: "sm",
              variant: "secondary",
              icon: <Icon icon={PlusIcon} />,
              isDisabled: pending || Boolean(addTooltip),
              tooltip: addTooltip ?? `Add a provider for ${label.toLowerCase()}`,
            }}
            alignment="end"
            items={addable.map((p) => ({
              id: p.id,
              label: p.name,
              description: p.configured ? undefined : (p.problem ?? "Not complete"),
              icon: <ProviderLogo provider={p} />,
              onClick: () => void saveRoute([...base, p.id]),
            }))}
          />
        </HStack>
      </HStack>
      <List listStyle="decimal" density="compact">
        {route.steps.map((step, i) => {
          const p = providerById(view, step.provider);
          return (
            <ListItem
              key={step.provider}
              startContent={<ProviderLogo provider={{ logo: p?.logo ?? "", name: p?.name ?? step.name }} />}
              label={<Text weight="semibold">{step.name}</Text>}
              description={step.ready ? undefined : <StatusLine tone="warning" text={stepProblem(step)} />}
              endContent={
                <OrderControls
                  name={step.name}
                  index={i}
                  count={providers.length}
                  isDisabled={pending}
                  removeDisabledMessage={providers.length === 1 ? "Each kind of work needs a provider" : undefined}
                  onMove={(delta) => void saveRoute(moveItem(providers, i, delta))}
                  onRemove={() => void saveRoute(removeAt(providers, i))}
                />
              }
            />
          );
        })}
      </List>
      {!route.custom && (
        <Text type="supporting" color="secondary">
          {byDefault}
        </Text>
      )}
      <FormError message={error} />
    </VStack>
  );
}
