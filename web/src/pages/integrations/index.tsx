/**
 * Integrations: Claude, Slack, GitHub and monday.com. A list of the four with
 * their status beside the selected one's pane (`#/integrations/<id>`).
 *
 * Responsive contract (useMediaQuery):
 *   >=1120px  list 288 | pane            the list stays in view while the pane scrolls
 *   <1120px   list, or pane + back       `#/integrations` shows the list, `#/integrations/<id>` the pane
 */
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { StackItem } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { ChatBubbleLeftRightIcon, ChevronRightIcon, CodeBracketIcon, RectangleStackIcon, SparklesIcon } from "@heroicons/react/24/outline";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useRef } from "react";
import { PageFrame } from "../../components/PageFrame";
import { href, navigate, useRoute } from "../../lib/router";
import { useConfig } from "../../lib/state";
import { type IntegrationId, type IntegrationSummary, defaultIntegration, isIntegrationId, summarize } from "./catalog";
import { ClaudePane } from "./ClaudePane";
import { GitHubPane } from "./GitHubPane";
import { MondayPane } from "./MondayPane";
import { type HeroIcon, TONE_LABEL } from "./parts";
import { SlackPane } from "./SlackPane";

const ICONS: Record<IntegrationId, HeroIcon> = {
  claude: SparklesIcon,
  slack: ChatBubbleLeftRightIcon,
  github: CodeBracketIcon,
  monday: RectangleStackIcon,
};

const styles = stylex.create({
  // The list stays in view while a long pane (GitHub) scrolls under the page header.
  sticky: { position: "sticky", top: spacingVars["--spacing-0"], alignSelf: "flex-start" },
});

export default function IntegrationsPage() {
  const { config } = useConfig();
  const route = useRoute();
  const isNarrow = useMediaQuery("(max-width: 1119px)");
  const rows = summarize(config);
  const requested = route.rest[0];
  const selectedId: IntegrationId | undefined = isIntegrationId(requested) ? requested : isNarrow ? undefined : defaultIntegration(rows);
  const selected = rows.find((r) => r.id === selectedId);
  const missing = rows.filter((r) => r.required && !r.connected).length;

  const description =
    missing > 0
      ? `Claude, Slack and GitHub are required; monday.com is optional. ${missing} still ${missing === 1 ? "needs" : "need"} connecting.`
      : "Everything required is connected. Choose one to see who it is connected as, or to change it.";

  // A newly selected pane starts at its top, not at the previous pane's scroll position.
  const top = useRef<HTMLElement>(null);
  const shown = useRef(selectedId);
  useEffect(() => {
    if (shown.current === selectedId) return;
    shown.current = selectedId;
    scrollContainerToTop(top.current);
  }, [selectedId]);

  const list = <IntegrationList rows={rows} selectedId={isNarrow ? undefined : selectedId} showChevron={isNarrow} />;
  const pane = selected && <IntegrationPane key={selected.id} summary={selected} onBack={isNarrow ? () => navigate("integrations") : undefined} />;

  return (
    <PageFrame title="Integrations" description={description}>
      <VStack ref={top}>
        {isNarrow ? (
          (pane ?? list)
        ) : (
          <HStack gap={8} vAlign="start">
            <StackItem xstyle={styles.sticky}>
              <VStack width={288}>{list}</VStack>
            </StackItem>
            <StackItem size="fill">{pane}</StackItem>
          </HStack>
        )}
      </VStack>
    </PageFrame>
  );
}

/** Scrolls the nearest scrolling ancestor (the page content) back to its top. */
function scrollContainerToTop(el: HTMLElement | null): void {
  for (let e = el?.parentElement; e; e = e.parentElement) {
    const { overflowY } = getComputedStyle(e);
    if (overflowY === "auto" || overflowY === "scroll") {
      e.scrollTop = 0;
      return;
    }
  }
}

function IntegrationList({ rows, selectedId, showChevron }: { rows: IntegrationSummary[]; selectedId?: IntegrationId; showChevron: boolean }) {
  return (
    <List
      header={
        <Text type="label" color="secondary">
          Connections
        </Text>
      }
      density="spacious"
      hasDividers>
      {rows.map((r) => (
        <ListItem
          key={r.id}
          href={href("integrations", r.id)}
          isSelected={r.id === selectedId}
          align="start"
          startContent={<NavIcon icon={<Icon icon={ICONS[r.id]} size="sm" />} />}
          label={<Text weight="semibold">{r.name}</Text>}
          description={<RowDescription row={r} />}
          endContent={showChevron ? <Icon icon={ChevronRightIcon} size="sm" color="secondary" /> : undefined}
        />
      ))}
    </List>
  );
}

function RowDescription({ row }: { row: IntegrationSummary }): ReactNode {
  return (
    <VStack gap={1}>
      <HStack gap={1.5} vAlign="center">
        <StatusDot variant={row.tone} label={TONE_LABEL[row.tone]} />
        <Text type="supporting" color="primary" maxLines={1}>
          {row.status}
        </Text>
      </HStack>
      <Text type="supporting">{row.enables}</Text>
    </VStack>
  );
}

function IntegrationPane({ summary, onBack }: { summary: IntegrationSummary; onBack?: () => void }) {
  switch (summary.id) {
    case "claude":
      return <ClaudePane summary={summary} onBack={onBack} />;
    case "slack":
      return <SlackPane summary={summary} onBack={onBack} />;
    case "github":
      return <GitHubPane summary={summary} onBack={onBack} />;
    case "monday":
      return <MondayPane summary={summary} onBack={onBack} />;
  }
}
