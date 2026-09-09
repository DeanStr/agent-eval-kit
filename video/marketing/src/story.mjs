export const FPS = 30;
export const DURATION = 40;
export const FORMATS = {
  landscape: { id: "HillClimbWide", width: 1920, height: 1080 },
  portrait: { id: "HillClimbFeed", width: 1080, height: 1350 },
};
export const scenes = [
  {
    start: 0,
    end: 4,
    label: "AUTONOMOUS IMPROVEMENT",
    title: ["Give your agent", "something to climb."],
    detail: "A feedback loop for better software.",
    best: null,
    step: -1,
  },
  {
    start: 4,
    end: 8,
    label: "01 / DEFINE BETTER",
    title: ["Start with a rubric.", "Measure the baseline."],
    detail: "Same criteria. Every revision.",
    best: 54,
    score: "54",
    status: "BASELINE",
    step: 0,
  },
  {
    start: 8,
    end: 13,
    label: "02 / TAKE A STEP",
    title: ["Your agent edits.", "AEK measures the gain."],
    detail: "Evidence returns. Your agent keeps the improvement.",
    best: 68,
    score: "68",
    status: "ACCEPTED",
    step: 1,
  },
  {
    start: 13,
    end: 18,
    label: "03 / REJECT A REGRESSION",
    title: ["Higher score.", "Wrong direction."],
    detail: "A critical check fails. Your agent rejects the change.",
    best: 68,
    score: "77",
    status: "REJECTED",
    step: 2,
    tone: "orange",
  },
  {
    start: 18,
    end: 23,
    label: "04 / USE THE FEEDBACK",
    title: ["Revise the approach.", "Keep the next gain."],
    detail: "Critical checks pass. The accepted score climbs.",
    best: 82,
    score: "82",
    status: "ACCEPTED",
    step: 3,
  },
  {
    start: 23,
    end: 28,
    label: "05 / RESPECT UNCERTAINTY",
    title: ["Missing evidence?", "Withhold the score."],
    detail: "58% coverage. Your agent needs more evidence.",
    best: 82,
    score: "—",
    status: "UNVERIFIED",
    step: 4,
    tone: "violet",
  },
  {
    start: 28,
    end: 33,
    label: "06 / CLIMB AGAIN",
    title: ["Another revision.", "A new best."],
    detail: "Evidence guides the next move. Repeat.",
    best: 91,
    score: "91",
    status: "NEW BEST",
    step: 5,
  },
  {
    start: 33,
    end: 40,
    label: "AGENT EVAL KIT",
    title: ["Let your agent", "keep climbing."],
    detail: "Define better. Evaluate. Feed the next move.",
    best: 91,
    step: 5,
    closing: true,
  },
];
export const sampleTimes = [2, 6, 10.5, 15.5, 20.5, 25.5, 30.5, 37];
export function sceneAt(time) {
  if (!Number.isFinite(time) || time < 0 || time >= DURATION)
    throw new Error(`Time outside video: ${time}`);
  return scenes.find((scene) => time >= scene.start && time < scene.end);
}
