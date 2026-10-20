import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserSession } from "../src/browser/session.js";
import { BrowserEvidenceError } from "../src/browser/interaction-context.js";

test("opaque HTTP frames remain excluded despite origin spoofing and sandbox changes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-opaque-http-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const route = request.url!;
    if (route === "/csp" || route === "/nested")
      response.setHeader("content-security-policy", "sandbox allow-scripts");
    if (route !== "/") {
      const label = ["/public", "/allowed"].includes(route)
        ? `Public ${route}`
        : `PRIVATE ${route}`;
      response.end(`<h1>${label}</h1><input aria-label="${label}" value="initial">
        ${route === "/nested" ? '<iframe src="/grandchild"></iframe>' : ""}
        <script>Object.defineProperty(window, 'origin', {value: location.origin, configurable: true});</script>`);
      return;
    }
    response.end(`<!doctype html><h1>Trusted parent</h1>
      <iframe id="public" src="/public"></iframe>
      <iframe id="allowed" sandbox="allow-same-origin" src="/allowed"></iframe>
      <iframe id="attribute" sandbox="allow-scripts" src="/attribute"></iframe>
      <iframe id="empty" sandbox="" src="/empty"></iframe>
      <iframe id="csp" src="/csp"></iframe>
      <iframe id="nested" src="/nested"></iframe>
      <iframe id="mutable" sandbox="allow-scripts" src="/mutable"></iframe>
      <iframe srcdoc="<button>Inherited control</button>"></iframe>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const session = new BrowserSession(directory, true, origin);
  t.after(() => session.stop());
  await session.start();
  await session.page.goto(origin);
  await session.page.frameLocator("#mutable").locator("input").waitFor();
  await session.page.locator("#mutable").evaluate((node) => node.removeAttribute("sandbox"));
  for (const id of ["attribute", "csp", "nested", "mutable"]) {
    const frame = await (await session.page.locator(`#${id}`).elementHandle())!.contentFrame();
    assert.ok(frame);
    assert.equal(
      await frame.evaluate(() => window.origin),
      origin,
      "page code spoofs the public getter",
    );
    assert.equal(
      await frame.evaluate(() => {
        try {
          return Boolean(window.parent.document);
        } catch {
          return false;
        }
      }),
      false,
      "the loaded document retains an opaque origin",
    );
  }
  const snapshot = await session.snapshot();
  assert.match(snapshot, /Public \/public|Public \/allowed/);
  assert.match(snapshot, /Inherited control/);
  assert.doesNotMatch(snapshot, /PRIVATE/);
  assert.match(snapshot, /AEK excluded 6 child frame/);
  const publicRef = snapshot
    .split("\n")
    .find((line) => /^\[e\d+\]/.test(line) && line.includes("Public /public"))
    ?.match(/^\[(e\d+)\]/)?.[1];
  assert.ok(publicRef);
  assert.doesNotMatch(await session.fill(publicRef, "permitted"), /^(ERROR|BLOCKED):/);
  assert.equal(
    await session.page.frameLocator("#public").locator("input").inputValue(),
    "permitted",
  );

  const capture = session.page.screenshot.bind(session.page);
  session.page.screenshot = async (...args) => {
    for (const id of ["attribute", "empty", "csp", "nested", "mutable"])
      assert.equal(
        await session.page
          .locator(`#${id}`)
          .evaluate((node) => (node as HTMLElement).style.visibility),
        "hidden",
      );
    assert.equal(
      await session.page
        .locator("#allowed")
        .evaluate((node) => (node as HTMLElement).style.visibility),
      "",
    );
    return capture(...args);
  };
  await session.screenshot("opaque-frames-masked", false);
  session.page.screenshot = capture;
  assert.equal(
    await session.page.locator("#csp").evaluate((node) => (node as HTMLElement).style.visibility),
    "",
  );

  const publicFrame = await (await session.page.locator("#public").elementHandle())!.contentFrame();
  assert.ok(publicFrame);
  await session.page.locator("#public").evaluate((node) => {
    const frame = node as HTMLIFrameElement;
    frame.sandbox.value = "allow-scripts";
    frame.src = "/late";
  });
  await publicFrame.waitForURL(`${origin}/late`);
  // Reuse the old ref in the new document: rejection must come from the origin
  // boundary rather than merely from the absence of its generated attribute.
  await publicFrame
    .locator("input")
    .evaluate((node, ref) => node.setAttribute("data-aek-ref", ref), publicRef);
  assert.match(await session.fill(publicRef, "forbidden"), /^ERROR:/);
  assert.equal(await publicFrame.locator("input").inputValue(), "initial");
});

