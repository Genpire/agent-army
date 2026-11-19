import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { VStack } from "@astryxdesign/core/VStack";
import { BriefcaseIcon, SparklesIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { Fragment } from "react";
import { plural, timeAgo, usd } from "../../lib/format";
import { useConfig } from "../../lib/state";
import type { Team } from "../../lib/types";
import { useAction } from "../../lib/useAction";
import { type Decision, HR_AGENT_ID, type HrReview, REVIEW_BUDGET, hrApi } from "./hr";
import { HrProposalRow } from "./HrProposalRow";
import { modelLabel } from "./team";
import { useHrReviews } from "./useHrReviews";

/** "5 min ago · 40 recent tasks · Opus 5.5 · cost $0.31". */
function reviewMeta(review: HrReview, lead: string): string {
  const from = review.instructionsFrom === "team" ? "HR's instructions from the team" : "HR's built-in instructions";
  return [
    `Reviewed ${timeAgo(review.createdAt)}`,
    plural(review.tasksSeen, "recent task"),
    review.model ? modelLabel(review.model) : `${lead}'s model`,
    from,
    `cost ${usd(review.costUsd)}`,
  ].join(" · ");
}

/** A review's summary and its proposals as rows. */
function ReviewBody({ review, team, onDecided }: { review: HrReview; team: Team; onDecided: (d: Decision) => Promise<void> }) {
  const open = review.proposals.filter((p) => p.status === "open").length;
  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Text>{review.summary}</Text>
        <Text type="supporting">
          {reviewMeta(review, team.pointer.name)}
          {review.proposals.length > 0 ? ` · ${open} of ${plural(review.proposals.length, "proposal")} open` : ""}
        </Text>
      </VStack>
      {review.proposals.length === 0 ? (
        <Text color="secondary">No proposals: HR thinks the team fits the work it gets.</Text>
      ) : (
        review.proposals.map((p) => (
          <Fragment key={p.id}>
            <Divider />
            <HrProposalRow review={review} proposal={p} team={team} onDecided={onDecided} />
          </Fragment>
        ))
      )}
      {review.dropped.length > 0 && (
        <Text type="supporting">
          {plural(review.dropped.length, "proposal")} left out because {review.dropped.length === 1 ? "it was" : "they were"} not valid:{" "}
          {review.dropped.map((d) => `${d.kind} (${d.why})`).join("; ")}.
        </Text>
      )}
    </VStack>
  );
}

/**
 * HR recommendations on the Team page: ask HR for a review of how the team
 * works, then apply or dismiss each proposal. Applying changes the team at
 * once (the roster above refreshes); a skill opens the Skills page's search.
 */
export function HrSection() {
  const { config, refresh } = useConfig();
  const team = config.team;
  const lead = team.pointer.name;
  const hr = team.agents.find((a) => a.id === HR_AGENT_ID);
  const { reviews, error, put } = useHrReviews();
  const ask = useAction();
  const addHr = useAction();
  const showToast = useToast();
  const [latest, ...earlier] = reviews ?? [];

  const onDecided = async (decision: Decision) => {
    put(decision.review);
    if (decision.proposal.kind !== "skill") await refresh();
  };

  const askButton = (
    <Button
      label={latest ? "Ask HR for a new review" : "Ask HR for a review"}
      variant={latest ? "secondary" : "primary"}
      icon={<Icon icon={SparklesIcon} />}
      isLoading={ask.pending}
      tooltip={`One model call of about a minute, at most ${REVIEW_BUDGET}, counted with chat.`}
      clickAction={async () => {
        await ask.run(async () => {
          const { review } = await hrApi.review();
          put(review);
          showToast({ body: `HR's review is ready. It cost ${usd(review.costUsd)}.`, type: "info" });
        });
      }}
    />
  );

  return (
    <>
      <Divider />
      <VStack gap={4}>
        <HStack gap={4} hAlign="between" vAlign="end" wrap="wrap">
          <VStack gap={1}>
            <Heading level={2}>HR recommendations</Heading>
            <Text type="supporting">
              HR looks at the last 60 repo tasks (requests, results, failures, costs) and the team, then recommends who to hire, change or retire and
              which skills to add. Nothing changes until you apply a proposal.
            </Text>
          </VStack>
          {askButton}
        </HStack>

        {!hr && (
          <Banner
            status="info"
            title="HR is not on the team"
            description="Reviews use HR's built-in instructions. Add HR to edit how it reviews, its model, or to let it help in chat."
            endContent={
              <Button
                label="Add HR to the team"
                size="sm"
                icon={<Icon icon={UserPlusIcon} />}
                isLoading={addHr.pending}
                clickAction={async () => {
                  await addHr.run(
                    async () => {
                      await hrApi.addHr();
                      await refresh();
                    },
                    { success: "HR joined the team." },
                  );
                }}
              />
            }
          />
        )}
        {hr && !hr.enabled && (
          <Text type="supporting">HR is disabled, so {lead} does not hand it work in chat. You can still ask it for a review here.</Text>
        )}

        {error && !reviews && <Banner status="error" title="Could not load HR's reviews" description={error} collapsible={false} />}

        {!reviews && !error ? (
          <Skeleton height={160} index={0} />
        ) : latest ? (
          <Card>
            <ReviewBody review={latest} team={team} onDecided={onDecided} />
          </Card>
        ) : (
          reviews && (
            <Card>
              <EmptyState
                title="No review yet"
                description={`HR reads the recent repo tasks and the team in one model call (about a minute, at most ${REVIEW_BUDGET}) and proposes changes for you to apply.`}
                icon={<Icon icon={BriefcaseIcon} size="lg" />}
              />
            </Card>
          )
        )}

        {earlier.length > 0 && (
          <Collapsible defaultIsOpen={false} trigger={<Text weight="semibold">Earlier reviews ({earlier.length})</Text>}>
            <VStack gap={3}>
              {earlier.map((review, i) => (
                <Fragment key={review.id}>
                  {i > 0 && <Divider />}
                  <Collapsible
                    defaultIsOpen={false}
                    chevronPosition="start"
                    trigger={
                      <Text weight="medium">
                        {new Date(review.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} ·{" "}
                        {plural(review.proposals.length, "proposal")} · {usd(review.costUsd)}
                      </Text>
                    }>
                    <ReviewBody review={review} team={team} onDecided={onDecided} />
                  </Collapsible>
                </Fragment>
              ))}
            </VStack>
          </Collapsible>
        )}
      </VStack>
    </>
  );
}
