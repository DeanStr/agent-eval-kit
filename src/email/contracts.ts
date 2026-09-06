import { z } from "zod";

const agentMailSchema = z
  .object({
    provider: z.literal("agentmail"),
    inboxId: z.string().min(1),
    address: z.email(),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    // Override only for a trusted gateway or a loopback integration fixture.
    baseUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
        );
      }, "use HTTPS or a loopback HTTP endpoint without credentials, query or fragment")
      .default("https://api.agentmail.to/v0"),
  })
  .strict();
export const mailpitOptionsSchema = z
  .object({
    baseUrl: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, "Mailpit capture requires a loopback HTTP origin without credentials or a path"),
    address: z.email(),
  })
  .strict();
export const mailboxSchema = z.discriminatedUnion("provider", [
  agentMailSchema,
  mailpitOptionsSchema.extend({ provider: z.literal("mailpit") }),
]);
export type MailboxConfig = z.infer<typeof mailboxSchema>;

export const emailMatchSchema = z
  .object({
    from: z.email(),
    subject: z.string().min(1),
  })
  .strict();
export type EmailMatch = z.infer<typeof emailMatchSchema>;

export const emailAuthSchema = z
  .object({
    mailbox: z.string().min(1),
    startPath: z.string().regex(/^\/(?!\/)/, "use a target-relative path starting with one slash"),
    emailSelector: z.string().min(1),
    requestSelector: z.string().min(1),
    message: emailMatchSchema,
    credential: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("link"),
          path: z.string().regex(/^\/(?!\/)/),
          parameter: z.string().min(1),
        })
        .strict(),
      z
        .object({
          type: z.literal("code"),
          length: z.number().int().min(4).max(12).default(6),
          selector: z.string().min(1),
          submitSelector: z.string().min(1),
        })
        .strict(),
    ]),
    success: z.object({ selector: z.string().min(1), text: z.string().min(1) }).strict(),
    timeoutSeconds: z.number().positive().max(300).default(120),
    pollIntervalMs: z.number().int().min(100).max(10000).default(1000),
  })
  .strict();
export type EmailAuthFlow = z.infer<typeof emailAuthSchema>;

/** Private handoff payload; never retain this in collected browser evidence. */
export const emailAuthenticationSchema = z
  .object({ key: z.string().min(1).optional(), flow: emailAuthSchema, mailbox: mailboxSchema })
  .strict()
  .superRefine((value, context) => {
    if (value.mailbox.provider === "agentmail" && !value.key)
      context.addIssue({
        code: "custom",
        message: "AgentMail authentication requires a private API key",
      });
    if (value.mailbox.provider === "mailpit" && value.key !== undefined)
      context.addIssue({
        code: "custom",
        message: "Local Mailpit authentication does not accept an API key",
      });
  });
export type EmailAuthentication = z.infer<typeof emailAuthenticationSchema>;

export class MailboxError extends Error {
  override readonly name = "MailboxError";
}
