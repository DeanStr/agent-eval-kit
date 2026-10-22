import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A self-contained skill; publish its entrypoint last and never overwrite an installation. */
export function installImprovementSkill(directory: string): string {
  const source = fileURLToPath(new URL("../../skills/aek-improve", import.meta.url));
  if (!fs.existsSync(path.join(source, "SKILL.md")))
    throw new Error(`Incomplete AEK package: missing ${source}/SKILL.md`);
  const parent = path.resolve(directory);
  const target = path.join(parent, "aek-improve");
  fs.mkdirSync(parent, { recursive: true });
  const staged = fs.mkdtempSync(path.join(parent, ".aek-improve-install-"));
  let reserved = false;
  try {
    fs.cpSync(source, staged, { recursive: true, dereference: true });
    fs.mkdirSync(target);
    reserved = true;
    for (const entry of fs
      .readdirSync(staged)
      .sort((a, b) => Number(a === "SKILL.md") - Number(b === "SKILL.md")))
      fs.renameSync(path.join(staged, entry), path.join(target, entry));
    return target;
  } catch (error) {
    if (reserved) fs.rmSync(target, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Refusing to overwrite ${target}. Install into another directory to review an update.`,
      );
    throw error;
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
