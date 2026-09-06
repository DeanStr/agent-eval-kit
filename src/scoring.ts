import type {
  AreaResult,
  EvalConfig,
  EvalSpec,
  JudgedItem,
  JudgedCase,
  RunReport,
  ScenarioEvidence,
  ScoreSlice,
  RunReceipt,
  Verdict,
} from "./types.js";
import { KIT_VERSION } from "./version.js";
import {
  aggregateAreaMeasurements,
  belowPercentageThreshold,
  calculateScoreSlice,
} from "./score-slice.js";

function verdictPoints(verdict: Verdict, partialCredit: number): number | null {
  switch (verdict) {
    case "pass":
      return 1;
    case "partial":
      return partialCredit;
    case "fail":
    case "not_found":
      return 0;
    case "cannot_judge":
      return null;
  }
}

class Slice {
  earned = 0;
  judgeable = 0;
  total = 0;

  add(total: number, judgeable: number, earned: number): void {
    this.total += total;
    this.judgeable += judgeable;
    this.earned += earned;
  }

  finish(): ScoreSlice {
    return calculateScoreSlice(this);
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Collapse the weighted automatic/manual components into their semantic
 * verdict. Critical gates require every non-zero share to pass, regardless of
 * the numeric partial-credit setting used for score calculation.
 */
export function hybridAggregateVerdict(
  components: NonNullable<JudgedItem["components"]>,
  autoShare: number,
): Verdict {
  const required = [
    ...(autoShare > 0 ? [components.automatic] : []),
    ...(autoShare < 1 ? [components.manual] : []),
  ];
  if (required.some((verdict) => !verdict || verdict === "cannot_judge")) return "cannot_judge";
  if (required.every((verdict) => verdict === "pass")) return "pass";
  if (required.every((verdict) => verdict === "fail" || verdict === "not_found")) return "fail";
  return "partial";
}

export function scoreArea(options: {
  spec: EvalSpec;
  judgements: JudgedItem[];
  evidence: ScenarioEvidence[];
  config: EvalConfig;
  defects?: AreaResult["defects"];
  notes?: string;
  caseResults?: JudgedCase[];
}): AreaResult {
  const { spec, judgements, evidence, config } = options;
  // Retain the automatic verdict separately from the aggregate from the first
  // scoring pass. Pending human work must never look like a full hybrid pass.
  // Rescores also rebuild aggregates under the current configured shares.
  const normalizedJudgements = judgements.map((item) => {
    const rubric = spec.rubric.find((candidate) => candidate.id === item.id);
    if (rubric?.grader.type !== "hybrid") return { ...item };
    const components =
      item.components ??
      (item.source === "manual" ? { manual: item.verdict } : { automatic: item.verdict });
    return {
      ...item,
      components,
      verdict: hybridAggregateVerdict(components, rubric.grader.autoShare),
    };
  });
  const byId = new Map(normalizedJudgements.map((item) => [item.id, item]));
  const looked = new Set(
    evidence
      .filter(
        (scenario) => scenario.outcome === "completed" || scenario.outcome === "feature_not_found",
      )
      .map((scenario) => scenario.scenarioId),
  );
  const total = new Slice();
  const byTag = new Map<string, Slice>();
  const pendingManual: string[] = [];
  const unproven: string[] = [];
  const judgeableByRubric = new Map<string, number>();

  for (const rubric of spec.rubric) {
    const item = byId.get(rubric.id);
    let judgeable = 0;
    let earned = 0;
    // Unscoped LLM and hybrid criteria are backed by the area's evidence as a
    // whole. They still need at least one scenario that actually reached the
    // product; an empty selector must not turn an entirely blocked area into
    // judgeable evidence. Command and direct text graders are independent of scenario reach.
    const backingWasReached =
      rubric.grader.type === "command" ||
      rubric.grader.type === "text-pairwise" ||
      (rubric.scenarios.length ? rubric.scenarios.some((id) => looked.has(id)) : looked.size > 0);

    if (rubric.grader.type === "manual") {
      const points =
        item?.source === "manual"
          ? verdictPoints(item.verdict, config.scoring.partialCredit)
          : null;
      if (points === null) pendingManual.push(rubric.id);
      else {
        judgeable = rubric.weight;
        earned = rubric.weight * points;
      }
    } else if (rubric.grader.type === "hybrid") {
      const automaticVerdict = item?.components?.automatic;
      const manualVerdict = item?.components?.manual;
      const automaticPoints = automaticVerdict
        ? verdictPoints(automaticVerdict, config.scoring.partialCredit)
        : null;
      const manualPoints = manualVerdict
        ? verdictPoints(manualVerdict, config.scoring.partialCredit)
        : null;
      const autoWeight = rubric.weight * rubric.grader.autoShare;
      const manualWeight = rubric.weight - autoWeight;
      if (
        autoWeight > 0 &&
        automaticPoints !== null &&
        automaticPoints !== undefined &&
        backingWasReached
      ) {
        judgeable += autoWeight;
        earned += autoWeight * automaticPoints;
      } else if (
        autoWeight > 0 &&
        automaticPoints !== null &&
        automaticPoints !== undefined &&
        !backingWasReached
      ) {
        unproven.push(rubric.id);
      }
      if (manualWeight <= 0) {
        // A zero manual share does not require a human verdict.
      } else if (manualPoints !== null && manualPoints !== undefined) {
        judgeable += manualWeight;
        earned += manualWeight * manualPoints;
      } else {
        pendingManual.push(rubric.id);
      }
    } else {
      const points = item ? verdictPoints(item.verdict, config.scoring.partialCredit) : null;
      if (points === null || points === undefined) {
        // Automated graders that cannot judge reduce coverage. They cannot be
        // completed through the manual-review workflow unless configured as
        // manual or hybrid.
      } else if (item?.source !== "manual" && !backingWasReached) {
        unproven.push(rubric.id);
      } else {
        judgeable = rubric.weight;
        earned = rubric.weight * points;
      }
    }

    judgeableByRubric.set(rubric.id, judgeable);
    if (item) {
      const measurement = new Slice();
      measurement.add(rubric.weight, judgeable, earned);
      item.score = measurement.finish();
    }
    total.add(rubric.weight, judgeable, earned);
    for (const tag of new Set(rubric.tags)) {
      let slice = byTag.get(tag);
      if (!slice) byTag.set(tag, (slice = new Slice()));
      slice.add(rubric.weight, judgeable, earned);
    }
  }

  const score = total.finish();
  const scoredCases = (options.caseResults ?? []).map((item) => ({
    ...item,
    points: verdictPoints(item.verdict, config.scoring.partialCredit),
  }));
  const byStratum = new Map<string, { slice: Slice; cases: number }>();
  for (const item of scoredCases) {
    const rubric = spec.rubric.find((candidate) => candidate.id === item.rubricId);
    if (!rubric)
      throw new Error(
        `Case result ${item.caseId} refers to unknown rubric ${item.rubricId} in area ${spec.id}`,
      );
    const weight =
      rubric.grader.type === "hybrid" ? rubric.weight * rubric.grader.autoShare : rubric.weight;
    for (const stratum of new Set(item.strata)) {
      let aggregate = byStratum.get(stratum);
      if (!aggregate) {
        aggregate = { slice: new Slice(), cases: 0 };
        byStratum.set(stratum, aggregate);
      }
      aggregate.cases += 1;
      aggregate.slice.add(
        weight,
        item.points === null ? 0 : weight,
        item.points === null ? 0 : weight * item.points,
      );
    }
  }
  const gates = spec.rubric
    .filter((rubric) => rubric.gate)
    .map((rubric) => {
      const item = byId.get(rubric.id);
      const judgeable = judgeableByRubric.get(rubric.id) ?? 0;
      const incomplete = judgeable < rubric.weight - 0.0001;
      const unavailable =
        !item || item.verdict === "cannot_judge" || incomplete || unproven.includes(rubric.id);
      if (unavailable) {
        return {
          itemId: rubric.id,
          status: "unavailable" as const,
          ...(item === undefined ? {} : { verdict: item.verdict }),
          reason: !item
            ? "No verdict was produced."
            : unproven.includes(rubric.id)
              ? "The automatic verdict was not backed by a completed or feature-not-found scenario."
              : incomplete
                ? `Only ${round(judgeable)} of ${round(rubric.weight)} weight is judgeable.`
                : "The item could not be judged.",
        };
      }
      return item.verdict === "pass"
        ? {
            itemId: rubric.id,
            status: "passed" as const,
            verdict: item.verdict,
            reason: "Critical criterion passed.",
          }
        : {
            itemId: rubric.id,
            status: "failed" as const,
            verdict: item.verdict,
            reason: `Critical criterion received ${item.verdict}.`,
          };
    });
  return {
    id: spec.id,
    title: spec.title,
    weight: spec.weight,
    optional: spec.optional,
    ...score,
    items: normalizedJudgements,
    defects: options.defects ?? [],
    notes: options.notes ?? "",
    scenarios: evidence,
    pendingManual: [...new Set(pendingManual)],
    unproven: [...new Set(unproven)],
    byTag: Object.fromEntries([...byTag].map(([tag, slice]) => [tag, slice.finish()])),
    byStratum: Object.fromEntries(
      [...byStratum].map(([stratum, value]) => [
        stratum,
        { ...value.slice.finish(), cases: value.cases },
      ]),
    ),
    gates,
    caseResults: scoredCases,
  };
}

function aggregateTags(areas: AreaResult[]): Record<string, ScoreSlice> {
  const tags = new Map<string, Slice>();
  for (const area of areas) {
    if (area.total <= 0)
      throw new Error(`Area ${area.id} has no positive rubric weight to aggregate`);
    const areaScale = area.weight / area.total;
    for (const [tag, value] of Object.entries(area.byTag)) {
      let slice = tags.get(tag);
      if (!slice) tags.set(tag, (slice = new Slice()));
      slice.add(value.total * areaScale, value.judgeable * areaScale, value.earned * areaScale);
    }
  }
  return Object.fromEntries([...tags].map(([tag, slice]) => [tag, slice.finish()]));
}

function aggregateStrata(areas: AreaResult[]): Record<string, ScoreSlice & { cases: number }> {
  const strata = new Map<string, { slice: Slice; cases: number }>();
  for (const area of areas) {
    if (area.total <= 0)
      throw new Error(`Area ${area.id} has no positive rubric weight to aggregate`);
    const areaScale = area.weight / area.total;
    for (const [stratum, value] of Object.entries(area.byStratum)) {
      let aggregate = strata.get(stratum);
      if (!aggregate) {
        aggregate = { slice: new Slice(), cases: 0 };
        strata.set(stratum, aggregate);
      }
      aggregate.slice.add(
        value.total * areaScale,
        value.judgeable * areaScale,
        value.earned * areaScale,
      );
      aggregate.cases += value.cases;
    }
  }
  return Object.fromEntries(
    [...strata].map(([stratum, value]) => [
      stratum,
      { ...value.slice.finish(), cases: value.cases },
    ]),
  );
}

export function buildReport(options: {
  runId: string;
  startedAt: string;
  config: EvalConfig;
  areas: AreaResult[];
  receipt: RunReceipt;
}): RunReport {
  const required = options.areas.filter((area) => !area.optional);
  const aggregate = aggregateAreaMeasurements(required);
  const blocking = options.areas.flatMap((area) =>
    area.gates
      .filter((gate) => gate.status !== "passed")
      .map((gate) => ({ areaId: area.id, ...gate })),
  );
  return {
    schemaVersion: 1,
    runId: options.runId,
    project: options.config.project.name,
    target: {
      kind: options.config.target.kind,
      ...(options.config.target.url === undefined ? {} : { url: options.config.target.url }),
      root: options.config.project.root,
    },
    startedAt: options.startedAt,
    finishedAt: new Date().toISOString(),
    kitVersion: KIT_VERSION,
    providers: {
      agent: {
        provider: options.config.agent.provider,
        ...(options.config.agent.model === undefined ? {} : { model: options.config.agent.model }),
      },
      judge: {
        provider: options.config.judge.provider,
        ...(options.config.judge.model === undefined ? {} : { model: options.config.judge.model }),
      },
    },
    areas: options.areas,
    overallScorePct: aggregate.scorePct === null ? null : round(aggregate.scorePct),
    overallCoveragePct: round(aggregate.coveragePct),
    scoreWithheld: belowPercentageThreshold(
      aggregate.coveragePct,
      options.config.scoring.minimumCoverage,
    ),
    byTag: aggregateTags(required),
    byStratum: aggregateStrata(required),
    manualPending: options.areas.reduce((sum, area) => sum + area.pendingManual.length, 0),
    receipt: options.receipt,
    gates: { passed: blocking.length === 0, blocking },
  };
}
