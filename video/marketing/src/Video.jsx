import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
  useVideoConfig,
  delayRender,
  continueRender,
  cancelRender,
} from "remotion";
import { CUTS, sceneAt } from "./story.mjs";
const C = {
  bg: "#111e19",
  panel: "#1c2e25",
  ink: "#f3f3e9",
  muted: "#b2c7b9",
  lime: "#d9fc86",
  red: "#ffb39d",
  line: "#3a5142",
  paper: "#f3f4ee",
  dark: "#18352e",
  amber: "#f0d79a",
  risk: "#a04b27",
  mark: "#c9792f",
  ok: "#3f7d4f",
};
const at = (x, y, w, h) => ({ position: "absolute", left: x, top: y, width: w, height: h });
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (time, start = 0, duration = 0.65) =>
  1 - (1 - clamp01((time - start) / duration)) ** 3;
// Symmetric easing for camera moves, so pans start and settle gently.
const glide = (time, start, duration) => {
  const x = clamp01((time - start) / duration);
  return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
};
const mix = (a, b, k) => a + (b - a) * k;
const mixView = (a, b, k) => ({
  cx: mix(a.cx, b.cx, k),
  cy: mix(a.cy, b.cy, k),
  width: mix(a.width, b.width, k),
});
// Camera keyframes: [[seconds, view], ...], gliding between consecutive views.
const track = (t, keys) => {
  for (let i = 1; i < keys.length; i++)
    if (t < keys[i][0])
      return mixView(
        keys[i - 1][1],
        keys[i][1],
        glide(t, keys[i - 1][0], keys[i][0] - keys[i - 1][0]),
      );
  return keys.at(-1)[1];
};
// The whole capture, letterboxed inside a w × h frame.
const fit = (shot, w, h) => ({
  cx: shot.width / 2,
  cy: shot.height / 2,
  width: Math.max(shot.width, (shot.height * w) / h),
});
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const first = (name) => name.split(" ")[0];
const pct = (value) => `${Math.round(value)}%`;
const status = {
  pass: { label: "Pass", color: C.lime },
  partial: { label: "Needs work", color: C.amber },
  fail: { label: "Fail", color: C.red },
};
const names = { DATA: "Data", TASK: "Task", PHONE: "Phone", DECISION: "Decision", CRAFT: "Craft" };
function Label({ children, style = {} }) {
  return (
    <div
      style={{
        fontSize: 24,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        color: C.muted,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
function Panel({ children, style = {} }) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 18,
        background: C.panel,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
// Frames a capture like a camera. `view` is the visible centre and width in the
// capture's CSS pixels; marks are measured element boxes from the same capture.
function Camera({ shot, x, y, w, h, view, marks = [], opacity = 1, clip, shadow = true }) {
  const scale = w / view.width,
    visible = h / scale;
  const cx =
    shot.width <= view.width
      ? shot.width / 2
      : Math.min(Math.max(view.cx, view.width / 2), shot.width - view.width / 2);
  const cy =
    shot.height <= visible
      ? shot.height / 2
      : Math.min(Math.max(view.cy, visible / 2), shot.height - visible / 2);
  const left = w / 2 - cx * scale,
    top = h / 2 - cy * scale;
  return (
    <div
      style={{
        ...at(x, y, w, h),
        borderRadius: 14,
        overflow: "hidden",
        background: C.paper,
        boxShadow: shadow ? "0 20px 70px #0004" : "none",
        opacity,
        clipPath: clip,
      }}
    >
      <Img
        src={shot.src}
        style={{
          position: "absolute",
          left,
          top,
          width: shot.width * scale,
          height: shot.height * scale,
        }}
      />
      {marks.map((mark, i) =>
        mark.k > 0 ? (
          mark.pulse ? (
            <Pulse key={i} {...mark} left={left} top={top} scale={scale} />
          ) : (
            <Mark key={i} {...mark} left={left} top={top} scale={scale} />
          )
        ) : null,
      )}
    </div>
  );
}
function Mark({ box, color, k, left, top, scale, inset = false }) {
  // Inset marks outline full-width regions inside the frame instead of beyond it.
  const grow = (inset ? -4 : 10) + (1 - k) * 16;
  return (
    <div
      style={{
        position: "absolute",
        left: left + box.x * scale - grow,
        top: top + box.y * scale - grow,
        width: box.width * scale + grow * 2,
        height: box.height * scale + grow * 2,
        border: `4px solid ${color}`,
        borderRadius: 12,
        boxShadow: `0 0 0 8px ${color}2e`,
        opacity: k,
      }}
    />
  );
}
function Pulse({ box, color, k, left, top, scale }) {
  const point = center(box),
    radius = 18 + k * 70;
  return (
    <div
      style={{
        position: "absolute",
        left: left + point.x * scale - radius,
        top: top + point.y * scale - radius,
        width: radius * 2,
        height: radius * 2,
        borderRadius: "50%",
        border: `5px solid ${color}`,
        opacity: 1 - k,
      }}
    />
  );
}
function Heading({ scene, p }) {
  return (
    <div
      style={{
        ...at(p ? 64 : 96, 145, p ? 952 : 1728, 180),
        fontSize: p ? 76 : 85,
        fontWeight: 520,
        letterSpacing: -3.8,
        lineHeight: 1.07,
        whiteSpace: "pre-line",
      }}
    >
      {scene.title}
    </div>
  );
}
function Reveal({ t, start, children, style = {} }) {
  const k = ease(t, start, 0.55);
  return (
    <div style={{ opacity: k, transform: `translateY(${(1 - k) * 18}px)`, ...style }}>
      {children}
    </div>
  );
}
function Hook({ p, t, d, workflow }) {
  const box = p ? { x: 64, y: 695, w: 952, h: 480 } : { x: 990, y: 255, w: 834, h: 560 };
  const workspace = workflow.screenshots.desktopBaseline;
  return (
    <>
      <div
        style={{
          ...at(p ? 64 : 96, p ? 150 : 205, p ? 952 : 860, 440),
          fontSize: p ? 84 : 96,
          lineHeight: 1.04,
          letterSpacing: -4.5,
          fontWeight: 510,
        }}
      >
        Turn{" "}
        <span style={{ color: C.lime }}>
          “make
          <br />
          this better”
        </span>
        <br />
        into measured
        <br />
        progress.
      </div>
      <div
        style={{
          ...at(p ? 64 : 96, p ? 528 : 690, p ? 952 : 760, 120),
          fontSize: p ? 31 : 34,
          color: C.muted,
          lineHeight: 1.4,
        }}
      >
        Your standards become feedback
        <br />
        your coding agent can act on.
      </div>
      <Label
        style={{
          ...at(box.x, box.y - 48, box.w, 40),
          color: C.lime,
        }}
      >
        Dispatch baseline · {pct(workflow.evaluation.results[0].score)}
      </Label>
      <div
        style={{
          opacity: ease(t, 0.1),
          transform: `translateY(${(1 - ease(t, 0.1)) * 24}px)`,
        }}
      >
        <Camera
          shot={workspace}
          {...box}
          view={mixView(
            { cx: 720, cy: workspace.height * 0.56, width: 1440 },
            { cx: 720, cy: workspace.height * 0.44, width: 1440 },
            glide(t, 0, d),
          )}
        />
      </div>
      <div
        style={{
          ...at(box.x, box.y + box.h + 22, box.w, 45),
          fontSize: 26,
          color: C.lime,
        }}
      >
        Standards → Evaluation → Agent revision → Repeat
      </div>
    </>
  );
}
const standards = [
  [
    "01",
    "Protect the task",
    "Correct records. A saved, reversible assignment.",
    "Data + Task · Critical gates",
  ],
  [
    "02",
    "Work on a phone",
    "Every delivery reachable. Readable options.",
    "Phone · Browser checks",
  ],
  [
    "03",
    "Make decisions clear",
    "Visible constraints. A coherent interface.",
    "Decision + Craft · Fresh judges",
  ],
];
function Target({ p, t, d }) {
  return (
    <>
      <div
        style={{
          ...at(p ? 64 : 96, p ? 365 : 370, p ? 952 : 1728, p ? 735 : 500),
          display: "flex",
          flexDirection: p ? "column" : "row",
          gap: p ? 20 : 24,
          transform: `translateY(${-10 * glide(t, 0, d)}px)`,
        }}
      >
        {standards.map(([number, title, body, method], i) => (
          <Panel
            key={number}
            style={{
              flex: 1,
              padding: p ? "28px 34px" : "36px",
              opacity: ease(t, i * 0.16),
              transform: `translateY(${(1 - ease(t, i * 0.16)) * 24}px)`,
            }}
          >
            <Label style={{ color: C.lime, fontSize: 25 }}>{number} / Your standard</Label>
            <div
              style={{
                fontSize: p ? 43 : 47,
                letterSpacing: -1.8,
                lineHeight: 1.15,
                marginTop: p ? 15 : 48,
              }}
            >
              {title}
            </div>
            <div
              style={{
                fontSize: p ? 27 : 31,
                color: C.muted,
                lineHeight: 1.4,
                marginTop: p ? 10 : 24,
              }}
            >
              {body}
            </div>
            <div
              style={{
                fontSize: 23,
                color: C.lime,
                marginTop: p ? 13 : 48,
                opacity: ease(t, d * 0.3 + i * 0.35),
              }}
            >
              {method}
            </div>
          </Panel>
        ))}
      </div>
      {!p && (
        <Reveal t={t} start={d * 0.55} style={at(96, 900, 1700, 45)}>
          <div style={{ fontSize: 29, color: C.muted }}>
            Five criteria. One frozen evaluator across every revision.
          </div>
        </Reveal>
      )}
    </>
  );
}
function DispatchFinding({ p, t, d, workflow }) {
  const shot = workflow.screenshots.mobileQueueBaseline;
  const baseline = workflow.evaluation.results[0];
  const box = p ? { x: 274, y: 600, w: 532, h: 655 } : { x: 1190, y: 325, w: 540, h: 650 };
  return (
    <>
      <div style={at(p ? 64 : 96, p ? 340 : 365, p ? 952 : 920, 450)}>
        <Label style={{ color: C.red }}>
          AEK finding / Phone: {status[baseline.items.PHONE.verdict].label}
        </Label>
        <div style={{ fontSize: p ? 54 : 68, letterSpacing: -2, lineHeight: 1.15, marginTop: 22 }}>
          Hidden deliveries.
          <br />
          Text down to <span style={{ color: C.red }}>9px.</span>
        </div>
        <Reveal
          t={t}
          start={d * 0.32}
          style={{ marginTop: 26, fontSize: p ? 28 : 34, color: C.muted }}
        >
          The phone queue traps rows inside its own scroll.
        </Reveal>
        {!p && (
          <div style={{ marginTop: 45, fontSize: 40 }}>Baseline score: {pct(baseline.score)}</div>
        )}
      </div>
      <Camera
        shot={shot}
        {...box}
        view={mixView(
          fit(shot, box.w, box.h),
          { cx: shot.width / 2, cy: shot.height / 2, width: shot.width },
          glide(t, 0, d),
        )}
        marks={[{ box: shot.regions.rows, color: C.risk, k: ease(t, d * 0.18), inset: true }]}
      />
    </>
  );
}

function DispatchRevision({ p, t, d, workflow }) {
  const before = workflow.screenshots.mobileQueueBaseline;
  const after = workflow.screenshots.mobileQueueRevision;
  const [baseline, revision] = workflow.evaluation.results;
  const boxes = p
    ? [
        { x: 64, y: 800, w: 460, h: 460 },
        { x: 556, y: 800, w: 460, h: 460 },
      ]
    : [
        { x: 930, y: 380, w: 420, h: 580 },
        { x: 1404, y: 380, w: 420, h: 580 },
      ];
  return (
    <>
      <div style={at(p ? 64 : 96, p ? 335 : 350, p ? 952 : 760, 420)}>
        <Label style={{ color: C.lime }}>Agent revision 01 / Phone queue</Label>
        <div style={{ fontSize: p ? 43 : 55, lineHeight: 1.2, letterSpacing: -1.5, marginTop: 20 }}>
          Scroll the whole page.
          <br />
          Make the options readable.
        </div>
        <Reveal t={t} start={d * 0.25} style={{ marginTop: 22 }}>
          <Steps
            values={[baseline.score, revision.score]}
            t={t}
            starts={[0, d * 0.25]}
            size={p ? 56 : 72}
          />
          <div style={{ fontSize: p ? 27 : 32, color: C.lime, marginTop: 16 }}>
            Same suite · Phone: {status[revision.items.PHONE.verdict].label}
          </div>
          <div style={{ fontSize: p ? 27 : 32, color: C.amber, marginTop: 10 }}>
            Craft: {status[revision.items.CRAFT.verdict].label}
          </div>
        </Reveal>
      </div>
      <Label style={{ ...at(boxes[0].x, boxes[0].y - 40, boxes[0].w, 35), fontSize: 22 }}>
        Baseline
      </Label>
      <Label
        style={{ ...at(boxes[1].x, boxes[1].y - 40, boxes[1].w, 35), fontSize: 22, color: C.lime }}
      >
        After agent revision 01
      </Label>
      <Camera shot={before} {...boxes[0]} view={fit(before, boxes[0].w, boxes[0].h)} />
      <Camera
        shot={after}
        {...boxes[1]}
        opacity={ease(t, d * 0.2)}
        view={{
          cx: after.width / 2,
          cy: mix(0, after.height, glide(t, d * 0.25, d * 0.7)),
          width: after.width,
        }}
      />
    </>
  );
}

function Policy({ p, t, label, left, right, color }) {
  const boxes = p
    ? [
        { x: 64, y: 420, w: 952, h: 390 },
        { x: 64, y: 850, w: 952, h: 390 },
      ]
    : [
        { x: 96, y: 400, w: 820, h: 480 },
        { x: 1004, y: 400, w: 820, h: 480 },
      ];
  return (
    <>
      <Label
        style={{
          ...at(p ? 64 : 96, 335, p ? 952 : 1728, 60),
          fontSize: p ? 25 : 28,
          color: C.amber,
        }}
      >
        Illustrative policy example · {label}
      </Label>
      {[left, right].map((card, i) => (
        <Reveal key={card.title} t={t} start={i * 1.2}>
          <Panel
            style={{
              ...at(boxes[i].x, boxes[i].y, boxes[i].w, boxes[i].h),
              padding: 38,
              boxSizing: "border-box",
            }}
          >
            <Label style={{ color: i ? C.lime : color }}>{card.label}</Label>
            <div
              style={{
                fontSize: p ? 48 : 57,
                lineHeight: 1.14,
                letterSpacing: -1.5,
                marginTop: 25,
              }}
            >
              {card.title}
            </div>
            <div style={{ fontSize: p ? 27 : 32, color: C.muted, lineHeight: 1.4, marginTop: 24 }}>
              {card.body}
            </div>
          </Panel>
        </Reveal>
      ))}
    </>
  );
}
function Regression({ p, t }) {
  return (
    <Policy
      p={p}
      t={t}
      label="Critical regression"
      color={C.red}
      left={{
        label: "AEK / Task gate: fail",
        title: "Looks better. Loses the assignment.",
        body: "The saved driver disappears after reload.",
      }}
      right={{
        label: "Coding agent / Reject candidate",
        title: "Keep the accepted revision.",
        body: "A higher score cannot override a critical failure.",
      }}
    />
  );
}
function Coverage({ p, t }) {
  return (
    <Policy
      p={p}
      t={t}
      label="Insufficient evidence"
      color={C.amber}
      left={{
        label: "Persistence / Not scored",
        title: "The scenario was blocked.",
        body: "No observed reload result. Coverage falls; this is not a zero.",
      }}
      right={{
        label: "Below required coverage",
        title: "Overall score withheld.",
        body: "Gather the missing evidence before selecting. Collector execution errors remain errors.",
      }}
    />
  );
}

function Finding({ p, t, d, proof }) {
  const rows = proof.phoneRows.baseline,
    north = rows.find((x) => x.region === "North"),
    central = rows.find((x) => x.region === "Central");
  const box = p ? { x: 64, y: 570, w: 952, h: 510 } : { x: 1000, y: 345, w: 824, h: 520 };
  const rowsTop = north.bar.y,
    rowsBottom = Math.max(...rows.map((x) => x.bar.y + x.bar.height));
  return (
    <>
      <div
        style={{
          ...at(p ? 64 : 96, p ? 350 : 365, p ? 952 : 760, 240),
          fontSize: p ? 53 : 62,
          letterSpacing: -2,
          lineHeight: 1.15,
        }}
      >
        {central.value} deliveries.
        <br />
        <span style={{ color: C.red }}>A shorter bar than {north.value}.</span>
      </div>
      <Label style={{ ...at(box.x, box.y - 50, box.w, 40), color: C.lime, fontSize: 28 }}>
        Phone view · Original dashboard
      </Label>
      <Camera
        shot={proof.screenshots.baselineMobile}
        {...box}
        view={mixView(
          { cx: 187, cy: (rowsTop + rowsBottom) / 2, width: 375 },
          { cx: 190, cy: (rowsTop + rowsBottom) / 2 - 4, width: 360 },
          glide(t, 0, d),
        )}
        marks={[
          { box: north.bar, color: C.mark, k: ease(t, d * 0.2) },
          { box: central.bar, color: C.risk, k: ease(t, d * 0.38) },
        ]}
      />
      <Panel
        style={{
          ...at(p ? 64 : 96, p ? 1110 : 640, p ? 952 : 760, p ? 150 : 200),
          padding: p ? "20px 28px" : "30px",
          boxSizing: "border-box",
        }}
      >
        <Label style={{ color: C.red, fontSize: p ? 24 : 26 }}>
          AEK / Data accuracy · {status[proof.results.baseline.items.DATA.verdict].label}
        </Label>
        <Reveal t={t} start={d * 0.45}>
          <div style={{ fontSize: p ? 27 : 30, color: C.muted, lineHeight: 1.5, marginTop: 14 }}>
            North: {north.value} deliveries · {north.bar.width.toFixed(1)}px bar
            <br />
            Central: {central.value} deliveries · {central.bar.width.toFixed(1)}px bar
          </div>
        </Reveal>
      </Panel>
    </>
  );
}
function First({ p, t, d, proof }) {
  const before = proof.phoneRows.baseline.find((x) => x.region === "Central"),
    after = proof.phoneRows.proportions.find((x) => x.region === "Central");
  const wipe = glide(t, 0.3, 0.9),
    push = glide(t, 0, d),
    view = p
      ? { cx: 187, cy: 263, width: 375 - 20 * push }
      : { cx: 190, cy: 295, width: 360 - 20 * push };
  const boxes = p
    ? [
        { x: 64, y: 440, w: 952, h: 285 },
        { x: 64, y: 790, w: 952, h: 285 },
      ]
    : [
        { x: 96, y: 440, w: 745, h: 360 },
        { x: 1079, y: 440, w: 745, h: 360 },
      ];
  const score = proof.results.proportions.score;
  return (
    <>
      <Label style={{ ...at(p ? 64 : 96, p ? 345 : 330, 900, 40) }}>
        Separate dashboard suite / Correct the phone chart
      </Label>
      <Label style={{ ...at(boxes[0].x, boxes[0].y - 42, 600, 36), fontSize: 22 }}>Before</Label>
      <Label style={{ ...at(boxes[1].x, boxes[1].y - 42, 600, 36), fontSize: 22, color: C.lime }}>
        Agent revision
      </Label>
      <Camera
        shot={proof.screenshots.baselineMobile}
        {...boxes[0]}
        view={view}
        marks={[{ box: before.bar, color: C.risk, k: 1 - ease(t, 1.6) * 0.6 }]}
      />
      <Camera
        shot={proof.screenshots.proportionsMobile}
        {...boxes[1]}
        view={view}
        clip={`inset(0 ${(1 - wipe) * 100}% 0 0 round 14px)`}
        marks={[{ box: after.bar, color: C.ok, k: ease(t, 1.4) }]}
      />
      {!p && (
        <div style={{ ...at(915, 570, 120, 100), fontSize: 76, color: C.lime, opacity: wipe }}>
          →
        </div>
      )}
      <div
        style={{
          ...at(p ? 64 : 96, p ? 1100 : 840, p ? 952 : 1728, 120),
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          gap: p ? "8px 28px" : 36,
          fontSize: p ? 30 : 35,
        }}
      >
        <span style={{ fontSize: p ? 44 : 50, letterSpacing: -1.5 }}>
          Score {pct(proof.results.baseline.score)} →{" "}
          <span style={{ color: C.lime }}>{pct(score)}</span>
        </span>
        <span style={{ color: C.lime, opacity: ease(t, 1.6) }}>
          Data: {status[proof.results.proportions.items.DATA.verdict].label}
        </span>
        <span style={{ color: C.amber, opacity: ease(t, 2) }}>
          Overview: {status[proof.results.proportions.items.OVERVIEW.verdict].label}
        </span>
      </div>
    </>
  );
}
function Steps({ values, t, starts, size }) {
  return (
    <div style={{ fontSize: size, letterSpacing: -2, lineHeight: 1.1 }}>
      {values.map((value, i) => (
        <span key={i} style={{ opacity: ease(t, starts[i], 0.45) }}>
          {i > 0 && <span style={{ color: C.muted }}> → </span>}
          <span style={{ color: i === values.length - 1 ? C.lime : C.ink }}>{pct(value)}</span>
        </span>
      ))}
    </div>
  );
}
function Callouts({ p, t, d, facts }) {
  const s = facts.shipment;
  const big = p ? 54 : 64;
  return (
    <div style={{ color: C.dark }}>
      <Reveal t={t} start={d * 0.12}>
        <Label style={{ color: C.dark, fontSize: 24 }}>{s.name} · at risk</Label>
      </Reveal>
      <Reveal t={t} start={d * 0.42} style={{ marginTop: p ? 26 : 34 }}>
        <div style={{ fontSize: 27 }}>Estimated arrival</div>
        <div style={{ fontSize: big, letterSpacing: -2.5, color: C.risk }}>{s.eta}</div>
        <div style={{ fontSize: 27, marginTop: 12 }}>
          Due {s.due} · {s.timing}
        </div>
      </Reveal>
      <Reveal t={t} start={d * 0.62} style={{ marginTop: p ? 26 : 34 }}>
        <div style={{ fontSize: p ? 27 : 30, lineHeight: 1.4 }}>{s.cause}</div>
      </Reveal>
    </div>
  );
}
function Result({ p, t, d, workflow, cut }) {
  const facts = workflow.facts;
  const label = (
    <Label
      style={{
        ...at(p ? 64 : 96, p ? 322 : 275, p ? 952 : 1728, 40),
        color: C.dark,
        fontSize: 23,
        textTransform: "none",
        letterSpacing: 0,
      }}
    >
      Same dispatch product. Two evaluated agent revisions.
    </Label>
  );
  if (p) {
    const shot = workflow.screenshots.mobileWorkspace,
      r = shot.regions;
    return (
      <>
        {label}
        <Camera
          shot={shot}
          x={64}
          y={380}
          w={520}
          h={860}
          view={{
            cx: 195,
            cy: mix(0, center(r.arrival).y, glide(t, d * 0.3, d * 0.55)),
            width: 390,
          }}
          marks={[
            { box: r.row, color: C.mark, k: ease(t, d * 0.12) },
            { box: r.arrival, color: C.mark, k: ease(t, d * 0.7) },
          ]}
        />
        <div style={at(620, 400, 396, 820)}>
          <Callouts p t={t} d={d} facts={facts} cut={cut} workflow={workflow} />
        </div>
      </>
    );
  }
  const shot = workflow.screenshots.desktopWorkspace,
    r = shot.regions;
  // Wide workspace, then the late row with its customer, then its details.
  const row = { cx: 470, cy: center(r.row).y + 60, width: 940 },
    detail = { cx: center(r.detail).x - 160, cy: center(r.detail).y, width: 940 };
  return (
    <>
      {label}
      <Camera
        shot={shot}
        x={96}
        y={330}
        w={1180}
        h={640}
        view={track(t, [
          [d * 0.05, { cx: 720, cy: 500, width: 1440 }],
          [d * 0.38, row],
          [d * 0.52, row],
          [d * 0.85, detail],
        ])}
        marks={[
          { box: r.row, color: C.mark, k: ease(t, d * 0.25) },
          { box: r.arrival, color: C.mark, k: ease(t, d * 0.62) },
        ]}
      />
      <div style={at(1340, 360, 484, 600)}>
        <Callouts t={t} d={d} facts={facts} cut={cut} workflow={workflow} />
      </div>
    </>
  );
}
function Compare({ p, t, d, workflow }) {
  const facts = workflow.facts,
    chosen = facts.options.find((o) => o.eligible),
    rejected = facts.options.find((o) => !o.eligible);
  const turn = d * 0.55,
    k = glide(t, turn - 0.25, 0.5),
    saved = t >= turn;
  const dialog = workflow.screenshots[p ? "mobileDialog" : "desktopDialog"],
    after = workflow.screenshots[p ? "mobileAfter" : "desktopAfter"];
  const box = p ? { x: 230, y: 500, w: 620, h: 760 } : { x: 1060, y: 290, w: 700, h: 740 };
  const marks = [
    { box: dialog.regions.reason, color: C.mark, k: ease(t, d * 0.08) },
    { box: dialog.regions.chosen, color: C.ok, k: ease(t, d * 0.26) },
    { box: dialog.regions.confirm, color: C.ok, k: clamp01((t - d * 0.44) / 0.6), pulse: true },
  ];
  // Portrait holds on the choices, then pans down so confirm is in view before the click.
  const dialogView = p
    ? {
        cx: dialog.width / 2,
        cy: mix(0, dialog.height, glide(t, d * 0.3, d * 0.12)),
        width: dialog.width + 20,
      }
    : fit(dialog, box.w, box.h);
  const afterView = p
    ? fit(after, box.w, box.h)
    : {
        cx: center(after.regions.detail).x,
        cy: mix(
          center(after.regions.detail).y + 30,
          center(after.regions.detail).y - 10,
          glide(t, turn, d - turn),
        ),
        width: 620,
      };
  const before = (
    <>
      {first(rejected.name)} arrives sooner.
      <br />
      {first(chosen.name)} has the right van.
    </>
  );
  const done = (
    <>
      Assigned to {first(facts.after.driver)}.
      <br />
      Arrival <span style={{ color: C.lime }}>{facts.after.eta}.</span>
    </>
  );
  return (
    <>
      <div
        style={{
          ...at(p ? 64 : 96, p ? 345 : 380, p ? 952 : 860, 440),
          fontSize: p ? 49 : 72,
          lineHeight: 1.16,
          letterSpacing: p ? -1.5 : -2.5,
        }}
      >
        {saved ? done : before}
        {!p && (
          <div
            style={{
              marginTop: 40,
              fontSize: 30,
              lineHeight: 1.45,
              letterSpacing: 0,
              color: C.muted,
            }}
          >
            {saved ? (
              <>
                Saved after reload.
                <br />
                Undo is available.
              </>
            ) : (
              <>
                {rejected.name}: {rejected.reason.toLowerCase()}.
                <br />
                {chosen.name}: {chosen.vehicle.toLowerCase()}.
              </>
            )}
          </div>
        )}
      </div>
      <Camera shot={dialog} {...box} view={dialogView} marks={marks} opacity={1 - k} />
      <Camera
        shot={after}
        {...box}
        view={afterView}
        opacity={k}
        marks={[
          { box: after.regions.recovered, color: C.ok, k: ease(t, turn + 0.4) },
          { box: after.regions.undo, color: C.ok, k: ease(t, turn + 1.1) },
        ]}
      />
    </>
  );
}
function Measured({ p, t, d, workflow }) {
  const results = workflow.evaluation.results,
    baseline = results[0],
    revisions = results.slice(1, -1),
    repeat = results.at(-1);
  const shots = workflow.screenshots;
  const changes = (result, i) => {
    const previous = results[i];
    return Object.entries(result.items)
      .filter(([id, item]) => item.verdict !== previous.items[id].verdict)
      .map(
        ([id, item]) =>
          `${names[id]} ${status[previous.items[id].verdict].label.toLowerCase()} → ${status[item.verdict].label.toLowerCase()}`,
      )
      .join(" · ");
  };
  const starts = [d * 0.06, d * 0.28, d * 0.48];
  const rowSize = p ? 26 : 30;
  const queueBox = p
    ? [
        { x: 64, y: 735, w: 460, h: 555 },
        { x: 556, y: 735, w: 460, h: 555 },
      ]
    : [
        { x: 930, y: 380, w: 420, h: 580 },
        { x: 1404, y: 380, w: 420, h: 580 },
      ];
  const final = shots.mobileQueueFinal,
    base = shots.mobileQueueBaseline;
  const finalVisible = final.width * (queueBox[1].h / queueBox[1].w);
  return (
    <>
      <div style={at(p ? 64 : 96, p ? 335 : 340, p ? 952 : 780, 460)}>
        <Label style={{ color: C.lime }}>Same AEK suite · 5 frozen criteria</Label>
        <div style={{ marginTop: 16 }}>
          <Steps
            values={results.slice(0, -1).map((r) => r.score)}
            t={t}
            starts={starts}
            size={p ? 60 : 76}
          />
        </div>
        <div style={{ fontSize: rowSize, lineHeight: 1.35, marginTop: p ? 14 : 30 }}>
          <Reveal t={t} start={starts[0] + 0.3}>
            <span style={{ color: C.red }}>Baseline {pct(baseline.score)}:</span> deliveries hidden
            in a nested scroll; text down to 9px on phones.
          </Reveal>
          {revisions.map((result, i) => (
            <Reveal key={result.label} t={t} start={starts[i + 1] + 0.3} style={{ marginTop: 10 }}>
              <span style={{ color: C.lime }}>
                Agent revision {i + 1} · {pct(result.score)}:
              </span>{" "}
              {i === 0 ? "Page scrolling + readable options." : "Type, contrast + map labels."}
              <span style={{ color: C.muted }}> {changes(result, i)}</span>
            </Reveal>
          ))}
          <Reveal t={t} start={d * 0.8} style={{ marginTop: 10, color: C.muted }}>
            Fresh repeat of the final revision: {pct(repeat.score)}.
          </Reveal>
        </div>
      </div>
      <Label
        style={{ ...at(queueBox[0].x, queueBox[0].y - 42, 460, 36), fontSize: 22, color: C.red }}
      >
        Baseline · phone
      </Label>
      <Label
        style={{ ...at(queueBox[1].x, queueBox[1].y - 42, 460, 36), fontSize: 22, color: C.lime }}
      >
        After revisions · phone
      </Label>
      <Camera
        shot={base}
        {...queueBox[0]}
        view={fit(base, queueBox[0].w, queueBox[0].h)}
        marks={[
          { box: base.regions.rows, color: C.risk, k: ease(t, starts[0] + 0.5), inset: true },
        ]}
      />
      <Camera
        shot={final}
        {...queueBox[1]}
        view={{
          cx: final.width / 2,
          cy: mix(finalVisible / 2, final.height - finalVisible / 2, glide(t, starts[1], d * 0.55)),
          width: final.width,
        }}
        opacity={ease(t, starts[1] - 0.2)}
      />
    </>
  );
}
function Author({ p, t, d }) {
  return (
    <div
      style={{ position: "absolute", inset: 0, transform: `translateY(${-12 * glide(t, 0, d)}px)` }}
    >
      <Panel
        style={{
          ...at(p ? 64 : 96, 350, p ? 952 : 1728, p ? 445 : 265),
          padding: p ? 40 : 48,
          boxSizing: "border-box",
        }}
      >
        <Label style={{ color: C.lime }}>Ask your coding agent</Label>
        <div style={{ fontSize: p ? 57 : 62, lineHeight: 1.2, letterSpacing: -2, marginTop: 28 }}>
          “Build an AEK evaluation suite
          <br />
          for my project.”
        </div>
      </Panel>
      <div
        style={{
          ...at(p ? 64 : 96, p ? 850 : 680, p ? 952 : 1728, 280),
          fontSize: p ? 38 : 45,
          lineHeight: 1.6,
          color: C.muted,
        }}
      >
        {[
          "Clarify your standards.",
          "Evaluate a baseline.",
          "Use the findings. Improve again.",
        ].map((line, i) => (
          <Reveal key={line} t={t} start={1.2 + i * 1.4}>
            {line}
          </Reveal>
        ))}
      </div>
    </div>
  );
}
function Close({ p, t, d, terrain }) {
  return (
    <>
      <div
        style={{
          ...at(p ? 64 : 96, 210, p ? 952 : 1728, 310),
          fontSize: p ? 111 : 132,
          fontWeight: 500,
          letterSpacing: -6,
          lineHeight: 1.02,
        }}
      >
        Give your agent
        <br />
        <span style={{ color: C.lime }}>something to climb.</span>
      </div>
      <Reveal
        t={t}
        start={0.5}
        style={{
          ...at(p ? 64 : 96, p ? 590 : 575, p ? 952 : 1200, 180),
          fontSize: p ? 40 : 43,
          lineHeight: 1.4,
        }}
      >
        Ask your coding agent to build
        <br />
        an AEK evaluation suite for your project.
      </Reveal>
      <Reveal
        t={t}
        start={1}
        style={{
          ...at(p ? 64 : 96, p ? 805 : 780, p ? 952 : 1450, 100),
          fontSize: p ? 32 : 35,
          color: C.lime,
        }}
      >
        github.com/DeanStr/agent-eval-kit
      </Reveal>
      <div
        style={{
          ...at(p ? 360 : 1300, p ? 845 : 600, p ? 690 : 560, p ? 360 : 320),
          opacity: 0.45 * ease(t, 0.3, 1.2),
          transform: `translateY(${-24 * glide(t, 0, d)}px) scale(${1 + 0.1 * glide(t, 0, d)})`,
          overflow: "hidden",
        }}
      >
        <Img src={terrain} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </div>
      <Label
        style={{ ...at(p ? 64 : 96, p ? 1100 : 920, p ? 952 : 1350, 50), fontSize: p ? 24 : 26 }}
      >
        Your agent edits. AEK evaluates. You set the standard.
      </Label>
    </>
  );
}
const components = {
  hook: Hook,
  target: Target,
  finding: Finding,
  first: First,
  dispatchFinding: DispatchFinding,
  dispatchRevision: DispatchRevision,
  regression: Regression,
  coverage: Coverage,
  result: Result,
  compare: Compare,
  measured: Measured,
  author: Author,
  close: Close,
};
export function Video({ format, cut = "main", font, terrain, proof, workflow }) {
  const frame = useCurrentFrame(),
    { fps, width, height } = useVideoConfig(),
    time = frame / fps,
    p = format === "portrait",
    scene = sceneAt(time, cut),
    t = time - scene.start,
    d = scene.end - scene.start;
  const [fontHandle] = useState(() => delayRender("Load local film font"));
  useEffect(() => {
    const face = new FontFace("FilmInter", `url(${font})`);
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        continueRender(fontHandle);
      })
      .catch(cancelRender);
  }, [font, fontHandle]);
  if (!proof || proof.version !== 2) throw Error("Render requires sealed dashboard evidence");
  if (!workflow || workflow.version !== 2)
    throw Error("Render requires the measured dispatch workflow capture");
  const Body = components[scene.kind];
  if (!Body) throw Error(`Unknown scene: ${scene.kind}`);
  const productReveal = scene.kind === "result";
  const walkthrough = cut === "walkthrough";
  // The walkthrough reserves a caption band; scale scene content to sit above it.
  const fit = walkthrough ? (height - 165 - 300) / (height - 60 - 300) : 1;
  return (
    <AbsoluteFill
      style={{
        background: productReveal ? C.paper : C.bg,
        color: productReveal ? C.dark : C.ink,
        fontFamily: "FilmInter, sans-serif",
      }}
    >
      <div
        style={{
          ...at(p ? 64 : 96, 57, p ? 952 : 1728, 55),
          display: "flex",
          justifyContent: "space-between",
          fontSize: 28,
          color: productReveal ? C.dark : C.muted,
        }}
      >
        <span style={{ color: productReveal ? C.dark : C.ink, fontWeight: 600 }}>
          ↗ agent eval kit
        </span>
        {scene.kind === "target" && (
          <span style={{ fontSize: p ? 21 : 24 }}>Your project. Your standards.</span>
        )}
      </div>
      {scene.kind !== "hook" && scene.kind !== "close" && <Heading scene={scene} p={p} />}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: ease(t, 0, 0.32),
          transform: `scale(${fit})`,
          transformOrigin: `${width / 2}px 300px`,
        }}
      >
        <Body
          p={p}
          t={t}
          d={d}
          proof={proof}
          workflow={workflow}
          terrain={terrain}
          scene={scene}
          cut={cut}
        />
      </div>
      {walkthrough && (
        <div
          style={{
            ...at(p ? 64 : 96, height - 150, width - (p ? 128 : 192), 105),
            borderTop: `1px solid ${productReveal ? "#c9d3c7" : C.line}`,
            paddingTop: 18,
            boxSizing: "border-box",
            fontSize: p ? 25 : 28,
            lineHeight: 1.3,
            color: productReveal ? C.dark : C.muted,
          }}
        >
          {scene.caption}
        </div>
      )}
      <div
        style={{
          ...at(p ? 64 : 96, height - 32, width - (p ? 128 : 192), 20),
          fontSize: 16,
          color: productReveal ? C.dark : "#8da797",
        }}
      >
        {scene.illustrative
          ? "Illustrative policy example · Not an observed dispatch result"
          : "Synthetic data · Actual browser captures and AEK results · Edited sequence"}
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          height: 4,
          width: `${(time / CUTS[cut].duration) * 100}%`,
          background: C.lime,
        }}
      />
    </AbsoluteFill>
  );
}
