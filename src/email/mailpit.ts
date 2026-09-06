import { requestMailboxJson } from "./http.js";
import { z } from "zod";
import { MailboxError, mailpitOptionsSchema } from "./contracts.js";
import type { EmailMetadata, MailboxProvider } from "./mailbox.js";

const addressSchema = z.object({ Address: z.email() });
const envelopeSchema = z.object({
  ID: z.string().min(1),
  From: addressSchema,
  To: z.array(addressSchema).nullable(),
  Cc: z.array(addressSchema).nullable(),
  Bcc: z.array(addressSchema).nullable(),
  Subject: z.string(),
  Tags: z.array(z.string()).nullable(),
});
const summarySchema = envelopeSchema.extend({ Created: z.iso.datetime({ offset: true }) });
const detailSchema = envelopeSchema.extend({ Text: z.string(), HTML: z.string() });

/** Local capture evidence only. Reading a message marks it read in Mailpit. */
export function createMailpitMailbox(input: z.input<typeof mailpitOptionsSchema>): MailboxProvider {
  const config = mailpitOptionsSchema.parse(input);
  const listed = new Map<string, EmailMetadata>();
  const request = (route: string, signal?: AbortSignal) =>
    requestMailboxJson("Mailpit", new URL(route, config.baseUrl), signal);
  function metadata(message: z.infer<typeof envelopeSchema>, createdAt: string): EmailMetadata {
    return {
      message_id: message.ID,
      inbox_id: config.address,
      from: message.From.Address,
      to: [...(message.To ?? []), ...(message.Cc ?? []), ...(message.Bcc ?? [])].map(
        (entry) => entry.Address,
      ),
      subject: message.Subject,
      created_at: createdAt,
      labels: ["local-capture", ...(message.Tags ?? [])],
    };
  }
  return {
    async list(signal) {
      const all: EmailMetadata[] = [];
      let total: number | undefined;
      for (let start = 0; ; start += 100) {
        const parsed = z
          .object({
            start: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
            messages: z.array(summarySchema).max(100),
          })
          .safeParse(await request(`/api/v1/messages?start=${start}&limit=100`, signal));
        if (!parsed.success) throw new MailboxError("Invalid Mailpit message-list response");
        const page = parsed.data;
        if (page.total > 1000)
          throw new MailboxError(
            "Mailpit exceeds the 1000-message inspection limit; use a dedicated capture instance",
          );
        if (page.start !== start || (total !== undefined && page.total !== total))
          throw new MailboxError(
            "Mailpit changed during pagination; retry collection against a quiet capture instance",
          );
        total = page.total;
        all.push(...page.messages.map((message) => metadata(message, message.Created)));
        if (all.length === total) break;
        if (all.length > total || page.messages.length !== 100)
          throw new MailboxError("Mailpit returned inconsistent pagination");
      }
      if (new Set(all.map((message) => message.message_id)).size !== all.length)
        throw new MailboxError("Mailpit returned duplicate message identities");
      const matching = all.filter((message) =>
        message.to.some((to) => to.toLowerCase() === config.address.toLowerCase()),
      );
      listed.clear();
      for (const message of matching) listed.set(message.message_id, message);
      return matching;
    },
    async get(messageId, signal) {
      const prior = listed.get(messageId);
      if (!prior)
        throw new MailboxError(
          "List the Mailpit recipient before inspecting a message; arbitrary/latest lookup is unsupported",
        );
      const parsed = detailSchema.safeParse(
        await request(`/api/v1/message/${encodeURIComponent(messageId)}`, signal),
      );
      if (!parsed.success) throw new MailboxError("Invalid Mailpit message response");
      // Mailpit detail Date is sender-controlled; retain the list's receive time.
      const current = metadata(parsed.data, prior.created_at);
      if (JSON.stringify(current) !== JSON.stringify(prior))
        throw new MailboxError("Mailpit message identity or envelope changed after listing");
      return { ...current, text: parsed.data.Text, html: parsed.data.HTML };
    },
  };
}
