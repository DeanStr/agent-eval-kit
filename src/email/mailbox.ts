import { z } from "zod";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { mailboxSchema, emailMatchSchema, MailboxError, type EmailMatch } from "./contracts.js";

const metadataSchema = z.object({
  message_id: z.string().min(1),
  inbox_id: z.string().min(1),
  from: z.string().min(1),
  to: z.array(z.string()).min(1),
  subject: z.string().optional(),
  created_at: z.iso.datetime({ offset: true }),
  labels: z.array(z.string()),
});
const messageSchema = metadataSchema.extend({
  text: z.string().optional(),
  html: z.string().optional(),
});
export type EmailMessage = z.infer<typeof messageSchema>;
export type EmailMetadata = z.infer<typeof metadataSchema>;

/** Raw messages remain private to the caller. Never print them from an auth flow. */
export interface MailboxProvider {
  list(signal?: AbortSignal): Promise<EmailMetadata[]>;
  get(messageId: string, signal?: AbortSignal): Promise<EmailMessage>;
}

export function createMailbox(
  input: z.input<typeof mailboxSchema>,
  credentials: { apiKey?: string } = {},
): MailboxProvider {
  const config = mailboxSchema.parse(input);
  const key = credentials.apiKey ?? process.env[config.apiKeyEnv];
  if (!key) throw new MailboxError(`Missing mailbox credential: set ${config.apiKeyEnv}`);
  const root = `${config.baseUrl.replace(/\/$/, "")}/inboxes/${encodeURIComponent(config.inboxId)}/messages`;
  async function request(url: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new MailboxError(
          `AgentMail request failed (HTTP ${response.status}); check mailbox access, service status and rate limits`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new MailboxError("AgentMail returned an empty response");
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new MailboxError("AgentMail response exceeds the 2 MiB inspection limit");
        }
        chunks.push(result.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      // Fetch, JSON and schema diagnostics can contain headers, bodies or URLs.
      throw new MailboxError(
        "AgentMail transport or response failed; check connectivity, timeout and API compatibility",
      );
    }
  }
  return {
    async list(signal) {
      const messages: EmailMetadata[] = [];
      const pages = new Set<string>();
      let page: string | undefined;
      do {
        const url = new URL(root);
        url.searchParams.set("limit", "100");
        for (const category of ["spam", "blocked", "unauthenticated", "trash"])
          url.searchParams.set(`include_${category}`, "true");
        if (page) url.searchParams.set("page_token", page);
        const parsed = z
          .object({
            messages: z.array(metadataSchema),
            next_page_token: z.string().min(1).nullish(),
          })
          .safeParse(await request(url.toString(), signal));
        if (!parsed.success)
          throw new MailboxError(
            "Invalid AgentMail message-list response; check API compatibility",
          );
        for (const message of parsed.data.messages) {
          if (message.inbox_id !== config.inboxId)
            throw new MailboxError("AgentMail returned a message from another inbox");
          messages.push(message);
        }
        page = parsed.data.next_page_token ?? undefined;
        if (page && pages.has(page))
          throw new MailboxError("AgentMail pagination repeated a cursor");
        if (page) pages.add(page);
        if (messages.length > 1000 || pages.size > 10)
          throw new MailboxError(
            "Mailbox exceeds the 1000-message inspection limit; use a dedicated test inbox",
          );
      } while (page);
      if (new Set(messages.map((message) => message.message_id)).size !== messages.length)
        throw new MailboxError("AgentMail returned duplicate message identities");
      return messages;
    },
    async get(messageId, signal) {
      const parsed = messageSchema.safeParse(
        await request(`${root}/${encodeURIComponent(messageId)}`, signal),
      );
      if (!parsed.success)
        throw new MailboxError("Invalid AgentMail message response; check API compatibility");
      if (parsed.data.inbox_id !== config.inboxId || parsed.data.message_id !== messageId)
        throw new MailboxError(
          "AgentMail message identity does not match the requested inbox and message",
        );
      return parsed.data;
    },
  };
}

export interface MailboxWatch {
  startedAt: string;
  excludedIds: string[];
}
const watchSchema = z
  .object({
    startedAt: z.iso.datetime({ offset: true }),
    excludedIds: z.array(z.string().min(1)).max(1000),
  })
  .strict();

/** Establish the cursor BEFORE triggering the application's send action. */
export async function beginMailboxWatch(provider: MailboxProvider): Promise<MailboxWatch> {
  const startedAt = new Date().toISOString();
  return { startedAt, excludedIds: (await provider.list()).map((message) => message.message_id) };
}

function address(value: string): string {
  const match = /<([^<>]+)>\s*$/.exec(value);
  return (match?.[1] ?? value).trim().toLowerCase();
}

export function matchesEmail(
  message: EmailMetadata,
  match: EmailMatch,
  recipient: string,
): boolean {
  return (
    address(message.from) === match.from.toLowerCase() &&
    message.to.some((value) => address(value) === recipient.toLowerCase()) &&
    message.subject === match.subject
  );
}

