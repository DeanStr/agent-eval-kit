import type { VoteSummary } from "../visual/contracts.js";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

export function textComparisonHtml(options: {
  id: string;
  policy: string;
  decision: VoteSummary;
  candidate: string;
  reference: string;
  style?: string;
  votes: Array<{
    candidateIsA: boolean;
    outcome: string;
    reasoning: string;
    citations: Array<{
      text: string;
      quote: string;
      sourceQuote: string;
      whitespaceNormalized: boolean;
      explanation: string;
    }>;
  }>;
}): string {
  const { id, policy, decision, votes } = options;
  const panel = (label: string, text: string) =>
    `<section><h2>${label}</h2><pre>${escapeHtml(text)}</pre></section>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(id)} text comparison</title>
<style>body{font:16px system-ui,sans-serif;line-height:1.6;color:#17212d;max-width:1500px;margin:32px}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:32px}pre,blockquote{white-space:pre-wrap;overflow-wrap:anywhere}pre{font:inherit;background:#f4f6f8;padding:20px}blockquote{border-left:3px solid #ccd3dc;padding-left:16px;margin-left:0}li{margin-bottom:24px}</style>
<h1>${escapeHtml(id)} — ${escapeHtml(decision.decision)}</h1>
<p>${decision.judgeable}/${decision.attempted} judgeable votes. Policy: ${escapeHtml(policy)}. Vote fractions measure judge consistency, not calibrated confidence or human preference.</p>
<p><a href="comparison.json">Comparison and all votes (JSON)</a></p>
<div class="panels">${panel("Candidate", options.candidate)}${panel("Reference", options.reference)}</div>
${options.style === undefined ? "" : panel("Style target", options.style)}
<h2>Votes and passage citations</h2><ol>${votes.map((vote) => `<li><strong>${escapeHtml(vote.outcome)}</strong><p>A = ${vote.candidateIsA ? "Candidate; B = Reference" : "Reference; B = Candidate"}</p><p>${escapeHtml(vote.reasoning)}</p>${vote.citations.map((citation) => `<p><strong>${escapeHtml(citation.text)}</strong></p><blockquote>${escapeHtml(citation.sourceQuote)}</blockquote>${citation.whitespaceNormalized ? "<p>Matched with whitespace normalization; original source formatting shown.</p>" : ""}<p>${escapeHtml(citation.explanation)}</p>`).join("")}</li>`).join("")}</ol></html>`;
}

export function textRubricHtml(options: {
  id: string;
  decision: VoteSummary;
  texts: Record<string, string>;
  votes: Array<{
    verdict: string;
    reasoning: string;
    citations: Array<{
      text: string;
      quote: string;
      sourceQuote: string;
      whitespaceNormalized: boolean;
      explanation: string;
    }>;
  }>;
}): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(options.id)} text rubric</title>
<style>body{font:16px system-ui,sans-serif;line-height:1.6;max-width:1100px;margin:32px}pre,blockquote{white-space:pre-wrap;overflow-wrap:anywhere}pre{background:#f4f6f8;padding:20px}blockquote{border-left:3px solid #ccd3dc;padding-left:16px}</style>
<h1>${escapeHtml(options.id)} — ${escapeHtml(options.decision.decision)}</h1>
<p>${options.decision.judgeable}/${options.decision.attempted} judgeable votes. Vote fractions describe consistency, not calibrated probabilities.</p>
<p><a href="judgment.json">Judgment and votes (JSON)</a></p>
${Object.entries(options.texts)
  .map(([name, text]) => `<h2>${escapeHtml(name)}</h2><pre>${escapeHtml(text)}</pre>`)
  .join("")}
<h2>Votes and quotations</h2>${options.votes.map((vote) => `<h3>${escapeHtml(vote.verdict)}</h3><p>${escapeHtml(vote.reasoning)}</p>${vote.citations.map((citation) => `<strong>${escapeHtml(citation.text)}</strong><blockquote>${escapeHtml(citation.sourceQuote)}</blockquote>${citation.whitespaceNormalized ? "<p>Matched with whitespace normalization; original source formatting shown.</p>" : ""}<p>${escapeHtml(citation.explanation)}</p>`).join("")}`).join("")}</html>`;
}
