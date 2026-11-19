import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../lib/api";
import { type HrReview, hrApi } from "./hr";

/**
 * HR's stored reviews, newest first (GET /api/hr/reviews). `put` replaces or
 * adds one review, as a review or a decision returns it, without a reload.
 */
export function useHrReviews() {
  const [reviews, setReviews] = useState<HrReview[]>();
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      setReviews((await hrApi.reviews()).reviews);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const put = useCallback((review: HrReview) => {
    setReviews((current) => [review, ...(current ?? []).filter((r) => r.id !== review.id)].sort((a, b) => b.id.localeCompare(a.id)));
  }, []);

  return { reviews, error, reload, put };
}
