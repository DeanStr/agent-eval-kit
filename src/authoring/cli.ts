import { installAuthoringSkill } from "./install.js";
import { initializeAuthoring } from "./plan.js";
import { authoringStatus } from "./status.js";

export async function authoringCommand(
  subcommand: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const value = (name: string, defaultValue: string): string => {
    const flag = flags[name];
    if (flag === undefined) return defaultValue;
    if (typeof flag !== "string" || !flag.trim()) throw new Error(`--${name} requires a value`);
    return flag;
  };
  if (subcommand === "install") {
    const target = installAuthoringSkill(value("directory", ".agents/skills"));
    console.log(
      `Installed: ${target}\nAsk your coding agent to use $aek-author to build or extend this project's evaluation suite.`,
    );
    return;
  }
  const project = value("project", ".");
  if (subcommand === "init") {
    const mode = value("mode", "project");
    if (mode !== "project" && mode !== "feature")
      throw new Error("--mode must be project or feature");
    const description = value(
      "description",
      mode === "project"
        ? "Define evaluations for this project"
        : "Define evaluations for the requested feature",
    );
    console.log(
      `Authoring plan: ${initializeAuthoring(project, mode, description)}\nThe map is empty. Survey the project, record sources, and resolve product decisions with the user.`,
    );
    return;
  }
  if (subcommand !== "status" && subcommand !== "validate")
    throw new Error("author requires install, init, status, or validate");
  const status = await authoringStatus(project);
  if (flags.json) console.log(JSON.stringify(status, null, 2));
  else {
    console.log(
      `${status.scope.description}\nInventory reviewed: ${status.scope.reviewedBy ?? "pending"}\nReady to pilot reviewed scope: ${status.ready ? "yes" : "no"}`,
    );
    console.log(
      Object.entries(status.counts)
        .map(([stage, count]) => `${stage}: ${count}`)
        .join("; "),
    );
    for (const requirement of status.requirements)
      console.log(
        `  ${requirement.id} [${requirement.stage}] ${requirement.statement}${requirement.blockers.length ? ` — ${requirement.blockers.join("; ")}` : ""}`,
      );
    for (const decision of status.openDecisions)
      console.log(
        `  ${decision.id} [${decision.readyToAsk ? "ask user" : "waiting on prerequisite"}] ${decision.question}`,
      );
    for (const remaining of status.discoveryRemaining)
      console.log(`  Discovery remaining: ${remaining}`);
    for (const area of status.emptyAreas) console.log(`  Area without requirements: ${area}`);
    for (const check of status.unlinkedChecks)
      console.log(`  Unmapped check: ${check.suite ?? "default"}/${check.area}/${check.rubric}`);
    console.log(status.interpretation);
  }
  if (flags["require-ready"] && !status.ready) process.exitCode = 2;
}
