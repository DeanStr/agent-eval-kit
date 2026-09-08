import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { authoringDirectory } from "./paths.js";
import { isWithin, prospectiveRealPath } from "../io.js";

const text = z.string().trim().min(1);
const id = text.regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  "Use letters, digits, underscores, or hyphens",
);
const source = z.object({ kind: z.enum(["user", "document", "inference"]), ref: text }).strict();
const review = z.object({ reviewer: text, reason: text }).strict();
const check = z.object({ suite: text.optional(), area: text, rubric: text }).strict();
const trial = z.object({ kind: z.enum(["good", "defect"]), run: text, rationale: text }).strict();

export const authoringPlanSchema = z
  .object({
    version: z.literal(1),
    scope: z
      .object({
        mode: z.enum(["project", "feature"]),
        description: text,
        reviewedBy: text.optional(),
      })
      .strict(),
    config: text.optional(),
    discovery: z
      .object({
        sources: z.array(source),
        remaining: z.array(text),
      })
      .strict(),
    areas: z.array(z.object({ id, title: text, sources: z.array(source).min(1) }).strict()),
    decisions: z.array(
      z
        .object({
          id,
          question: text,
          dependsOn: z.array(id),
          resolution: z.object({ answer: text, source }).strict().optional(),
        })
        .strict(),
    ),
    requirements: z.array(
      z
        .object({
          id,
          area: id,
          statement: text,
          sources: z.array(source).min(1),
          priority: z.enum(["critical", "normal", "low", "undecided"]),
          decisionIds: z.array(id),
          dependsOn: z.array(id),
          acceptance: text.optional(),
          evidence: text.optional(),
          preparation: text.optional(),
          confirmedBy: text.optional(),
          exclusion: review.optional(),
          checks: z.array(check),
          trials: z.array(trial),
        })
        .strict(),
    ),
  })
  .strict();

export type AuthoringPlan = z.infer<typeof authoringPlanSchema>;
export type AuthoringRequirement = AuthoringPlan["requirements"][number];
export type AuthoringCheck = AuthoringRequirement["checks"][number];

function unique(values: string[], context: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const folded = value.toLowerCase();
    if (seen.has(folded)) throw new Error(`${context}: duplicate identity ${value}`);
    seen.add(folded);
  }
}

function graph(entries: Array<{ id: string; dependsOn: string[] }>, context: string): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (key: string): void => {
    if (done.has(key)) return;
    if (visiting.has(key)) throw new Error(`${context}: dependency cycle at ${key}`);
    const entry = byId.get(key);
    if (!entry) throw new Error(`${context}: unknown dependency ${key}`);
    visiting.add(key);
    unique(entry.dependsOn, `${context} ${key} dependencies`);
    for (const dependency of entry.dependsOn) visit(dependency);
    visiting.delete(key);
    done.add(key);
  };
  for (const entry of entries) visit(entry.id);
}

export function validateAuthoringPlan(value: unknown): AuthoringPlan {
  const parsed = authoringPlanSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid authoring plan:\n${z.prettifyError(parsed.error)}`);
  const plan = parsed.data;
  unique(
    plan.areas.map((area) => area.id),
    "areas",
  );
  unique(
    plan.decisions.map((decision) => decision.id),
    "decisions",
  );
  unique(
    plan.requirements.map((requirement) => requirement.id),
    "requirements",
  );
  graph(plan.decisions, "decisions");
  graph(plan.requirements, "requirements");
  const areas = new Set(plan.areas.map((area) => area.id));
  const decisions = new Map(plan.decisions.map((decision) => [decision.id, decision]));
  for (const decision of plan.decisions) {
    if (decision.resolution?.source.kind === "inference")
      throw new Error(`${decision.id}: an inference cannot resolve a product decision`);
    if (decision.resolution && decision.dependsOn.some((key) => !decisions.get(key)?.resolution))
      throw new Error(`${decision.id}: resolve prerequisite decisions first`);
  }
  for (const requirement of plan.requirements) {
    if (!areas.has(requirement.area))
      throw new Error(`${requirement.id}: unknown area ${requirement.area}`);
    unique(requirement.decisionIds, `${requirement.id} decisions`);
    for (const key of requirement.decisionIds)
      if (!decisions.has(key)) throw new Error(`${requirement.id}: unknown decision ${key}`);
    unique(
      requirement.checks.map((binding) => JSON.stringify(binding)),
      `${requirement.id} checks`,
    );
    unique(
      requirement.trials.map((entry) => entry.run),
      `${requirement.id} trials`,
    );
    if (requirement.exclusion && (requirement.checks.length || requirement.trials.length))
      throw new Error(`${requirement.id}: excluded requirements cannot claim checks or trials`);
    if (requirement.checks.length && !isClarified(requirement, plan))
      throw new Error(
        `${requirement.id}: resolve decisions and supply acceptance, evidence, preparation, priority, and confirmedBy before binding checks`,
      );
    if (requirement.checks.length && !plan.config)
      throw new Error(`${requirement.id}: set config before binding checks`);
    if (requirement.trials.length && !requirement.checks.length)
      throw new Error(`${requirement.id}: trials require linked checks`);
  }
  return plan;
}

export function isClarified(requirement: AuthoringRequirement, plan: AuthoringPlan): boolean {
  return Boolean(
    requirement.acceptance &&
      requirement.evidence &&
      requirement.preparation &&
      requirement.confirmedBy &&
      requirement.priority !== "undecided" &&
      requirement.decisionIds.every((key) =>
        plan.decisions.some((decision) => decision.id === key && decision.resolution),
      ),
  );
}

export function authoringPlanPath(projectRoot: string): string {
  const root = fs.realpathSync(projectRoot);
  const directory = authoringDirectory(root);
  // This reserved directory must stay inside this project, including through symlinks.
  if (prospectiveRealPath(directory) !== directory)
    throw new Error(`Authoring directory must not be a symlink: ${directory}`);
  const file = path.join(directory, "plan.json");
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()))
    throw new Error(`Authoring plan must be a regular file: ${file}`);
  return file;
}

export function loadAuthoringPlan(projectRoot: string): AuthoringPlan {
  const file = authoringPlanPath(projectRoot);
  if (!fs.existsSync(file))
    throw new Error(`No authoring plan at ${file}. Run aek author init --project <directory>.`);
  if (fs.statSync(file).size > 4 * 1024 * 1024)
    throw new Error(`Authoring plan exceeds 4 MiB: ${file}`);
  return validateAuthoringPlan(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function initializeAuthoring(
  projectRoot: string,
  mode: "project" | "feature",
  description: string,
): string {
  const file = authoringPlanPath(projectRoot);
  const plan = validateAuthoringPlan({
    version: 1,
    scope: { mode, description },
    discovery: {
      sources: [],
      remaining: ["Survey the project and review the evaluation scope with the user."],
    },
    areas: [],
    decisions: [],
    requirements: [],
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Authoring plan already exists: ${file}. Read it and continue; initialization never overwrites decisions.`,
      );
    throw error;
  }
  return file;
}

export function authoringConfigPath(projectRoot: string, configured: string): string {
  const root = fs.realpathSync(projectRoot);
  const file = prospectiveRealPath(path.resolve(root, configured));
  if (!isWithin(root, file))
    throw new Error(`Authoring config must be inside the project: ${configured}`);
  return file;
}
