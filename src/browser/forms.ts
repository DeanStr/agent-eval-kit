import type { BrowserInteractionContext } from "./interaction-context.js";
import type { Frame, Locator } from "playwright";
import { normalizeTemporal, TEMPORAL_FORMATS } from "./temporal.js";
import { OriginBoundaryError } from "./interaction-context.js";

type FormsContext = Pick<
  BrowserInteractionContext,
  | "actionTimeoutMs"
  | "click"
  | "drainNotes"
  | "enforceOrigin"
  | "frameEditors"
  | "isAllowedFrame"
  | "page"
  | "postflightOrigin"
  | "refFrames"
  | "refLocator"
  | "refMissing"
  | "stale"
>;

export class BrowserForms {
  constructor(private readonly context: FormsContext) {}

  /**
   * Type into a field. Handles plain inputs, contenteditable, and rich-text
   * editors (TinyMCE/Quill/ProseMirror/Slate) — abstract and description
   * fields are rich text in nearly every product in this category, and a
   * naive fill() reports them as unfillable, which reads as a missing feature.
   */
  async fill(ref: string, text: string): Promise<string> {
    // A rich-text editor living in its own iframe, surfaced by snapshot().
    const frame = this.context.frameEditors.get(ref);
    if (frame) {
      if (!(await this.context.isAllowedFrame(frame))) {
        return `ERROR: editor ref ${ref} navigated outside the configured origins. Take a new snapshot.`;
      }
      const body = frame.locator("body");
      await body.click();
      const originBlock = await this.context.enforceOrigin();
      if (originBlock) return originBlock;
      await this.context.page.keyboard.press("ControlOrMeta+a");
      await this.context.page.keyboard.press("Delete");
      await body.pressSequentially(text, { delay: 5 });
      return (
        this.context.drainNotes() + `Filled rich-text editor ${ref} with: ${text.slice(0, 120)}`
      );
    }

    const loc = await this.context.refLocator(ref);
    if (await this.context.refMissing(loc)) return this.context.stale(ref);

    const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
    // A dropdown addressed with fill instead of select: do the right thing
    // rather than erroring — models mix these two up constantly.
    if (tag === "select") return this.select(ref, text);

    if (tag === "input" || tag === "textarea") {
      const meta = await loc.evaluate((el) => ({
        type: (el.getAttribute("type") ?? "").toLowerCase(),
        readOnly:
          (el as HTMLInputElement).readOnly === true || el.getAttribute("aria-readonly") === "true",
        disabled:
          (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true",
      }));

      if (meta.disabled) {
        return `ERROR: ${ref} is disabled, so it cannot be filled. Something earlier in the form probably has to be set first (or the field is genuinely not editable in this state).`;
      }

      // Read-only text fields in this product category are nearly always date
      // pickers that must be operated by clicking. Typing at them times out
      // after 10s and reads as "the app has no deadline field".
      if (meta.readOnly) {
        const clicked = await this.context.click(ref);
        if (/^(ERROR|BLOCKED):/.test(clicked)) return clicked;
        return (
          `NOTE: ${ref} is read-only, so text cannot be typed into it — it was clicked instead, which normally opens a picker. ` +
          `Choose "${text.slice(0, 60)}" from the elements listed below; if no picker appeared, the field may be filled by a nearby control instead.\n\n${clicked}`
        );
      }

      if (TEMPORAL_FORMATS[meta.type]) {
        const norm = normalizeTemporal(meta.type, text);
        if (!norm) {
          return `ERROR: ${ref} is <input type=${meta.type}> and "${text}" could not be parsed as a ${meta.type}. Supply it as ${TEMPORAL_FORMATS[meta.type]}.`;
        }
        await loc.fill(norm);
        return (
          this.context.drainNotes() +
          `Filled ${ref} with: ${norm}` +
          (norm === text.trim() ? "" : ` (normalized from "${text}" for this ${meta.type} field)`)
        );
      }

      await loc.fill(text);
      return this.context.drainNotes() + `Filled ${ref} with: ${text.slice(0, 120)}`;
    }

    const typeInto = async (target: Locator) => {
      await target.click();
      const originBlock = await this.context.enforceOrigin();
      if (originBlock) throw new OriginBoundaryError(originBlock);
      await this.context.page.keyboard.press("ControlOrMeta+a");
      await this.context.page.keyboard.press("Delete");
      await target.pressSequentially(text, { delay: 5 });
    };

    if ((await loc.getAttribute("contenteditable")) === "true") {
      await typeInto(loc);
      return this.context.drainNotes() + `Filled ${ref} with: ${text.slice(0, 120)}`;
    }

    // Inline rich-text editors nest the editable surface below the labelled
    // wrapper the snapshot pointed at (Quill .ql-editor, ProseMirror, Slate).
    const nested = loc.locator('[contenteditable="true"]').first();
    if ((await nested.count()) > 0) {
      await typeInto(nested);
      return (
        this.context.drainNotes() +
        `Filled nested rich-text area under ${ref} with: ${text.slice(0, 120)}`
      );
    }

    // Classic TinyMCE: the editable body lives inside an iframe under the wrapper.
    const innerFrame = loc.locator("iframe").first();
    if ((await innerFrame.count()) > 0) {
      const handle = await innerFrame.elementHandle();
      const child = await handle?.contentFrame();
      if (!child || !(await this.context.isAllowedFrame(child))) {
        return `ERROR: editor iframe under ${ref} is outside the configured origins or its origin could not be verified.`;
      }
      const body = child.locator("body");
      await body.click();
      const originBlock = await this.context.enforceOrigin();
      if (originBlock) return originBlock;
      await this.context.page.keyboard.press("ControlOrMeta+a");
      await this.context.page.keyboard.press("Delete");
      await body.pressSequentially(text, { delay: 5 });
      return (
        this.context.drainNotes() + `Filled editor iframe under ${ref} with: ${text.slice(0, 120)}`
      );
    }

    return `ERROR: ${ref} is not an editable field. For a click-to-edit control, explicitly click it, take a fresh snapshot, then fill the revealed input.`;
  }

  /**
   * Choose a value in a dropdown. Native <select> goes through selectOption;
   * anything else is treated as a custom combobox/listbox (react-select,
   * headlessui, radix, MUI, Downshift), which is what modern apps actually
   * ship for tracks, rooms, statuses and timezones. Those are plain <div>s, so
   * selectOption throws "Element is not a <select> element" and the whole
   * field reads as unsupported.
   */
  async select(ref: string, value: string): Promise<string> {
    const loc = await this.context.refLocator(ref);
    if (await this.context.refMissing(loc)) return this.context.stale(ref);
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase());

    if (tag === "select") {
      try {
        await loc.selectOption({ label: value });
      } catch {
        try {
          await loc.selectOption(value);
        } catch {
          const opts = await loc.evaluate((el) =>
            Array.from((el as HTMLSelectElement).options)
              .slice(0, 40)
              .map((o) => (o.label || o.text || o.value).trim()),
          );
          return `ERROR: no option matching "${value}" in ${ref}. Available options: ${opts.join(" | ") || "(none)"}`;
        }
      }
      return this.context.drainNotes() + `Selected "${value}" in ${ref}`;
    }

    return this.selectCustom(ref, loc, value);
  }

