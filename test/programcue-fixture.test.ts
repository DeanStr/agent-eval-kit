import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureVersionHistoryFixture } from "../examples/judge-validation/version-history-fixture.js";

test("ProgramCue fixture isolates the latest-marker defect while retaining both downloads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-history-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = Buffer.from("%PDF-1.4\nversion one\n%%EOF");
  const latest = Buffer.from("%PDF-1.4\nversion two\n%%EOF");
  const pages: string[] = [];
  for (const latestVersion of [2, 1] as const) {
    const output = path.join(root, `latest-${latestVersion}`);
    const record = await captureVersionHistoryFixture({ latestVersion, previous, latest, output });
    for (const observation of record.observations.slice(1, 3)) {
      const rows = JSON.parse(observation.slice(observation.indexOf(": ") + 2)) as string[];
      assert.equal(rows.length, 2);
      for (const version of [1, 2]) {
        const row = rows.find((value) => value.includes(`deck-v${version}.pdf`));
        assert.ok(row);
        assert.equal(row.includes("Latest · Current"), version === latestVersion);
      }
    }
    assert.deepEqual(fs.readFileSync(path.join(output, "deck-v1.pdf")), previous);
    assert.deepEqual(fs.readFileSync(path.join(output, "deck-v2.pdf")), latest);
    assert.match(record.summary, /synthetic/);
    assert.match(record.imageExtraction, /synthetic/);
    for (const image of record.images)
      assert.ok(fs.statSync(path.join(output, `${image.label}.png`)).size > 0);
    pages.push(
      fs
        .readFileSync(path.join(output, "history.html"), "utf8")
        .replaceAll('<strong class="latest">Latest · Current</strong>', "STATUS")
        .replaceAll("<td>Retained</td>", "<td>STATUS</td>"),
    );
  }
  assert.equal(pages[0], pages[1], "Only latest/current placement may differ between fixtures");
  await assert.rejects(
    captureVersionHistoryFixture({
      latestVersion: 2,
      previous,
      latest: previous,
      output: path.join(root, "invalid"),
    }),
    /distinct content/,
  );
});
