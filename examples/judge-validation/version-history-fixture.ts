import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { sha256 } from "../../src/io.js";

/** A controlled contract fixture, never a screenshot of the live application. */
export async function captureVersionHistoryFixture(options: {
  latestVersion: 1 | 2;
  previous: Buffer;
  latest: Buffer;
  output: string;
}) {
  const { latestVersion, previous, latest, output } = options;
  if (latestVersion !== 1 && latestVersion !== 2) throw new Error("Invalid latest version");
  for (const pdf of [previous, latest])
    if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("Fixture requires PDF bytes");
  if (previous.equals(latest)) throw new Error("Fixture PDFs must have distinct content");
  fs.mkdirSync(output, { recursive: false });
  const rows = ([2, 1] as const)
    .map(
      (version) => `<tr data-version="${version}"><td>deck-v${version}.pdf</td><td>v${version}</td>
<td>2026-09-06 08:0${version}</td><td>${version === latestVersion ? '<strong class="latest">Latest · Current</strong>' : "Retained"}</td>
<td><a download="deck-v${version}.pdf" href="data:application/pdf;base64,${(version === 1 ? previous : latest).toString("base64")}">Download v${version}</a></td></tr>`,
    )
    .join("\n");
  const section = (id: string, title: string) => `<section id="${id}">
<p>ProgramCue version-history contract fixture · synthetic local example</p><h1>${title}</h1>
<h2>Upload presentation slides</h2><table><thead><tr><th>File</th><th>Version</th><th>Uploaded</th><th>Status</th><th>Access</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Version history fixture</title>
<style>body{margin:0;background:#f4f5f3;color:#182927;font:18px system-ui}section{padding:32px;background:white;margin:20px;border:1px solid #cbd5cf;border-radius:12px}p{font-size:14px;color:#53645e}h1{font-size:28px}h2{font-size:20px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:14px 8px;border-bottom:1px solid #dce3df}a{color:#854121}strong{color:#245540}</style>
${section("participant", "Participant task")}${section("organizer", "Organizer file library")}</html>`;
  const pageFile = path.join(output, "history.html");
  fs.writeFileSync(pageFile, html);
  const browser = await chromium.launch();
  try {
    const session = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await session.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(pathToFileURL(pageFile).href);
    await page.reload();
    const observations = [
      "Synthetic local contract fixture; this is not a live or historical ProgramCue execution.",
      `Participant history after reload: ${JSON.stringify(await page.locator("#participant tbody tr").allTextContents())}`,
      `Organizer history after reload: ${JSON.stringify(await page.locator("#organizer tbody tr").allTextContents())}`,
    ];
    for (const [version, expected] of [
      [1, previous],
      [2, latest],
    ] as const) {
      const pending = page.waitForEvent("download");
      await page
        .locator("#participant")
        .getByRole("link", { name: `Download v${version}` })
        .click();
      const download = await pending;
      const file = path.join(output, `deck-v${version}.pdf`);
      await download.saveAs(file);
      if (!fs.readFileSync(file).equals(expected))
        throw new Error(`Fixture v${version} download differs`);
      observations.push(
        `Successful fixture v${version} download: ${expected.length} bytes; SHA-256 ${sha256(expected)}.`,
      );
    }
    const images = [
      { label: "versions-after-reload", source: "image0", selector: "#participant" },
      { label: "expanded-clean-version-history", source: "image1", selector: "#organizer" },
    ];
    for (const image of images)
      await page
        .locator(image.selector)
        .screenshot({ path: path.join(output, `${image.label}.png`) });
    return {
      summary:
        "Post-reload history and downloads from a synthetic local ProgramCue contract fixture.",
      observations,
      imageExtraction:
        "Browser screenshot of the supplied synthetic HTML contract fixture after reload; no live ProgramCue execution is claimed.",
      images: images.map(({ label, source }) => ({ label, source })),
    };
  } finally {
    await browser.close();
  }
}