/** Null means a healthy, completed observation window with no matching message. */
export async function waitForEmail(options: {
  provider: MailboxProvider;
  watch: MailboxWatch;
  match: EmailMatch;
  recipient: string;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
}): Promise<EmailMessage | null> {
  const match = emailMatchSchema.parse(options.match);
  const timeout = options.timeoutSeconds ?? 120;
  const interval = options.pollIntervalMs ?? 1000;
  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > 300 ||
    !Number.isFinite(interval) ||
    interval < 100 ||
    interval > 10000
  )
    throw new MailboxError(
      "Mailbox wait requires timeoutSeconds in (0,300] and pollIntervalMs in [100,10000]",
    );
  if (
    !watchSchema.safeParse(options.watch).success ||
    !z.email().safeParse(options.recipient).success
  )
    throw new MailboxError("Invalid mailbox watch; begin observation before the send action");
  const deadline = Date.now() + timeout * 1000;
  const excluded = new Set(options.watch.excludedIds);
  for (;;) {
    // A request that cannot finish within its own timeout is an execution error,
    // not evidence that an expected email failed to arrive.
    const messages = await options.provider.list();
    const matches = messages.filter(
      (message) =>
        !excluded.has(message.message_id) &&
        // APIs may report whole-second receive timestamps. The ID snapshot and
        // unique action matcher provide the primary correlation boundary.
        Date.parse(message.created_at) >=
          Math.floor(Date.parse(options.watch.startedAt) / 1000) * 1000 &&
        Date.parse(message.created_at) <= deadline &&
        matchesEmail(message, match, options.recipient),
    );
    if (matches.length > 1)
      throw new MailboxError(
        "Multiple new emails match; use a unique subject or a dedicated inbox for this action",
      );
    if (matches[0]) {
      const message = await options.provider.get(matches[0].message_id);
      if (
        message.message_id !== matches[0].message_id ||
        message.inbox_id !== matches[0].inbox_id ||
        !matchesEmail(message, match, options.recipient) ||
        message.created_at !== matches[0].created_at
      )
        throw new MailboxError("Message changed between listing and inspection");
      return message;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
  }
}

function trimUrlPunctuation(value: string): string {
  const brackets = [
    { open: "(", close: ")", balance: 0 },
    { open: "[", close: "]", balance: 0 },
    { open: "{", close: "}", balance: 0 },
  ];
  for (const character of value) {
    for (const bracket of brackets) {
      if (character === bracket.open) bracket.balance++;
      if (character === bracket.close) bracket.balance--;
    }
  }
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1]!;
    if (/[.,;:!?]/.test(last)) {
      end--;
      continue;
    }
    const bracket = brackets.find((pair) => pair.close === last);
    if (!bracket || bracket.balance >= 0) break;
    bracket.balance++;
    end--;
  }
  return value.slice(0, end);
}

const urlDelimiters: Record<string, string> = {
  "<": ">",
  '"': '"',
  "'": "'",
  "“": "”",
  "‘": "’",
};

// Preserve structural text boundaries without executing or rendering email HTML.
const textBoundaryTags = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Parse HTML as inert data: no browser navigation, scripts or remote resources. */
export function emailContent(message: Pick<EmailMessage, "html" | "text">): {
  text: string;
  links: string[];
} {
  const links: string[] = [];
  const parts: string[] = [];
  function visit(node: DefaultTreeAdapterMap["node"]): void {
    if ("tagName" in node && ["script", "style", "template"].includes(node.tagName)) return;
    const boundary = "tagName" in node && textBoundaryTags.has(node.tagName);
    if (boundary) parts.push("\n");
    if ("value" in node) parts.push(node.value);
    if ("tagName" in node && node.tagName === "a") {
      const href = node.attrs.find((attr) => attr.name === "href")?.value;
      if (href) links.push(href);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
    if (boundary) parts.push("\n");
  }
  if (message.html !== undefined) visit(parseFragment(message.html));
  if (message.text !== undefined) {
    parts.push("\n", message.text);
    for (const match of message.text.matchAll(/https?:\/\/[^\s<>"'“”‘’]+/g)) {
      const opening = message.text[match.index - 1];
      const closing = opening === undefined ? undefined : urlDelimiters[opening];
      const explicit =
        closing !== undefined && message.text[match.index + match[0].length] === closing;
      links.push(explicit ? match[0] : trimUrlPunctuation(match[0]));
    }
  }
  if (message.html === undefined && message.text === undefined)
    throw new MailboxError("Email has no inspectable text or HTML body");
  return { text: parts.join(""), links: [...new Set(links)] };
}

/** Retain assertions and receipt metadata, never arbitrary email bodies or credentials. */
export function emailEvidence(message: EmailMessage | null, expectedText: string[] = []) {
  const content = message && expectedText.length ? emailContent(message).text : "";
  return {
    version: 1,
    received: message !== null,
    ...(message
      ? { messageId: message.message_id, receivedAt: message.created_at, labels: message.labels }
      : {}),
    checks: expectedText.map((expected) => ({
      expected,
      present: message !== null && content.includes(expected),
    })),
  };
}

export { type MailboxConfig, type EmailMatch, MailboxError } from "./contracts.js";
