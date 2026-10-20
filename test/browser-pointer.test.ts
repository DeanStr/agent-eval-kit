import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright";
import { BrowserPointer } from "../src/browser/pointer.js";

test("click failures preserve bounded diagnostics for thrown values across contexts", async () => {
  const foreignError: unknown = runInNewContext(
    'new Error("foreign click failure\\nstack details")',
  );
  assert.equal(foreignError instanceof Error, false);
  const cases: Array<[unknown, string]> = [
    [new Error("click failure\nstack details"), "click failure"],
    [foreignError, "foreign click failure"],
    [{ message: "serialized click failure" }, "serialized click failure"],
    ["string failure", "string failure"],
    [null, "null"],
    [undefined, "undefined"],
    [new Error("x".repeat(300)), "x".repeat(200)],
  ];
  for (const [failure, expected] of cases) {
    const context = {
      refLocator: async () => ({
        scrollIntoViewIfNeeded: async () => {},
        evaluate: async () => null,
        click: async () => {
          throw failure;
        },
      }),
      refMissing: async () => false,
      snapshot: async () => assert.fail("failed clicks must not return a success snapshot"),
    } as unknown as ConstructorParameters<typeof BrowserPointer>[0];
    assert.equal(
      await new BrowserPointer(context).click("e1"),
      `ERROR: click on e1 failed: ${expected}`,
    );
  }
});

test("blocked drags never dispatch raw pointer events and unblocked drags still work", async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html>
      <button id="source" draggable="true" style="position:absolute;left:40px;top:50px">Drag source</button>
      <button id="target" style="position:absolute;left:300px;top:50px">Drop target</button>
      <div id="cover" style="position:fixed;inset:0;z-index:100;background:#fffa">Loading veil</div>
      <script>
        source.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', 'source'));
        target.addEventListener('dragover', event => event.preventDefault());
        target.addEventListener('drop', event => {
          event.preventDefault();
          document.body.dataset.dropped = event.dataTransfer.getData('text/plain');
        });
        cover.addEventListener('pointerdown', () => document.body.dataset.overlayPressed = 'yes');
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  const source = page.locator("#source");
  const target = page.locator("#target");
  const drag = source.dragTo.bind(source);
  source.dragTo = (to, options) => drag(to, { ...options, timeout: 1_000 });
  let snapshots = 0;
  const pointer = new BrowserPointer({
    page,
    refLocator: async (ref: string) => (ref === "e1" ? source : target),
    refMissing: async () => false,
    snapshot: async () => {
      snapshots++;
      return "snapshot";
    },
  } as unknown as ConstructorParameters<typeof BrowserPointer>[0]);
  await assert.rejects(pointer.drag("e1", "e2"), /intercepts pointer events/);
  assert.equal(await page.locator("body").getAttribute("data-overlay-pressed"), null);
  assert.equal(await page.locator("body").getAttribute("data-dropped"), null);
  assert.equal(snapshots, 0);

  await page.locator("#cover").evaluate((element) => element.remove());
  assert.equal(await pointer.drag("e1", "e2"), "snapshot");
  assert.equal(await page.locator("body").getAttribute("data-dropped"), "source");
  assert.equal(snapshots, 1);
});
