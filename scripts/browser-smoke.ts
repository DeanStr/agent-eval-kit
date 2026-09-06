import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "../src/browser/session.js";

const html = `<!doctype html><html><body>
<label>Name <input id="name"></label>
<label>Plan <select id="plan"><option>Free</option><option>Pro</option></select></label>
<button id="save" onclick="document.getElementById('result').textContent=document.getElementById('name').value+':'+document.getElementById('plan').value">Save</button>
<p id="result"></p>
</body></html>`;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No test server address");
const url = `http://127.0.0.1:${address.port}`;
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "aek-browser-"));
const browser = new BrowserSession(evidence, true, url, undefined, [url]);

try {
  let snapshot = await browser.start().then(() => browser.navigate(url));
  const name = snapshot.match(/\[(e\d+)\] <input/)?.[1];
  const plan = snapshot.match(/\[(e\d+)\] <select/)?.[1];
  if (!name || !plan) throw new Error(`Controls not found:\n${snapshot}`);
  await browser.fill(name, "Ada");
  snapshot = await browser.snapshot();
  const freshPlan = snapshot.match(/\[(e\d+)\] <select/)?.[1];
  if (!freshPlan) throw new Error("Select not found after fill");
  await browser.select(freshPlan, "Pro");
  snapshot = await browser.snapshot();
  const save = snapshot.match(/\[(e\d+)\][^\n]*Save/)?.[1];
  if (!save) throw new Error("Save not found");
  const result = await browser.click(save);
  if (!result.includes("Ada:Pro")) throw new Error(`Result did not update:\n${result}`);
  const shot = await browser.screenshot("smoke", false);
  if (!fs.existsSync(path.join(evidence, shot.relPath))) throw new Error("Screenshot missing");
  const blocked = await browser.navigate("https://example.org");
  if (!blocked.includes("BLOCKED")) throw new Error("Off-origin navigation was not contained");
  console.log(
    "Browser smoke passed: refs, fill, select, click, screenshot, and origin containment.",
  );
} finally {
  await browser.stop();
  server.close();
  fs.rmSync(evidence, { recursive: true, force: true });
}
