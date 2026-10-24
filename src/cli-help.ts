const descriptions: Record<string, string> = {
  config: "Configuration file (default: the nearest evalkit.yaml in this or a parent directory).",
  suite: "Select a configured named suite.",
  url: "Override the web target URL.",
  "max-turns": "Positive scenario turn budget; Codex uses an MCP interaction limit.",
  agent: "Collection provider: codex, claude, grok, cursor, or mock.",
  judge: "Judging provider: codex, claude, grok, cursor, or mock.",
  "agent-model": "Collection model ID or alias understood by the provider.",
  "judge-model": "Judging model ID or alias understood by the provider.",
  "judge-effort": "Provider-specific judging effort.",
  headed: "Show the browser during execution.",
  areas: "Comma-separated area IDs; default: required areas.",
  scenarios:
    "Comma-separated scenario/template IDs. Omitting prerequisites blocks their dependents.",
  "include-optional": "Include optional areas when no explicit area list is supplied.",
  split: "development (default), evaluation, or all; unsplit cases are shared.",
  resume:
    "Resume an incomplete run (directory, run ID, or latest) with matching inputs and its original options.",
  "dry-run":
    "Validate and preview execution without creating output or starting services/providers.",
  json: "Print machine-readable results to stdout; progress goes to stderr.",
  debug: "Include error stack traces on stderr.",
  "fail-under-score": "Minimum score percentage, 0–100; unavailable scores fail.",
  "fail-under-coverage": "Minimum evidence coverage percentage, 0–100.",
  "changed-since":
    "Evaluate text dataset cases changed since an intact prior run (directory, run ID, latest, or previous).",
  "text-cases": "Comma-separated area/dataset/case selectors; skipped cases reduce coverage.",
  repetitions: "Total campaign attempts, at least 2 (default: 3).",
  output: "New output directory.",
  recipe: "Benchmark experiment JSON; candidate config and resource paths resolve relative to it.",
  run: "Run directory, run ID from paths.runs, latest, or previous.",
  evidence: "Sealed collection: directory, run ID, latest, or previous.",
  dataset: "Judge-validation dataset JSON with pinned collection identities.",
  labels: "Separate reviewer-label JSON; never passed to judges.",
  configurations: "JSON manifest of named judge configurations.",
  input: "Adjudication decision JSON file outside the run directory.",
  reviewer: "Reviewer identity recorded with the decision or promotion.",
  baseline: "Baseline run: directory, report.json, run ID, latest, or previous.",
  "baseline-name": "Promoted baseline name instead of --baseline.",
  candidate: "Candidate run: directory, report.json, run ID, latest, or previous.",
  "fail-on-regression": "Exit 2 when comparable results regress or lose coverage.",
  "max-score-drop": "Largest permitted score drop, in percentage points (0–100).",
  "max-coverage-drop": "Largest permitted coverage drop, in percentage points (0–100).",
  "allow-incompatible":
    "Record an exploratory compatibility override and enable numeric comparisons.",
  name: "Name for the promoted baseline or text reference.",
  "include-images": "Copy screenshot pixels into the promoted baseline.",
  mode: "Promotion mode: release (default) or milestone; milestone requires --reason.",
  reason: "Recorded reason for milestone promotion.",
  public: "Required: export minimal results without private evidence, then privacy-lint them.",
  path: "File or directory to scan for likely private data.",
  providers: "Comma-separated providers to check without model calls.",
  persona: "Named browser identity to authenticate.",
  at: "Login path relative to the target (default: target URL).",
  click: "Visible control text to click before capturing the session.",
  email: "Use the persona's configured magic-link or verification-code flow.",
  kind: "Starter: web (default), repository, command, artifact, or visual.",
  directory: "Skill installation directory (default: .agents/skills).",
  interactive: "Prompt for each pending manual verdict instead of reading manual-results.json.",
  keep: "Keep this many newest runs.",
  "older-than": "Delete only runs started more than this many days ago.",
  limit: "Show at most this many newest runs (default: 20).",
  goal: "Product improvement objective; acceptance comes from the frozen suite.",
  session: "Existing improvement session directory.",
  hypothesis: "Concrete change and expected benefit, recorded before editing.",
  guidance: "Optional UTF-8 repair notes (max 64 KiB); never supplied to acceptance judges.",
  "max-attempts": "Maximum candidate attempts, 1–100 (default: 3).",
  "max-stalls":
    "Stop after this many consecutive attempts without improvement, 1–100 (default: 2).",
  "budget-seconds": "Session wall-clock budget, including edits, 1–86400 (default: 3600).",
  "minimum-gain": "Minimum score gain in percentage points, 0–100; ties always fail (default: 0).",
  project: "Project directory (default: current directory).",
  description: "Scope of the authoring project or feature.",
  "require-ready": "Exit 2 for a valid but incomplete authoring inventory.",
  manifest: "JSON image batch manifest; image paths resolve relative to this file.",
  concurrency: "Maximum simultaneous image comparisons, 1–8 (default: 2).",
  reuse: "Prior image batch; reuse completed identical comparisons, including failures.",
  "capacity-retries": "Retries for explicit temporary judge capacity errors, 0–5 (default: 2).",
  reference: "Reference image file.",
  criterion: "Required relative image-quality criterion.",
  "absolute-criterion": "Optional independent candidate-only quality gate.",
  policy: "non_regression (default) accepts equivalence; preference requires a win.",
  "timeout-seconds": "Positive per-invocation timeout in seconds (default: 900).",
  "minimum-votes": "Minimum votes per check, 1–25 (default: 5).",
  "maximum-votes": "Maximum votes, 1–25 and >= minimum (default: 9).",
  agreement: "Required agreement, greater than 0.5 and <= 1 (default: 0.8).",
  "minimum-confidence": "Confidence floor, 0–1 (default: 0.55).",
  width: "Comparison panel width, 1–2000 pixels (default: 1280).",
  height: "Comparison panel height, 1–2000 pixels (default: 800).",
  help: "Show help for this command.",
};

