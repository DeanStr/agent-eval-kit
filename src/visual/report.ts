import type { PairResult, VoteSummary } from "./contracts.js";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export interface DiagnosticTable { caption: string; columns: string[]; rows: Array<Array<string | number | null>> }
export function diagnosticHtml(options: { id: string; verdict: string; reasoning: string; diagnostics: unknown; pictures: Array<{ label: string; file: string }>; tables?: DiagnosticTable[] }): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(options.id)} checks</title>
<style>body{font:16px system-ui,sans-serif;max-width:1500px;margin:32px;color:#17212d}.pictures{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}figure{margin:0}img{width:100%;height:auto}figcaption{margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:16px}table{border-collapse:collapse;width:100%;margin:24px 0}caption{text-align:left;font-weight:bold}td,th{text-align:left;padding:8px;border-bottom:1px solid #ccd3dc}.table{overflow:auto}</style>
<h1>${escape(options.id)} — ${escape(options.verdict)}</h1><p>${escape(options.reasoning)}</p><p><a href="diagnostics.json">Download measurements (JSON)</a></p>
${(options.tables ?? []).map(table => `<div class="table"><table><caption>${escape(table.caption)}</caption><thead><tr>${table.columns.map(column => `<th scope="col">${escape(column)}</th>`).join("")}</tr></thead><tbody>${table.rows.map(row => `<tr>${row.map(value => `<td>${escape(value === null ? "unavailable" : typeof value === "number" ? String(Number(value.toPrecision(6))) : value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`).join("")}
<div class="pictures">${options.pictures.map(picture => `<figure><img src="${escape(encodeURIComponent(picture.file))}" alt="${escape(picture.label)}"><figcaption>${escape(picture.label)}</figcaption></figure>`).join("")}</div>
<details><summary>All measurements and configured bounds</summary><pre>${escape(JSON.stringify(options.diagnostics, null, 2))}</pre></details></html>`;
}

export function comparisonHtml(options: {
  id: string;
  policy: string;
  decision: VoteSummary;
  votes: Array<{ outcome: string; reasoning: string }>;
  findings: PairResult["findings"];
}): string {
  const { id, policy, decision, votes, findings } = options;
  const regions = findings.map(finding => {
    const r = finding.region;
    return `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="#d22" stroke-width="0.004"><title>${escape(finding.description)}</title></rect>`;
  }).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(id)} comparison</title>
<style>body{font:16px system-ui,sans-serif;color:#17212d;margin:32px;max-width:1500px}figure{margin:0}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}img{display:block;width:100%;height:auto}.image{position:relative}.regions{position:absolute;inset:0;width:100%;height:100%}figcaption{margin:12px 0}li{margin:12px 0}details img{max-width:700px}</style>
<h1>${escape(id)} — ${escape(decision.decision)}</h1>
<p>${decision.judgeable}/${decision.attempted} judgeable votes. Policy: ${escape(policy)}. Vote fractions are not calibrated confidence intervals.</p>
<div class="panels"><figure><div class="image"><img src="candidate.png" alt="Candidate image"><svg class="regions" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Reported candidate defect regions">${regions}</svg></div><figcaption>Candidate · red outlines identify reported defects</figcaption></figure>
<figure><img src="reference.png" alt="Reference image"><figcaption>Reference</figcaption></figure></div>
<details><summary>Pixel difference (diagnostic)</summary><img src="difference.png" alt="Pixel difference"></details>
<p><a href="diagnostics.json">Image measurements and changes (diagnostic)</a> · <a href="../../statistics.json">Full rubric image-statistic cohort (diagnostic)</a></p>
<h2>Votes</h2><ol>${votes.map(vote => `<li><strong>${escape(vote.outcome)}</strong>: ${escape(vote.reasoning)}</li>`).join("")}</ol>
<h2>Reported candidate findings</h2><ul>${findings.map(finding => `<li><strong>${escape(finding.severity)}</strong>: ${escape(finding.description)}</li>`).join("") || "<li>No visible defects reported.</li>"}</ul></html>`;
}
