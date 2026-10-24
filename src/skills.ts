import fs from "node:fs";
import path from "node:path";
import { installAuthoringSkill } from "./authoring/install.js";
import { installImprovementSkill } from "./improvement/install.js";

/** Where each coding agent discovers project skills. */
export const SKILL_DIRECTORIES = {
  claude: ".claude/skills",
  codex: ".agents/skills",
  cursor: ".agents/skills",
  grok: ".agents/skills",
} as const;

export type SkillAgent = keyof typeof SKILL_DIRECTORIES;

/**
 * Choose the skills directory: explicit --directory, then --agent, then Claude Code's
 * directory when the project already has .claude/ but no .agents/, else .agents/skills.
 */
export function chooseSkillsDirectory(
  options: { agent?: string; directory?: string },
  cwd = process.cwd(),
): { directory: string; reason: string } {
  if (options.directory !== undefined)
    return { directory: path.resolve(cwd, options.directory), reason: "--directory" };
  if (options.agent !== undefined) {
    if (!Object.hasOwn(SKILL_DIRECTORIES, options.agent))
      throw new Error(`--agent must be one of ${Object.keys(SKILL_DIRECTORIES).join(", ")}`);
    return {
      directory: path.resolve(cwd, SKILL_DIRECTORIES[options.agent as SkillAgent]),
      reason: `--agent ${options.agent}`,
    };
  }
  if (fs.existsSync(path.join(cwd, ".claude")) && !fs.existsSync(path.join(cwd, ".agents")))
    return {
      directory: path.resolve(cwd, SKILL_DIRECTORIES.claude),
      reason: "found .claude/ (Claude Code)",
    };
  return { directory: path.resolve(cwd, ".agents/skills"), reason: "default" };
}

/** Install aek-author and aek-improve together; refuse before writing if either exists. */
export function installSkills(directory: string): { author: string; improve: string } {
  const existing = ["aek-author", "aek-improve"]
    .map((name) => path.join(directory, name))
    .filter((target) => fs.existsSync(target));
  if (existing.length)
    throw new Error(
      `Refusing to overwrite ${existing.join(" and ")}. Review the existing skills, or install into another directory with --directory to compare an update.`,
    );
  return {
    author: installAuthoringSkill(directory),
    improve: installImprovementSkill(directory),
  };
}