/** Value names shown after each flag; boolean flags have none. */
const placeholders: Record<string, string> = {
  config: "file",
  suite: "name",
  url: "url",
  "max-turns": "n",
  agent: "provider",
  judge: "provider",
  "agent-model": "id",
  "judge-model": "id",
  "judge-effort": "level",
  areas: "a,b",
  scenarios: "x,y",
  split: "split",
  resume: "run",
  "fail-under-score": "pct",
  "fail-under-coverage": "pct",
  "changed-since": "run",
  "text-cases": "a/d/c,…",
  repetitions: "n",
  output: "dir",
  recipe: "file",
  run: "run",
  evidence: "run",
  dataset: "file",
  labels: "file",
  configurations: "file",
  input: "file",
  reviewer: "name",
  baseline: "run",
  "baseline-name": "name",
  candidate: "run",
  "max-score-drop": "points",
  "max-coverage-drop": "points",
  name: "name",
  mode: "mode",
  reason: "text",
  path: "path",
  providers: "a,b",
  persona: "name",
  at: "path",
  click: "text",
  kind: "kind",
  directory: "dir",
  goal: "text",
  session: "dir",
  hypothesis: "text",
  guidance: "file",
  "max-attempts": "n",
  "max-stalls": "n",
  "budget-seconds": "seconds",
  "minimum-gain": "points",
  project: "dir",
  description: "text",
  manifest: "file",
  concurrency: "n",
  reuse: "dir",
  "capacity-retries": "n",
  reference: "file",
  criterion: "text",
  "absolute-criterion": "text",
  policy: "policy",
  "timeout-seconds": "seconds",
  "minimum-votes": "n",
  "maximum-votes": "n",
  agreement: "fraction",
  "minimum-confidence": "fraction",
  width: "pixels",
  height: "pixels",
  keep: "n",
  "older-than": "days",
  limit: "n",
};

