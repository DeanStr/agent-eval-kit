import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { beginMailboxWatch, createMailpitMailbox, waitForEmail } from "../src/email/mailbox.js";

const recipient = "speaker@example.test";
const sender = "sender@example.test";
function summary(id: string) {
  return {
    ID: id,
    From: { Address: sender },
    To: [{ Address: recipient }],
    Cc: null,
    Bcc: null,
    Subject: "Receipt",
    Tags: null,
    Created: new Date().toISOString(),
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

test("Mailpit paginates, scopes recipients, excludes old mail and uses receive time instead of sender Date", async () => {
  const messages = Array.from({ length: 102 }, (_, i) => summary(String(i)));
  messages[0]!.To = [{ Address: "other@example.test" }];
  const fixture = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/api/v1/messages") {
      const start = Number(url.searchParams.get("start"));
      res.end(
        JSON.stringify({
          start,
          total: messages.length,
          messages: messages.slice(start, start + 100),
        }),
      );
    } else {
      const message = messages.find((m) => m.ID === url.pathname.split("/").at(-1));
      res.end(
        JSON.stringify({ ...message, Date: "1999-01-01T00:00:00Z", Text: "Hello Priya", HTML: "" }),
      );
    }
  });
  try {
    const provider = createMailpitMailbox({ baseUrl: fixture.url, address: recipient });
    await assert.rejects(provider.get("latest"), /List the Mailpit recipient/);
    const watch = await beginMailboxWatch(provider);
    assert.equal(watch.excludedIds.length, 101);
    messages.unshift(summary("new"));
    const received = await waitForEmail({
      provider,
      watch,
      match: { from: sender, subject: "Receipt" },
      recipient,
      timeoutSeconds: 0.1,
      pollIntervalMs: 100,
    });
    assert.equal(received?.text, "Hello Priya");
    assert.equal(received?.created_at, messages[0]!.Created);
    assert.deepEqual(received?.labels, ["local-capture"]);
    await assert.rejects(provider.get("0"), /List the Mailpit recipient/);
  } finally {
    await fixture.close();
  }
});

test("Mailpit rejects malformed, oversized, changing and redirected evidence without leaking bodies", async () => {
  let mode = "invalid";
  const fixture = await serve((_req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { location: "/private-canary" });
      res.end();
    } else if (mode === "large") res.end("private-canary".repeat(200000));
    else if (mode === "http") {
      res.statusCode = 503;
      res.end("private-canary");
    } else if (mode === "duplicate")
      res.end(JSON.stringify({ start: 0, total: 2, messages: [summary("x"), summary("x")] }));
    else if (mode === "limit") res.end(JSON.stringify({ start: 0, total: 1001, messages: [] }));
    else if (mode === "short")
      res.end(JSON.stringify({ start: 0, total: 2, messages: [summary("x")] }));
    else if (mode === "changed")
      res.end(JSON.stringify({ ...summary("different"), Text: "private-canary", HTML: "" }));
    else if (mode === "valid")
      res.end(JSON.stringify({ start: 0, total: 1, messages: [summary("x")] }));
    else res.end("private-canary");
  });
  try {
    const provider = createMailpitMailbox({ baseUrl: fixture.url, address: recipient });
    for (mode of ["invalid", "redirect", "large", "http", "duplicate", "limit", "short"]) {
      await assert.rejects(provider.list(), (error: Error) => {
        assert.doesNotMatch(error.message, /private-canary/);
        return true;
      });
    }
    mode = "valid";
    await provider.list();
    mode = "changed";
    await assert.rejects(provider.get("x"), /changed after listing/);
  } finally {
    await fixture.close();
  }
  for (const baseUrl of [
    "https://mailpit.example.test",
    "http://user:pass@localhost:8025",
    "http://localhost:8025/api",
    "http://localhost:8025/?secret=x",
  ]) {
    assert.throws(() => createMailpitMailbox({ baseUrl, address: recipient }));
  }
});

test("Mailpit rejects concurrent pagination changes and includes Cc/Bcc recipients", async () => {
  let changing = true;
  const first = Array.from({ length: 100 }, (_, i) => summary(String(i)));
  const fixture = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    const start = Number(new URL(req.url!, "http://localhost").searchParams.get("start"));
    if (changing) {
      res.end(
        JSON.stringify({
          start,
          total: start === 0 ? 101 : 102,
          messages: start === 0 ? first : [summary("100"), summary("101")],
        }),
      );
    } else {
      res.end(
        JSON.stringify({
          start,
          total: 2,
          messages: [
            { ...summary("cc"), To: null, Cc: [{ Address: recipient }] },
            { ...summary("bcc"), To: [], Bcc: [{ Address: recipient }] },
          ],
        }),
      );
    }
  });
  try {
    const mailbox = createMailpitMailbox({ baseUrl: fixture.url, address: recipient });
    await assert.rejects(mailbox.list(), /changed during pagination/);
    changing = false;
    assert.deepEqual(
      (await mailbox.list()).map((message) => message.message_id),
      ["cc", "bcc"],
    );
  } finally {
    await fixture.close();
  }
});
