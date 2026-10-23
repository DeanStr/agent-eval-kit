import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CUTS, FORMATS, exportName } from "./src/story.mjs";
import { loadEvidence } from "./evidence.mjs";
import { loadWorkflow } from "./workflow.mjs";
import { renderInputs, verifyExport, pointToRelease } from "./release.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export async function preparePreview() {
  const output = path.join(root, ".agent-eval/marketing-video");
  const inputs = await renderInputs(root);
  const proof = await loadEvidence();
  const workflow = await loadWorkflow();
  const releases = {};
  // Preflight the whole release before replacing any preview export.
  for (const cut of Object.keys(CUTS))
    for (const format of Object.keys(FORMATS)) {
      const name = exportName(cut, format);
      releases[name] = await fs.realpath(path.join(output, "exports", name));
      await verifyExport(releases[name], { cut, format, duration: CUTS[cut].duration, ...inputs });
    }
  await fs.mkdir(path.join(output, "previews"), { recursive: true });
  const preview = await fs.mkdtemp(path.join(output, "previews/release-"));
  for (const cut of Object.keys(CUTS))
    for (const format of Object.keys(FORMATS)) {
      const name = exportName(cut, format);
      await fs.copyFile(path.join(releases[name], "video.mp4"), path.join(preview, `${name}.mp4`));
      await fs.copyFile(
        path.join(releases[name], "poster.png"),
        path.join(preview, `${name}-poster.png`),
      );
      await fs.copyFile(
        path.join(releases[name], "captions.vtt"),
        path.join(preview, `${name}.vtt`),
      );
    }
  for (const [name, directory] of Object.entries(proof.artifacts)) {
    const destination = path.join(preview, "proof", name);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(path.join(root, directory), destination, { recursive: true });
  }
  // Comparisons link to ../runs/<runId>; retain that original relative structure.
  const linkedRuns = path.join(preview, "proof/runs");
  await fs.rm(linkedRuns, { recursive: true, force: true });
  for (const name of ["baseline", "proportions", "overview", "repeat"]) {
    const directory = proof.artifacts[name];
    await fs.cp(path.join(root, directory), path.join(linkedRuns, path.basename(directory)), {
      recursive: true,
    });
  }
  // Dispatch evaluation: stable label folders for the page, runs/<id> for comparison links.
  const dispatchProof = path.join(preview, "proof/dispatch");
  await fs.rm(dispatchProof, { recursive: true, force: true });
  for (const result of workflow.evaluation.results) {
    await fs.cp(path.join(root, result.run), path.join(dispatchProof, result.label), {
      recursive: true,
    });
    await fs.cp(
      path.join(root, result.run),
      path.join(dispatchProof, "runs", path.basename(result.run)),
      {
        recursive: true,
      },
    );
  }
  for (const [name, directory] of Object.entries(workflow.evaluation.comparisons))
    await fs.cp(
      path.join(root, directory),
      path.join(dispatchProof, "comparisons", `compare-${name}`),
      {
        recursive: true,
      },
    );
  for (const label of ["baseline", workflow.evaluation.results.at(-2).label])
    await fs.cp(
      path.join(root, workflow.evaluation.session, label),
      path.join(dispatchProof, label === "baseline" ? "prototype-baseline" : "prototype-final"),
      { recursive: true },
    );
  const session = path.join(root, proof.session);
  for (const name of ["baseline", "proportions", "overview"])
    await fs.copyFile(
      path.join(session, `${name}.html`),
      path.join(preview, "proof", `${name}.html`),
    );
  await fs.copyFile(
    path.join(session, "journal.ndjson"),
    path.join(preview, "proof", "journal.ndjson"),
  );
  await fs.copyFile(
    path.join(output, "evidence.json"),
    path.join(preview, "proof", "manifest.json"),
  );
  await fs.copyFile(
    path.join(output, "workflow.json"),
    path.join(preview, "proof/workflow-manifest.json"),
  );
  await fs.cp(path.join(root, workflow.session), path.join(preview, "proof/workflow"), {
    recursive: true,
  });
  await loadEvidence();
  await loadWorkflow();
  if (JSON.stringify(await renderInputs(root)) !== JSON.stringify(inputs))
    throw Error(
      "Composition or evidence changed while preparing the preview. Rebuild before publishing.",
    );
  await pointToRelease(path.join(output, "preview"), preview);
  const link = path.join(root, "docs/marketing/video-output");
  try {
    await fs.symlink("../../.agent-eval/marketing-video/preview", link, "dir");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await fs.realpath(link)) !== preview)
      throw new Error(`Preview path already points elsewhere: ${link}`);
  }
  console.log("Preview ready: docs/marketing/video.html");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await preparePreview();
