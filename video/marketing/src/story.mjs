export const FPS = 30;
export const DURATION = 100;
export const FORMATS = {
  landscape: { id: "HillClimbWide", width: 1920, height: 1080 },
  portrait: { id: "HillClimbFeed", width: 1080, height: 1350 },
};
export const scenes = [
  {
    start: 0,
    end: 8,
    kind: "summit",
    speed: 1,
    label: "AUTONOMOUS HILL CLIMBING",
    title: "Help your coding agent improve your project.",
  },
  {
    start: 8,
    end: 11,
    kind: "hook",
    speed: 1.2,
    label: "YOUR PROJECT / ONE EXAMPLE",
    title: "Your agent built this.",
  },
  {
    start: 11,
    end: 16,
    kind: "story",
    speed: 1.3,
    label: "01 / THE USER STORY",
    title: "Your stories set the target.",
  },
  {
    start: 16,
    end: 21,
    kind: "run",
    speed: 1.8,
    label: "02 / RUN THE JOURNEY",
    title: "Two lamps. One broken total.",
  },
  {
    start: 21,
    end: 27,
    kind: "inspect",
    speed: 1,
    label: "03 / INSPECT THE FAILURE",
    title: "A failure it can act on.",
  },
  {
    start: 27,
    end: 31,
    kind: "edit",
    speed: 1.7,
    label: "04 / THE CODING AGENT EDITS",
    title: "Evidence becomes the next edit.",
  },
  {
    start: 31,
    end: 37,
    kind: "retest",
    speed: 1.2,
    label: "05 / RUN THE SAME STORY AGAIN",
    title: "Same journey. Better outcome.",
  },
  {
    start: 37,
    end: 43,
    kind: "rubric",
    speed: 1,
    label: "",
    title: "",
  },
  {
    start: 43,
    end: 49,
    kind: "sources",
    speed: 1,
    label: "",
    title: "",
  },
  {
    start: 49,
    end: 57,
    kind: "judges",
    speed: 1.4,
    label: "",
    title: "",
  },
  {
    start: 57,
    end: 63,
    kind: "compare",
    speed: 1,
    label: "",
    title: "",
  },
  {
    start: 63,
    end: 71,
    kind: "loop",
    speed: 1,
    label: "",
    title: "",
  },
  {
    start: 71,
    end: 77,
    kind: "coverage",
    speed: 1,
    label: "",
    title: "",
  },
  {
    start: 77,
    end: 82,
    kind: "breadth",
    speed: 1.2,
    label: "ANOTHER USER STORY",
    title: "Your users define the climb.",
  },
  {
    start: 82,
    end: 94,
    kind: "climb",
    speed: 1,
    label: "ACCEPTED PROGRESS / SAME RUBRIC",
    title: "Every attempt teaches the next.",
  },
  {
    start: 94,
    end: 100,
    kind: "close",
    speed: 1,
    label: "AGENT EVAL KIT",
    title: "Give your agent a way to get better.",
  },
];
export const sampleGroups = [
  [6, 10],
  [13.5, 18.5],
  [23, 26],
  [29.5, 34],
  [36, 40],
  [46, 52],
  [55.8, 60.5],
  [64, 69.5],
  [74, 80],
  [83.5, 85.5],
  [89, 92.5],
  [97.5],
];
export const sampleTimes = sampleGroups.flat();
export function sceneAt(time) {
  if (!Number.isFinite(time) || time < 0 || time >= DURATION)
    throw new Error(`Time outside video: ${time}`);
  const scene = scenes.find((s) => time >= s.start && time < s.end);
  if (!scene) throw new Error(`No scene at ${time}s`);
  return scene;
}
export const CHECKOUT_TIMING = { quantity: 2.4, payStart: 3.4, confirm: 4.8 };
export function cartState(kind, local) {
  if (!["run", "retest"].includes(kind)) throw new Error(`Not a checkout scene: ${kind}`);
  const quantity = local >= CHECKOUT_TIMING.quantity ? 2 : 1;
  const fixed = kind === "retest";
  return {
    quantity,
    total: fixed ? quantity * 120 : 120,
    expected: quantity * 120,
    confirmed: fixed && local >= CHECKOUT_TIMING.confirm,
  };
}
export function panelState(local) {
  const count = local < 5.5 ? 3 : 5;
  const votes =
    local < 2
      ? []
      : local < 7.5
        ? ["PASS", "FAIL", "PASS"]
        : ["PASS", "FAIL", "PASS", "PASS", "PASS"];
  return {
    count,
    votes,
    decision:
      votes.length === 5
        ? "4 / 5 AGREE · PASS"
        : votes.length
          ? "2 / 3 · INCONCLUSIVE"
          : "REVIEWING EVIDENCE",
  };
}

export const WORKFLOW_KINDS = ["rubric", "sources", "judges", "compare", "loop", "coverage"];
export function climbState(t) {
  if (t < 1) return { best: 54, status: "baseline", step: 0 };
  if (t < 2.5) return { best: 68, status: "accepted", step: 1 };
  if (t < 4.5) return { best: 68, status: "rejected", step: 2 };
  if (t < 6.5) return { best: 82, status: "accepted", step: 3 };
  if (t < 9) return { best: 82, status: "withheld", step: 4 };
  return { best: 91, status: "accepted", step: 5 };
}
// Shared carrier geometry keeps the product visible across evaluation phases.
export function carrierAt(time, portrait) {
  const mix = (a, b, f) => a + (b - a) * f;
  const ease = (v) => {
    const x = Math.min(1, Math.max(0, v));
    return x * x * (3 - 2 * x);
  };
  const main = portrait ? { x: 60, y: 255, w: 960, h: 460 } : { x: 100, y: 300, w: 740, h: 620 };
  const source = portrait ? { ...main, x: 110, w: 860, h: 412 } : { ...main, x: 1080 };
  const knots = [
    [37, main],
    [43, main],
    [43.8, source],
    [49, source],
    [49.8, main],
    [62.4, main],
  ];
  const centers = portrait
    ? [
        [540, 600],
        [540, 635],
        [540, 600],
        [540, 600],
      ]
    : [
        [650, 635],
        [680, 610],
        [650, 635],
        [650, 635],
      ];
  const small = portrait ? { w: 900, h: 431 } : { w: 920, h: 770 };
  const at = (point) => ({ x: point[0] - small.w / 2, y: point[1] - small.h / 2, ...small });
  knots.push([63, at(centers[0])]);
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let i = 1; i <= 3; i++) knots.push([63 + cycle * 4 + (i * 4) / 3, at(centers[i])]);
  }
  knots.push([71.8, main], [77, main]);
  for (let i = 1; i < knots.length; i++)
    if (time <= knots[i][0]) {
      const [start, a] = knots[i - 1],
        [end, b] = knots[i];
      const f = ease((time - start) / (end - start));
      return Object.fromEntries(Object.keys(main).map((k) => [k, mix(a[k], b[k], f)]));
    }
  return main;
}
