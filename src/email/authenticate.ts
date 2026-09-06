import type { BrowserSession } from "../browser/session.js";
import { errors } from "playwright";
import { AuthenticationEvidenceError } from "../browser/interaction-context.js";
import {
  emailAuthSchema,
  MailboxError,
  type EmailAuthFlow,
  type MailboxConfig,
} from "./contracts.js";
import {
  beginMailboxWatch,
  createMailbox,
  emailContent,
  waitForEmail,
  type MailboxProvider,
} from "./mailbox.js";

export class EmailAuthenticationBlocked extends Error {
  override readonly name = "EmailAuthenticationBlocked";
}

/** One atomic browser operation. Credentials never cross the model/tool boundary. */
export async function authenticateEmail(options: {
  browser: BrowserSession;
  targetUrl: string;
  flow: EmailAuthFlow;
  mailbox: MailboxConfig;
  provider?: MailboxProvider;
}): Promise<{
  messageId: string;
  receivedAt: string;
  method: "link" | "code";
  identityVerified: true;
}> {
  const flow = emailAuthSchema.parse(options.flow);
  const provider = options.provider ?? createMailbox(options.mailbox);
  const browser = options.browser;
  const origin = new URL(options.targetUrl).origin;
  const start = new URL(flow.startPath, origin);
  if (start.origin !== origin)
    throw new MailboxError("Email login start path must remain on the target origin");
  browser.beginPrivateAuthentication();
  let stage = "requesting the login email";
  try {
    await browser.page.goto(start.toString(), { waitUntil: "domcontentloaded" });
    if (await browser.preflightOrigin())
      throw new EmailAuthenticationBlocked("Email login left the allowed application origins");
    await browser.page.locator(flow.emailSelector).fill(options.mailbox.address);
    const watch = await beginMailboxWatch(provider);
    await browser.page.locator(flow.requestSelector).click();
    if (await browser.postflightOrigin())
      throw new EmailAuthenticationBlocked("Email request left the allowed application origins");
    stage = "waiting for the login email";
    const message = await waitForEmail({
      provider,
      watch,
      match: flow.message,
      recipient: options.mailbox.address,
      timeoutSeconds: flow.timeoutSeconds,
      pollIntervalMs: flow.pollIntervalMs,
    });
    if (!message)
      throw new EmailAuthenticationBlocked(
        "No matching login email arrived within the configured observation window",
      );
    const content = emailContent(message);
    stage = "consuming the emailed credential";
    if (flow.credential.type === "link") {
      const credential = flow.credential;
      const links = content.links.flatMap((link) => {
        let url: URL;
        try {
          url = new URL(link);
        } catch {
          return [];
        }
        return url.origin === origin &&
          url.pathname === credential.path &&
          !url.username &&
          !url.password &&
          url.searchParams.getAll(credential.parameter).length === 1 &&
          url.searchParams.get(credential.parameter)
          ? [url]
          : [];
      });
      const unique = [...new Map(links.map((link) => [link.toString(), link])).values()];
      if (unique.length !== 1)
        throw new MailboxError(
          "Expected exactly one login link matching the declared target origin, path and parameter",
        );
      const link = unique[0]!;
      browser.protectAuthenticationSecret(link.toString());
      browser.protectAuthenticationSecret(link.searchParams.get(credential.parameter)!);
      if (link.hash) browser.protectAuthenticationSecret(link.hash.slice(1));
      await browser.page.goto(link.toString(), { waitUntil: "domcontentloaded" });
    } else {
      const matches = [
        ...new Set(
          content.text.match(
            new RegExp(`(?<![A-Za-z0-9])\\d{${flow.credential.length}}(?![A-Za-z0-9])`, "g"),
          ) ?? [],
        ),
      ];
      if (matches.length !== 1)
        throw new MailboxError(
          "Expected exactly one distinct verification code of the declared length",
        );
      const code = matches[0]!;
      browser.protectAuthenticationSecret(code);
      if (await browser.preflightOrigin())
        throw new EmailAuthenticationBlocked(
          "Verification form left the allowed application origins",
        );
      await browser.page.locator(flow.credential.selector).fill(code);
      await browser.page.locator(flow.credential.submitSelector).click();
    }
    stage = "verifying the authenticated identity";
    if (await browser.postflightOrigin())
      throw new EmailAuthenticationBlocked(
        "Email verification left the allowed application origins",
      );
    await browser.waitForAuthenticationIdentity(flow.success.selector, flow.success.text);
    await browser.finishPrivateAuthentication();
    return {
      messageId: message.message_id,
      receivedAt: message.created_at,
      method: flow.credential.type,
      identityVerified: true,
    };
  } catch (error) {
    // The session stays private after any failure: no terminal screenshots or
    // snapshots may accidentally capture a code, link, or an error echoing it.
    if (error instanceof MailboxError || error instanceof EmailAuthenticationBlocked) throw error;
    if (error instanceof AuthenticationEvidenceError)
      throw new EmailAuthenticationBlocked(error.message);
    if (error instanceof errors.TimeoutError)
      throw new EmailAuthenticationBlocked(
        `Email authentication could not finish while ${stage}; check the application and configured selectors`,
      );
    throw new MailboxError(
      `Email authentication execution failed while ${stage}; check browser health and selector syntax`,
    );
  }
}
