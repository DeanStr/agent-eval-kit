import fs from "node:fs";
import path from "node:path";
import { checkpointRefs } from "./checkpoints.js";
import { isWithin } from "./io.js";
import type { ScenarioEvidence } from "./types.js";

export const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ReportEvidence {
  ref: string;
  scope: "run" | "area";
  text?: string;
  truncated?: boolean;
  image?: boolean;
}

/** Select only cited evidence, expanding checkpoints to their supporting steps. */
export function evidencePreviews(refs: string[], scenarios: ScenarioEvidence[]): ReportEvidence[] {
  const expanded = new Set(refs);
  for (const scenario of scenarios)
    for (const name of Object.keys(scenario.checkpoints ?? {}))
      if (expanded.has(`${scenario.scenarioId}/evidence.json#checkpoint-${name}`))
        for (const ref of checkpointRefs(scenario, [name])) expanded.add(ref);
  return [...expanded].map((ref) => {
    for (const scenario of scenarios) {
      const prefix = `${scenario.scenarioId}/`;
      if (!ref.startsWith(prefix)) continue;
      const local = ref.slice(prefix.length);
      if (local === "evidence.json")
        return { ref, scope: "run", text: [scenario.summary, ...scenario.observations].join("\n") };
      const observation = /^evidence\.json#observation-([1-9][0-9]*)$/.exec(local);
      if (observation) {
        const text = scenario.observations[Number(observation[1]) - 1];
        if (text !== undefined) return { ref, scope: "run", text };
      }
      const step = /-transcript\.ndjson#step-([1-9][0-9]*)$/.exec(local);
      const entry = step && scenario.transcript.find((entry) => entry.step === Number(step[1]));
      if (entry) return { ref, scope: "run", text: JSON.stringify(entry, null, 2) };
      if (scenario.screenshots.some((shot) => shot.path === local))
        return { ref, scope: "run", image: true };
      const file = scenario.files?.find((file) => file.path === local);
      if (file)
        return {
          ref,
          scope: "run",
          image: file.mediaType.startsWith("image/"),
          ...(file.text ? { text: file.text.content, truncated: file.text.truncated } : {}),
        };
      if (
        local.startsWith("evidence.json#") ||
        local === `${scenario.kind}-transcript.ndjson` ||
        Object.values(scenario.artifacts ?? {}).includes(local)
      )
        return { ref, scope: "run" };
    }
    return { ref, scope: ref.startsWith("graders/") ? "area" : "run" };
  });
}

/** Local artifact links are relative to the report, including when output is elsewhere. */
export function artifactHref(outputDir: string, root: string, ref: string): string | undefined {
  const [relative, fragment] = ref.split("#", 2);
  if (
    !relative ||
    /[\\:]/.test(relative) ||
    [...relative].some((character) => character.charCodeAt(0) < 32) ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((part) => part === ".." || part === "." || !part)
  )
    return undefined;
  const file = path.resolve(root, relative);
  if (!fs.existsSync(file)) return undefined;
  if (!isWithin(fs.realpathSync(root), fs.realpathSync(file)) || !fs.statSync(file).isFile())
    return undefined;
  const href = path.relative(outputDir, file).split(path.sep).map(encodeURIComponent).join("/");
  return `${href}${fragment === undefined ? "" : `#${encodeURIComponent(fragment)}`}`;
}

const PREVIEW_LENGTH = 4000;
function previewText(text: string, truncated = false): string {
  const excerpt = [...text].slice(0, PREVIEW_LENGTH).join("");
  return `<pre>${escapeHtml(excerpt)}${truncated || excerpt.length < text.length ? "\n… (preview truncated)" : ""}</pre>`;
}

export function evidenceHtml(
  evidence: ReportEvidence[],
  context?: { outputDir: string; runDir: string; areaId: string },
): string {
  if (!evidence.length) return "<p>No evidence cited.</p>";
  return `<ul class="evidence">${evidence
    .map(({ ref, scope, text, image, truncated }) => {
      const local = scope === "area" ? `areas/${context?.areaId}/${ref}` : ref;
      const artifactPath = local.split("#", 1)[0]!;
      const href = context && artifactHref(context.outputDir, context.runDir, local);
      let preview = text === undefined ? "" : previewText(text, truncated);
      if (href && (image ?? /\.(png|jpe?g|webp|gif)$/i.test(artifactPath)))
        preview += `<a href="${escapeHtml(href)}"><img loading="lazy" src="${escapeHtml(href)}" alt="${escapeHtml(ref)}"></a>`;
      else if (
        href &&
        text === undefined &&
        !local.includes("#") &&
        /\.(txt|md|json|ndjson|log)$/i.test(artifactPath)
      ) {
        // An unresolved fragment must remain a link, never a preview of another passage.
        const file = path.resolve(context!.runDir, artifactPath);
        const descriptor = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(PREVIEW_LENGTH * 4);
          const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
          const shortened = fs.fstatSync(descriptor).size > bytes;
          const decoded = new TextDecoder().decode(buffer.subarray(0, bytes), {
            stream: shortened,
          });
          preview = previewText(decoded, shortened);
        } finally {
          fs.closeSync(descriptor);
        }
      }
      return `<li>${href ? `<a href="${escapeHtml(href)}">${escapeHtml(ref)}</a>` : `<code>${escapeHtml(ref)}</code>${context ? " <small>(artifact unavailable)</small>" : ""}`}${preview}</li>`;
    })
    .join("")}</ul>`;
}

/**
 * Shared layout for generated reports: a centred column. Prose breaks long words only when they
 * would overflow (break-word keeps table min-content widths intact); code and preformatted
 * evidence may break anywhere.
 */
const documentStyles =
  "body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1f2328;background:#fff;max-width:1120px;margin:2rem auto;padding:0 1rem;overflow-wrap:break-word}h1{margin-bottom:0}.subtitle{color:#57606a;font-size:1.1rem;margin:.1rem 0 .4rem}.meta{color:#57606a;margin-top:0}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.45rem .65rem;text-align:left;vertical-align:top}th{background:#f6f8fa}.headline{font-size:1.6rem;font-weight:750;margin:.8rem 0}.verdict{font-size:1.15rem;font-weight:700}.good{color:#1a7f37;font-weight:650}.bad{color:#cf222e;font-weight:650}.muted{color:#57606a;font-weight:650}.warn{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:.6rem 1rem}.error{background:#ffebe9;border:1px solid #ff8182;border-radius:6px;padding:.6rem 1rem}.error .headline{color:#cf222e}.error ul,.warn ul{margin:.3rem 0;padding-left:1.2rem}code{font-size:.9em;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fa;padding:.7rem;max-height:24rem;overflow:auto}details{margin:.55rem 0}summary{cursor:pointer}.evidence{padding-left:1.2rem}.evidence img{max-width:100%;max-height:320px;display:block;margin:.5rem 0}.ballots{padding-left:1.4rem}.ballots li{margin:.4rem 0}.decisions{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}.decision{min-width:0;border:1px solid #d0d7de;border-radius:6px;padding:1rem}.reasoning{white-space:pre-wrap}section{margin:1.5rem 0}.filters{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}.table-scroll{overflow-x:auto}[hidden]{display:none!important}";

export function reportDocument(title: string, body: string, script = "", styles = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>
${documentStyles}${styles}
</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
}
