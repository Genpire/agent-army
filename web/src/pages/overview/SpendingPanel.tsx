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
import { type BudgetView, CAP_VARIANT, type UsageView, alertSentence, capLeft, capLine } from "./spending";

/** Repositories with a cap shown on the Overview; the rest are under Settings → Spending. */
const REPOS_SHOWN = 5;

const changeCaps = <Button label="Change caps" variant="secondary" href={href("settings")} />;

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
          title={monthlyUsedUp ? "Monthly budget used up" : usedUp.length === 1 ? "A repository's cap is used up" : `${usedUp.length} repository caps are used up`}
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
  if (!monthly && repos.length === 0) {
    return (
      <EmptyState
        isCompact
        title="No spending cap"
        description={`${usd(usage.totalUsd)} spent this month. Set a monthly budget, or caps per repository, so new work stops before it costs more than you want.`}
        icon={<Icon icon={BanknotesIcon} size="lg" />}
        actions={<Button label="Set a cap" variant="secondary" href={href("settings")} />}
      />
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
    </VStack>
  );
}
