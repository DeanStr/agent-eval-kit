import { randomUUID } from "node:crypto";
import { installReadOnlyFrameGuard } from "./read-only-frame-guard.js";
import type { ReadOnlyFramePolicy } from "../types.js";
import { attachDiagnostics } from "./diagnostics.js";
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../io.js";
import { assertEvaluationPlatform } from "../platform.js";
import { collectFrame, type RawEl } from "./elements.js";
import { BrowserForms } from "./forms.js";
import { BrowserPointer } from "./pointer.js";
import { upload } from "./uploads.js";
import {
  OriginBoundaryError,
  AuthenticationEvidenceError,
  BrowserEvidenceError,
  ScreenshotFramingError,
  type BrowserInteractionContext,
} from "./interaction-context.js";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";

type TaggedEl = RawEl & { frameLabel: string };

/**
 * Thin Playwright wrapper the agent loop drives. Interactive elements are
 * tagged with data-aek-ref attributes on every snapshot so the model can
 * address them by stable short refs (e1, e2, ...) instead of guessing CSS
 * selectors. Refs are re-assigned on each snapshot.
 *
 * Containment: top-level navigation is pinned to an explicit origin allowlist.
 * Subresources may come from CDNs, but redirects, external links, and popups
 * outside the allowlist are rolled back after every action.
 */
export class BrowserSession {
  private readonly interaction: BrowserInteractionContext;
  private readonly forms: BrowserForms;
  private readonly pointer: BrowserPointer;
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;
  private refCounter = 0;
  private referencesValid = true;
  private shotCounter = 0;
  private readonly readOnlyFrameGuardKey = `aek-preview-${randomUUID()}`;
  private diagnosticBudget = { count: 0 };
  private privateAuthentication = false;
  private authenticationSecrets = new Set<string>();

  beginPrivateAuthentication(): void {
    this.privateAuthentication = true;
    this.invalidateReferences();
  }

  protectAuthenticationSecret(secret: string): void {
    for (const value of [
      secret,
      encodeURIComponent(secret),
      secret.replaceAll("&", "&amp;"),
      JSON.stringify(secret).slice(1, -1),
    ])
      this.authenticationSecrets.add(value);
  }

  redactAuthentication(value: string): string {
    if (this.privateAuthentication) return "[private email authentication]";
    return this.redactSecrets(value);
  }

  redactSecrets(value: string): string {
    let result = value;
    for (const secret of [...this.authenticationSecrets].sort((a, b) => b.length - a.length))
      result = result.replaceAll(secret, "[authentication credential]");
    return result;
  }

  async finishPrivateAuthentication(): Promise<void> {
    await this.assertNoAuthenticationCredential();
    this.privateAuthentication = false;
    this.pendingNotes = [];
    this.invalidateReferences();
  }

  async waitForAuthenticationIdentity(selector: string, text: string): Promise<void> {
    const deadline = performance.now() + this.actionTimeoutMs;
    const remaining = () => Math.max(1, deadline - performance.now());
    for (;;) {
      if (await this.enforceOrigin())
        throw new AuthenticationEvidenceError(
          "Identity verification left the allowed application origins",
        );
      const identity = this.page.locator(selector);
      await identity.waitFor({ state: "visible", timeout: remaining() });
      if ((await identity.innerText({ timeout: remaining() })).trim() === text) return;
      if (performance.now() >= deadline)
        throw new AuthenticationEvidenceError(
          "The authenticated identity did not match the declared success text within the browser action timeout",
        );
      await this.page.waitForTimeout(Math.min(100, remaining()));
    }
  }

  private async assertNoAuthenticationCredential(): Promise<void> {
    if (!this.authenticationSecrets.size) return;
    for (const page of this.context.pages()) {
      if (page.isClosed()) continue;
      if (!this.isAllowedUrl(page.url()))
        throw new Error("Email authentication left an external page open");
      for (const frame of page.frames()) {
        if (!(await this.isEvidenceFrame(frame, page.mainFrame()))) continue;
        const content = await frame
          .evaluate(() => {
            const roots: Array<Document | ShadowRoot> = [document];
            const parts = [location.href];
            for (const root of roots) {
              parts.push(
                root instanceof Document ? root.documentElement.outerHTML : root.innerHTML,
              );
              // Markup can split a visible credential across inline elements
              // or encode its characters as entities. Inspect decoded text too.
              const textRoot = root instanceof Document ? root.documentElement : root;
              parts.push(textRoot.textContent ?? "");
              if (root instanceof Document) parts.push(root.documentElement.innerText);
              for (const element of root.querySelectorAll("*")) {
                if (element.shadowRoot) roots.push(element.shadowRoot);
                if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
                  parts.push(element.value);
              }
            }
            return parts.join("\n");
          })
          .catch(() => {
            throw new BrowserEvidenceError(
              "Could not inspect a page for authentication credentials; check browser and frame health",
            );
          });
        if ([...this.authenticationSecrets].some((secret) => content.includes(secret)))
          throw new AuthenticationEvidenceError(
            "Authentication credential remains in a page URL or DOM; require a clean post-login redirect and clear verification fields before capturing evidence",
          );
      }
    }
  }

