export interface EvidenceMcpContext {
  /** Directory containing only the screenshots selected for this judge. */
  attachmentRoot: string;
  /** Canonical evidence reference to a file name directly below attachmentRoot. */
  screenshots: Record<string, string>;
  transcriptFile: string;
  maxToolCalls: number;
}