test("missing or failed effective-origin inspection remains an execution error", async () => {
  const origin = "https://app.example.test";
  const session = new BrowserSession("/tmp/aek-unused", true, origin);
  const main = { url: () => origin };
  session.page = { mainFrame: () => main } as never;
  const inspect = (evaluate: () => Promise<unknown>) =>
    (session as unknown as { isAllowedFrame(frame: unknown): Promise<boolean> }).isAllowedFrame({
      url: () => `${origin}/child`,
      parentFrame: () => main,
      evaluate,
    });
  await assert.rejects(
    inspect(async () => undefined),
    BrowserEvidenceError,
  );
  await assert.rejects(
    inspect(async () => {
      throw new Error("inspection failed");
    }),
    BrowserEvidenceError,
  );
  assert.equal(await inspect(async () => "null"), false);
});

for (const change of [
  "snapshot",
  "editor-inspection",
  "capture",
  "new-frame",
  "removed-mask",
  "mask-inspection",
  "masked-descendant",
] as const) {
  test(`frame boundaries are rechecked after ${change}`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-frame-race-"));
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/private") response.setHeader("content-security-policy", "sandbox");
      response.end(
        request.url === "/"
          ? '<h1>Parent</h1><iframe src="/public"></iframe>'
          : `<h2>${request.url === "/private" ? "Private content" : "Public content"}</h2><input aria-label="Frame input">`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const session = new BrowserSession(directory, true, origin);
    try {
      await session.start();
      await session.navigate(origin);
      const frame = session.page.frames().find((frame) => frame !== session.page.mainFrame())!;
      if (change === "snapshot" || change === "editor-inspection") {
        const locator = frame.locator.bind(frame);
        frame.locator = (...args) => {
          const result = locator(...args);
          const read = result.ariaSnapshot.bind(result);
          result.ariaSnapshot = async (...args) => {
            if (change === "snapshot") await frame.goto(`${origin}/private`);
            const text = await read(...args);
            if (change === "editor-inspection")
              await frame.evaluate(() => {
                document.body.getAttribute = () => {
                  throw new Error("Editor inspection failed");
                };
              });
            return text;
          };
          return result;
        };
        await assert.rejects(session.snapshot(), BrowserEvidenceError);
        return;
      }
      if (["removed-mask", "mask-inspection", "masked-descendant"].includes(change))
        await frame.goto(`${origin}/private`);
      const capture = session.page.screenshot.bind(session.page);
      session.page.screenshot = async (...args) => {
        if (change === "capture") await frame.goto(`${origin}/private`);
        if (change === "new-frame") {
          await session.page.evaluate(() => {
            const child = document.createElement("iframe");
            child.id = "new-private";
            child.src = "/private";
            document.body.append(child);
          });
          await session.page.frameLocator("#new-private").locator("input").waitFor();
        }
        if (change === "removed-mask") {
          await session.page.locator("iframe").evaluate((node) => {
            (node as HTMLElement).style.removeProperty("visibility");
          });
        }
        if (change === "mask-inspection")
          frame.frameElement = async () => {
            throw new Error("Mask inspection failed");
          };
        if (change === "masked-descendant") {
          await frame.evaluate(() => {
            const child = document.createElement("iframe");
            child.src = "/private";
            document.body.append(child);
          });
          await frame.frameLocator("iframe").locator("input").waitFor({ state: "attached" });
        }
        return capture(...args);
      };
      const before = fs.readdirSync(path.join(directory, "screenshots"));
      if (change === "masked-descendant") {
        await session.screenshot("masked-child", false);
        assert.equal(fs.readdirSync(path.join(directory, "screenshots")).length, before.length + 1);
        return;
      }
      await assert.rejects(session.screenshot("changed-frame", false), BrowserEvidenceError);
      assert.deepEqual(fs.readdirSync(path.join(directory, "screenshots")), before);
    } finally {
      await session.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
