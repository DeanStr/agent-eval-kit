import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Install a self-contained copy; never overwrite an existing skill. */
export function installAuthoringSkill(directory: string): string {
  // Both src/authoring and dist/authoring are two levels below the package root.
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const source = path.join(packageRoot, "skills", "aek-author");
  const docs = path.join(packageRoot, "docs");
  for (const file of [path.join(source, "SKILL.md"), path.join(docs, "authoring.md")])
    if (!fs.existsSync(file)) throw new Error(`Incomplete AEK package: missing ${file}`);
  const parent = path.resolve(directory);
  const target = path.join(parent, "aek-author");
  fs.mkdirSync(parent, { recursive: true });
  const staged = fs.mkdtempSync(path.join(parent, ".aek-author-install-"));
  let reserved = false;
  try {
    fs.cpSync(source, staged, { recursive: true, dereference: true });
    // The installed skill must not depend on a source checkout or node_modules path.
    fs.cpSync(docs, path.join(staged, "references", "docs"), {
      recursive: true,
      dereference: true,
    });
    fs.copyFileSync(
      path.join(packageRoot, "README.md"),
      path.join(staged, "references", "README.md"),
    );
    fs.cpSync(
      path.join(packageRoot, "examples", "authoring"),
      path.join(staged, "references", "examples", "authoring"),
      { recursive: true },
    );
    // Keep the authoring guide's own contract/example links local after installation.
    const authoringGuide = path.join(staged, "references", "docs", "authoring.md");
    fs.writeFileSync(
      authoringGuide,
      fs
        .readFileSync(authoringGuide, "utf8")
        .replaceAll("../skills/aek-author/references/plan.md", "../plan.md")
        .replaceAll("../skills/aek-author/references/generation.md", "../generation.md"),
    );
    fs.mkdirSync(target); // Exclusive reservation: concurrent installs and existing files fail.
    reserved = true;
    // Publish the entrypoint after its resources, so discovery cannot load a partial skill.
    for (const entry of fs
      .readdirSync(staged)
      .sort((left, right) => Number(left === "SKILL.md") - Number(right === "SKILL.md")))
      fs.renameSync(path.join(staged, entry), path.join(target, entry));
    return target;
  } catch (error) {
    if (reserved) fs.rmSync(target, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Refusing to overwrite ${target}. Review your existing skill; install into another directory to compare an update.`,
      );
    throw error;
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