/** Descriptions that differ by command, keyed by `<command> --<flag>`. */
const contextual: Record<string, string> = {
  "image compare --candidate": "Candidate image file.",
  "image compare --output": "New output directory (default: .agent-eval/image-comparisons/<id>).",
  "author init --mode": "Authoring scope: project (default) or feature.",
  "improve stop --reason": "Reason for ending this session and restoring its best checkpoint.",
  "improve start --output":
    "New session directory outside the source checkout; owns its candidate Git worktree.",
  "improve start --repetitions":
    "Evaluate baseline and candidates as 2–20-run campaigns; omit for single-run acceptance.",
  "campaign --resume":
    "Continue only unstarted repetitions; only --json and --debug may accompany it. Retains failures and thresholds.",
  "campaign --output": "New campaign directory (default: campaigns/ beside paths.runs).",
  "campaign compare --baseline": "Baseline campaign directory or campaign.json.",
  "campaign compare --candidate": "Candidate campaign directory or campaign.json.",
  "campaign compare --output": "New comparison directory (default: inside the candidate campaign).",
  "compare --output": "New comparison directory (default: the candidate run's comparisons/).",
  "compare --config":
    "Configuration for resolving run IDs and --baseline-name (default: nearest evalkit.yaml).",
  "export --output": "New export directory (default: exports/<run-id> beside paths.runs).",
  "export --config": "Configuration for resolving run IDs (default: nearest evalkit.yaml).",
  "verify --config": "Configuration for resolving run IDs (default: nearest evalkit.yaml).",
  "rescore --config": "Current project configuration to rescore with (default: the run's config).",
  "finalize --config": "Current project configuration (default: the run's recorded config).",
  "adjudicate --config": "Current project configuration (default: the run's recorded config).",
  "judge --resume": "Resume an incomplete judging run (directory, run ID, or latest).",
  "collect --resume": "Resume an incomplete collection (directory, run ID, or latest).",
  "init --agent": "Collection provider (default: a signed-in provider; command starters use mock).",
  "init --judge":
    "Judging provider (default: a signed-in provider other than the agent when available).",
  "skills install --agent":
    "Coding agent: claude installs into .claude/skills; codex, cursor, and grok into .agents/skills.",
  "skills install --directory":
    "Installation directory (default: .claude/skills when only .claude/ exists, else .agents/skills).",
  "check --areas": "Only checkers in these area IDs.",
  "runs prune --dry-run": "List the runs that would be deleted without deleting them.",
  "auth --json": "Print the result as JSON.",
  "author install --json": "Print the result as JSON.",
  "author init --json": "Print the result as JSON.",
  "author status --json": "Print the result as JSON.",
  "author validate --json": "Print the result as JSON.",
  "image compare --json": "Print the execution preview as JSON; requires --dry-run.",
  "image batch --json": "Print the execution preview as JSON; requires --dry-run.",
};