  private async assertAuthenticationEvidenceSafe(): Promise<void> {
    if (this.privateAuthentication)
      throw new AuthenticationEvidenceError(
        "Email authentication has not completed safely; start a fresh authentication attempt",
      );
    await this.assertNoAuthenticationCredential();
  }
  /** Only Chromium's pristine page may bypass top-level origin enforcement. */
  private initialBlankAllowed = false;
  /** Events (dialogs, popups, origin blocks) surfaced in the next tool result. */
  private pendingNotes: string[] = [];
  /** ref -> iframe-hosted rich-text editor (TinyMCE and friends). */
  private frameEditors = new Map<string, Frame>();
  /**
   * ref -> the frame that owns it. Refs living in a child iframe cannot be
   * resolved from the main frame, so every lookup has to go through here.
   */
  private refFrames = new Map<string, Frame>();

  constructor(
    private readonly evidenceDir: string,
    private readonly headless: boolean,
    private readonly targetUrl: string,
    /** Playwright storageState file to restore (pre-authenticated persona). */
    private readonly storageStatePath?: string,
    private readonly allowedOrigins: string[] = [new URL(targetUrl).origin],
    private readonly viewport: { width: number; height: number } = { width: 1280, height: 800 },
    private readonly actionTimeoutMs = 10_000,
    private readonly popupPolicy: "same-origin" | "authentication" = "same-origin",
    private readonly captureOptions?: {
      lossless?: boolean;
      software?: boolean;
      disableAnimations?: boolean;
      namespace?: number;
      readOnlyFrames?: ReadOnlyFramePolicy[];
    },
  ) {
    this.refCounter = (captureOptions?.namespace ?? 0) * 1_000_000;
    const session = this;
    this.interaction = {
      get page() {
        return session.page;
      },
      get frameEditors() {
        return session.frameEditors;
      },
      get refFrames() {
        return session.refFrames;
      },
      actionTimeoutMs,
      refLocator: (ref) => this.refLocator(ref),
      refMissing: (locator) => this.refMissing(locator),
      stale: (ref) => this.stale(ref),
      isAllowedFrame: (frame) => this.isAllowedFrame(frame),
      allowedFrames: () => this.allowedFrames(),
      enforceOrigin: () => this.enforceOrigin(),
      postflightOrigin: () => this.postflightOrigin(),
      drainNotes: () => this.drainNotes(),
      snapshot: () => this.snapshot(),
      click: (ref) => this.click(ref),
    };
    this.forms = new BrowserForms(this.interaction);
    this.pointer = new BrowserPointer(this.interaction);
  }

