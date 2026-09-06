import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { errors } from "playwright";
import { BrowserForms } from "../src/browser/forms.js";
import { BrowserPointer } from "../src/browser/pointer.js";
import { upload } from "../src/browser/uploads.js";
import type { BrowserInteractionContext } from "../src/browser/interaction-context.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserActionResultIsError, type BrowserMcpContext } from "../src/browser/context.js";
import { browserMcpLaunch } from "../src/mcp-config.js";
import { writeJson } from "../src/io.js";
import { BrowserSession } from "../src/browser/session.js";
import { OriginBoundaryError } from "../src/browser/interaction-context.js";

test("browser action failures remain errors after leading diagnostic notes", () => {
  assert.equal(
    browserActionResultIsError("NOTE: native dialog was accepted\nBLOCKED: external navigation"),
    true,
  );
  assert.equal(
    browserActionResultIsError("NOTE: native dialog was accepted\nERROR: action failed"),
    true,
  );
  assert.equal(browserActionResultIsError("NOTE: action completed"), false);
});

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  assert.equal(buffer.readUInt16BE(0), 0xffd8, "expected a JPEG image");
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = requireDefined(buffer[offset + 1], "buffer[offset + 1]");
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    offset += 2 + segmentLength;
  }
  throw new Error("JPEG dimensions were not found");
}

test("wildcard origins match subdomains only and normalize default ports", () => {
  const implicit = new BrowserSession(
    "/tmp/aek-unused",
    true,
    "https://app.example.com",
    undefined,
    ["https://*.example.com"],
  );
  assert.equal(implicit.isAllowedUrl("https://child.example.com/path"), true);
  assert.equal(implicit.isAllowedUrl("https://example.com/path"), false);
  assert.equal(implicit.isAllowedUrl("https://child.example.com:8443/path"), false);

  const explicit = new BrowserSession(
    "/tmp/aek-unused",
    true,
    "https://app.example.com",
    undefined,
    ["https://*.example.com:443"],
  );
  assert.equal(explicit.isAllowedUrl("https://child.example.com/path"), true);
  assert.equal(explicit.isAllowedUrl("about:blank"), false);
});

