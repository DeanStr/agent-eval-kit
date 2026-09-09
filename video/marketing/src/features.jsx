import React from "react";
import { Img } from "remotion";
import { C, pos, ramp, Tag } from "./visuals.jsx";
import { climbState } from "./story.mjs";

export function InspectFeature({ t, p, lamp }) {
  const detail = t >= 3.5;
  return (
    <div
      style={{
        ...pos(p ? 60 : 180, p ? 340 : 330, p ? 960 : 1560, p ? 850 : 670),
        background: C.paper,
        color: C.dark,
        borderRadius: 14,
        overflow: "hidden",
        boxShadow: "0 35px 80px #0008",
        transform: p ? "none" : `perspective(2200px) rotateY(${-3 + ramp(t, 0, 1) * 2}deg)`,
      }}
    >
      <div
        style={{
          padding: "25px 35px",
          borderBottom: "1px solid #c9cdbf",
          display: "flex",
          justifyContent: "space-between",
          fontSize: p ? 25 : 29,
        }}
      >
        <span>
          <b>aek</b> / Evidence / US-01
        </span>
        <span style={{ color: C.red }}>× FAILED</span>
      </div>
      <div style={{ padding: "24px 35px", display: "flex", gap: 40, fontSize: p ? 26 : 30 }}>
        {["Screenshot", "Assertion log"].map((tab, i) => (
          <span
            key={tab}
            style={{
              paddingBottom: 13,
              borderBottom: `3px solid ${(detail ? 1 : 0) === i ? C.dark : "transparent"}`,
              opacity: (detail ? 1 : 0) === i ? 1 : 0.45,
            }}
          >
            {tab}
          </span>
        ))}
      </div>
      <div
        style={{
          ...pos(35, p ? 200 : 190, p ? 890 : 610, p ? 225 : 310),
          display: "flex",
          alignItems: "center",
          gap: 30,
          background: "#e3e4d9",
          padding: 25,
          boxSizing: "border-box",
        }}
      >
        <Img
          src={lamp}
          style={{ width: p ? 175 : 215, height: p ? 175 : 245, objectFit: "cover" }}
        />
        <div style={{ fontSize: p ? 30 : 33, lineHeight: 1.5 }}>
          <b>2 × Arc lamp</b>
          <br />
          $120.00 each
          <br />
          <span style={{ color: C.red }}>Total: $120.00</span>
        </div>
      </div>
      <div
        style={{
          ...pos(p ? 35 : 710, p ? 460 : 200, p ? 890 : 795, p ? 215 : 300),
          fontFamily: detail ? "monospace" : "InterFilm",
          fontSize: p ? 32 : 35,
          lineHeight: 1.6,
        }}
      >
        {detail ? (
          <>
            <span style={{ color: "#637053" }}>checkout.total · assertion</span>
            <br />
            <span>expected: 240</span>
            <br />
            <span style={{ color: C.red }}>received: 120</span>
            <br />
            <b>quantity changed; total did not</b>
          </>
        ) : (
          <>
            <Tag color={C.red}>US-01 / CRITICAL GATE</Tag>
            <div style={{ fontSize: p ? 43 : 47, lineHeight: 1.15, marginTop: 20 }}>
              The quantity changed.
              <br />
              The total didn’t.
            </div>
            <div style={{ marginTop: 23 }}>Expected $240 · observed $120</div>
          </>
        )}
      </div>
      <div
        style={{
          ...pos(35, p ? 738 : 540, p ? 890 : 1490, 95),
          borderTop: "1px solid #c9cdbf",
          paddingTop: 20,
          fontSize: p ? 25 : 27,
          color: "#58634e",
        }}
      >
        <span style={{ fontFamily: "monospace" }}>Source snapshot · sha256: 8f31c2…a9d4</span>
        <div style={{ marginTop: 10 }}>Screenshot + log + source hash → coding agent</div>
      </div>
    </div>
  );
}
export function ClimbFeature({ t, p, terrain, routes, points, intro = false }) {
  const starts = intro
    ? { 0: 0, 1: 1.2, 3: 3.1, 5: 5.2 }
    : { 0: 0, 1: 1, 2: 2.5, 3: 4.5, 4: 6.5, 5: 9 };
  const values = { 0: 54, 1: 68, 2: "77 ×", 3: 82, 4: "— ?", 5: 91 };
  const state = climbState(t);
  const best = intro ? (t < 1.2 ? 54 : t < 3.1 ? 68 : t < 5.2 ? 82 : 91) : state.best;
  const color = (step) => (step === 2 ? "#ffad91" : step === 4 ? C.blue : C.lime);
  const captions = [
    ["Start from a verified baseline.", "Every candidate has to earn its place."],
    ["68 accepted · required gates pass", "Compare every candidate against it."],
    ["77 rejected · checkout gate failed", "Best accepted stays at 68."],
    ["82 accepted · checkout verified", "Keep this revision."],
    ["Score withheld · refund unavailable", "Best accepted stays at 82."],
    ["91 accepted · missing evidence collected", "Only verified gains move the baseline."],
  ];
  return (
    <>
      <div style={{ ...pos(p ? 60 : 100, p ? 325 : 300, p ? 960 : 650, 210) }}>
        <Tag color={C.lime}>
          {intro ? "EDIT → EVALUATE → SELECT → REPEAT" : "BEST ACCEPTED / SAME RUBRIC"}
        </Tag>
        <div style={{ fontSize: p ? 140 : 150, letterSpacing: -8, fontWeight: 520, marginTop: 10 }}>
          {best}
          <span style={{ fontSize: 38, letterSpacing: -1, color: C.muted }}> / 100</span>
        </div>
      </div>
      <div style={{ ...pos(p ? 0 : 100, p ? 600 : 390, p ? 1080 : 1720, p ? 392 : 624) }}>
        <Img src={terrain} style={{ width: "100%", height: "100%" }} />
        <svg
          viewBox="0 255 1600 580"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            overflow: "visible",
          }}
        >
          {routes
            .filter((r) => !intro || [1, 3, 5].includes(r.step))
            .map((r) => (
              <path
                key={r.step}
                d={r.step === 4 ? `${r.d}L1332 650` : r.d}
                fill="none"
                stroke={color(r.step)}
                strokeWidth={r.step === 2 || r.step === 4 ? "4" : "6"}
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={1 - ramp(t, starts[r.step], 1.1)}
              />
            ))}
          {(intro ? [0, 1, 3, 5] : [0, 1, 2, 3, 4, 5]).map((k) => (
            <g key={k} opacity={ramp(t, starts[k], 0.5)}>
              <circle
                cx={points[k][0]}
                cy={points[k][1]}
                r="11"
                fill={C.bg}
                stroke={color(k)}
                strokeWidth="4"
              />
              <text
                x={points[k][0] + 22}
                y={points[k][1] - 25}
                fontFamily="InterFilm"
                fontSize={p ? 57 : 40}
                fill={color(k)}
                stroke={C.bg}
                strokeWidth="6"
                paintOrder="stroke"
              >
                {values[k]}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div
        style={{
          ...pos(p ? 60 : 920, p ? 1100 : 280, p ? 960 : 890, 120),
          fontSize: p ? 34 : 35,
          lineHeight: 1.4,
          color: C.muted,
        }}
      >
        {intro ? "AEK evaluates your project." : captions[state.step][0]}
        <br />
        <span style={{ color: C.lime }}>
          {intro ? "Your coding agent improves it. ↻" : captions[state.step][1]}
        </span>
      </div>
    </>
  );
}
