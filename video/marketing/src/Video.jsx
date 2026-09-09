import React from "react";
import { AbsoluteFill, Img, interpolate, Easing, useCurrentFrame, useVideoConfig } from "remotion";
import { sceneAt, scenes } from "./story.mjs";
const ink = "#ecf2e7",
  muted = "#97aaa9",
  green = "#c5f5aa";
const tones = { orange: "#f0ae88", violet: "#c6bfec", green };
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
const ease = { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) };
const mono = { fontFamily: '"DejaVu Sans Mono", monospace', letterSpacing: 2 };

function Mark() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40">
      <rect width="40" height="40" rx="11" fill={green} />
      <path
        d="m8 28 9-13 6 6 9-12"
        fill="none"
        stroke="#14251b"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function Video({ format, terrain, routes, points }) {
  if (!terrain || !routes || !points)
    throw new Error("Render with render.mjs to supply the terrain assets.");
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig(),
    time = frame / fps;
  const scene = sceneAt(time),
    local = time - scene.start,
    portrait = format === "portrait";
  const accent = tones[scene.tone ?? "green"];
  const enter = interpolate(local, [0, 0.75], [0, 1], ease);
  const leave = scene.closing
    ? 1
    : interpolate(local, [scene.end - scene.start - 0.3, scene.end - scene.start], [1, 0], clamp);
  const terrainWidth = portrait ? 1260 : 1760;
  const terrainLeft = portrait ? -100 : 80;
  const terrainTop = portrait ? 555 : 355;
  const scale = interpolate(time, [0, 18, 33, 40], [1.02, 1.06, 1.02, 1.045], clamp);
  const stateEntry = scenes.find((s) => s.step === scene.step)?.start ?? 0;
  const pulse = interpolate(time - stateEntry, [0, 1.3], [35, 11], ease);
  return (
    <AbsoluteFill
      style={{
        background: "#0b121c",
        color: ink,
        fontFamily: '"DejaVu Sans", Arial, sans-serif',
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{ background: "radial-gradient(ellipse at 65% 65%, #20433755 0%, transparent 62%)" }}
      />
      <div
        style={{
          position: "absolute",
          left: portrait ? 72 : 100,
          top: portrait ? 72 : 64,
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontSize: 27,
          fontWeight: 600,
        }}
      >
        <Mark />
        agent eval kit
      </div>
      <div
        style={{
          position: "absolute",
          right: portrait ? 72 : 100,
          top: portrait ? 83 : 77,
          ...mono,
          fontSize: 17,
          color: muted,
        }}
      >
        EDIT → EVAL → REPEAT
      </div>
      <div
        style={{
          position: "absolute",
          left: portrait ? 72 : 100,
          top: portrait ? 180 : 172,
          opacity: enter * leave,
          transform: `translateY(${(1 - enter) * 22}px)`,
          zIndex: 2,
        }}
      >
        <div style={{ ...mono, color: accent, fontSize: portrait ? 19 : 18, marginBottom: 25 }}>
          {scene.label}
        </div>
        <div
          style={{
            fontSize: portrait ? 76 : 91,
            fontWeight: 500,
            letterSpacing: portrait ? -3.8 : -4.5,
            lineHeight: 1.13,
          }}
        >
          {scene.title.map((line, i) => (
            <div key={line} style={{ color: i === 1 ? accent : ink }}>
              {line}
            </div>
          ))}
        </div>
      </div>
      {scene.best !== null && (
        <div
          style={{
            position: "absolute",
            right: portrait ? 78 : 104,
            top: portrait ? 460 : 221,
            textAlign: "right",
            zIndex: 2,
          }}
        >
          <div style={{ ...mono, fontSize: portrait ? 17 : 18, color: muted }}>BEST ACCEPTED</div>
          <div
            style={{
              fontSize: portrait ? 70 : 100,
              letterSpacing: -5,
              lineHeight: 1.15,
              color: green,
            }}
          >
            {scene.best}
            <span style={{ fontSize: 24, color: muted, letterSpacing: 0 }}> / 100</span>
          </div>
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: terrainLeft,
          top: terrainTop,
          width: terrainWidth,
          height: (terrainWidth * 580) / 1600,
          transform: `scale(${scale})`,
          transformOrigin: "60% 50%",
        }}
      >
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
          <defs>
            <filter id="glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          </defs>
          {routes
            .filter((route) => route.step !== 4)
            .map((route) => {
              const start = scenes.find((s) => s.step === route.step).start;
              const progress = interpolate(time - start, [0.1, 1.8], [0, 1], ease);
              const color =
                route.step === 2 ? tones.orange : route.step === 4 ? tones.violet : green;
              return (
                <g key={route.step} opacity={progress > 0 ? 1 : 0}>
                  <path
                    d={route.d}
                    pathLength="1"
                    stroke={color}
                    strokeWidth="11"
                    fill="none"
                    filter="url(#glow)"
                    opacity=".45"
                    strokeDasharray="1"
                    strokeDashoffset={1 - progress}
                  />
                  <path
                    d={route.d}
                    pathLength="1"
                    stroke={color}
                    strokeWidth="3.2"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray="1"
                    strokeDashoffset={1 - progress}
                  />
                </g>
              );
            })}
          {Object.entries(points)
            .filter(([key]) => key !== "4")
            .map(([key, [x, y]]) => {
              const step = Number(key),
                start = scenes.find((s) => s.step === step).start;
              const reveal = interpolate(time - start, [0.2, 1], [0, 1], ease);
              const color = step === 2 ? tones.orange : step === 4 ? tones.violet : green;
              return (
                <g key={key} opacity={reveal}>
                  {step === scene.step && (
                    <circle cx={x} cy={y} r={pulse} fill="none" stroke={color} opacity=".6" />
                  )}
                  <circle cx={x} cy={y} r="8" stroke={color} fill="#0b121c" strokeWidth="2.5" />
                  {step === 2 ? (
                    <path d={`M${x - 3} ${y - 3}l6 6m0-6-6 6`} stroke={color} strokeWidth="1.5" />
                  ) : (
                    <circle cx={x} cy={y} r="3" fill={color} />
                  )}
                  <text
                    x={x + 16}
                    y={y - 19}
                    fill={color}
                    fontSize="30"
                    fontFamily="DejaVu Sans"
                    paintOrder="stroke"
                    stroke="#0b121c"
                    strokeWidth="7"
                  >
                    {["54", "68", "77", "82", "—", "91"][step]}
                  </text>
                </g>
              );
            })}
        </svg>
      </div>
      <div
        style={{
          position: "absolute",
          left: portrait ? 72 : 100,
          right: portrait ? 72 : 100,
          bottom: portrait ? 150 : 127,
          opacity: enter * leave,
          zIndex: 3,
        }}
      >
        {scene.closing ? (
          <div>
            <div
              style={{
                display: "flex",
                gap: portrait ? 12 : 22,
                alignItems: "center",
                fontSize: portrait ? 24 : 30,
                marginBottom: 25,
              }}
            >
              <span style={{ color: muted }}>Your agent edits</span>
              <span>→</span>
              <span style={{ color: green }}>AEK evaluates</span>
              <span>→</span>
              <span style={{ color: muted }}>Agent selects</span>
            </div>
            <div style={{ fontSize: portrait ? 29 : 37, fontWeight: 500 }}>
              github.com/DeanStr/agent-eval-kit <span style={{ color: green }}>↗</span>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 26,
              padding: portrait ? "24px 28px" : "21px 30px",
              border: "1px solid #3a504c",
              borderRadius: 16,
              background: "#111e27ee",
            }}
          >
            {scene.score && (
              <div
                style={{
                  borderRight: "1px solid #3a504c",
                  paddingRight: 26,
                  minWidth: portrait ? 128 : 150,
                }}
              >
                <div style={{ fontSize: 54, lineHeight: 1.1, color: accent }}>{scene.score}</div>
                <div style={{ ...mono, fontSize: 15, marginTop: 8, color: accent }}>
                  {scene.status}
                </div>
              </div>
            )}
            <div
              style={{
                fontSize: portrait ? 28 : 32,
                lineHeight: 1.4,
                maxWidth: portrait ? 590 : 1350,
              }}
            >
              {scene.detail}
            </div>
          </div>
        )}
      </div>
      <div
        style={{
          position: "absolute",
          bottom: portrait ? 70 : 51,
          left: portrait ? 72 : 100,
          right: portrait ? 72 : 100,
          display: "flex",
          justifyContent: "space-between",
          color: muted,
          ...mono,
          fontSize: portrait ? 15 : 17,
        }}
      >
        <span>ILLUSTRATIVE SCORES · CONCEPTUAL LANDSCAPE</span>
        <span>{String(Math.min(8, scenes.indexOf(scene) + 1)).padStart(2, "0")} / 08</span>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          height: 3,
          background: green,
          width: `${(time / 40) * 100}%`,
          opacity: 0.7,
        }}
      />
    </AbsoluteFill>
  );
}
