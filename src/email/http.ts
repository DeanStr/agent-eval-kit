import { MailboxError } from "./contracts.js";

export async function requestMailboxJson(
  provider: "AgentMail" | "Mailpit",
  url: string | URL,
  signal?: AbortSignal,
  headers?: HeadersInit,
): Promise<unknown> {
  try {
    const response = await fetch(url, {
      ...(headers === undefined ? {} : { headers }),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MailboxError(
        `${provider} request failed (HTTP ${response.status}); check mailbox access, service status and rate limits`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new MailboxError(`${provider} returned an empty response`);
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new MailboxError(`${provider} response exceeds the 2 MiB inspection limit`);
      }
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof MailboxError) throw error;
    // Fetch, JSON and schema diagnostics can contain headers, bodies or URLs.
    throw new MailboxError(
      `${provider} transport or response failed; check connectivity, timeout and API compatibility`,
    );
  }
}