  /** Open a custom dropdown, then click the option whose text matches. */
  private async selectCustom(ref: string, loc: Locator, value: string): Promise<string> {
    const scope = this.context.refFrames.get(ref) ?? this.context.page.mainFrame();
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await loc.click({ timeout: Math.min(this.context.actionTimeoutMs, 8_000) });
    } catch (error) {
      return `ERROR: ${ref} could not be opened as a custom dropdown: ${String(
        error instanceof Error ? error.message : error,
      )
        .split("\n")[0]
        .slice(0, 200)}`;
    }
    const originBlock = await this.context.enforceOrigin();
    if (originBlock) return originBlock;
    await this.context.page.waitForTimeout(300);

    let picked = await this.clickOptionByText(scope, value);
    if (picked.originBlock) return picked.originBlock;
    if (!picked.ok && !picked.clickError) {
      // Typeahead combobox (react-select, Downshift): the options only render
      // once the query narrows them.
      const typed = await this.typeIntoCombobox(loc, value);
      // Filling or typing can itself navigate. Contain that navigation before
      // waiting for, inspecting, or clicking anything on the destination.
      const typedOriginBlock = await this.context.postflightOrigin();
      if (typedOriginBlock) return typedOriginBlock;
      if (typed) {
        await this.context.page.waitForTimeout(400);
        const delayedOriginBlock = await this.context.enforceOrigin();
        if (delayedOriginBlock) return delayedOriginBlock;
        picked = await this.clickOptionByText(scope, value);
        if (picked.originBlock) return picked.originBlock;
      }
    }
    if (!picked.ok) {
      if (picked.clickError) {
        return `ERROR: ${ref} contains a matching option "${picked.matched}", but it could not be selected: ${picked.clickError}`;
      }
      return (
        `ERROR: ${ref} is not a native <select>, and after opening it no option matching "${value}" appeared. ` +
        (picked.options.length
          ? `Options currently visible: ${picked.options.slice(0, 20).join(" | ")}. Pick one of those, or click the option's own ref from a fresh snapshot.`
          : `No option list appeared at all — this control may not be a dropdown, or its options may load asynchronously (wait, snapshot, then click the option directly).`)
      );
    }