test("top-level about:blank navigation is contained after startup", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><button onclick=\"location.href='about:blank'\">Leave application</button>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-blank-origin-"));
  const session = new BrowserSession(directory, true, url, undefined, [url]);
  try {
    await session.start();
    await session.navigate(url);
    await session.page.goto("about:blank");
    const result = await session.preflightOrigin();
    assert.match(result ?? "", /^BLOCKED:.*about:blank/);
    assert.equal(new URL(session.page.url()).origin, new URL(url).origin);
  } finally {
    await session.stop();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("saved browser state excludes cookies and local storage outside allowed origins", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><script>localStorage.setItem("application", "retained")</script>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-storage-boundary-"));
  const stateFile = path.join(directory, "state.json");
  const session = new BrowserSession(directory, true, url, undefined, [url]);
  try {
    await session.start();
    await session.navigate(url);
    await session.page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("application-auth", 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore("tokens").put("retained", "session");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        }),
    );
    await session.page.context().addCookies([
      { name: "application", value: "retained", url },
      { name: "tracker", value: "excluded", url: "https://tracker.example.test" },
    ]);

    await session.saveStorageState(stateFile);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepEqual(
      state.cookies.map((cookie: { name: string }) => cookie.name),
      ["application"],
    );
    assert.deepEqual(
      state.origins.map((origin: { origin: string }) => origin.origin),
      [url],
    );
    assert.deepEqual(
      state.origins[0].indexedDB.map((database: { name: string }) => database.name),
      ["application-auth"],
    );
  } finally {
    await session.stop();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser ref budgets collapse repetitive navigation before retaining main controls", async () => {
  const navigation = Array.from(
    { length: 260 },
    (_, index) => `<a href="#same">Nav ${index}</a>`,
  ).join("");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><nav>${navigation}</nav><main><button>Main action</button></main>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-ref-budget-"));
  const session = new BrowserSession(directory, true, url, undefined, [url]);
  try {
    await session.start();
    const snapshot = await session.navigate(url);
    assert.match(snapshot, /\[e\d+\] <button[^>]*> Main action/);
    assert.match(snapshot, /\(\+259 redundant refs hidden/);
  } finally {
    await session.stop();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("full-page screenshots enforce the image-width ceiling", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><style>html,body{margin:0}main{width:3000px;height:100px}</style><main>Wide content</main>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-wide-shot-"));
  const session = new BrowserSession(directory, true, url, undefined, [url]);
  try {
    await session.start();
    await session.navigate(url);
    const screenshot = await session.screenshot("wide", true);
    const dimensions = jpegDimensions(Buffer.from(screenshot.base64, "base64"));
    assert.ok(dimensions.width <= 1_900, JSON.stringify(dimensions));
    assert.ok(dimensions.height <= 1_900, JSON.stringify(dimensions));
    assert.match(
      await session.snapshot(),
      /Full-page screenshot was clipped to 1900×800px \(page is 3000×800px\)/,
    );
  } finally {
    await session.stop();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser snapshots fail closed when off-origin recovery fails", async () => {
  const target = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Allowed page</title><p>Allowed content</p>");
  });
  const external = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>External secret</title><p>Must not be inspected</p>");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  const externalAddress = external.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  assert.ok(externalAddress && typeof externalAddress !== "string");
  const targetUrl = `http://127.0.0.1:${targetAddress.port}`;
  const externalUrl = `http://127.0.0.1:${externalAddress.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-origin-recovery-"));
  const session = new BrowserSession(directory, true, targetUrl, undefined, [targetUrl]);
  try {
    await session.start();
    await session.page.goto(externalUrl);
    let titleRead = false;
    Object.defineProperty(session.page, "goBack", { value: async () => null });
    Object.defineProperty(session.page, "goto", { value: async () => null });
    Object.defineProperty(session.page, "title", {
      value: async () => {
        titleRead = true;
        return "External secret";
      },
    });

    await assert.rejects(
      session.snapshot(),
      (error) =>
        error instanceof OriginBoundaryError && /Origin recovery failed/.test(error.message),
    );
    assert.equal(titleRead, false);
  } finally {
    await session.stop();
    target.close();
    external.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("origin recovery returns to the configured application path", async () => {
  const target = http.createServer((request, response) => {
    response.writeHead(request.url === "/app/start" ? 200 : 404, { "content-type": "text/html" });
    response.end(
      request.url === "/app/start"
        ? "<!doctype html><title>Application</title>"
        : "not the application",
    );
  });
  const external = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>External</title>");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  const externalAddress = external.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  assert.ok(externalAddress && typeof externalAddress !== "string");
  const targetUrl = `http://127.0.0.1:${targetAddress.port}/app/start`;
  const externalUrl = `http://127.0.0.1:${externalAddress.port}/outside`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-path-recovery-"));
  const session = new BrowserSession(directory, true, targetUrl, undefined, [
    new URL(targetUrl).origin,
  ]);
  try {
    await session.start();
    await session.navigate(targetUrl);
    await session.page.goto(externalUrl);
    Object.defineProperty(session.page, "goBack", { value: async () => null });
    const result = await session.preflightOrigin();
    assert.match(result ?? "", /browser was returned/i);
    assert.equal(new URL(session.page.url()).pathname, "/app/start");
  } finally {
    await session.stop();
    target.close();
    external.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("screenshots are discarded when the page crosses origins during capture", async () => {
  const target = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Allowed</title><p>Allowed content</p>");
  });
  const external = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>External private page</title>");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  const externalAddress = external.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  assert.ok(externalAddress && typeof externalAddress !== "string");
  const targetUrl = `http://127.0.0.1:${targetAddress.port}`;
  const externalUrl = `http://127.0.0.1:${externalAddress.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-screenshot-race-"));
  const session = new BrowserSession(directory, true, targetUrl, undefined, [targetUrl]);
  try {
    await session.start();
    await session.navigate(targetUrl);
    const originalScreenshot = session.page.screenshot.bind(session.page);
    Object.defineProperty(session.page, "screenshot", {
      value: async (options: Parameters<typeof session.page.screenshot>[0]) => {
        const buffer = await originalScreenshot(options);
        await session.page.goto(externalUrl);
        return buffer;
      },
    });

    await assert.rejects(
      session.screenshot("origin-race", false),
      (error) => error instanceof OriginBoundaryError && /navigated off-target/.test(error.message),
    );
    assert.equal(
      fs
        .readdirSync(path.join(directory, "screenshots"))
        .some((name) => name.includes("origin-race")),
      false,
    );
    assert.equal(new URL(session.page.url()).origin, new URL(targetUrl).origin);
  } finally {
    await session.stop();
    target.close();
    external.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("styled uploads never attach fixtures after an off-origin redirect", async () => {
  let externalChanges = 0;
  const external = http.createServer((request, response) => {
    if (request.url === "/changed") {
      externalChanges += 1;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><input type=file onchange=\"fetch('/changed')\">");
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const externalAddress = external.address();
  assert.ok(externalAddress && typeof externalAddress !== "string");
  const externalUrl = `http://127.0.0.1:${externalAddress.port}`;

  const target = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><button onclick="setTimeout(() => location.href='${externalUrl}', 200)">Upload fixture</button>`,
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  const targetUrl = `http://127.0.0.1:${targetAddress.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-upload-origin-"));
  const fixture = path.join(directory, "fixture.txt");
  fs.writeFileSync(fixture, "private fixture");
  const session = new BrowserSession(directory, true, targetUrl, undefined, [targetUrl]);
  try {
    await session.start();
    const snapshot = await session.navigate(targetUrl);
    const ref = /\[(e\d+)\]\s*<button[^[]*Upload fixture/.exec(snapshot)?.[1];
    assert.ok(ref, snapshot);
    Object.defineProperty(session.page, "waitForEvent", {
      value: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new errors.TimeoutError("no file chooser");
      },
    });

    const result = await session.upload(ref, fixture);
    assert.match(result, /^BLOCKED:.*navigated off-target/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(externalChanges, 0);
    assert.equal(new URL(session.page.url()).origin, new URL(targetUrl).origin);
  } finally {
    await session.stop();
    target.close();
    external.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ambiguous fills do not click and custom-select clicks contain redirected origins", async () => {
  let externalInputEvents = 0;
  let externalOptionClicks = 0;
  const external = http.createServer((request, response) => {
    if (request.url === "/typed") {
      externalInputEvents += 1;
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/clicked") {
      externalOptionClicks += 1;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>External private page</title>
      <input autofocus oninput="fetch('/typed')">
      <button role="option" onclick="location.href='/clicked'">External secret option</button>`);
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const externalAddress = external.address();
  assert.ok(externalAddress && typeof externalAddress !== "string");
  const externalUrl = `http://127.0.0.1:${externalAddress.port}/private`;

  const target = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/fill") {
      response.end(
        `<!doctype html><button onclick="location.href='${externalUrl}'">Edit value</button>`,
      );
    } else if (request.url === "/select-open") {
      response.end(
        `<!doctype html><button role="combobox" onclick="location.href='${externalUrl}'">Open choices</button>`,
      );
    } else if (request.url === "/select-type") {
      response.end(
        `<!doctype html><input role="combobox" oninput="setTimeout(() => location.href='${externalUrl}', 0)">`,
      );
    } else {
      response.end(`<!doctype html>
        <button role="combobox" onclick="document.getElementById('choices').hidden=false">Choose value</button>
        <div id="choices" hidden><button role="option" onclick="location.href='${externalUrl}'">Leave target</button></div>`);
    }
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  const targetUrl = `http://127.0.0.1:${targetAddress.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-internal-click-origin-"));
  const session = new BrowserSession(directory, true, targetUrl, undefined, [targetUrl]);
  try {
    await session.start();

    const fillSnapshot = await session.navigate(`${targetUrl}/fill`);
    const fillRef = /\[(e\d+)\]\s*<button[^[]*Edit value/.exec(fillSnapshot)?.[1];
    assert.ok(fillRef, fillSnapshot);
    const fillResult = await session.fill(fillRef, "must not reach the external input");
    assert.match(fillResult, /^ERROR:.*not an editable field/);
    assert.equal(session.page.url(), `${targetUrl}/fill`, "fill must not activate the button");

    const openSnapshot = await session.navigate(`${targetUrl}/select-open`);
    const openRef = /\[(e\d+)\]\s*<button[^[]*Open choices/.exec(openSnapshot)?.[1];
    assert.ok(openRef, openSnapshot);
    const openResult = await session.select(openRef, "External secret option");
    assert.match(openResult, /^BLOCKED:.*navigated off-target/);
    assert.doesNotMatch(openResult, /External secret option/);

    const typeSnapshot = await session.navigate(`${targetUrl}/select-type`);
    const typeRef = /\[(e\d+)\]\s*<input[^[]*combobox/.exec(typeSnapshot)?.[1];
    assert.ok(typeRef, typeSnapshot);
    const typeResult = await session.select(typeRef, "External secret option");
    assert.match(typeResult, /^BLOCKED:.*navigated off-target/);
    assert.doesNotMatch(typeResult, /External secret option/);

    const optionSnapshot = await session.navigate(`${targetUrl}/select-option`);
    const optionRef = /\[(e\d+)\]\s*<button[^[]*Choose value/.exec(optionSnapshot)?.[1];
    assert.ok(optionRef, optionSnapshot);
    const optionResult = await session.select(optionRef, "Leave target");
    assert.match(optionResult, /^BLOCKED:.*navigated off-target/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(externalInputEvents, 0);
    assert.equal(externalOptionClicks, 0);
  } finally {
    await session.stop();
    target.close();
    external.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed fallback clicks cannot type into or select unrelated controls", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <input id="unrelated" autofocus>
      <p id="untagged">Untagged action</p>
      <script>document.getElementById('untagged').addEventListener('click', () => document.body.dataset.untaggedClicked='yes')</script>
      <button disabled>Edit profile value</button>
      <button role="combobox" disabled>Choose status</button>
      <button role="option" onclick="document.body.dataset.optionClicked='yes'">Approved</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-failed-fallback-click-"));
  const session = new BrowserSession(
    directory,
    true,
    url,
    undefined,
    [url],
    { width: 800, height: 600 },
    250,
  );
  try {
    await session.start();
    const snapshot = await session.navigate(url);
    const editRef = /\[(e\d+)\]\s*<button[^[]*Edit profile value/.exec(snapshot)?.[1];
    const selectRef = /\[(e\d+)\]\s*<button[^[]*Choose status/.exec(snapshot)?.[1];
    assert.ok(editRef, snapshot);
    assert.ok(selectRef, snapshot);

    assert.match(await session.fill(editRef, "must not be typed"), /not an editable field/);
    assert.equal(await session.page.locator("#unrelated").inputValue(), "");
    assert.match(
      await session.select(selectRef, "Approved"),
      /could not be opened as a custom dropdown/,
    );
    assert.equal(await session.page.locator("body").getAttribute("data-option-clicked"), null);
    await assert.rejects(
      session.click('bogus"], #untagged, [data-aek-ref="bogus'),
      /Invalid element ref/,
    );
    assert.equal(await session.page.locator("body").getAttribute("data-untagged-clicked"), null);
  } finally {
    await session.stop();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser sessions exclude cross-origin child frames from actions and evidence", async () => {
  const external = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><title>External secret editor</title><body contenteditable="true"><button>External secret control</button></body>',
    );
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const externalAddress = external.address();
  assert.ok(externalAddress && typeof externalAddress !== "string");
  const externalUrl = `http://127.0.0.1:${externalAddress.port}`;

  const target = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/child") {
      response.end("<!doctype html><button>Allowed child control</button>");
      return;
    }
    response.end(`<!doctype html><button>Main control</button>
      <iframe src="/child"></iframe>
      <iframe srcdoc="<button>Inherited srcdoc control</button>"></iframe>
      <iframe id="opaque" sandbox srcdoc="<button>Opaque secret control</button>"></iframe>
      <iframe id="external" src="${externalUrl}"></iframe>
      <script>
        new MutationObserver(() => {
          if (document.querySelector('#external').style.visibility === 'hidden') {
            document.body.dataset.externalFrameWasMasked = 'yes';
          }
        }).observe(document.querySelector('#external'), { attributes: true, attributeFilter: ['style'] });
        new MutationObserver(() => {
          if (document.querySelector('#opaque').style.visibility === 'hidden') {
            document.body.dataset.opaqueFrameWasMasked = 'yes';
          }
        }).observe(document.querySelector('#opaque'), { attributes: true, attributeFilter: ['style'] });
      </script>`);
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  const targetUrl = `http://127.0.0.1:${targetAddress.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-frame-origin-"));
  const session = new BrowserSession(directory, true, targetUrl, undefined, [targetUrl]);
  try {
    await session.start();
    const snapshot = await session.navigate(targetUrl);
    assert.match(snapshot, /Main control/);
    assert.match(snapshot, /Allowed child control/);
    assert.match(snapshot, /Inherited srcdoc control/);
    assert.doesNotMatch(
      snapshot,
      /Opaque secret control|External secret control|External secret editor/,
    );

    await session.screenshot("frame-boundary", false);
    assert.equal(
      await session.page.locator("body").getAttribute("data-external-frame-was-masked"),
      "yes",
    );
    assert.equal(
      await session.page.locator("body").getAttribute("data-opaque-frame-was-masked"),
      "yes",
    );
    assert.equal(
      await session.page
        .locator("#external")
        .evaluate((element) => (element as HTMLElement).style.visibility),
      "",
    );
    assert.equal(
      await session.page
        .locator("#opaque")
        .evaluate((element) => (element as HTMLElement).style.visibility),
      "",
    );
  } finally {
    await session.stop();
    target.close();
    external.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("screenshots fail closed when an off-origin child frame cannot be masked", async () => {
  const session = new BrowserSession(
    "/tmp/aek-unused",
    true,
    "https://target.example.test",
    undefined,
    ["https://target.example.test"],
  );
  const mainFrame = {
    url: () => "https://target.example.test",
    parentFrame: () => null,
  };
  const externalFrame = {
    url: () => "https://external.example.test",
    parentFrame: () => mainFrame,
    frameElement: async () => {
      throw new Error("frame detached");
    },
  };
  session.page = {
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, externalFrame],
  } as never;

  await assert.rejects(
    () =>
      (
        session as unknown as { maskDisallowedFrames(): Promise<() => Promise<void>> }
      ).maskDisallowedFrames(),
    (error) =>
      error instanceof OriginBoundaryError &&
      /Could not mask every off-origin frame.*frame detached/.test(error.message),
  );
});

test("browser MCP exposes the shared tool contract and persists evidence", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <label>Deadline <input type=date></label>
      <label>Billing month <input type=month></label>
      <label>Reporting week <input type=week></label>
      <label>Starts at <input type=datetime-local></label>
      <button role=combobox aria-haspopup=listbox onclick="document.getElementById('options').hidden=false">Tier</button>
      <div id=options role=listbox hidden><button role=option disabled>Unavailable</button></div>
      <button onclick="document.body.append('DONE')">Run</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-mcp-"));
  const contextFile = path.join(directory, "context.json");
  const context: BrowserMcpContext = {
    targetUrl: url,
    allowedOrigins: [url],
    evidenceDir: directory,
    fixtureFiles: {},
    expectAuthenticated: false,
    headless: true,
    viewport: { width: 800, height: 600 },
    actionTimeoutMs: 5_000,
    maxToolCalls: 20,
  };
  writeJson(contextFile, context);
  const launch = browserMcpLaunch(contextFile);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: directory,
    stderr: "pipe",
  });
  const client = new Client({ name: "aek-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "navigate"));
    assert.ok(tools.tools.some((tool) => tool.name === "done"));
    const blankNavigation = await client.callTool({
      name: "navigate",
      arguments: { url: "about:blank" },
    });
    assert.equal(blankNavigation.isError, true);
    assert.match(
      JSON.stringify(blankNavigation.content),
      /explicit navigation requires an HTTP\(S\) target URL/,
    );
    const navigation = await client.callTool({ name: "navigate", arguments: { url } });
    const navigationText = JSON.stringify(navigation.content);
    const ref = /\[(e\d+)\]\s*<button[^[]*Run/.exec(navigationText)?.[1];
    const dateRef = /\[(e\d+)\]\s*<input type=date/.exec(navigationText)?.[1];
    const monthRef = /\[(e\d+)\]\s*<input type=month/.exec(navigationText)?.[1];
    const weekRef = /\[(e\d+)\]\s*<input type=week/.exec(navigationText)?.[1];
    const dateTimeRef = /\[(e\d+)\]\s*<input type=datetime-local/.exec(navigationText)?.[1];
    const tierRef = /\[(e\d+)\]\s*<button[^[]*Tier/.exec(navigationText)?.[1];
    assert.ok(ref, navigationText);
    assert.ok(dateRef, navigationText);
    assert.ok(monthRef, navigationText);
    assert.ok(weekRef, navigationText);
    assert.ok(dateTimeRef, navigationText);
    assert.ok(tierRef, navigationText);
    const invalidDate = await client.callTool({
      name: "fill",
      arguments: { ref: dateRef, text: "2026-02-30" },
    });
    assert.equal(invalidDate.isError, true);
    assert.match(JSON.stringify(invalidDate.content), /could not be parsed/);
    const validDate = await client.callTool({
      name: "fill",
      arguments: { ref: dateRef, text: "February 28, 2026" },
    });
    assert.notEqual(validDate.isError, true);
    const validMonth = await client.callTool({
      name: "fill",
      arguments: { ref: monthRef, text: "2026-03" },
    });
    assert.notEqual(validMonth.isError, true);
    assert.match(JSON.stringify(validMonth.content), /Filled .* with: 2026-03/);
    const validWeek = await client.callTool({
      name: "fill",
      arguments: { ref: weekRef, text: "2026-W03" },
    });
    assert.notEqual(validWeek.isError, true);
    assert.match(JSON.stringify(validWeek.content), /Filled .* with: 2026-W03/);
    const invalidDateTime = await client.callTool({
      name: "fill",
      arguments: { ref: dateTimeRef, text: "2026-03-05T25:00" },
    });
    assert.equal(invalidDateTime.isError, true);
    assert.match(JSON.stringify(invalidDateTime.content), /could not be parsed/);
    const unavailableOption = await client.callTool({
      name: "select",
      arguments: { ref: tierRef, value: "Unavailable" },
    });
    assert.equal(unavailableOption.isError, true);
    assert.match(
      JSON.stringify(unavailableOption.content),
      /matching option.*could not be selected.*disabled/,
    );
    const click = await client.callTool({ name: "click", arguments: { ref } });
    assert.match(JSON.stringify(click.content), /DONE/);
    await client.callTool({ name: "observe", arguments: { note: "The Run action completed." } });
    await client.callTool({
      name: "done",
      arguments: { outcome: "completed", summary: "Primary action worked." },
    });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "browser-result.json"), "utf8")).outcome,
      "completed",
    );
    assert.ok(fs.existsSync(path.join(directory, "browser-transcript.ndjson")));
    assert.ok(
      JSON.parse(fs.readFileSync(path.join(directory, "screenshots.json"), "utf8")).length >= 1,
    );
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser MCP never captures evidence after an action redirects off-origin", async () => {
  let externalKeypresses = 0;
  let externalWheelEvents = 0;
  let externalLoads = 0;
  const external = http.createServer((request, response) => {
    if (request.url === "/key-received") {
      externalKeypresses += 1;
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/wheel-received") {
      externalWheelEvents += 1;
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/loaded") {
      externalLoads += 1;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><title>External private page</title><script>fetch('/loaded')</script><body style=\"height:3000px\" onwheel=\"fetch('/wheel-received')\"><input autofocus onkeydown=\"fetch('/key-received')\"><p>must not be captured</p></body>",
    );
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const externalAddress = external.address();
  assert.ok(externalAddress && typeof externalAddress !== "string");
  const externalUrl = `http://127.0.0.1:${externalAddress.port}/private`;

  const target = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>Allowed page</title><label>Redirect <input oninput="if(this.value.startsWith('delayed')){setTimeout(()=>location.href='${externalUrl}',500)}else{location.href='${externalUrl}'}"></label>`,
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  const targetUrl = `http://127.0.0.1:${targetAddress.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-origin-capture-"));
  const contextFile = path.join(directory, "context.json");
  writeJson(contextFile, {
    targetUrl,
    allowedOrigins: [targetUrl],
    evidenceDir: directory,
    fixtureFiles: {},
    expectAuthenticated: false,
    headless: true,
    viewport: { width: 800, height: 600 },
    actionTimeoutMs: 5_000,
    maxToolCalls: 20,
  } satisfies BrowserMcpContext);
  const launch = browserMcpLaunch(contextFile);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: directory,
    stderr: "pipe",
  });
  const client = new Client({ name: "aek-origin-capture-test", version: "1.0.0" });
  const waitForExternalLoad = async (previous: number) => {
    const deadline = Date.now() + 2_000;
    while (externalLoads <= previous && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(externalLoads > previous, "the off-origin page did not finish loading");
  };
  try {
    await client.connect(transport);
    const navigation = await client.callTool({ name: "navigate", arguments: { url: targetUrl } });
    const inputRef = /\[(e\d+)\]\s*<input[^[]*Redirect/.exec(
      JSON.stringify(navigation.content),
    )?.[1];
    assert.ok(inputRef, JSON.stringify(navigation.content));
    let priorLoads = externalLoads;
    const rejectedFill = await client.callTool({
      name: "fill",
      arguments: { ref: inputRef, text: "leave" },
    });
    await waitForExternalLoad(priorLoads);
    assert.equal(rejectedFill.isError, true);
    assert.match(JSON.stringify(rejectedFill.content), /page navigated off-target/);

    const safeScroll = await client.callTool({ name: "scroll", arguments: { direction: "down" } });
    assert.notEqual(safeScroll.isError, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(externalWheelEvents, 0);

    const beforePress = await client.callTool({ name: "snapshot", arguments: {} });
    const beforePressRef = /\[(e\d+)\]\s*<input[^[]*Redirect/.exec(
      JSON.stringify(beforePress.content),
    )?.[1];
    assert.ok(beforePressRef, JSON.stringify(beforePress.content));
    priorLoads = externalLoads;
    const rejectedKeypressFill = await client.callTool({
      name: "fill",
      arguments: { ref: beforePressRef, text: "leave for keypress" },
    });
    await waitForExternalLoad(priorLoads);
    assert.equal(rejectedKeypressFill.isError, true);
    const safePress = await client.callTool({ name: "press", arguments: { key: "Enter" } });
    assert.notEqual(safePress.isError, true);
    assert.equal(externalKeypresses, 0);

    const afterPress = await client.callTool({ name: "snapshot", arguments: {} });
    const afterPressRef = /\[(e\d+)\]\s*<input[^[]*Redirect/.exec(
      JSON.stringify(afterPress.content),
    )?.[1];
    assert.ok(afterPressRef, JSON.stringify(afterPress.content));
    priorLoads = externalLoads;
    const delayedScreenshotFill = await client.callTool({
      name: "fill",
      arguments: { ref: afterPressRef, text: "delayed screenshot" },
    });
    assert.notEqual(delayedScreenshotFill.isError, true);
    await waitForExternalLoad(priorLoads);

    const rejected = await client.callTool({
      name: "screenshot",
      arguments: { label: "forbidden", fullPage: false },
    });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /page navigated off-target/);
    assert.equal(
      fs
        .readdirSync(path.join(directory, "screenshots"))
        .some((name) => name.includes("forbidden")),
      false,
    );

    const restored = await client.callTool({ name: "snapshot", arguments: {} });
    const restoredRef = /\[(e\d+)\]\s*<input[^[]*Redirect/.exec(
      JSON.stringify(restored.content),
    )?.[1];
    assert.ok(restoredRef, JSON.stringify(restored.content));
    priorLoads = externalLoads;
    const delayedDoneFill = await client.callTool({
      name: "fill",
      arguments: { ref: restoredRef, text: "delayed done" },
    });
    assert.notEqual(delayedDoneFill.isError, true);
    await waitForExternalLoad(priorLoads);
    const done = await client.callTool({
      name: "done",
      arguments: { outcome: "completed", summary: "Should be overridden." },
    });
    assert.match(
      JSON.stringify(done.content),
      /finalized as blocked without capturing off-origin evidence/,
    );
    const state = JSON.parse(fs.readFileSync(path.join(directory, "browser-result.json"), "utf8"));
    assert.equal(state.outcome, "blocked");
    assert.match(state.summary, /page navigated off-target/);
    assert.equal(new URL(state.finalUrl).origin, new URL(targetUrl).origin);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "screenshots.json"), "utf8"));
    assert.ok(
      saved.every(
        (shot: { url?: string }) =>
          !shot.url || new URL(shot.url).origin === new URL(targetUrl).origin,
      ),
    );
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    target.close();
    external.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser MCP halts after a saved authenticated session remains on a login wall", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><title>Sign in</title><form><input name=email><button>Sign in</button></form>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const cases = [
      { route: "/login", blocked: true, expectAuthenticated: true },
      { route: "/users/sign_in", blocked: true, expectAuthenticated: true },
      { route: "/auth", blocked: true, expectAuthenticated: true },
      { route: "/?reason=sessionExpired", blocked: true, expectAuthenticated: true },
      { route: "/settings/auth", blocked: false, expectAuthenticated: true },
      { route: "/?next=/login", blocked: false, expectAuthenticated: true },
      { route: "/login", blocked: false, expectAuthenticated: false },
      { route: "/login", blocked: true, expectAuthenticated: true, finalizeImmediately: true },
    ];
    for (const { route, blocked, expectAuthenticated, finalizeImmediately } of cases) {
      const url = `http://127.0.0.1:${address.port}${route}`;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-auth-loss-"));
      const stateFile = path.join(directory, "persona.json");
      fs.writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }));
      const contextFile = path.join(directory, "context.json");
      writeJson(contextFile, {
        targetUrl: url,
        allowedOrigins: [new URL(url).origin],
        evidenceDir: directory,
        storageStatePath: stateFile,
        expectAuthenticated,
        fixtureFiles: {},
        headless: true,
        viewport: { width: 800, height: 600 },
        actionTimeoutMs: 5_000,
        maxToolCalls: 20,
      } satisfies BrowserMcpContext);
      const launch = browserMcpLaunch(contextFile);
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        cwd: directory,
        stderr: "pipe",
      });
      const client = new Client({ name: "aek-auth-loss-test", version: "1.0.0" });
      try {
        await client.connect(transport);
        const navigation = await client.callTool({ name: "navigate", arguments: { url } });
        assert.notEqual(navigation.isError, true, route);
        const halted = finalizeImmediately
          ? await client.callTool({
              name: "done",
              arguments: { outcome: "completed", summary: "Authenticated flow completed." },
            })
          : await client.callTool({ name: "snapshot", arguments: {} });
        assert.equal(halted.isError === true, blocked && !finalizeImmediately, route);
        if (blocked) {
          assert.match(JSON.stringify(halted.content), /started with saved authentication/);
          const state = JSON.parse(
            fs.readFileSync(path.join(directory, "browser-result.json"), "utf8"),
          );
          assert.equal(state.outcome, "blocked");
          const stillHalted = await client.callTool({ name: "navigate", arguments: { url } });
          assert.equal(stillHalted.isError, true);
        } else {
          assert.equal(fs.existsSync(path.join(directory, "browser-result.json")), false);
        }
      } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    server.close();
  }
});

