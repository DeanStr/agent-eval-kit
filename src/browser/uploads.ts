import type { BrowserInteractionContext } from "./interaction-context.js";
import path from "node:path";
import { errors } from "playwright";

type UploadContext = Pick<
  BrowserInteractionContext,
  | "allowedFrames"
  | "drainNotes"
  | "enforceOrigin"
  | "isAllowedFrame"
  | "page"
  | "refFrames"
  | "refLocator"
  | "refMissing"
  | "stale"
>;

/** Set a file input's files (for headshot/slides/CSV upload flows). */
export async function upload(
  context: UploadContext,
  ref: string,
  absoluteFilePath: string,
): Promise<string> {
  const loc = await context.refLocator(ref);
  if (await context.refMissing(loc)) return context.stale(ref);
  const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
  if (tag === "input") {
    await loc.setInputFiles(absoluteFilePath);
    return context.drainNotes() + `Uploaded ${path.basename(absoluteFilePath)} to ${ref}`;
  }
  // Fingerprint the file inputs that exist BEFORE the click, in every
  // configured-origin frame.
  // "Upload Files" often opens a NESTED third-party picker (Filestack et al)
  // that mounts its own `input[type=file]` — 0x0, opacity:0, multiple — and
  // never fires a native chooser event. Without this mark we cannot tell that
  // input from an unrelated one already sitting on the page, and picking the
  // wrong one is worse than failing.
  for (const f of await context.allowedFrames()) {
    await f.evaluate(() => {
      const els = document.querySelectorAll('input[type="file"]');
      for (let k = 0; k < els.length; k++) els[k].setAttribute("data-aek-file-before", "1");
    });
  }

  // Only absence of a chooser after a successful click permits another path.
  // Keep the wait's timeout separate from click, origin, and upload failures.
  const [fc] = await Promise.all([
    context.page.waitForEvent("filechooser", { timeout: 8_000 }).catch((error) => {
      if (error instanceof errors.TimeoutError) return null;
      throw error;
    }),
    loc.click({ timeout: 8_000 }),
  ]);
  const originBlock = await context.enforceOrigin();
  if (originBlock) return originBlock;
  if (fc) {
    await fc.setFiles(absoluteFilePath);
    return (
      context.drainNotes() +
      `Uploaded ${path.basename(absoluteFilePath)} via file chooser triggered by ${ref}`
    );
  }

  // No chooser fired. Re-scan every frame for a file input that appeared (or
  // became present) since the click, however invisible — this is what a
  // nested Filestack/Uppy/Dropzone modal leaves behind. Reporting "did not
  // open a file chooser and it is not a file input" here would be a false
  // negative on the entire content-management area.
  await context.page.waitForTimeout(600);
  const delayedOriginBlock = await context.enforceOrigin();
  if (delayedOriginBlock) return delayedOriginBlock;
  for (const f of await context.allowedFrames()) {
    const fresh = f.locator('input[type="file"]:not([data-aek-file-before])').first();
    if ((await fresh.count()) === 0) continue;
    await fresh.setInputFiles(absoluteFilePath);
    return (
      context.drainNotes() +
      `Uploaded ${path.basename(absoluteFilePath)} via a file input that appeared after clicking ${ref} (a nested upload picker opened and mounted a hidden input instead of firing a file chooser). Snapshot to confirm the app registered the file.`
    );
  }

  // Drop zones (react-dropzone and hand-rolled ones) keep a display:none
  // <input type=file> inside the zone, which the snapshot skips because it
  // is invisible. Setting files on it directly is what a real drop does.
  const scope = context.refFrames.get(ref) ?? context.page.mainFrame();
  if (!(await context.isAllowedFrame(scope))) {
    return "BLOCKED: the upload control's frame navigated outside the configured origins.";
  }
  const hidden = loc.locator('input[type="file"]').first();
  if ((await hidden.count()) > 0) {
    await hidden.setInputFiles(absoluteFilePath);
    return (
      context.drainNotes() +
      `Uploaded ${path.basename(absoluteFilePath)} via the hidden file input behind ${ref} (drop zone). Snapshot to confirm the app registered the file.`
    );
  }
  return `ERROR: ${ref} is not a file input, clicking it opened no file chooser, no file input appeared afterwards in any frame, and no hidden file input was found near it. This may be a drag-and-drop-only zone with no file input at all.`;
}