  async start(): Promise<void> {
    assertEvaluationPlatform();
    this.browser = await chromium.launch({
      headless: this.headless,
      args: this.captureOptions?.software
        ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        : [],
    });
    try {
      this.context = await this.browser.newContext({
        viewport: this.viewport,
        // Consistent UA so clones don't serve mobile layouts.
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 agent-eval-kit/0.1",
        ...(this.storageStatePath ? { storageState: this.storageStatePath } : {}),
      });
      fs.mkdirSync(this.evidenceDir, { recursive: true });
      writeJson(path.join(this.evidenceDir, "browser-provenance.json"), {
        chromium: this.browser.version(),
        viewport: this.viewport,
        deviceScaleFactor: 1,
        software: this.captureOptions?.software ?? false,
      });
      if (this.captureOptions?.readOnlyFrames?.length)
        await installReadOnlyFrameGuard(this.context, this.readOnlyFrameGuardKey);
      this.page = await this.context.newPage();
      this.initialBlankAllowed = true;
      this.page.setDefaultTimeout(this.actionTimeoutMs);
      this.attachPageHandlers(this.page);

      // Evaluation popups remain origin-contained. Authentication capture is
      // the one exception: an external identity-provider popup may stay open
      // temporarily, but finalization below requires every remaining page to
      // have returned to the configured application boundary.
      this.context.on("page", async (newPage) => {
        this.attachPageHandlers(newPage);
        if (this.popupPolicy === "authentication") {
          newPage.on("framenavigated", (frame) => {
            if (
              frame === newPage.mainFrame() &&
              !newPage.isClosed() &&
              newPage.url() !== "about:blank" &&
              this.isOnTarget(newPage.url())
            ) {
              this.page = newPage;
              this.page.setDefaultTimeout(this.actionTimeoutMs);
            }
          });
          newPage.on("close", () => {
            if (this.page !== newPage) return;
            const fallback = this.context
              .pages()
              .filter((page) => !page.isClosed() && this.isOnTarget(page.url()))
              .at(-1);
            if (fallback) this.page = fallback;
          });
        }
        try {
          await newPage.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
          const url = newPage.url();
          if (this.isOnTarget(url)) {
            this.pendingNotes.push(`A new tab opened at ${url}; the session switched to it.`);
            this.page = newPage;
            this.page.setDefaultTimeout(this.actionTimeoutMs);
          } else if (this.popupPolicy === "authentication") {
            this.pendingNotes.push(
              `An external authentication popup opened at ${url}; it must return to an allowed origin or close before credentials are saved.`,
            );
          } else {
            this.pendingNotes.push(`A new tab opened at off-target URL ${url} and was closed.`);
            await newPage.close().catch(() => {});
          }
        } catch {
          /* best-effort */
        }
      });

      fs.mkdirSync(path.join(this.evidenceDir, "screenshots"), { recursive: true });
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  private attachPageHandlers(page: Page): void {
    attachDiagnostics(page, this.evidenceDir, this.diagnosticBudget, (value) =>
      this.redactAuthentication(value),
    );
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url() !== "about:blank") {
        this.initialBlankAllowed = false;
      }
    });
    page.on("dialog", async (dialog) => {
      this.pendingNotes.push(
        `Native ${dialog.type()} dialog appeared with message "${dialog.message()}" — it was accepted.`,
      );
      await dialog.accept().catch(() => {});
    });
  }

  /**
   * Containment check. Exact origins are the safe default. A project can opt
   * into sibling hosts explicitly with entries such as
   * `https://*.example.com`; this avoids both the old `co.uk` registrable-domain
   * bug and silently granting every sibling subdomain access.
   */
  /** Public form of the containment rule, so callers don't re-implement it. */
  isAllowedUrl(url: string): boolean {
    return this.isOnTarget(url);
  }

  private isOnTarget(url: string): boolean {
    try {
      const u = new URL(url);
      return this.allowedOrigins.some((entry) => {
        // Opaque origins such as file:// serialize to "null", which is not
        // itself parseable as a URL but is still safe to compare exactly.
        if (u.origin === entry) return true;
        if (!entry.includes("*")) {
          try {
            return u.origin === new URL(entry).origin;
          } catch {
            return url.startsWith(entry);
          }
        }
        const match = /^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/.exec(entry);
        if (!match?.[2]) return false;
        const [, protocol, suffix, port] = match;
        const defaultPort = protocol === "https" ? "443" : "80";
        const urlPort = u.port || defaultPort;
        const configuredPort = port || defaultPort;
        return (
          u.protocol === `${protocol}:` &&
          u.hostname.endsWith(`.${suffix.toLowerCase()}`) &&
          urlPort === configuredPort
        );
      });
    } catch {
      return false;
    }
  }

  /**
   * A child frame is usable only when it and every ancestor below the main
   * frame are on an explicitly allowed origin. Direct about:blank frames
   * inherit their parent's origin, but an about:blank descendant must not
   * bypass a disallowed parent.
   */
  private async isAllowedFrame(frame: Frame, main = this.page.mainFrame()): Promise<boolean> {
    let current: Frame | null = frame;
    while (current && current !== main) {
      const url = current.url();
      if (url === "about:blank" || url === "about:srcdoc") {
        // These documents inherit their embedding frame's origin unless the
        // iframe is sandboxed without allow-same-origin. Inspect the embedding
        // element rather than treating every about:* URL as trustworthy: an
        // opaque sandbox must remain outside the evidence/action boundary.
        const inheritsOrigin = await current
          .frameElement()
          .then((element) =>
            element.evaluate((node) => {
              const iframe = node as HTMLIFrameElement;
              return (
                !iframe.hasAttribute("sandbox") || iframe.sandbox.contains("allow-same-origin")
              );
            }),
          )
          .catch(() => {
            throw new BrowserEvidenceError(
              "Could not inspect iframe origin inheritance; check browser and frame health",
            );
          });
        if (!inheritsOrigin) return false;
      } else if (!this.isOnTarget(url)) {
        return false;
      }
      current = current.parentFrame();
    }
    return current === main && this.isOnTarget(main.url());
  }

  /** Evidence-only opt-in; never used to authorize interactive references. */
  private async isReadOnlyFrame(frame: Frame, main = this.page.mainFrame()): Promise<boolean> {
    const policies = this.captureOptions?.readOnlyFrames;
    if (!policies?.length || frame.parentFrame() !== main || frame.url() !== "about:srcdoc")
      return false;
    const pageUrl = new URL(main.url());
    if (pageUrl.origin !== new URL(this.targetUrl).origin) return false;
    const selectors = policies
      .filter((policy) => pageUrl.pathname.startsWith(policy.pathPrefix))
      .map((policy) => policy.selector);
    if (!selectors.length) return false;
    try {
      const element = await frame.frameElement();
      return await element.evaluate(
        (node, { approved, key }) => {
          const iframe = node as HTMLIFrameElement;
          const guard = (
            window as unknown as Record<string, { allows(element: Element): boolean }>
          )[key];
          if (!guard) throw new Error("Read-only preview attachment history is unavailable");
          return (
            guard.allows(iframe) &&
            approved.some((selector) => iframe.matches(selector)) &&
            iframe.hasAttribute("srcdoc") &&
            iframe.hasAttribute("sandbox") &&
            iframe.sandbox.length === 0
          );
        },
        { approved: selectors, key: this.readOnlyFrameGuardKey },
      );
    } catch (error) {
      throw new BrowserEvidenceError(
        `Could not inspect read-only preview policy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async isEvidenceFrame(frame: Frame, main = this.page.mainFrame()): Promise<boolean> {
    return (await this.isAllowedFrame(frame, main)) || (await this.isReadOnlyFrame(frame, main));
  }

  private async allowedFrames(): Promise<Frame[]> {
    const frames = this.page.frames();
    const allowed = await Promise.all(frames.map((frame) => this.isAllowedFrame(frame)));
    return frames.filter((_frame, index) => allowed[index]);
  }

  /**
   * Post-action containment check: if any action (redirect, link click, form
   * submit) landed off the target origin, roll back and tell the model.
   */
  private async enforceOrigin(url = this.page.url()): Promise<string | null> {
    if (url === "about:blank" && this.initialBlankAllowed) return null;
    if (this.isOnTarget(url)) return null;
    const blocked = `BLOCKED: the page navigated off-target to ${url}. Allowed origins: ${this.allowedOrigins.join(", ")}.`;
    await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => null);
    let recoveredUrl = this.page.url();
    if (this.isOnTarget(recoveredUrl)) {
      return `${blocked} The browser was returned to ${recoveredUrl}.`;
    }

    await this.page
      .goto(this.targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => null);
    recoveredUrl = this.page.url();
    if (this.isOnTarget(recoveredUrl)) {
      return `${blocked} The browser was returned to ${recoveredUrl}.`;
    }

    // Do not let callers continue into title/DOM/screenshot reads while the
    // page is still external. The MCP boundary converts this into an error.
    throw new OriginBoundaryError(
      `${blocked} Origin recovery failed; no off-target page content was inspected.`,
    );
  }

  /**
   * Contain an asynchronous redirect before an MCP tool can dispatch its next
   * browser interaction. The MCP calls this once at the common tool boundary;
   * methods such as snapshot and screenshot still enforce again before they
   * read or persist page content.
   */
  async preflightOrigin(): Promise<string | null> {
    // page.url() is a client-side cache. A tool request can reach this process
    // before queued navigation notifications, even after Chromium has moved.
    let url: string;
    try {
      const session = await this.page.context().newCDPSession(this.page);
      try {
        // Browser metadata survives navigation replacing the document's
        // execution context; evaluating location.href can race that replacement.
        const { frameTree } = await session.send("Page.getFrameTree");
        url = frameTree.frame.url + (frameTree.frame.urlFragment ?? "");
      } finally {
        await session.detach();
      }
    } catch (error) {
      throw new BrowserEvidenceError(
        `Could not inspect the current browser URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.enforceOrigin(url);
  }

  /**
   * Let navigation scheduled by the browser action's own input/click handler
   * reach the main frame before enforcing containment. Playwright may resolve
   * a DOM action while that navigation is queued but before page.url() changes.
   */
  async postflightOrigin(): Promise<string | null> {
    await this.page.waitForTimeout(50);
    return this.enforceOrigin();
  }

  /** Complete the temporary OAuth exception without weakening evaluation containment. */
  async finalizeAuthenticationCapture(): Promise<void> {
    if (this.popupPolicy !== "authentication") {
      throw new Error(
        "Authentication finalization is available only for authentication capture sessions",
      );
    }
    const pages = this.context
      .pages()
      .filter((page) => !page.isClosed() && page.url() !== "about:blank");
    const external = pages.filter((page) => !this.isOnTarget(page.url()));
    if (external.length) {
      throw new OriginBoundaryError(
        `Auth capture cannot finish while an external page is open: ${external.map((page) => page.url()).join(", ")}`,
      );
    }
    const allowed = pages.filter((page) => this.isOnTarget(page.url()));
    if (!allowed.length)
      throw new OriginBoundaryError(
        "Auth capture has no open page on an allowed application origin",
      );
    this.page = allowed.at(-1)!;
    this.page.setDefaultTimeout(this.actionTimeoutMs);
  }

  private drainNotes(): string {
    if (this.pendingNotes.length === 0) return "";
    const notes = this.pendingNotes.map((n) => `NOTE: ${n}`).join("\n");
    this.pendingNotes = [];
    return notes + "\n\n";
  }

  /** Persist allowed-origin cookies/localStorage for later scenarios. */
  async saveStorageState(filePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Some authentication systems (including Firebase Authentication) keep
    // their durable session in IndexedDB rather than cookies/localStorage.
    const state = await this.context.storageState({ indexedDB: true });
    const cookieAllowed = (domainValue: string) => {
      const domain = domainValue.replace(/^\./, "").toLowerCase();
      return this.allowedOrigins.some((entry) => {
        if (entry.includes("*")) {
          const match = /^(?:https?):\/\/\*\.([^/:]+)(?::\d+)?$/.exec(entry);
          const suffix = match?.[1]?.toLowerCase();
          return Boolean(suffix && (domain === suffix || domain.endsWith(`.${suffix}`)));
        }
        const host = new URL(entry).hostname.toLowerCase();
        return host === domain || host.endsWith(`.${domain}`);
      });
    };
    const filtered = {
      cookies: state.cookies.filter((cookie) => cookieAllowed(cookie.domain)),
      origins: state.origins.filter((origin) => this.isOnTarget(origin.origin)),
    };
    writeJson(filePath, filtered, { mode: 0o600 });
  }

  invalidateReferences(): void {
    this.referencesValid = false;
    this.refFrames.clear();
    this.frameEditors.clear();
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<string> {
    // Even an attempted first navigation revokes the startup exception. A
    // caller cannot deliberately navigate to about:blank and retain it.
    this.initialBlankAllowed = false;
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await this.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    return this.snapshot();
  }

  /**
   * Text snapshot of the current page: url, title, aria outline, and an
   * indexed list of interactive elements. This is the agent's primary sense.
   */
  async snapshot(): Promise<string> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    const originMsg = await this.enforceOrigin();
    await this.assertAuthenticationEvidenceSafe();
    const url = this.page.url();
    const title = await this.page.title().catch(() => "");

    const { entries, modalLabel, frameOutlines, hidden } = await this.tagInteractiveElements();
    try {
      for (const frame of this.page.frames()) {
        if (!(await this.isReadOnlyFrame(frame))) continue;
        const outline = await frame.locator("body").ariaSnapshot({ timeout: this.actionTimeoutMs });
        if (!(await this.isReadOnlyFrame(frame)))
          throw new BrowserEvidenceError(
            "Read-only preview changed its evidence boundary during capture",
          );
        frameOutlines.push({
          label: "approved read-only preview (no interactive refs)",
          aria: outline,
        });
      }
    } catch (error) {
      throw new BrowserEvidenceError(
        `Could not capture read-only preview evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // With a modal open, the aria outline of <body> is mostly unreachable
    // background; scope it to the dialog so the outline matches the refs.
    let aria = "";
    try {
      const scope = modalLabel
        ? this.page.locator('[data-aek-modal="1"]').first()
        : this.page.locator("body");
      aria = await scope.ariaSnapshot({ timeout: 5_000 });
    } catch {
      try {
        aria = await this.page.locator("body").ariaSnapshot({ timeout: 5_000 });
      } catch {
        aria = "(aria snapshot unavailable)";
      }
    }
    // Cap the outline so a giant page doesn't blow up the context window.
    const MAX_ARIA = 12_000;
    if (aria.length > MAX_ARIA) aria = aria.slice(0, MAX_ARIA) + "\n... (truncated)";
    for (const fo of frameOutlines) {
      aria += `\n\n--- content of ${fo.label} ---\n${fo.aria.slice(0, 2_500)}`;
    }

    const lines = entries.map((el) => {
      const attrs =
        (el.type ? ` type=${el.type}` : "") + (el.flags.length ? ` ${el.flags.join(" ")}` : "");
      return `[${el.ref}] <${el.tag}${attrs}> ${el.label}${el.frameLabel ? ` — ${el.frameLabel}` : ""}`;
    });
    let elementList = lines.join("\n");
    const MAX_ELEMS = 10_000;
    if (elementList.length > MAX_ELEMS)
      elementList = elementList.slice(0, MAX_ELEMS) + "\n... (truncated)";
    // Sidebar chrome routinely accounts for ~40% of a snapshot's refs (every
    // nav item repeats as link + duplicate <span> + a per-item "Pin to top"),
    // which is how a screen hits the ref cap and loses MAIN CONTENT. Those
    // repeats are collapsed; say so, so the model does not read the shorter
    // list as a missing menu.
    if (hidden > 0) {
      elementList += `\n(+${hidden} redundant refs hidden: repeated sidebar/nav chrome and <span> wrappers of controls already listed above. Every navigation destination is still listed exactly once.)`;
    }

    const editorLines = await this.tagFrameEditors();
    if (editorLines.length) {
      elementList = (elementList ? elementList + "\n" : "") + editorLines.join("\n");
    }

    const excludedFrames = (
      await Promise.all(
        this.page.frames().map(async (frame) => !(await this.isEvidenceFrame(frame))),
      )
    ).filter(Boolean).length;
    if (excludedFrames) this.pendingNotes.push(this.frameExclusionNote(excludedFrames));
    this.referencesValid = true;
    return [
      this.drainNotes() + (originMsg ? originMsg + "\n" : "") + `URL: ${url}`,
      `TITLE: ${title}`,
      ``,
      `PAGE OUTLINE (aria):`,
      aria,
      ``,
      ...(modalLabel
        ? [
            `MODAL OPEN: "${modalLabel}" — a modal dialog is covering the page, so ONLY its contents are listed below. Everything behind it is inert and cannot be clicked. Save/close/cancel inside the dialog (or press Escape) to reach the rest of the page.`,
            ``,
          ]
        : []),
      `INTERACTIVE ELEMENTS (use these refs with click/fill/select):`,
      elementList || "(none found)",
    ].join("\n");
  }

  /**
   * Tag every interactive element the agent could act on, across the main
   * frame and every reachable same-origin child frame, and return one flat
   * list of refs.
   */
  private async tagInteractiveElements(): Promise<{
    entries: TaggedEl[];
    modalLabel: string | null;
    frameOutlines: { label: string; aria: string }[];
    hidden: number;
  }> {
    this.refFrames.clear();
    const entries: TaggedEl[] = [];
    const frameOutlines: { label: string; aria: string }[] = [];
    let hidden = 0;

    let main = await this.collectFrame(this.page.mainFrame(), this.refCounter, true);
    // Safety valve: if scoping to a modal leaves the agent with nothing to
    // click (an aria-modal container that is really an inline panel, or a
    // dialog whose controls are all in a portal outside it), the agent would
    // be stranded. Re-run unscoped rather than show an empty page.
    if (main.modalLabel && main.out.length === 0) {
      main = await this.collectFrame(this.page.mainFrame(), this.refCounter, false);
      main.modalLabel = null;
    }
    this.refCounter = main.last;
    hidden += main.hidden;
    for (const el of main.out) entries.push({ ...el, frameLabel: "" });

    // Allowed-origin child frames: embedded widgets ("add this agenda to your
    // site"), payment/booking panes and embedded admin screens can live in one,
    // and a top-level DOM query cannot see a single control inside them. A
    // third-party frame must be listed in allowedOrigins before it is exposed.
    let frames = 0;
    for (const frame of await this.allowedFrames()) {
      if (frame === this.page.mainFrame()) continue;
      if (frames >= 5) break;
      let label = "";
      try {
        const fe = await frame.frameElement();
        if (main.modalLabel) {
          const insideModal = await fe
            .evaluate((el) => !!(el as HTMLElement).closest('[data-aek-modal="1"]'))
            .catch(() => false);
          if (!insideModal) continue;
        }
        label = await fe
          .evaluate((el) => {
            const e = el as HTMLIFrameElement;
            const id = e.id ? `#${e.id}` : "";
            const nm = e.name || e.title || "";
            return `iframe ${id || nm || (e.getAttribute("src") || "").slice(-40) || "(inline)"}`;
          })
          .catch(() => "iframe");
      } catch {
        continue; // detached or cross-origin: frameElement() is unavailable
      }

      const res = await this.collectFrame(frame, this.refCounter, false);
      this.refCounter = res.last;
      hidden += res.hidden;
      if (res.out.length === 0) continue;
      frames += 1;
      for (const el of res.out) {
        this.refFrames.set(el.ref, frame);
        entries.push({ ...el, frameLabel: `in ${label}` });
      }
      const fAria = await frame
        .locator("body")
        .ariaSnapshot({ timeout: 3_000 })
        .catch(() => "");
      if (fAria) frameOutlines.push({ label, aria: fAria });
    }

    return { entries, modalLabel: main.modalLabel, frameOutlines, hidden };
  }

  private collectFrame(frame: Frame, base: number, detectModal: boolean) {
    return collectFrame(frame, base, detectModal);
  }

  /**
   * Rich-text editors that render into their own iframe (classic TinyMCE) are
   * invisible to a top-level DOM query, so the agent cannot see the abstract
   * field exists. List each editable frame body as its own ref.
   */
  private async tagFrameEditors(): Promise<string[]> {
    this.frameEditors.clear();
    const lines: string[] = [];
    for (const frame of await this.allowedFrames()) {
      if (frame === this.page.mainFrame()) continue;
      try {
        const editable = await frame
          .evaluate(() => {
            const b = document.body;
            if (!b) return null;
            const ce =
              b.getAttribute("contenteditable") === "true"
                ? b
                : b.querySelector('[contenteditable="true"]');
            if (!ce) return null;
            return {
              label: (document.title || b.id || b.className || "rich text editor").slice(0, 60),
            };
          })
          .catch(() => null);
        if (!editable) continue;
        this.refCounter += 1;
        const ref = `e${this.refCounter}`;
        this.frameEditors.set(ref, frame);
        lines.push(`[${ref}] <richtext> ${editable.label} (editor iframe — use fill)`);
      } catch {
        /* cross-origin or detached frame */
      }
    }
    return lines;
  }

  /**
   * Refs are resolved inside the frame that owns them. `page.locator` only
   * searches the main frame, so an embed-widget ref would silently resolve to
   * nothing. (Playwright's CSS engine does pierce open shadow roots, so
   * shadow-DOM refs need no special handling here.)
   */
  private async refLocator(ref: string): Promise<Locator> {
    if (!/^e[1-9]\d*$/.test(ref)) {
      throw new Error(
        "Invalid element ref; take a fresh snapshot and use a generated ref such as e1",
      );
    }
    const frame = this.refFrames.get(ref);
    // A previously allowed frame can navigate between snapshot and action.
    // Resolve it only while its complete frame ancestry remains allowed.
    if (!this.referencesValid || (frame && !(await this.isAllowedFrame(frame)))) {
      return this.page.mainFrame().locator('[data-aek-ref=""]').first();
    }
    return (frame ?? this.page.mainFrame()).locator(`[data-aek-ref="${ref}"]`).first();
  }

  private async refMissing(loc: Locator): Promise<boolean> {
    try {
      return (await loc.count()) === 0;
    } catch {
      return true; // frame detached out from under us
    }
  }

  private stale(ref: string): string {
    return `ERROR: ref ${ref} not found on the current page. Take a new snapshot to get fresh refs.`;
  }
  click(ref: string): Promise<string> {
    return this.pointer.click(ref);
  }

  fill(ref: string, text: string): Promise<string> {
    return this.forms.fill(ref, text);
  }

  select(ref: string, value: string): Promise<string> {
    return this.forms.select(ref, value);
  }

  upload(ref: string, absoluteFilePath: string): Promise<string> {
    return upload(this.interaction, ref, absoluteFilePath);
  }

  drag(fromRef: string, toRef: string): Promise<string> {
    return this.pointer.drag(fromRef, toRef);
  }

  press(key: string): Promise<string> {
    return this.pointer.press(key);
  }

  scroll(direction: "up" | "down", ref?: string): Promise<string> {
    return this.pointer.scroll(direction, ref);
  }

  async wait(ms: number): Promise<string> {
    await this.page.waitForTimeout(Math.min(ms, 8_000));
    return this.drainNotes() + `Waited ${Math.min(ms, 8_000)}ms`;
  }

  /**
   * Saves a JPEG to the evidence dir; returns {relPath, base64}. Full-page
   * captures are clipped to safe dimensions because both the scenario agent
   * and judge consume these images in multi-image requests.
   */
  async screenshot(
    label: string,
    fullPage: boolean,
    timeoutMs?: number,
  ): Promise<{ relPath: string; base64: string; notes: string }> {
    // Actions such as fill/select/upload/wait do not otherwise need a fresh
    // snapshot, and client-side handlers can redirect during any of them.
    // Evidence is a security boundary of its own: contain the page and fail
    // this capture rather than persisting or returning an off-origin image.
    const originMsg = await this.enforceOrigin();
    if (originMsg) throw new OriginBoundaryError(originMsg);
    await this.assertAuthenticationEvidenceSafe();

    this.shotCounter += 1;
    const safe = label.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60) || "shot";
    // Forward slashes always: these appear in report.html href/src attributes.
    const relPath = `screenshots/${this.captureOptions?.namespace ? `p${this.captureOptions.namespace}-` : ""}${String(this.shotCounter).padStart(3, "0")}-${safe}.${this.captureOptions?.lossless ? "png" : "jpg"}`;
    const abs = path.join(this.evidenceDir, ...relPath.split("/"));

    // Hard ceiling: the Messages API rejects any image over 2000px on a side
    // once a request carries many images — which both the agent loop and the
    // judge become. Stay under it so a tall page can never poison a request.
    const MAX_SIDE = 1_900;
    let clippingNote: string | undefined;
    let options: Parameters<Page["screenshot"]>[0] = {
      path: abs,
      type: this.captureOptions?.lossless ? "png" : "jpeg",
      ...(this.captureOptions?.lossless ? {} : { quality: 60 }),
      animations: this.captureOptions?.disableAnimations ? "disabled" : "allow",
      fullPage,
    };
    if (fullPage) {
      const documentSize = await this.page.evaluate(() => ({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
          window.innerWidth,
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
          window.innerHeight,
        ),
      }));
      if (documentSize.width > MAX_SIDE || documentSize.height > MAX_SIDE) {
        const clipWidth = Math.min(documentSize.width, MAX_SIDE);
        const clipHeight = Math.min(documentSize.height, MAX_SIDE);
        options = {
          path: abs,
          type: this.captureOptions?.lossless ? "png" : "jpeg",
          ...(this.captureOptions?.lossless ? {} : { quality: 60 }),
          animations: this.captureOptions?.disableAnimations ? "disabled" : "allow",
          fullPage: true,
          clip: { x: 0, y: 0, width: clipWidth, height: clipHeight },
        };
        clippingNote = `Full-page screenshot was clipped to ${clipWidth}×${clipHeight}px (page is ${documentSize.width}×${documentSize.height}px). Scroll and take viewport screenshots (fullPage: false) if content outside that region matters.`;
      }
    }
    // A top-level screenshot normally includes pixels rendered by third-party
    // iframes. Hide frames outside the allowlist for the duration of capture so
    // image evidence obeys the same boundary as text snapshots and actions.
    const { restoreFrames, readOnlyFrames } = await this.maskDisallowedFrames();
    try {
      if (fullPage) {
        for (const frame of readOnlyFrames) {
          const element = await frame.frameElement();
          let offscreen: boolean;
          try {
            offscreen = await element.evaluate(
              (node, clip) =>
                new Promise<boolean>((resolve, reject) => {
                  // Expand the observer's document viewport to the screenshot's
                  // document-coordinate clip. Chromium then intersects the frame
                  // with ancestor overflow clips, including per-axis clipping and
                  // scroll containers, rather than its entire bounding box.
                  const margins = [
                    window.scrollY,
                    clip.width - window.scrollX - window.innerWidth,
                    clip.height - window.scrollY - window.innerHeight,
                    window.scrollX,
                  ];
                  const observer = new IntersectionObserver(
                    ([entry]) => {
                      clearTimeout(timer);
                      observer.disconnect();
                      if (!entry) {
                        reject(new Error("Preview visibility observation returned no entry"));
                        return;
                      }
                      const box = entry.intersectionRect;
                      resolve(
                        box.width > 0 &&
                          box.height > 0 &&
                          (box.left < 0 ||
                            box.top < 0 ||
                            box.right > window.innerWidth ||
                            box.bottom > window.innerHeight),
                      );
                    },
                    { root: document, rootMargin: margins.map((value) => `${value}px`).join(" ") },
                  );
                  const timer = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error("Timed out waiting for preview visibility observation"));
                  }, clip.timeoutMs);
                  observer.observe(node as Element);
                }),
              {
                width: options.clip?.width ?? MAX_SIDE,
                height: options.clip?.height ?? MAX_SIDE,
                timeoutMs: timeoutMs ?? this.actionTimeoutMs,
              },
            );
          } catch (error) {
            throw new BrowserEvidenceError(
              `Could not inspect preview visibility before capture: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            await element.dispose();
          }
          // Chromium can omit offscreen opaque-frame pixels even when its ARIA
          // text is available. Reject the requested capture, without changing its
          // meaning or retaining a blank image as evidence. A viewport retry is safe.
          if (offscreen)
            throw new ScreenshotFramingError(
              "Full-page capture would omit an offscreen read-only preview. Scroll the preview into view and take viewport screenshots with fullPage: false; use additional scroll positions for a tall preview.",
            );
        }
      }
      const buf = await this.page.screenshot({
        ...options,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      });
      try {
        const postCaptureOrigin = await this.enforceOrigin();
        if (postCaptureOrigin) throw new OriginBoundaryError(postCaptureOrigin);
        await this.assertAuthenticationEvidenceSafe();
        for (const frame of readOnlyFrames) {
          if (!(await this.isReadOnlyFrame(frame)))
            throw new BrowserEvidenceError(
              "Read-only preview changed its evidence boundary during capture",
            );
        }
      } catch (error) {
        // page.screenshot({ path }) writes before returning. Never retain the
        // file or expose its buffer when the page crossed the boundary during
        // capture or containment itself failed.
        fs.rmSync(abs, { force: true });
        throw error;
      }
      if (clippingNote) this.pendingNotes.push(clippingNote);
      return { relPath, base64: buf.toString("base64"), notes: this.drainNotes() };
    } finally {
      await restoreFrames();
    }
  }

  private frameExclusionNote(count: number): string {
    return `AEK excluded ${count} child frame(s) by origin policy, including sandboxed frames without an allowed origin. Their content is unavailable to this evaluation and is masked in screenshots. Do not interpret blank frame regions as missing or broken product content.`;
  }

  private async maskDisallowedFrames(): Promise<{
    restoreFrames: () => Promise<void>;
    readOnlyFrames: Frame[];
  }> {
    const restorers: Array<() => Promise<void>> = [];
    const readOnlyFrames: Frame[] = [];
    try {
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame() || (await this.isAllowedFrame(frame))) continue;
        if (await this.isReadOnlyFrame(frame)) {
          readOnlyFrames.push(frame);
          continue;
        }
        const element = await frame.frameElement();
        const previous = await element.evaluate((node) => {
          const style = (node as HTMLElement).style;
          const value = style.getPropertyValue("visibility");
          const priority = style.getPropertyPriority("visibility");
          style.setProperty("visibility", "hidden", "important");
          return { value, priority };
        });
        restorers.push(async () => {
          await element.evaluate((node, prior) => {
            const style = (node as HTMLElement).style;
            if (prior.value) style.setProperty("visibility", prior.value, prior.priority);
            else style.removeProperty("visibility");
          }, previous);
        });
      }
    } catch (error) {
      await Promise.allSettled(restorers.reverse().map((restore) => restore()));
      throw new BrowserEvidenceError(
        `Could not mask every off-origin frame before capturing evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (restorers.length) this.pendingNotes.push(this.frameExclusionNote(restorers.length));
    return {
      readOnlyFrames,
      restoreFrames: async () => {
        await Promise.all(restorers.reverse().map((restore) => restore()));
      },
    };
  }
}
