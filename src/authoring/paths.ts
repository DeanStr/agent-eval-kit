import path from "node:path";

/** Project-owned authoring notes are never product evidence or target inputs. */
export const AUTHORING_DIRECTORY = ".aek-authoring";

export function authoringDirectory(projectRoot: string): string {
  return path.join(projectRoot, AUTHORING_DIRECTORY);
}
