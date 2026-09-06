import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  beginMailboxWatch,
  createMailbox,
  emailContent,
  emailEvidence,
  waitForEmail,
  type EmailMessage,
  type MailboxProvider,
} from "../src/email/mailbox.js";
import { emailAuthSchema, mailboxSchema, MailboxError } from "../src/email/contracts.js";
import { authenticateEmail, EmailAuthenticationBlocked } from "../src/email/authenticate.js";
import { BrowserSession } from "../src/browser/session.js";
import { browserMcpLaunch } from "../src/mcp-config.js";
import type { BrowserMcpContext } from "../src/browser/context.js";
import { readNdjson, writeJson } from "../src/io.js";
import { validateEvidenceFiles } from "../src/evidence/files.js";
import type { EvidenceFile, TranscriptEntry, EvalConfig } from "../src/types.js";
import { loadConfig, loadResolvedConfig, redactConfig } from "../src/config.js";
import { captureAuth, personaAuthPath } from "../src/auth.js";
import { collectionConfig } from "../src/collection.js";
import { executeScenario } from "../src/scenario.js";
import {
  loadSpecs,
  assertEmailConfiguration,
  assertScenarioTargetCompatibility,
} from "../src/specs.js";

const address = "speaker@example.test";
const sender = "login@example.test";
const key = "private-agentmail-key-canary";
function message(id: string, overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    message_id: id,
    inbox_id: address,
    from: `Login <${sender}>`,
    to: [address],
    subject: "Sign in",
    created_at: new Date().toISOString(),
    labels: ["received"],
    text: "Your code is 739182",
    ...overrides,
  };
}
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const location = server.address();
  assert.ok(location && typeof location !== "string");
  return {
    url: `http://127.0.0.1:${location.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
function fakeProvider(messages: EmailMessage[]): MailboxProvider {
  return {
    async list() {
      return messages;
    },
    async get(id) {
      const found = messages.find((m) => m.message_id === id);
      assert.ok(found);
      return found;
    },
  };
}

test("email HTML is parsed without execution, including entities, HTML-only codes and links", () => {
  const content = emailContent({
    html: '<p>Your code is <b>739182</b></p><a href="https://app.test/auth?token=a&amp;mode=login">Continue</a><script>fetch("https://evil.test")</script>',
  });
  assert.match(content.text, /Your code is 739182/);
  assert.doesNotMatch(content.text, /fetch/);
  assert.deepEqual(content.links, ["https://app.test/auth?token=a&mode=login"]);
  for (const html of [
    "<h1>739182</h1><p>Expires soon</p>",
    "Use this code<h2>739182</h2>to sign in",
    "<table><tr><th>Code</th><td>739182</td></tr></table>",
    "<section>739182</section><aside>Expires soon</aside>",
  ]) {
    assert.match(emailContent({ html }).text, /(?:^|\s)739182(?:\s|$)/);
  }
  assert.equal(emailContent({ html: "<span>739</span><b>182</b>" }).text, "739182");
  const link = "https://app.test/auth?token=abc123";
  assert.deepEqual(
    emailContent({ html: `<a href="${link}">Sign in</a>`, text: `Sign in (${link}).` }).links,
    [link],
  );
  assert.deepEqual(emailContent({ text: `Sign in: ${link}, or [continue](${link}).` }).links, [
    link,
  ]);
  const balanced = "https://app.test/path_(section)?token=abc(123)";
  assert.deepEqual(emailContent({ text: `Sign in (${balanced}).` }).links, [balanced]);
  const encoded = "https://app.test/auth?token=abc%29%2E";
  assert.deepEqual(emailContent({ text: `“${encoded}”` }).links, [encoded]);
  const punctuationToken = "https://app.test/auth?token=abc.";
  assert.deepEqual(emailContent({ text: `<${punctuationToken}>` }).links, [punctuationToken]);
  assert.deepEqual(emailContent({ text: `"${punctuationToken}"` }).links, [punctuationToken]);
  assert.throws(() => emailContent({}), MailboxError);
  const receipt = emailEvidence(message("m1"), ["Your code is"]);
  assert.equal(receipt.checks[0]?.present, true);
  assert.ok(!JSON.stringify(receipt).includes("739182"));
});

test("mailbox observation excludes old mail, checks exact identities and rejects ambiguous new mail", async () => {
  const messages = [message("old")];
  const provider = fakeProvider(messages);
  const watch = await beginMailboxWatch(provider);
  messages.push(
    message("wrong-from", { from: "not-login@example.test" }),
    message("wrong-to", { to: ["other@example.test"] }),
    message("wrong-subject", { subject: "Sign in now" }),
    message("late-old", { created_at: "2020-01-01T00:00:00Z" }),
  );
  const options = {
    provider,
    watch,
    match: { from: sender, subject: "Sign in" },
    recipient: address,
    timeoutSeconds: 0.15,
    pollIntervalMs: 100,
  };
  assert.equal(await waitForEmail(options), null);
  messages.push(message("new"));
  assert.equal((await waitForEmail(options))?.message_id, "new");
  messages.push(message("duplicate"));
  await assert.rejects(waitForEmail(options), /Multiple new emails/);
  await assert.rejects(
    waitForEmail({
      ...options,
      provider: {
        ...provider,
        list: async () => {
          throw new MailboxError("API unavailable");
        },
      },
    }),
    /API unavailable/,
  );
});

test("AgentMail adapter paginates all categories, fails on invalid responses and never exposes response secrets", async () => {
  let mode = "pages";
  const requests: URL[] = [];
  const endpoint = await serve((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    const url = new URL(request.url!, "http://localhost");
    requests.push(url);
    if (mode === "error") {
      response.writeHead(401);
      response.end(key);
      return;
    }
    if (mode === "redirect") {
      response.writeHead(302, { location: "https://example.com/" });
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (mode === "invalid") {
      response.end(JSON.stringify({ messages: [{ secret: key }] }));
      return;
    }
    if (url.pathname.endsWith("/m2")) {
      response.end(JSON.stringify(message("m2")));
      return;
    }
    response.end(
      JSON.stringify(
        url.searchParams.has("page_token")
          ? { messages: [message("m2")] }
          : { messages: [message("m1")], next_page_token: "page-two" },
      ),
    );
  });
  process.env.AEK_TEST_MAIL_KEY = key;
  try {
    const provider = createMailbox(
      mailboxSchema.parse({
        provider: "agentmail",
        inboxId: address,
        address,
        apiKeyEnv: "AEK_TEST_MAIL_KEY",
        baseUrl: endpoint.url,
      }),
    );
    assert.equal((await provider.list()).length, 2);
    assert.equal(requests[0]?.searchParams.get("include_unauthenticated"), "true");
    assert.equal(requests[0]?.searchParams.get("include_spam"), "true");
    assert.equal(requests[1]?.searchParams.get("page_token"), "page-two");
    assert.equal((await provider.get("m2")).message_id, "m2");
    for (const value of ["error", "invalid", "redirect"]) {
      mode = value;
      await assert.rejects(
        provider.list(),
        (error: Error) => error instanceof MailboxError && !error.message.includes(key),
      );
    }
    assert.throws(() =>
      mailboxSchema.parse({
        provider: "agentmail",
        inboxId: address,
        address,
        apiKeyEnv: "AEK_TEST_MAIL_KEY",
        baseUrl: "http://remote.example.test/v0",
      }),
    );
  } finally {
    delete process.env.AEK_TEST_MAIL_KEY;
    await endpoint.close();
  }
});

test("emails arriving after the observation deadline cannot satisfy delivery", async () => {
  const provider = fakeProvider([]);
  const watch = await beginMailboxWatch(provider);
  const late = message("late");
  const result = await waitForEmail({
    provider: {
      async list() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        late.created_at = new Date().toISOString();
        return [late];
      },
      async get() {
        return late;
      },
    },
    watch,
    match: { from: sender, subject: "Sign in" },
    recipient: address,
    timeoutSeconds: 0.01,
    pollIntervalMs: 100,
  });
  assert.equal(result, null);
});

async function loginFixture(
  type: "link" | "code",
  failure?: "identity" | "echo" | "ambiguous" | "api" | "loading",
  format: "html" | "plain" | "multipart" = "html",
  provider: "agentmail" | "mailpit" = "agentmail",
) {
  const messages: EmailMessage[] = [];
  const token = "magic-link-secret-canary-418726";
  let root = "";
  let usedCredential = false;
  const endpoint = await serve((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname.startsWith("/api/v1/")) {
      assert.equal(request.headers.authorization, undefined);
      response.setHeader("content-type", "application/json");
      const captured = messages.map((item) => ({
        ID: item.message_id,
        From: { Address: sender },
        To: [{ Address: address }],
        Cc: null,
        Bcc: null,
        Tags: null,
        Subject: item.subject,
        Created: item.created_at,
        Text: item.text ?? "",
        HTML: item.html ?? "",
      }));
      response.end(
        JSON.stringify(
          url.pathname === "/api/v1/messages"
            ? { start: 0, total: captured.length, messages: captured }
            : captured[0],
        ),
      );
      return;
    }
    if (url.pathname.startsWith("/v0/")) {
      if (failure === "api") {
        response.writeHead(503);
        response.end(key);
        return;
      }
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(url.pathname.endsWith("/messages") ? { messages } : messages[0]));
      return;
    }
    response.setHeader("content-type", "text/html");
    if (url.pathname === "/expire") {
      response.writeHead(302, { location: `/login?token=${token}` });
      response.end();
      return;
    }
    if (url.pathname === "/request") {
      response.setHeader("Set-Cookie", "challenge=browser-bound; HttpOnly; Path=/");
      const content =
        type === "link"
          ? `<a href="${root}/verify?token=${token}">Sign in</a>${failure === "ambiguous" ? `<a href="${root}/verify?token=second">Again</a>` : ""}`
          : "<h1>739182</h1><p>Expires soon</p>";
      messages.push(
        message("new-login", {
          text: format === "html" ? "" : `Sign in (${root}/verify?token=${token}).`,
          ...(format === "plain" ? {} : { html: content }),
        }),
      );
      response.end(
        '<form action="/verify"><input name="code" id="code"><button id="verify">Verify</button></form>',
      );
      return;
    }
    if (url.pathname === "/verify") {
      usedCredential =
        request.headers.cookie?.includes("challenge=browser-bound") === true &&
        (type === "link"
          ? url.searchParams.get("token") === token
          : url.searchParams.get("code") === "739182");
      if (!usedCredential) {
        response.writeHead(403);
        response.end("No session");
        return;
      }
      response.setHeader("Set-Cookie", "authenticated=yes; HttpOnly; Path=/");
      response.writeHead(302, { location: "/account" });
      response.end();
      return;
    }
    if (url.pathname === "/auth-log.js") {
      response.setHeader("content-type", "application/javascript");
      response.end(`console.error(${JSON.stringify(type === "link" ? token : "739182")})`);
      return;
    }
    response.setHeader("content-type", "text/html");
    if (url.pathname === "/account") {
      response.end(
        `<h1 id="identity">${failure === "identity" ? "wrong@example.test" : failure === "loading" ? "Loading..." : address}</h1>${failure === "loading" ? `<script>setTimeout(() => document.querySelector('#identity').textContent = ${JSON.stringify(address)}, 800)</script>` : ""}${failure === "echo" ? `<p>${token}</p>` : ""}<script src="/auth-log.js"></script>`,
      );
      return;
    }
    response.end(
      '<form action="/request"><input type="email" id="email" name="email"><button id="request">Email me</button></form>',
    );
  });
  root = endpoint.url;
  const flow = emailAuthSchema.parse({
    mailbox: "speaker",
    startPath: "/login",
    emailSelector: "#email",
    requestSelector: "#request",
    message: { from: sender, subject: "Sign in" },
    credential:
      type === "link"
        ? { type: "link", path: "/verify", parameter: "token" }
        : { type: "code", length: 6, selector: "#code", submitSelector: "#verify" },
    success: { selector: "#identity", text: address },
    timeoutSeconds: 1,
    pollIntervalMs: 100,
  });
  const mailbox = mailboxSchema.parse(
    provider === "mailpit"
      ? { provider, address, baseUrl: root }
      : {
          provider: "agentmail",
          inboxId: address,
          address,
          apiKeyEnv: "AEK_TEST_MAIL_KEY",
          baseUrl: `${root}/v0`,
        },
  );
  return { ...endpoint, flow, mailbox, token, used: () => usedCredential };
}

for (const [type, expires, format, provider] of [
  ["link", false, "html", "agentmail"],
  ["code", false, "html", "agentmail"],
  ["link", true, "html", "agentmail"],
  ["link", false, "plain", "agentmail"],
  ["link", false, "multipart", "agentmail"],
  ["link", false, "html", "mailpit"],
  ["code", false, "html", "mailpit"],
] as const) {
  test(`${provider} email ${type} login (${format}) ${expires ? "blocks expiry before finalization" : "uses the initiating browser"} and retains no credentials in evidence`, async () => {
    const fixture = await loginFixture(type, undefined, format, provider);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-email-browser-"));
    const credentialFile = path.join(directory, "private-key.json");
    writeJson(
      credentialFile,
      {
        ...(provider === "agentmail" ? { key } : {}),
        flow: fixture.flow,
        mailbox: fixture.mailbox,
      },
      { mode: 0o600 },
    );
    const context: BrowserMcpContext = {
      targetUrl: fixture.url,
      allowedOrigins: [fixture.url],
      evidenceDir: directory,
      persona: "speaker",
      fixtureFiles: {},
      expectAuthenticated: false,
      headless: true,
      viewport: { width: 800, height: 600 },
      actionTimeoutMs: 3000,
      storageStateCandidatePath: path.join(directory, "candidate.json"),
      emailAuthentication: { credentialFile },
    };
    const contextFile = path.join(directory, "context.json");
    writeJson(contextFile, context);
    const transport = new StdioClientTransport({
      ...browserMcpLaunch(contextFile),
      stderr: "pipe",
    });
    const client = new Client({ name: "email-test", version: "1" });
    try {
      await client.connect(transport);
      const forbidden = await client.callTool({
        name: "navigate",
        arguments: { url: fixture.url },
      });
      assert.equal(forbidden.isError, true);
      const login = await client.callTool({ name: "authenticate_email", arguments: {} });
      assert.notEqual(login.isError, true, JSON.stringify(login));
      assert.equal(fixture.used(), true);
      const snapshot = await client.callTool({ name: "snapshot", arguments: {} });
      assert.ok(JSON.stringify(snapshot).includes(address));
      const screenshot = await client.callTool({
        name: "screenshot",
        arguments: { label: "authenticated" },
      });
      assert.notEqual(screenshot.isError, true, JSON.stringify(screenshot));
      if (expires) {
        // An application can echo its consumed token when the session expires.
        // Exercise that transition before finalizing; no tool input has the token.
        await client.callTool({ name: "navigate", arguments: { url: `${fixture.url}/expire` } });
        for (let attempt = 0; attempt < 2; attempt++)
          await client.callTool({ name: "wait", arguments: { ms: 1 } });
      }
      await client.callTool({
        name: "done",
        arguments: { outcome: "completed", summary: "Authenticated as speaker" },
      });
      assert.equal(fs.existsSync(credentialFile), false);
      const terminal = JSON.parse(
        fs.readFileSync(path.join(directory, "browser-result.json"), "utf8"),
      );
      assert.equal(terminal.outcome, expires ? "blocked" : "completed");
      if (expires) assert.equal(fs.existsSync(path.join(directory, "candidate.json")), false);
      else {
        const state = JSON.parse(fs.readFileSync(path.join(directory, "candidate.json"), "utf8"));
        assert.ok(
          state.cookies.some((cookie: { name: string }) => cookie.name === "authenticated"),
        );
      }
      const files = JSON.parse(
        fs.readFileSync(path.join(directory, "files.json"), "utf8"),
      ) as EvidenceFile[];
      const transcript = readNdjson<TranscriptEntry>(
        path.join(directory, "browser-transcript.ndjson"),
      );
      validateEvidenceFiles(files, transcript);
      assert.throws(() => validateEvidenceFiles([], transcript), /missing its file metadata/);
      for (const filename of fs.readdirSync(directory, { recursive: true }) as string[]) {
        const absolute = path.join(directory, filename);
        if (!fs.statSync(absolute).isFile()) continue;
        const data = fs.readFileSync(absolute).toString("utf8");
        for (const secret of [key, fixture.token, "739182"])
          assert.ok(!data.includes(secret), `${filename} leaked a credential`);
      }
    } finally {
      await client.close();
      await fixture.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("email authentication waits for the exact account identity to finish loading", async () => {
  const fixture = await loginFixture("link", "loading");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-email-identity-"));
  const browser = new BrowserSession(
    directory,
    true,
    fixture.url,
    undefined,
    [fixture.url],
    { width: 800, height: 600 },
    3000,
  );
  try {
    await browser.start();
    const receipt = await authenticateEmail({
      browser,
      targetUrl: fixture.url,
      flow: fixture.flow,
      mailbox: fixture.mailbox,
      provider: createMailbox(fixture.mailbox, { apiKey: key }),
    });
    assert.equal(receipt.identityVerified, true);
    assert.equal(await browser.page.locator("#identity").innerText(), address);
    await browser.screenshot("verified", false);
  } finally {
    await browser.stop();
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ambiguous links and API failures are errors; wrong identity and exposed credentials block capture", async () => {
  process.env.AEK_TEST_MAIL_KEY = key;
  try {
    for (const failure of ["ambiguous", "api", "identity", "echo"] as const) {
      const fixture = await loginFixture("link", failure);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-email-failure-"));
      const browser = new BrowserSession(
        directory,
        true,
        fixture.url,
        undefined,
        [fixture.url],
        { width: 800, height: 600 },
        2000,
      );
      try {
        await browser.start();
        await assert.rejects(
          authenticateEmail({
            browser,
            targetUrl: fixture.url,
            flow: fixture.flow,
            mailbox: fixture.mailbox,
          }),
          failure === "ambiguous" || failure === "api" ? MailboxError : EmailAuthenticationBlocked,
        );
        await assert.rejects(browser.screenshot("unsafe", false), /not completed safely/);
        assert.equal(fs.readdirSync(path.join(directory, "screenshots")).length, 0);
        const diagnostics = fs.readFileSync(
          path.join(directory, "browser-diagnostics.ndjson"),
          "utf8",
        );
        assert.ok(!diagnostics.includes(fixture.token));
      } finally {
        await browser.stop();
        await fixture.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    delete process.env.AEK_TEST_MAIL_KEY;
  }
});

test("authentication credential checks cover background tabs and preserve origin recovery", async () => {
  const fixture = await loginFixture("link");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-email-tabs-"));
  const browser = new BrowserSession(root, true, fixture.url);
  try {
    await browser.start();
    await browser.page.goto(`${fixture.url}/account`);
    const background = browser.page;
    // Keep the original tab open while inspecting the popup as the active page.
    const [popup] = await Promise.all([
      background.waitForEvent("popup", { timeout: 3000 }),
      background.evaluate(() => {
        window.open("/account");
      }),
    ]);
    await popup.waitForLoadState("domcontentloaded");
    browser.page = popup;
    await background.evaluate((secret) => {
      document.body.append(secret);
    }, fixture.token);
    browser.beginPrivateAuthentication();
    browser.protectAuthenticationSecret(fixture.token);
    await assert.rejects(browser.finishPrivateAuthentication(), /credential remains/);
    await background.close();
    await browser.finishPrivateAuthentication();
    // Screenshot containment must still recover a page that navigates away
    // after authentication, even with the credential guard enabled.
    await browser.page.goto("data:text/html,external");
    await assert.rejects(browser.screenshot("external", false), /off-target/);
    assert.equal(new URL(browser.page.url()).origin, fixture.url);
  } finally {
    await browser.stop();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("formatted credentials in DOM text and shadow roots block authentication and later capture", async () => {
  const fixture = await serve((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<h1>Account</h1>");
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-email-dom-text-"));
  const browser = new BrowserSession(root, true, fixture.url);
  try {
    await browser.start();
    browser.protectAuthenticationSecret("739182");
    for (const shadow of [false, true]) {
      await browser.page.goto(fixture.url);
      const displayCode = () =>
        browser.page.evaluate((useShadow) => {
          const host = document.createElement("div");
          document.body.append(host);
          const container = useShadow ? host.attachShadow({ mode: "open" }) : host;
          container.innerHTML = "<p>Code: <span>7&#51;9</span><b>182</b></p>";
        }, shadow);
      await displayCode();
      browser.beginPrivateAuthentication();
      await assert.rejects(browser.finishPrivateAuthentication(), /credential remains/);
      await browser.page.goto(fixture.url);
      await browser.finishPrivateAuthentication();
      await displayCode();
      await assert.rejects(browser.snapshot(), /credential remains/);
      await assert.rejects(browser.screenshot("unsafe", false), /credential remains/);
      assert.deepEqual(fs.readdirSync(path.join(root, "screenshots")), []);
    }
  } finally {
    await browser.stop();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("email auth configuration survives sealed redaction and aek auth saves a verified persona", async () => {
  const fixture = await loginFixture("code");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-email-config-"));
  process.env.AEK_TEST_MAIL_KEY = key;
  try {
    const filename = path.join(directory, "evalkit.yaml");
    fs.writeFileSync(
      filename,
      YAML.stringify({
        version: 1,
        project: { name: "Email", root: "." },
        target: { kind: "web", url: fixture.url },
        mailboxes: { speaker: fixture.mailbox },
        emailAuth: { speaker: fixture.flow },
      }),
    );
    const config = loadConfig(filename);
    fs.writeFileSync(filename, YAML.stringify(redactConfig(config)));
    const sealed = loadResolvedConfig(filename);
    assert.deepEqual(sealed.emailAuth, config.emailAuth);
    assert.deepEqual(sealed.mailboxes, config.mailboxes);
    const changed: EvalConfig = {
      ...config,
      emailAuth: {
        speaker: { ...fixture.flow, success: { selector: "#identity", text: "someone-else" } },
      },
    };
    assert.notDeepEqual(collectionConfig(config), collectionConfig(changed));
    const destination = await captureAuth({ config, persona: "speaker", email: true });
    assert.equal(destination, personaAuthPath(config, "speaker"));
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(config.paths.auth, ".capture")), []);
  } finally {
    delete process.env.AEK_TEST_MAIL_KEY;
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mailbox API errors remain execution failures despite a provider reporting completion, and private key files are cleaned up", async () => {
  const fixture = await loginFixture("link", "api");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-email-run-error-"));
  const directory = path.join(root, "LOGIN");
  fs.mkdirSync(directory);
  const credentialFile = path.join(root, "private.json");
  writeJson(credentialFile, { key, flow: fixture.flow, mailbox: fixture.mailbox }, { mode: 0o600 });
  const contextFile = path.join(directory, "context.json");
  writeJson(contextFile, {
    targetUrl: fixture.url,
    allowedOrigins: [fixture.url],
    evidenceDir: directory,
    persona: "speaker",
    fixtureFiles: {},
    expectAuthenticated: false,
    headless: true,
    viewport: { width: 800, height: 600 },
    actionTimeoutMs: 2000,
    emailAuthentication: { credentialFile },
  } satisfies BrowserMcpContext);
  const transport = new StdioClientTransport({ ...browserMcpLaunch(contextFile), stderr: "pipe" });
  const client = new Client({ name: "email-error-test", version: "1" });
  process.env.AEK_TEST_MAIL_KEY = key;
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "authenticate_email", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /HTTP 503/);
    assert.ok(!JSON.stringify(result).includes(key));
    await client.callTool({
      name: "done",
      arguments: { outcome: "completed", summary: "Agent ignored the failure" },
    });
    await client.close();
    const filename = path.join(root, "evalkit.yaml");
    fs.writeFileSync(
      filename,
      YAML.stringify({
        version: 1,
        project: { name: "Error", root: "." },
        target: { kind: "web", url: fixture.url },
        agent: { provider: "mock" },
        judge: { provider: "mock" },
        mailboxes: { speaker: fixture.mailbox },
        emailAuth: { speaker: fixture.flow },
      }),
    );
    const config = loadConfig(filename);
    const specFile = path.join(root, "spec.yaml");
    config.emailAuth!.speaker!.emailSelector = 'input[data-token="private-selector-canary"]';
    fs.writeFileSync(
      specFile,
      YAML.stringify({
        id: "email",
        title: "Login",
        description: "Login",
        weight: 100,
        scenarios: [
          {
            id: "LOGIN",
            name: "Login",
            persona: "speaker",
            authenticateEmail: true,
            instructions: "Authenticate",
          },
        ],
        rubric: [
          {
            id: "IDENTITY",
            criterion: "Identity",
            weight: 1,
            passCriteria: "Correct identity",
            scenarios: ["LOGIN"],
          },
        ],
      }),
    );
    const specs = loadSpecs(specFile);
    const spec = specs[0]!;
    assertScenarioTargetCompatibility(specs, config.target);
    assertEmailConfiguration(specs, config);
    await assert.rejects(
      executeScenario({ config, spec, scenario: spec.scenarios[0]!, fixtures: {}, directory }),
      /Email authentication execution failed.*503/,
    );
    assert.equal(fs.existsSync(personaAuthPath(config, "speaker")), false);
    assert.deepEqual(
      fs.readdirSync(config.paths.auth).filter((name) => name.startsWith(".email-")),
      [],
    );
    assert.equal(fs.existsSync(credentialFile), false);
    const retainedContext = fs.readFileSync(path.join(directory, "browser-context.json"), "utf8");
    assert.doesNotMatch(retainedContext, /private-selector-canary/);
    assert.deepEqual(Object.keys(JSON.parse(retainedContext).emailAuthentication), [
      "credentialFile",
    ]);
    const withoutFlow = { ...config };
    delete withoutFlow.emailAuth;
    assert.throws(() => assertEmailConfiguration(specs, withoutFlow), /configure emailAuth/);
    assert.throws(
      () =>
        assertScenarioTargetCompatibility(
          [{ ...spec, scenarios: [{ ...spec.scenarios[0]!, requiresAuth: true }] }],
          config.target,
        ),
      /without requiresAuth/,
    );
  } finally {
    delete process.env.AEK_TEST_MAIL_KEY;
    await client.close();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing email blocks authentication while invalid selector syntax is an execution error", async () => {
  const fixture = await loginFixture("code");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-email-no-message-"));
  const browser = new BrowserSession(
    root,
    true,
    fixture.url,
    undefined,
    [fixture.url],
    { width: 800, height: 600 },
    1000,
  );
  try {
    await browser.start();
    const provider = fakeProvider([]);
    await assert.rejects(
      authenticateEmail({
        browser,
        targetUrl: fixture.url,
        flow: { ...fixture.flow, timeoutSeconds: 0.15 },
        mailbox: fixture.mailbox,
        provider,
      }),
      (error: Error) =>
        error instanceof EmailAuthenticationBlocked &&
        /No matching login email/.test(error.message),
    );
    await assert.rejects(
      authenticateEmail({
        browser,
        targetUrl: fixture.url,
        flow: { ...fixture.flow, requestSelector: "[" },
        mailbox: fixture.mailbox,
        provider,
      }),
      MailboxError,
    );
  } finally {
    await browser.stop();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
