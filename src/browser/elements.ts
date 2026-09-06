import type { Frame } from "playwright";

export type RawEl = { ref: string; tag: string; type: string; label: string; flags: string[] };

export async function collectFrame(
  frame: Frame,
  base: number,
  detectModal: boolean,
  timeoutMs = 15_000,
): Promise<{ out: RawEl[]; last: number; modalLabel: string | null; hidden: number }> {
  const work = frame.evaluate(
    (args: { baseCount: number; detectModal: boolean }) => {
      const baseCount = args.baseCount;
      // NB: no named helper functions (or named const-arrows) in here — the
      // bundler's keepNames shim (__name) does not exist in the page context
      // and would throw. Everything below is written as inline loops.

      // Pass 0: walk the whole element tree INCLUDING open shadow roots.
      // querySelectorAll stops at a shadow boundary, so a design system built
      // on web components reads as a blank page: the aria outline still shows
      // "button Approve speaker" (the a11y tree does pierce shadow DOM) while
      // no ref exists for it, i.e. the agent can see the feature and not touch
      // it. Bound total elements EXAMINED so a 20k-row table can't stall us.
      const roots: (Document | ShadowRoot)[] = [document];
      const allEls: HTMLElement[] = [];
      let ri = 0;
      while (ri < roots.length && allEls.length < 20000) {
        const list = roots[ri].querySelectorAll<HTMLElement>("*");
        ri += 1;
        for (let k = 0; k < list.length; k++) {
          const el = list[k];
          allEls.push(el);
          if (el.shadowRoot) roots.push(el.shadowRoot);
          if (allEls.length >= 20000) break;
        }
      }
      // Clear markers from prior snapshots. In an SPA, elements that survive
      // navigation (sidebars, headers) keep their old attribute, so a stale
      // ref would silently resolve to the WRONG element — e.g. clicking "Sign
      // out" while intending something else. After clearing, a stale ref
      // resolves to nothing and the tool returns a take-a-new-snapshot error.
      for (let k = 0; k < allEls.length; k++) {
        const el = allEls[k];
        if (el.hasAttribute("data-aek-ref")) el.removeAttribute("data-aek-ref");
        if (el.hasAttribute("data-aek-modal")) el.removeAttribute("data-aek-modal");
        if (el.hasAttribute("data-aek-listed")) el.removeAttribute("data-aek-listed");
      }

      // Pass 0b: is a modal dialog open? If so it owns the interaction
      // surface — every background control is listed-but-unclickable, and the
      // agent burns turns on 8s "intercepts pointer events" timeouts.
      let modalRoot: HTMLElement | null = null;
      let modalLabel: string | null = null;
      if (args.detectModal) {
        // Radix (and most shadcn/Tailwind) Sheets and Dialogs render
        //   <div role="dialog" class="fixed z-50">
        // with aria-modal=null, no [inert], no aria-hidden and
        // body{pointer-events:auto} — EVERY classic modality heuristic misses
        // them, so ~150 background refs stay listed and each click on one
        // burns an 8s pointer-intercept timeout. What they do always render is
        // a full-viewport position:fixed overlay behind the panel
        // (div.fixed.inset-0.z-50.bg-black/50). Treat that as the signal.
        let hasOverlay = false;
        for (let k = 0; k < allEls.length && !hasOverlay; k++) {
          const el = allEls[k];
          const st = window.getComputedStyle(el);
          if (st.position !== "fixed") continue;
          if (st.display === "none" || st.visibility === "hidden") continue;
          if (Number(st.opacity) === 0) continue;
          const z = parseInt(st.zIndex, 10);
          if (!(z >= 40)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < window.innerWidth * 0.9) continue;
          if (r.height < window.innerHeight * 0.9) continue;
          hasOverlay = true;
        }
        for (let k = 0; k < allEls.length; k++) {
          const el = allEls[k];
          let isModal = false;
          try {
            isModal = el.matches(":modal"); // <dialog> opened with showModal()
          } catch {
            isModal = false;
          }
          if (!isModal) {
            // NB: getAttribute("role"), not the implicit role — a <dialog>
            // opened with show() (non-modal by definition) must stay unscoped.
            const role = el.getAttribute("role");
            isModal =
              (role === "dialog" || role === "alertdialog") &&
              (el.getAttribute("aria-modal") === "true" || hasOverlay);
          }
          if (!isModal) continue;
          const st = window.getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          modalRoot = el; // last visible one in document order = topmost
        }
        if (modalRoot) {
          modalRoot.setAttribute("data-aek-modal", "1");
          const raw =
            modalRoot.getAttribute("aria-label") ||
            modalRoot.getAttribute("title") ||
            (modalRoot.textContent ?? "").trim() ||
            "dialog";
          modalLabel = raw.replace(/\s+/g, " ").slice(0, 70);
        }
      }

      const selector =
        'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="listbox"], [role="option"], [role="treeitem"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
      const candTags: Record<string, number> = {
        DIV: 1,
        TR: 1,
        LI: 1,
        TD: 1,
        SPAN: 1,
        ARTICLE: 1,
        SECTION: 1,
      };
      const explicit: HTMLElement[] = [];
      // React/Vue rows and cards are frequently plain <div>/<tr> with a
      // synthetic click handler — no href, no button, no onclick attribute —
      // so a selector alone misses them entirely (e.g. an events table whose
      // rows are the only way into an event). Treat cursor:pointer as the
      // clickability signal for those, bounded so big pages stay fast.
      const candidates: HTMLElement[] = [];
      for (let k = 0; k < allEls.length; k++) {
        const el = allEls[k];
        if (el === document.body || el === document.documentElement) continue;
        if (modalRoot && !modalRoot.contains(el)) continue;
        if (el.closest && el.closest("[inert]")) continue;
        let isExp = false;
        try {
          isExp = el.matches(selector);
        } catch {
          isExp = false;
        }
        if (isExp) {
          if (explicit.length < 4000) explicit.push(el);
        } else if (candTags[el.tagName] && candidates.length < 3000) {
          candidates.push(el);
        }
      }

      // Inner scroll containers. Lazy / virtualised lists live inside one, and
      // the window scrollbar does not move them — so "only 12 sessions exist"
      // is really "the container was never scrolled". Surface them as refs the
      // agent can aim the scroll tool at.
      const scrollers: HTMLElement[] = [];
      for (let k = 0; k < allEls.length && scrollers.length < 5; k++) {
        const el = allEls[k];
        if (el === document.body || el === document.documentElement) continue;
        if (modalRoot && !modalRoot.contains(el)) continue;
        if (el.scrollHeight - el.clientHeight <= 24) continue;
        const st = window.getComputedStyle(el);
        if (st.overflowY !== "auto" && st.overflowY !== "scroll") continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < 8000) continue;
        scrollers.push(el);
      }

      // Pass 1: reads only (no interleaved writes -> no layout thrashing).
      const visible: HTMLElement[] = [];
      const seen = new Set<HTMLElement>();
      for (const el of explicit) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (style.visibility === "hidden" || style.display === "none") continue;
        seen.add(el);
        visible.push(el);
      }
      // Mark everything decided so far, so a cursor:pointer wrapper can be
      // told apart from a real target by what it CONTAINS.
      for (const el of visible) el.setAttribute("data-aek-listed", "1");

      // Candidates are judged in REVERSE document order — a descendant always
      // follows its ancestor, so going backwards means the inner cards are
      // decided (and marked) before the list container that wraps them. This
      // is the whole fix for the worst failure mode in this harness: a
      // cursor:pointer list container was given a ref labelled by its FIRST
      // child's text ("Engineering Review Group Closed v20 Evaluators…"), and
      // clicking that ref clicked the container's centre — which is a
      // different row entirely (it opened the Finance plan). The agent then
      // acted confidently on the wrong object, which scores worse than
      // failing outright.
      const keep = new Set<HTMLElement>();
      for (let k = candidates.length - 1; k >= 0; k--) {
        const el = candidates[k];
        if (seen.has(el)) continue;
        const style = window.getComputedStyle(el);
        if (style.cursor !== "pointer") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (style.visibility === "hidden" || style.display === "none") continue;
        const text = (el.textContent ?? "").trim();
        if (!text || text.length > 200) continue;
        // More than one already-listed clickable inside => this is a
        // container of targets, not a target. Its children are the things to
        // click, and they are already listed.
        if (el.querySelectorAll("[data-aek-listed]").length > 1) continue;
        el.setAttribute("data-aek-listed", "1");
        keep.add(el);
      }
      // Re-emit in document order so refs stay reading-order stable.
      for (const el of candidates) {
        if (!keep.has(el)) continue;
        seen.add(el);
        visible.push(el);
      }
      // Scrollers are appended past the cap: there are at most 5 and losing
      // them is what hides the rest of a long list.
      const scrollSet = new Set<HTMLElement>();
      for (const el of scrollers) {
        scrollSet.add(el);
        if (seen.has(el)) continue;
        seen.add(el);
        visible.push(el);
      }
      for (const el of visible) el.setAttribute("data-aek-listed", "1");

      // Pass 2: writes + label extraction.
      const out: { ref: string; tag: string; type: string; label: string; flags: string[] }[] = [];
      const chromeSeen: Record<string, number> = {};
      let hidden = 0;
      let i = baseCount;
      for (const el of visible) {
        const tagName = el.tagName;
        const role = el.getAttribute("role");
        const haspopup = el.getAttribute("aria-haspopup");

        // ---- redundant <span> wrappers -------------------------------------
        // A nav item routinely triples up as link + inner <span> + a repeated
        // per-item action. The <span> is the same target as its parent and
        // just burns a ref.
        if (tagName === "SPAN") {
          const par = el.parentElement;
          if (par && par.hasAttribute("data-aek-listed")) {
            const pt = (par.textContent ?? "").replace(/\s+/g, " ").trim();
            const st = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (pt === st) {
              hidden += 1;
              continue;
            }
          }
        }

        const labelSource =
          el.getAttribute("aria-label") ||
          (el as HTMLInputElement).placeholder ||
          el.getAttribute("title") ||
          (el.textContent ?? "").trim() ||
          (el as HTMLInputElement).name ||
          el.id ||
          "";
        let label = labelSource.replace(/\s+/g, " ").trim();
        const truncated = label.length > 90;
        if (truncated) label = label.slice(0, 90) + "…";

        // ---- row context ---------------------------------------------------
        // A table of 25 identical `<button>Edit` refs is untargetable; each
        // one has to carry the row it acts on.
        let rowText = "";
        let rowNode: Element | null = null;
        try {
          rowNode = el.closest('tr,[role="row"]');
        } catch {
          rowNode = null;
        }
        if (rowNode) {
          const cells = rowNode.querySelectorAll(
            'td,th,[role="cell"],[role="gridcell"],[role="rowheader"]',
          );
          for (let c = 0; c < cells.length && !rowText; c++) {
            const t = (cells[c].textContent ?? "").replace(/\s+/g, " ").trim();
            if (t) rowText = t.slice(0, 40);
          }
          // Selection checkboxes are usually the best-labelled thing in a row
          // ("Select Ada Testerman"), so borrow that when the cells are bare.
          if (!rowText) {
            const lab = rowNode.querySelector("[aria-label]");
            if (lab) {
              rowText = (lab.getAttribute("aria-label") ?? "")
                .replace(/^\s*select\s+/i, "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 40);
            }
          }
        }

        // ---- nameless controls ---------------------------------------------
        // Icon-only buttons (drag handle / switch / kebab), Radix switches
        // whose label is a sibling text node, and Radix's generated ids all
        // produce empty or meaningless labels — 23 refs reading `<button> `
        // with the thing they act on ("Track", "Level") carrying no ref at
        // all. Edit vs delete then becomes a coin flip. Synthesize a name.
        if (!label || /^radix-:/.test(label) || /^:r[0-9a-z]+:$/.test(label)) {
          let syn = "";
          let anc: Element | null = el.parentElement;
          for (let h = 0; anc && h < 6 && !syn; h++) {
            syn = (anc.getAttribute("aria-label") || anc.getAttribute("title") || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 40);
            anc = anc.parentElement;
          }
          if (!syn) syn = rowText;
          if (!syn) {
            const par = el.parentElement;
            if (par) {
              let sib = "";
              for (let n = 0; n < par.childNodes.length; n++) {
                const cn = par.childNodes[n];
                if (cn === el) continue;
                if (cn.nodeType === 3) {
                  sib += " " + (cn.nodeValue ?? "");
                  continue;
                }
                if (cn.nodeType !== 1) continue;
                const ce = cn as HTMLElement;
                let interactive = false;
                try {
                  interactive = ce.matches(selector) || !!ce.querySelector(selector);
                } catch {
                  interactive = true; // unknown => assume it is another control
                }
                if (interactive) continue;
                sib += " " + (ce.textContent ?? "");
              }
              syn = sib.replace(/\s+/g, " ").trim().slice(0, 40);
            }
          }
          if (!syn) {
            let node: Element | null = el;
            for (let h = 0; node && h < 5 && !syn; h++) {
              let s: Element | null = node.previousElementSibling;
              while (s && !syn) {
                if (/^H[1-6]$/.test(s.tagName)) {
                  syn = (s.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
                }
                s = s.previousElementSibling;
              }
              node = node.parentElement;
            }
          }
          // What KIND of control it is, so three icon buttons in one row do
          // not collapse into three identical refs.
          let hint = "";
          const sv = el.querySelector("svg");
          if (sv) {
            const ti = sv.querySelector("title");
            if (ti) hint = (ti.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
            if (!hint) {
              const cls = (sv.getAttribute("class") ?? "") + " " + (el.getAttribute("class") ?? "");
              const mi = /(?:lucide|icon|fa|bi)-([a-z0-9-]{2,30})/i.exec(cls);
              hint = mi ? mi[1] : (sv.getAttribute("data-icon") ?? "").slice(0, 30);
            }
            if (hint) hint = hint + " icon";
          }
          if (!hint) {
            if (haspopup === "menu" || haspopup === "dialog" || haspopup === "listbox") {
              hint = haspopup;
            } else if (role) {
              hint = role;
            } else {
              hint = tagName.toLowerCase();
            }
          }
          const parts: string[] = [];
          if (rowText) parts.push('(row "' + rowText + '")');
          if (syn && syn !== rowText) parts.push(syn);
          if (hint) parts.push(hint);
          label = parts.join(" ") || "(unlabeled " + tagName.toLowerCase() + ")";
        } else if (rowText && label.toLowerCase().indexOf(rowText.toLowerCase()) < 0) {
          label = label + ' (row "' + rowText + '")';
        }

        // ---- sidebar / nav chrome collapse ----------------------------------
        // Keep every destination reachable exactly once and drop the repeats
        // ("Pin to top" once per item, duplicate labels), so main content is
        // not the thing that gets truncated at the ref cap.
        let chrome: Element | null = null;
        try {
          chrome = el.closest('nav,aside,[role="navigation"],[role="complementary"]');
        } catch {
          chrome = null;
        }
        if (chrome) {
          const href = el.getAttribute("href") ?? "";
          const key = href ? "h:" + href : "l:" + label.toLowerCase();
          if (chromeSeen[key]) {
            hidden += 1;
            continue;
          }
          chromeSeen[key] = 1;
        }

        // Apply the ref budget only after wrapper and navigation duplicates
        // have been collapsed. Capping the raw visible list lets repetitive
        // chrome consume every slot before a main-content control is even
        // considered. Scroll containers remain exempt below because there are
        // at most five and they are the only way to reveal virtualized content.
        if (out.length >= 250 && !scrollSet.has(el)) continue;

        i += 1;
        const ref = `e${i}`;
        el.setAttribute("data-aek-ref", ref);
        const flags: string[] = [];
        if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") {
          flags.push("disabled");
        }
        if (el.hasAttribute("readonly") || el.getAttribute("aria-readonly") === "true") {
          flags.push("readonly");
        }
        const inputType = ((el as HTMLInputElement).type ?? "").toLowerCase();
        if (
          role === "switch" ||
          role === "checkbox" ||
          role === "radio" ||
          (tagName === "INPUT" && (inputType === "checkbox" || inputType === "radio"))
        ) {
          const ac = el.getAttribute("aria-checked");
          if (ac === "mixed") flags.push("mixed");
          else if (ac === null)
            flags.push((el as HTMLInputElement).checked ? "checked" : "unchecked");
          else flags.push(ac === "true" ? "checked" : "unchecked");
        }
        if (
          tagName !== "SELECT" &&
          (role === "combobox" ||
            role === "listbox" ||
            haspopup === "listbox" ||
            haspopup === "menu" ||
            // A date/time trigger is <button aria-haspopup="dialog">August 9th,
            // 2026 at 8:00 PM</button> opening a day-picker popover; without
            // this it read as an ordinary button and the popover was never
            // opened deliberately.
            haspopup === "dialog")
        ) {
          flags.push("dropdown");
        }
        if (scrollSet.has(el)) flags.push("scrollable");
        // A ref that wraps several other listed refs is a region, not a
        // button: clicking its centre hits whichever child happens to sit
        // there. Say so in the label — and note that a 90-char cut hides the
        // fact that the label spans many items.
        const innerListed = el.querySelectorAll("[data-aek-listed]").length;
        if (innerListed >= 2 || (truncated && innerListed >= 1)) label = "(container) " + label;
        out.push({
          ref,
          tag: tagName.toLowerCase(),
          type: (el as HTMLInputElement).type ?? "",
          label,
          flags,
        });
      }
      for (let k = 0; k < allEls.length; k++) {
        const el = allEls[k];
        if (el.hasAttribute("data-aek-listed")) el.removeAttribute("data-aek-listed");
      }
      return { out, last: i, modalLabel, hidden };
    },
    { baseCount: base, detectModal },
  );

  // page.evaluate is not covered by setDefaultTimeout; guard against pages
  // whose main thread never yields.
  // Failed observation must be a tool error, not a successful empty snapshot.
  type Collected = { out: RawEl[]; last: number; modalLabel: string | null; hidden: number };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<Collected>([
      work.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Element detection failed: ${message.slice(0, 160)}. Take a fresh snapshot to retry.`,
          { cause: err },
        );
      }),
      new Promise<Collected>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Element detection timed out after ${timeoutMs}ms. Take a fresh snapshot to retry.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
