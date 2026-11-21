import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { BanknotesIcon } from "@heroicons/react/24/outline";
import { plural, usd } from "../../lib/format";
import { href } from "../../lib/router";
import { type AgentSpendView, type BudgetAlertView, type BudgetView, CAP_VARIANT, type UsageView, alertSentence, capLeft, capLine, spendAgainstCap } from "./spending";

/** Repositories with a cap shown on the Overview; the rest are under Settings → Spending. */
const REPOS_SHOWN = 5;

const changeCaps = <Button label="Change caps" variant="secondary" href={href("settings")} />;

/** The banner's title for one used-up cap. */
function usedUpTitle(a: BudgetAlertView): string {
  if (a.scope === "repo") return "A repository's cap is used up";
  if (a.scope === "agent") return `${a.name ?? "An agent"}'s budget is used up`;
  if (a.scope === "provider") return `${a.name ?? "A provider"}'s budget is used up`;
  return "Monthly budget used up";
}

/** Agents shown on the Overview, most spent first; the rest are under Activity and Settings → Spending. */
const AGENTS_SHOWN = 4;

/** The agents that spent the most this month, with their cap when they have one. */
function TopAgents({ agents }: { agents: AgentSpendView[] }) {
  const top = agents.filter((a) => a.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, AGENTS_SHOWN);
  if (!top.length) return null;
  return (
    <VStack gap={2}>
      <Text weight="medium">By agent</Text>
      <List hasDividers edge="bleed">
        {top.map((a) => (
          <ListItem
            key={a.agentId}
            label={a.name}
            description={spendAgainstCap(a)}
            endContent={
              a.capUsd ? (
                <VStack gap={1} hAlign="end" width={112}>
                  <Text type="supporting" hasTabularNumbers>
                    {a.level === "exceeded" ? "Used up" : `${usd(a.remainingUsd ?? 0)} left`}
                  </Text>
                  <ProgressBar label={`${a.name} this month`} isLabelHidden value={Math.min(a.usd, a.capUsd)} max={a.capUsd} variant={CAP_VARIANT[a.level]} />
                </VStack>
              ) : undefined
            }
          />
        ))}
      </List>
    </VStack>
  );
}

/**
 * The page's spending banners: an error banner while a cap is used up, a
 * warning banner while one is past the alert level. One banner per status.
 */
export function SpendingBanners({ budget, pointer }: { budget: BudgetView; pointer: string }) {
  const usedUp = budget.alerts.filter((a) => a.level === "exceeded");
  const near = budget.alerts.filter((a) => a.level === "alert");
  const monthlyUsedUp = usedUp.some((a) => a.scope === "monthly");
  return (
    <>
      {usedUp.length > 0 && (
        <Banner
          status="error"
          title={monthlyUsedUp ? "Monthly budget used up" : usedUp.length === 1 ? usedUpTitle(usedUp[0]!) : `${usedUp.length} spending caps are used up`}
          description={`${usedUp.map(alertSentence).join(" ")} ${monthlyUsedUp ? `${pointer} answers again when the month ends or the cap is raised.` : ""} Running tasks finish.`.replace(/\s+/g, " ").trim()}
          endContent={changeCaps}
          collapsible={false}
        />
      )}
      {near.length > 0 && (
        <Banner
          status="warning"
          title={near.length === 1 ? "Spending is near a cap" : `Spending is near ${plural(near.length, "cap")}`}
          description={`${near.map(alertSentence).join(" ")} At the cap, new work there is refused until the month ends (UTC).`}
          endContent={changeCaps}
          collapsible={false}
        />
      )}
    </>
  );
}

/** Spend against the monthly budget and the repositories' caps, with a bar each. */
export function SpendingPanel({ usage, error }: { usage: UsageView | undefined; error: string | undefined }) {
  if (!usage) {
    return error ? <Text color="secondary">{error}</Text> : <Skeleton height={64} index={0} />;
  }
  const { monthly, repos } = usage.budget;
  const otherCaps = usage.agents.some((a) => a.capUsd) || usage.providers.some((p) => p.capUsd);
  if (!monthly && repos.length === 0 && !otherCaps) {
    return (
      <VStack gap={4}>
        <EmptyState
          isCompact
          title="No spending cap"
          description={`${usd(usage.totalUsd)} spent this month. Set a monthly budget, or caps per repository, AI provider or agent, so new work stops before it costs more than you want.`}
          icon={<Icon icon={BanknotesIcon} size="lg" />}
          actions={<Button label="Set a cap" variant="secondary" href={href("settings")} />}
        />
        <TopAgents agents={usage.agents} />
      </VStack>
    );
  }
  return (
    <VStack gap={4}>
      {monthly ? (
        <VStack gap={2}>
          <HStack gap={3} hAlign="between" vAlign="center">
            <Text weight="medium">Monthly budget</Text>
            <Text type="supporting" hasTabularNumbers>
              {capLeft(monthly)}
            </Text>
          </HStack>
          <ProgressBar label="Monthly budget used" isLabelHidden value={Math.min(monthly.usedUsd, monthly.capUsd)} max={monthly.capUsd} variant={CAP_VARIANT[monthly.level]} />
          <Text type="supporting" hasTabularNumbers>
            {`${capLine(monthly)} · chat and repo tasks · alerts at ${usage.budget.alertPercent}%`}
          </Text>
        </VStack>
      ) : (
        <Text type="supporting">{`No monthly budget: ${usd(usage.totalUsd)} spent this month.`}</Text>
      )}
      {repos.length > 0 && (
        <List hasDividers edge="bleed">
          {repos.slice(0, REPOS_SHOWN).map((r) => (
            <ListItem
              key={r.repo}
              label={r.repo}
              description={capLine(r)}
              endContent={
                <VStack gap={1} hAlign="end" width={112}>
                  <Text type="supporting" hasTabularNumbers>
                    {capLeft(r)}
                  </Text>
                  <ProgressBar label={`Spent on ${r.repo}`} isLabelHidden value={Math.min(r.usedUsd, r.capUsd)} max={r.capUsd} variant={CAP_VARIANT[r.level]} />
                </VStack>
              }
            />
          ))}
        </List>
      )}
      {repos.length > REPOS_SHOWN && <Text type="supporting">{`${plural(repos.length - REPOS_SHOWN, "more repository", "more repositories")} with a cap under Settings.`}</Text>}
      <TopAgents agents={usage.agents} />
    </VStack>
  );
}