    await this.context.page.waitForTimeout(250);
    const now = await loc.evaluate((el) =>
      ((el as HTMLInputElement).value || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80),
    );
    return (
      this.context.drainNotes() +
      `Selected "${picked.matched}" in ${ref} (custom dropdown: opened it and clicked the matching option).` +
      (now ? ` The control now reads "${now}".` : "") +
      ` Refs have shifted — take a snapshot before the next action.`
    );
  }

  /**
   * Find a visible option whose text matches and click it. Options are
   * routinely portalled to the end of <body>, far from the trigger, so the
   * search is frame-wide (and shadow-piercing).
   */
  private async clickOptionByText(
    scope: Frame,
    value: string,
  ): Promise<{
    ok: boolean;
    matched: string;
    options: string[];
    clickError?: string;
    originBlock?: string;
  }> {
    let found: {
      ok: boolean;
      disabled: boolean;
      matched: string;
      options: string[];
      clickError?: string;
      originBlock?: string;
    } = await scope.evaluate((wanted: string) => {
      const norm = String(wanted).replace(/\s+/g, " ").trim().toLowerCase();
      const roots: (Document | ShadowRoot)[] = [document];
      const all: HTMLElement[] = [];
      let ri = 0;
      while (ri < roots.length && all.length < 20000) {
        const list = roots[ri].querySelectorAll<HTMLElement>("*");
        ri += 1;
        for (let k = 0; k < list.length; k++) {
          const el = list[k];
          all.push(el);
          if (el.shadowRoot) roots.push(el.shadowRoot);
          if (all.length >= 20000) break;
        }
      }
      const optSel =
        '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"],li,[data-value],[class*="option"],[class*="item"]';
      const texts: string[] = [];
      let exact: HTMLElement | null = null;
      let loose: HTMLElement | null = null;
      for (let k = 0; k < all.length; k++) {
        const el = all[k];
        if (!el.matches(optSel)) continue;
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        // Prefer leaf options over the menu wrapper that contains them.
        if (el.querySelector(optSel)) continue;
        // Prefer the accessible name: in a day-picker grid the leading and
        // trailing grey days DUPLICATE the visible text ("31" appears in
        // both July and August), and only aria-label ("August 31st, 2026")
        // tells them apart.
        const t = (el.getAttribute("aria-label") || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!t || t.length > 120) continue;
        if (texts.length < 25) texts.push(t);
        const lt = t.toLowerCase();
        if (!exact && lt === norm) exact = el;
        if (!loose && lt.indexOf(norm) >= 0) loose = el;
      }
      const target: HTMLElement | null = exact || loose;
      if (target) target.setAttribute("data-aek-opt", "1");
      return {
        ok: !!target,
        disabled: Boolean(
          target &&
            (target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true"),
        ),
        matched: target
          ? (target.getAttribute("aria-label") || target.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80)
          : "",
        options: texts,
      };
    }, value);

    if (found.ok) {
      const opt = scope.locator('[data-aek-opt="1"]').first();
      if (found.disabled) {
        found = { ...found, ok: false, clickError: "the matching option is disabled" };
      } else {
        try {
          await opt.click({ timeout: 5_000 });
          const originBlock = await this.context.enforceOrigin();
          if (originBlock) found = { ...found, ok: false, originBlock };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          found = {
            ...found,
            ok: false,
            clickError: message.split("\n")[0].slice(0, 200) || "the click failed",
          };
        }
      }
      await scope
        .locator('[data-aek-opt="1"]')
        .evaluateAll((els) =>
          els.forEach((e) => {
            e.removeAttribute("data-aek-opt");
          }),
        )
        .catch(() => {});
    }
    const { disabled: _disabled, ...result } = found;
    return result;
  }

  /** react-select and friends keep a real <input> inside the control. */
  private async typeIntoCombobox(loc: Locator, value: string): Promise<boolean> {
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
    let target: Locator | null = null;
    if (tag === "input") {
      target = loc;
    } else {
      const inner = loc.locator("input:not([type=hidden])").first();
      if ((await inner.count()) > 0) target = inner;
    }
    if (!target) return false;
    // One atomic input operation prevents a navigation triggered by an
    // early character from transferring the remaining keystrokes to an
    // autofocus control on the destination page.
    await target.fill(value);
    return true;
  }
}
