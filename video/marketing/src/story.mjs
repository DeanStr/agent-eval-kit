export const FPS = 30;
export const FORMATS = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1350 },
};
const shot = (start, end, kind, title, caption, illustrative = false) => ({
  start,
  end,
  kind,
  title,
  caption,
  illustrative,
});
const HOOK = "Turn ‘make this better’\ninto measured progress.";
const CLOSE = "Give your agent\nsomething to climb.";
export const CUTS = {
  main: {
    duration: 60,
    label: "The product film",
    scenes: [
      shot(
        0,
        6,
        "hook",
        HOOK,
        "One dispatch prototype. AEK evaluates the baseline at 70% against five fixed criteria.",
      ),
      shot(
        6,
        12,
        "target",
        "Define better.\nKeep the standard fixed.",
        "Protect the data and task. Make the phone usable. Support clear decisions with a coherent interface.",
      ),
      shot(
        12,
        19,
        "dispatchFinding",
        "Find what blocks the task.",
        "AEK finds deliveries hidden in a nested phone queue and text down to 9px. Phone: fail.",
      ),
      shot(
        19,
        27,
        "dispatchRevision",
        "Give the agent a concrete fix.",
        "The agent lets the queue scroll with the page and enlarges option text. The same suite scores 90%; craft still needs work.",
      ),
      shot(
        27,
        35,
        "measured",
        "Same suite. Measured progress.",
        "The next agent revision improves type, contrast and map labels. The unchanged suite measures 70% → 90% → 100%; a fresh repeat confirms the final result.",
      ),
      shot(
        35,
        43,
        "result",
        "Now use the improved workflow.",
        "The evaluated final revision keeps the late shipment, its cause and its deadline together, with a readable phone queue.",
      ),
      shot(
        43,
        53,
        "compare",
        "Reassign it. Check the result.",
        "Nina arrives sooner but lacks a temperature-controlled van. Leo arrives at 14:18. The assignment survives reload and can be undone.",
      ),
      shot(
        53,
        60,
        "close",
        CLOSE,
        "Ask your coding agent to build an AEK evaluation suite for your project.",
      ),
    ],
  },
  social: {
    duration: 20,
    label: "The quick cut",
    scenes: [
      shot(0, 3, "hook", HOOK, "One dispatch prototype. Five fixed criteria. Baseline: 70%."),
      shot(
        3,
        7,
        "dispatchFinding",
        "Find what blocks the task.",
        "AEK finds hidden deliveries and 9px phone text.",
      ),
      shot(
        7,
        12,
        "measured",
        "Same suite. Measured progress.",
        "Two coding-agent revisions fix phone usability and craft: 70% → 90% → 100%, measured by the same AEK suite.",
      ),
      shot(
        12,
        16,
        "compare",
        "Reassign it. Check the result.",
        "The evaluated final prototype saves the assignment to Leo at 14:18. Reload and undo are checked.",
      ),
      shot(
        16,
        20,
        "close",
        CLOSE,
        "Ask your coding agent to build an AEK evaluation suite for your project.",
      ),
    ],
  },
  walkthrough: {
    duration: 150,
    label: "Inside the improvement loop",
    scenes: [
      shot(
        0,
        8,
        "hook",
        HOOK,
        "Start with the original dispatch prototype. Human-authored direction becomes five project-specific AEK criteria.",
      ),
      shot(
        8,
        20,
        "target",
        "Make your standards explicit.",
        "Data and task correctness are critical gates. Phone usability, decision quality and craft complete this frozen suite.",
      ),
      shot(
        20,
        33,
        "dispatchFinding",
        "Inspect the evidence.",
        "The baseline scores 70%. Its phone queue hides deliveries in a nested scroll region; text falls to 9px.",
      ),
      shot(
        33,
        47,
        "dispatchRevision",
        "Use findings to guide the edit.",
        "The coding agent makes the queue part of page scrolling and raises option text to 12px. Phone passes; craft remains partial. Score: 90%.",
      ),
      shot(
        47,
        62,
        "measured",
        "Same suite. Measured progress.",
        "The second agent revision improves type, contrast and map labels: 70% → 90% → 100%, under one evaluator. A fresh final repeat confirms the result.",
      ),
      shot(
        62,
        72,
        "result",
        "Use the evaluated final revision.",
        "Inspect the late delivery, its cause and deadline, and the improved phone queue in the same dispatch product.",
      ),
      shot(
        72,
        86,
        "compare",
        "Reassign it. Check the result.",
        "Compare vehicle eligibility, save Leo's 14:18 assignment, reload and undo. The retained browser evidence checks these actions.",
      ),
      shot(
        86,
        98,
        "regression",
        "A higher score is not enough.",
        "Illustrative policy example: an attractive revision loses the saved driver after reload. AEK reports a critical task regression; the coding agent rejects the candidate.",
        true,
      ),
      shot(
        98,
        110,
        "coverage",
        "Missing evidence stays unscored.",
        "Illustrative policy example: persistence stays unscored and coverage falls. Below required coverage, the overall score is withheld. Collector execution errors remain errors.",
        true,
      ),
      shot(
        110,
        120,
        "finding",
        "Another project. Its own criteria.",
        "Separate measured dashboard example: three criteria cover data, overview and phone fit. Central's 180 deliveries are drawn shorter than North's 140.",
      ),
      shot(
        120,
        132,
        "first",
        "The same loop works here too.",
        "The agent corrects the dashboard chart. Its own suite improves from 50% to 83%; the overview still needs work. These scores apply only to this dashboard.",
      ),
      shot(
        132,
        142,
        "author",
        "Bring the loop to your project.",
        "Ask your agent to clarify what good means, author checks, evaluate a baseline, then revise. Use evidence, coverage and gates when selecting candidates.",
      ),
      shot(
        142,
        150,
        "close",
        CLOSE,
        "Your coding agent edits and chooses revisions. AEK supplies evaluations and evidence.",
      ),
    ],
  },
};
export const sampleTimes = [2, 9, 15, 22, 26, 31, 34, 38, 42, 46, 51, 57];
export const sampleGroups = sampleTimes.map((time) => [time]);
export function sceneAt(time, cut = "main") {
  const definition = CUTS[cut];
  if (!definition || !Number.isFinite(time) || time < 0 || time >= definition.duration)
    throw new Error(`Time outside video: ${cut} at ${time}s`);
  const scene = definition.scenes.find((s) => time >= s.start && time < s.end);
  if (!scene) throw new Error(`No scene at ${time}s in ${cut}`);
  return scene;
}
export const compositionId = (cut, format) => `${cut}-${format}`;
export const exportName = (cut, format) => (cut === "main" ? format : `${cut}-${format}`);
export function captionVtt(cut) {
  if (!CUTS[cut]) throw new Error(`Unknown cut: ${cut}`);
  const stamp = (seconds) =>
    `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000`;
  return (
    "WEBVTT\n\n" +
    CUTS[cut].scenes
      .map(
        (s) =>
          `${stamp(s.start)} --> ${stamp(s.end)}\n${s.title.replaceAll("\n", " ")} ${s.caption}\n`,
      )
      .join("\n")
  );
}
