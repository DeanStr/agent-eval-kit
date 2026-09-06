import fs from "node:fs";
import path from "node:path";
import { createMailbox, waitForEmail, emailEvidence } from "agent-eval-kit/email";
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const mailbox = JSON.parse(fs.readFileSync(context.sources.mailbox.path, "utf8"));
const expected = JSON.parse(fs.readFileSync(context.sources.expected.path, "utf8"));
const watch = JSON.parse(fs.readFileSync(context.inputs.watch.path, "utf8"));
const message = await waitForEmail({
  provider: createMailbox(mailbox),
  watch,
  match: { from: expected.from, subject: context.inputs.subject.value },
  recipient: context.inputs.recipient.value,
  timeoutSeconds: 60,
});
const receipt = emailEvidence(message, expected.bodyIncludes);
fs.writeFileSync(path.join(context.outputDir, "receipt.json"), JSON.stringify(receipt));
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary: message
      ? "Inspected the matching email"
      : "Completed the observation window without a matching email",
    observations: [],
    files: [
      {
        label: "receipt",
        path: "receipt.json",
        filename: "receipt.json",
        mediaType: "application/json",
      },
    ],
  }),
);
