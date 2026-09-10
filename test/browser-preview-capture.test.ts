import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BrowserSession } from "../src/browser/session.js";
import { ScreenshotFramingError } from "../src/browser/interaction-context.js";
import { browserMcpLaunch } from "../src/mcp-config.js";

const html = `<!doctype html><style>body{margin:0;background:white}.spacer{height:1450px}
iframe{display:block;width:600px;height:400px;border:0}.end{height:500px}</style>
<div class=spacer></div><iframe class=preview sandbox srcdoc="<style>html,body{margin:0;background:rgb(255,0,255);height:100%}</style><h1>Hello Priya</h1>"></iframe><div class=end></div>`;
async function magentaPixels(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i]! > 240 && data[i + 1]! < 10 && data[i + 2]! > 240) count++;
  return count;
}

test("offscreen opaque previews reject full-page capture; visible viewport captures contain their pixels", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-preview-capture-"));
  const session = new BrowserSession(
    directory,
    true,
    origin,
    undefined,
    [origin],
    { width: 1280, height: 720 },
    5000,
    "same-origin",
    { readOnlyFrames: [{ pathPrefix: "/", selector: "iframe.preview" }], lossless: true },
  );
  try {
    await session.start();
    assert.match(await session.navigate(origin), /Hello Priya/);
    await assert.rejects(
      session.screenshot("offscreen", true),
      (error) => error instanceof ScreenshotFramingError && /fullPage: false/.test(error.message),
    );
    assert.deepEqual(fs.readdirSync(path.join(directory, "screenshots")), []);
    await session.page.evaluate(() => scrollTo(0, 1300));
    for (const fullPage of [false, true]) {
      const shot = await session.screenshot("visible", fullPage);
      if (!fullPage) assert.doesNotMatch(shot.notes, /Full-page screenshot was clipped/);
      assert.ok(
        (await magentaPixels(Buffer.from(shot.base64, "base64"))) > 200000,
        "the real opaque iframe pixels must appear",
      );
    }
    assert.equal(await session.page.locator("iframe").getAttribute("sandbox"), "");
    await session.page.evaluate(() => scrollTo(0, 1600));
    await assert.rejects(session.screenshot("partially-above", true), ScreenshotFramingError);
    await session.page.evaluate(() => {
      scrollTo(0, 0);
      document.querySelector<HTMLElement>(".spacer")!.style.height = "2100px";
    });
    await session.screenshot("outside-clip", true);
  } finally {
    await session.stop();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("full-page framing uses the preview portion visible through ancestor clipping", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><style>
body{margin:0;background:white}.spacer{height:0}
.container{width:600px;height:500px;overflow:hidden;border:12px solid black;margin:20px}
iframe{display:block;width:1600px;height:1400px;border:0}.end{height:700px}
</style><div class=spacer></div><div class=container><div><iframe class=preview sandbox
srcdoc="<style>html,body{margin:0;background:rgb(255,0,255);height:100%}</style>"></iframe></div></div><div class=end></div>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-preview-clipping-"));
  const session = new BrowserSession(
    directory,
    true,
    origin,
    undefined,
    [origin],
    { width: 1280, height: 720 },
    5000,
    "same-origin",
    { readOnlyFrames: [{ pathPrefix: "/", selector: "iframe.preview" }], lossless: true },
  );
  try {
    await session.start();
    await session.navigate(origin);
    for (const overflow of ["hidden", "auto", "clip"]) {
      await session.page.locator(".container").evaluate((node, value) => {
        (node as HTMLElement).style.overflow = value;
      }, overflow);
      const shot = await session.screenshot(`ancestor-${overflow}`, true);
      assert.equal(await magentaPixels(Buffer.from(shot.base64, "base64")), 600 * 500);
    }
    await session.page.locator(".container").evaluate((node) => {
      (node as HTMLElement).style.overflowX = "visible";
    });
    await assert.rejects(session.screenshot("horizontal-overflow", true), ScreenshotFramingError);
    await session.page.evaluate(() => {
      document.querySelector<HTMLElement>(".container")!.style.overflow = "hidden";
      document.querySelector<HTMLElement>(".spacer")!.style.height = "800px";
    });
    const before = fs.readdirSync(path.join(directory, "screenshots"));
    await assert.rejects(session.screenshot("offscreen-container", true), ScreenshotFramingError);
    assert.deepEqual(fs.readdirSync(path.join(directory, "screenshots")), before);
    await session.page.evaluate(() => scrollTo(0, 700));
    const shot = await session.screenshot("scrolled-container", true);
    assert.equal(await magentaPixels(Buffer.from(shot.base64, "base64")), 600 * 500);
  } finally {
    await session.stop();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP permits a viewport retry after rejecting offscreen preview framing", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-preview-mcp-"));
  const contextFile = path.join(directory, "context.json");
  fs.writeFileSync(
    contextFile,
    JSON.stringify({
      targetUrl: origin,
      allowedOrigins: [origin],
      evidenceDir: directory,
      requiredCheckpoints: [],
      fixtureFiles: {},
      expectAuthenticated: false,
      headless: true,
      viewport: { width: 1280, height: 720 },
      actionTimeoutMs: 5000,
      maxToolCalls: 12,
      readOnlyFrames: [{ pathPrefix: "/", selector: "iframe.preview" }],
    }),
  );
  const launch = browserMcpLaunch(contextFile);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    stderr: "pipe",
  });
  const client = new Client({ name: "preview-test", version: "1" });
  try {
    await client.connect(transport);
    await client.callTool({ name: "navigate", arguments: { url: origin } });
    const rejected = await client.callTool({
      name: "screenshot",
      arguments: { label: "offscreen", fullPage: true },
    });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /fullPage: false/);
    assert.equal(fs.existsSync(path.join(directory, "browser-error.json")), false);
    for (let i = 0; i < 3; i++)
      await client.callTool({ name: "scroll", arguments: { direction: "down" } });
    const shot = await client.callTool({
      name: "screenshot",
      arguments: { label: "visible", fullPage: false },
    });
    assert.notEqual(shot.isError, true);
    const image = (shot.content as Array<{ type: string; data?: string }>).find(
      (c) => c.type === "image",
    );
    assert.ok(image?.data);
    assert.ok((await magentaPixels(Buffer.from(image.data, "base64"))) > 100000);
    const done = await client.callTool({
      name: "done",
      arguments: { outcome: "completed", summary: "Preview visible in viewport" },
    });
    assert.notEqual(done.isError, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "browser-result.json"), "utf8")).outcome,
      "completed",
    );
  } finally {
    await client.close();
    await transport.close();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
