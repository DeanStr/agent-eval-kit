import type { VoteSummary } from "../visual/contracts.js";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function textComparisonHtml(options: {
  id: string; policy: string; decision: VoteSummary; candidate: string; reference: string; style?: string;
  votes: Array<{ candidateIsA: boolean; outcome: string; reasoning: string; citations: Array<{ text: string; quote: string; explanation: string }> }>;
}): string {
  const { id, policy, decision, votes } = options;
  const panel = (label: string, text: string) => `<section><h2>${label}</h2><pre>${escape(text)}</pre></section>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(id)} text comparison</title>
<style>body{font:16px system-ui,sans-serif;line-height:1.6;color:#17212d;max-width:1500px;margin:32px}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:32px}pre,blockquote{white-space:pre-wrap;overflow-wrap:anywhere}pre{font:inherit;background:#f4f6f8;padding:20px}blockquote{border-left:3px solid #ccd3dc;padding-left:16px;margin-left:0}li{margin-bottom:24px}</style>
<h1>${escape(id)} — ${escape(decision.decision)}</h1>
<p>${decision.judgeable}/${decision.attempted} judgeable votes. Policy: ${escape(policy)}. Vote fractions measure judge consistency, not calibrated confidence or human preference.</p>
<p><a href="comparison.json">Comparison and all votes (JSON)</a></p>
<div class="panels">${panel("Candidate", options.candidate)}${panel("Reference", options.reference)}</div>
${options.style === undefined ? "" : panel("Style target", options.style)}
<h2>Votes and passage citations</h2><ol>${votes.map(vote => `<li><strong>${escape(vote.outcome)}</strong><p>A = ${vote.candidateIsA ? "Candidate; B = Reference" : "Reference; B = Candidate"}</p><p>${escape(vote.reasoning)}</p>${vote.citations.map(citation => `<p><strong>${escape(citation.text)}</strong></p><blockquote>${escape(citation.quote)}</blockquote><p>${escape(citation.explanation)}</p>`).join("")}</li>`).join("")}</ol></html>`;
}
