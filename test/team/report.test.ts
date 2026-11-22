import { describe, expect, it } from "vitest";
import {
  CHECK_COMMAND_MAX_CHARS,
  LESSON_TEXT_MAX_CHARS,
  REPORTED_CHECKS_MAX,
  REPORT_SCHEMA,
  TEST_PROOF_MAX_CHARS,
  parseReport,
  parseReportedChecks,
  parseReportedLessons,
} from "../../src/team/agents.js";

describe("the report's checks, test proof and lessons", () => {
  const base = { kind: "change", title: "t", summary: "s", verification: "v", risks: "", projectNotes: "" };

  it("asks for them", () => {
    expect(REPORT_SCHEMA.required).toEqual(expect.arrayContaining(["testProof", "checks", "lessons"]));
    expect(REPORT_SCHEMA.properties.checks.items.properties.outcome.enum).toEqual(["pass", "fail", "no-result"]);
  });

  it("keeps well-formed checks and drops the rest", () => {
    const checks = parseReportedChecks([
      { command: "  npm test  ", outcome: "pass", summary: "212 passed,\n 0 failed" },
      { command: "", outcome: "pass", summary: "no command" },
      { command: "npm run lint", outcome: "passed", summary: "unknown outcome" },
      { command: "npx tsc", outcome: "no-result" },
      "npm test",
      null,
    ]);
    expect(checks).toEqual([
      { command: "npm test", outcome: "pass", summary: "212 passed, 0 failed" },
      { command: "npx tsc", outcome: "no-result", summary: "" },
    ]);
    expect(parseReportedChecks("npm test")).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({ command: `x${i} ${"y".repeat(2000)}`, outcome: "fail", summary: "" }));
    const kept = parseReportedChecks(many);
    expect(kept).toHaveLength(REPORTED_CHECKS_MAX);
    expect(kept[0].command).toHaveLength(CHECK_COMMAND_MAX_CHARS);
  });

  it("keeps lessons with text, on one line", () => {
    expect(
      parseReportedLessons([
        { area: "billing", lesson: "Refunds are in cents,\nnot dollars." },
        { area: "auth", lesson: "   " },
        { lesson: "No area is fine." },
        42,
      ]),
    ).toEqual([
      { area: "billing", lesson: "Refunds are in cents, not dollars." },
      { area: "", lesson: "No area is fine." },
    ]);
    expect(parseReportedLessons([{ area: "a", lesson: "z".repeat(5000) }])[0].lesson).toHaveLength(LESSON_TEXT_MAX_CHARS);
  });

  it("reads them from a report, and leaves them empty when a report lacks them", () => {
    const report = parseReport(
      { ...base, testProof: "Without the fix: 1 failed. With it: 1 passed.", checks: [{ command: "npm test", outcome: "pass", summary: "ok" }], lessons: [{ area: "a", lesson: "b" }] },
      "",
    );
    expect(report.testProof).toBe("Without the fix: 1 failed. With it: 1 passed.");
    expect(report.checks).toHaveLength(1);
    expect(report.lessons).toEqual([{ area: "a", lesson: "b" }]);
    expect(parseReport(base, "")).toMatchObject({ testProof: "", checks: [], lessons: [] });
    expect(parseReport({ ...base, testProof: 7, checks: {}, lessons: "x" }, "")).toMatchObject({ testProof: "", checks: [], lessons: [] });
    expect(parseReport(undefined, "plain")).toMatchObject({ testProof: "", checks: [], lessons: [] });
    expect(parseReport({ ...base, testProof: "p".repeat(10_000) }, "").testProof).toHaveLength(TEST_PROOF_MAX_CHARS);
  });
});