test("browser inspection failures remain execution errors", async (t) => {
  for (const operation of [
    "options",
    "field metadata",
    "container scroll",
    "page scroll",
  ] as const) {
    await t.test(operation, async () => {
      const failure = new Error("Execution context was destroyed");
      let evaluations = 0;
      const loc = {
        evaluate: async () => {
          evaluations++;
          if (operation === "options") return "div";
          if (operation === "field metadata" && evaluations === 1) return "input";
          throw failure;
        },
        scrollIntoViewIfNeeded: async () => {},
        click: async () => {},
        fill: async () => assert.fail("must not fill after failed inspection"),
      };
      const scope = {
        evaluate: async () => {
          throw failure;
        },
      };
      const context = {
        refLocator: async () => loc,
        refMissing: async () => false,
        frameEditors: new Map(),
        refFrames: new Map(),
        actionTimeoutMs: 100,
        enforceOrigin: async () => null,
        drainNotes: () => "",
        page: { mainFrame: () => scope, waitForTimeout: async () => {}, evaluate: scope.evaluate },
      } as unknown as BrowserInteractionContext;
      const action =
        operation === "options"
          ? new BrowserForms(context).select("e1", "Blue")
          : operation === "field metadata"
            ? new BrowserForms(context).fill("e1", "value")
            : new BrowserPointer(context).scroll(
                "down",
                operation === "container scroll" ? "e1" : undefined,
              );
      await assert.rejects(action, (error) => error === failure);
    });
  }
});

