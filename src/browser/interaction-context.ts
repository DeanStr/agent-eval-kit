import type { Frame, Locator, Page } from "playwright";

/** Session-owned page, references, and origin checks used by interaction handlers. */
export interface BrowserInteractionContext {
  readonly page: Page;
  readonly actionTimeoutMs: number;
  readonly frameEditors: ReadonlyMap<string, Frame>;
  readonly refFrames: ReadonlyMap<string, Frame>;
  refLocator(ref: string): Promise<Locator>;
  refMissing(locator: Locator): Promise<boolean>;
  stale(ref: string): string;
  isAllowedFrame(frame: Frame): Promise<boolean>;
  allowedFrames(): Promise<Frame[]>;
  enforceOrigin(): Promise<string | null>;
  postflightOrigin(): Promise<string | null>;
  drainNotes(): string;
  snapshot(): Promise<string>;
  click(ref: string): Promise<string>;
}

/** Raised when an action or evidence capture crosses the origin allowlist. */
export class OriginBoundaryError extends Error {
  override readonly name = "OriginBoundaryError";
}

export class AuthenticationEvidenceError extends Error {
  override readonly name = "AuthenticationEvidenceError";
}

/** Evidence inspection or persistence failed, rather than finding unavailable evidence. */
export class BrowserEvidenceError extends Error {
  override readonly name = "BrowserEvidenceError";
}