const usages: Record<string, string> = {
  "image batch": "--manifest file.json [options] | --resume directory",
  "image compare": "--candidate file --reference file --criterion text [options]",
  "author install": "[--directory directory]",
  "improve install": "[--directory directory] [--json]",
  "improve start":
    "--goal text --output new-directory [--config file] [--suite name] [--repetitions n] [options]",
  "improve attempt": "--session directory --hypothesis text [--json]",
  "improve evaluate": "--session directory [--guidance file] [--json]",
  "improve status": "--session directory [--json]",
  "improve stop": "--session directory --reason text [--json]",
  "author init": "[--project directory] [--mode project|feature] [--description text]",
  "author status": "[--project directory] [--json] [--require-ready]",
  "author validate": "[--project directory] [--json] [--require-ready]",
  init: "[directory] [--kind web|repository|command|artifact|visual] [options]",
  check: "[item | area/item ...] [options]",
  "runs list": "[--limit n] [--config file]",
  "runs prune": "--keep n | --older-than days [--dry-run] [--config file]",
  "skills install": "[--agent claude|codex|cursor|grok] [--directory dir]",
  validate: "[--config file] [--suite name]",
  list: "[--config file] [--suite name]",
  doctor: "[--config file] [--suite name] [--providers a,b]",
  run: "[options] [--resume run]",
  collect: "[options] [--resume run]",
  campaign: "[options] | --resume directory",
  "campaign compare": "--baseline campaign --candidate campaign [options]",
  "benchmark experiment": "--recipe recipe.json --output new-directory",
  judge: "--evidence collection [options] | --resume judging-directory [options]",
  "judge validate":
    "--dataset cases.json --labels labels.json --configurations configurations.json --output new-directory",
  verify: "--run run",
  export: "--public --run run [--output dir]",
  "privacy lint": "--path file-or-directory",
  auth: "--persona name [options]",
  rescore: "--run run [options]",
  finalize: "--run run [--interactive] [options]",
  adjudicate: "--run run --input decisions.json --reviewer name [options]",
  compare: "(--baseline run | --baseline-name name) --candidate run [options]",
  "baseline promote": "--run run --name name --reviewer name [options]",
  "baseline list": "[--config file] [--suite name]",
  "reference promote": "--run run --name name --reviewer name [options]",
  "reference list": "[--config file] [--suite name]",
};

function commandUsage(command: string): string {
  if (!Object.hasOwn(usages, command)) throw new Error(`Missing CLI usage for ${command}`);
  return usages[command]!;
}

export function commandHelp(
  command: string,
  positional: string | undefined,
  flags: string[],
  booleans: Set<string>,
): string {
  const groups: Record<string, string[]> = {
    benchmark: ["experiment"],
    image: ["compare", "batch"],
    author: ["install", "init", "status", "validate"],
    improve: ["install", "start", "attempt", "evaluate", "status", "stop"],
    baseline: ["promote", "list"],
    reference: ["promote", "list"],
    privacy: ["lint"],
    runs: ["list", "prune"],
    skills: ["install"],
  };
  if (!positional && groups[command])
    return `Usage: aek ${command} <${groups[command].join("|")}>\n\nCommands:\n${groups[command].map((subcommand) => `  aek ${command} ${subcommand} ${commandUsage(`${command} ${subcommand}`)}`).join("\n")}\n\nUse aek ${command} <command> --help for exact options.`;
  const key =
    ["init", "check"].includes(command) || !positional ? command : `${command} ${positional}`;
  const lines = flags.map((flag) => {
    const description = contextual[`${key} --${flag}`] ?? descriptions[flag];
    if (!description) throw new Error(`Missing CLI help for --${flag}`);
    const placeholder = booleans.has(flag)
      ? ""
      : ` <${(key === "skills install" && flag === "agent" ? "agent" : placeholders[flag]) ?? ""}>`;
    if (placeholder === " <>") throw new Error(`Missing CLI placeholder for --${flag}`);
    return `  ${`--${flag}${placeholder}`.padEnd(30)} ${description}`;
  });
  const exit =
    command === "improve"
      ? "Exit: 0 completed (evaluate: accepted); 1 input/execution error; 2 rejected, inconclusive, time budget exhausted, or no new attempt permitted; 130/143 interrupted. Status/stop return 0 for successful inspection/stopping."
      : key === "judge validate"
        ? "Exit: 0 completed (reviewer disagreements do not fail); 1 input/execution error; 130/143 interrupted."
        : key === "benchmark experiment"
          ? "Uses explicit candidate blocks and a shared resource lock. Output resolves from the working directory. Reports descriptive differences; no automatic performance acceptance.\n\nExit: 0 compared; 1 input/execution error; 2 requirement failure or inconclusive; 130/143 interrupted."
          : "Exit: 0 completed; 1 input/execution error; 2 acceptance failure; 130/143 interrupted.";
  return `Usage: aek ${key} ${commandUsage(key)}\n\nOptions:\n${lines.join("\n")}\n\n${command === "judge" && !positional ? "Also: aek judge validate --help for reviewed-evidence validation.\n\n" : ""}${exit}`;
}