test("uploads fall back only for an absent chooser, never for execution failures", async (t) => {
  for (const phase of [
    "fingerprint",
    "chooser",
    "click",
    "origin",
    "setFiles",
    "count",
    "fresh upload",
    "absent chooser",
  ] as const) {
    await t.test(phase, async () => {
      const failure =
        phase === "click" ? new errors.TimeoutError("click failed") : new Error(`${phase} failed`);
      let fallbackUploads = 0;
      let scans = 0;
      const fresh = {
        first() {
          return this;
        },
        count: async () => {
          if (phase === "count") throw failure;
          return 1;
        },
        setInputFiles: async () => {
          if (phase === "fresh upload") throw failure;
          fallbackUploads++;
        },
      };
      const frame = {
        evaluate: async () => {
          if (phase === "fingerprint") throw failure;
        },
        locator: () => {
          scans++;
          return fresh;
        },
      };
      const loc = {
        evaluate: async () => "button",
        click: async () => {
          if (phase === "click") throw failure;
        },
      };
      const context = {
        refLocator: async () => loc,
        refMissing: async () => false,
        allowedFrames: async () => [frame, frame],
        enforceOrigin: async () => {
          if (phase === "origin") throw failure;
          return null;
        },
        drainNotes: () => "",
        page: {
          waitForTimeout: async () => {},
          waitForEvent: async () => {
            if (phase === "chooser") throw failure;
            if (["click", "count", "fresh upload", "absent chooser"].includes(phase))
              throw new errors.TimeoutError("no chooser");
            return {
              setFiles: async () => {
                if (phase === "setFiles") throw failure;
              },
            };
          },
        },
      } as unknown as BrowserInteractionContext;
      if (phase === "absent chooser") {
        assert.match(
          await upload(context, "e1", "/tmp/fixture.txt"),
          /Uploaded fixture.txt via a file input/,
        );
        assert.equal(fallbackUploads, 1);
      } else {
        await assert.rejects(
          upload(context, "e1", "/tmp/fixture.txt"),
          (error) => error === failure,
        );
        assert.equal(fallbackUploads, 0);
        assert.equal(scans, ["count", "fresh upload"].includes(phase) ? 1 : 0);
      }
    });
  }
});
