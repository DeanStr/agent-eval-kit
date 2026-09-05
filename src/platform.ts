export const NATIVE_WINDOWS_ERROR =
  "Native Windows evaluation is not supported. Run AEK inside WSL/Linux using Linux Node.js, provider CLIs, and browser dependencies; Windows executables launched from WSL are not supported.";

export function assertEvaluationPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") throw new Error(NATIVE_WINDOWS_ERROR);
}
