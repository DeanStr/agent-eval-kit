import type { BrowserInteractionContext } from "./interaction-context.js";
import type { Locator } from "playwright";

type PointerContext = Pick<
  BrowserInteractionContext,
  "drainNotes" | "enforceOrigin" | "page" | "refLocator" | "refMissing" | "snapshot" | "stale"
>;

export class BrowserPointer {
  constructor(private readonly context: PointerContext) {}

  /**
   * When a click fails, name what is on top of the target. Playwright's raw
   * "intercepts pointer events" timeout is 8 wasted seconds plus an error the
   * model usually reads as "this control is broken", when the real answer is
   * "close the cookie banner / toast / drawer first".
   */
  private async describeClickBlocker(loc: Locator): Promise<string | null> {
    return await loc
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        // Off-screen centre: elementFromPoint would report an unrelated
        // element, so say nothing rather than accuse the wrong overlay.
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
        const top = document.elementFromPoint(x, y);
        if (!top || top === el || el.contains(top) || top.contains(el)) return null;
        // Shadow DOM retargets: for a control inside an open shadow root,
        // document.elementFromPoint reports the HOST, which is an ancestor in
        // the flattened tree, not an overlay. Walk the host chain before
        // accusing it of covering anything.
        let node: Node | null = el;
        for (let hop = 0; hop < 10 && node; hop++) {
          const root = node.getRootNode() as ShadowRoot;
          const host = root && root.host ? (root.host as HTMLElement) : null;
          if (!host) break;
          if (host === top || host.contains(top) || top.contains(host)) return null;
          node = host;
        }
        const id = top.id ? `#${top.id}` : "";
        const cn = typeof top.className === "string" ? top.className.trim() : "";
        const cls = cn ? "." + cn.split(/\s+/).slice(0, 2).join(".") : "";
        const txt = (top.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        return `<${top.tagName.toLowerCase()}${id}${cls}>${txt ? ` "${txt}"` : ""}`;
      })
      .catch(() => null);
  }

  async click(ref: string): Promise<string> {
    const loc = await this.context.refLocator(ref);
    if (await this.context.refMissing(loc)) return this.context.stale(ref);
    await loc.scrollIntoViewIfNeeded().catch(() => {});

    // Pre-check: if something is already on top, Playwright would retry for a
    // full 8s and then report an error the model reads as "control broken".
    // Re-check once, so a spinner that is about to clear is not misreported.
    let blocker = await this.describeClickBlocker(loc);
    if (blocker) {
      await this.context.page.waitForTimeout(700);
      blocker = await this.describeClickBlocker(loc);
    }
    if (!blocker) {
      try {
        await loc.click({ timeout: 8_000 });
      } catch (err) {
        blocker = await this.describeClickBlocker(loc);
        if (!blocker) {
          const message =
            err !== null &&
            (typeof err === "object" || typeof err === "function") &&
            "message" in err
              ? (err.message ?? err)
              : err;
          return `ERROR: click on ${ref} failed: ${String(message).split("\n", 1).join("").slice(0, 200)}`;
        }
      }
    }
    if (blocker) {
      return `ERROR: ${ref} could not be clicked because ${blocker} is covering it — an overlay, modal, cookie banner, toast or loading veil is in the way. Close or dismiss that layer first (press Escape, or click its close/accept control), then take a fresh snapshot and retry. The control itself is not necessarily broken.`;
    }
    await this.context.page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    return this.context.snapshot();
  }

  /**
   * Drag one element onto another. Agenda/schedule builders are commonly
   * drag-and-drop, so this is load-bearing for those scenarios. Tries
   * Playwright's dragTo first, then a manual mouse sequence (which some
   * HTML5-DnD and pointer-event implementations require).
   */
  async drag(fromRef: string, toRef: string): Promise<string> {
    const from = await this.context.refLocator(fromRef);
    const to = await this.context.refLocator(toRef);
    if (await this.context.refMissing(from))
      return `ERROR: source ref ${fromRef} not found. Take a new snapshot.`;
    if (await this.context.refMissing(to))
      return `ERROR: target ref ${toRef} not found. Take a new snapshot.`;

    await from.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await from.dragTo(to, { timeout: 8_000 });
    } catch {
      // Manual fallback: some grids only respond to real pointer movement.
      const a = await from.boundingBox();
      const b = await to.boundingBox();
      if (!a || !b) return `ERROR: could not compute drag geometry for ${fromRef} -> ${toRef}.`;
      await this.context.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await this.context.page.mouse.down();
      // Intermediate moves: many DnD libraries ignore a single jump.
      for (let i = 1; i <= 5; i++) {
        await this.context.page.mouse.move(
          a.x + a.width / 2 + ((b.x - a.x) * i) / 5,
          a.y + a.height / 2 + ((b.y - a.y) * i) / 5,
          { steps: 4 },
        );
      }
      await this.context.page.mouse.up();
    }
    await this.context.page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    return this.context.snapshot();
  }

  async press(key: string): Promise<string> {
    // A preceding action may have redirected without taking a snapshot. Do
    // not dispatch even one keyboard event until the page is contained.
    const before = await this.context.enforceOrigin();
    if (before) return before;
    await this.context.page.keyboard.press(key);
    await this.context.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const after = await this.context.enforceOrigin();
    return this.context.drainNotes() + (after ? after + "\n" : "") + `Pressed ${key}`;
  }

  /**
   * Scroll the page, or a specific scroll container when `ref` is given.
   *
   * Long session/speaker/submission lists routinely live in their own
   * overflow:auto box (or are virtualised), and the window scrollbar does not
   * move them at all — so the agent scrolls, sees the same 12 rows, and
   * concludes the app only has 12 sessions. `mouse.wheel` also used to fire at
   * the default cursor position (0,0), which is whatever sits in the top-left
   * corner rather than the content.
   */
  async scroll(direction: "up" | "down", ref?: string): Promise<string> {
    const dy = direction === "down" ? 600 : -600;

    if (ref) {
      const loc = await this.context.refLocator(ref);
      if (await this.context.refMissing(loc)) return this.context.stale(ref);
      const res = await loc.evaluate((el, d) => {
        let node: HTMLElement | null = el as HTMLElement;
        let hops = 0;
        while (node && hops < 20) {
          const st = window.getComputedStyle(node);
          const scrollable =
            (st.overflowY === "auto" || st.overflowY === "scroll") &&
            node.scrollHeight - node.clientHeight > 4;
          if (scrollable) {
            const before = node.scrollTop;
            node.scrollTop = before + d;
            return {
              found: true,
              moved: node.scrollTop !== before,
              at: node.scrollTop,
              max: node.scrollHeight - node.clientHeight,
            };
          }
          node = node.parentElement;
          hops += 1;
        }
        return { found: false, moved: false, at: 0, max: 0 };
      }, dy);
      await this.context.page.waitForTimeout(400); // let lazy loaders fire
      if (!res.found) {
        return (
          this.context.drainNotes() +
          `${ref} is not inside a scrollable container, so nothing was scrolled. Use scroll without a ref to scroll the page.`
        );
      }
      return (
        this.context.drainNotes() +
        `Scrolled the container holding ${ref} ${direction} (now at ${res.at} of ${res.max}px${res.moved ? "" : "; it was already at the end"}). Take a snapshot to see newly loaded rows.`
      );
    }

    const before = await this.context.page.evaluate(() => window.scrollY);
    const vp = this.context.page.viewportSize() ?? { width: 1280, height: 800 };
    // Put the cursor over the content before wheeling, or the wheel lands on
    // whatever occupies the top-left corner.
    await this.context.page.mouse.move(vp.width / 2, vp.height / 2);
    await this.context.page.mouse.wheel(0, dy);
    await this.context.page.waitForTimeout(400);
    const after = await this.context.page.evaluate(() => window.scrollY);
    if (after !== before) {
      return (
        this.context.drainNotes() +
        `Scrolled ${direction} (page is now at y=${Math.round(after)}). Take a snapshot or screenshot to see the result.`
      );
    }

    // The window did not move: the real scrollbar probably belongs to an inner
    // pane (app shells with a fixed chrome do this). Drive the biggest one.
    const inner = await this.context.page.evaluate((d) => {
      const els = document.querySelectorAll<HTMLElement>("*");
      let best: HTMLElement | null = null;
      let bestArea = 0;
      let examined = 0;
      for (const el of els) {
        if (examined++ >= 20000) break;
        if (el.scrollHeight - el.clientHeight <= 24) continue;
        const st = window.getComputedStyle(el);
        if (st.overflowY !== "auto" && st.overflowY !== "scroll") continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
      if (!best) return null;
      const from = best.scrollTop;
      best.scrollTop = from + d;
      const name = best.id ? `#${best.id}` : best.tagName.toLowerCase();
      return { name, moved: best.scrollTop !== from, at: best.scrollTop };
    }, dy);
    await this.context.page.waitForTimeout(400);
    if (inner?.moved) {
      return (
        this.context.drainNotes() +
        `The page itself does not scroll; scrolled its main inner container <${inner.name}> ${direction} instead (now at ${Math.round(inner.at)}px). Take a snapshot to see the result.`
      );
    }
    return (
      this.context.drainNotes() +
      `Scrolled ${direction} but nothing moved — the page is already at the ${direction === "down" ? "bottom" : "top"}. If a list looks short, it may live in its own scroll box: snapshot and call scroll with the ref marked "scrollable".`
    );
  }
}
