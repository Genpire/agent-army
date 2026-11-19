import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import type { SkillList } from "./skills";

/** The installed skills (GET /api/skills), with the load error and a reload. */
export function useSkillLibrary(enabled = true) {
  const [data, setData] = useState<SkillList>();
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      setData(await api.get<SkillList>("/api/skills"));
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { data, error, reload };
}
