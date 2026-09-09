import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  delayRender,
  continueRender,
  cancelRender,
} from "remotion";
import { DURATION, sceneAt, WORKFLOW_KINDS } from "./story.mjs";
import { C, ramp, pos, Hook, Story, Journey, Edit, Breadth, Close } from "./visuals.jsx";
import { InspectFeature, ClimbFeature } from "./features.jsx";
import { Workflow } from "./Workflow.jsx";
export function Video({ format, lamp, font, terrain, routes, points }) {
  if (!lamp || !font || !terrain || !routes || !points)
    throw Error("Render with render.mjs to supply the local image and font.");
  const [handle] = useState(() => delayRender("Loading local Inter font"));
  useEffect(() => {
    const face = new FontFace("InterFilm", `url(${font})`, { weight: "100 900" });
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        continueRender(handle);
      })
      .catch(cancelRender);
  }, [font, handle]);
  const time = useCurrentFrame() / useVideoConfig().fps,
    scene = sceneAt(time),
    t = (time - scene.start) * scene.speed,
    p = format === "portrait",
    hook = scene.kind === "hook",
    workflow = WORKFLOW_KINDS.includes(scene.kind),
    fullCheckout = scene.kind === "run" || scene.kind === "retest",
    light = hook || scene.kind === "edit" || fullCheckout;
  const props = { t, p, lamp, terrain, routes, points };
  let visual;
  switch (scene.kind) {
    case "summit":
      visual = <ClimbFeature {...props} intro />;
      break;
    case "inspect":
      visual = <InspectFeature {...props} />;
      break;
    case "hook":
      visual = <Hook {...props} />;
      break;
    case "story":
      visual = <Story {...props} />;
      break;
    case "run":
    case "retest":
      visual = <Journey {...props} kind={scene.kind} />;
      break;
    case "edit":
      visual = <Edit {...props} />;
      break;
    case "breadth":
      visual = <Breadth {...props} />;
      break;
    case "rubric":
    case "sources":
    case "judges":
    case "compare":
    case "loop":
    case "coverage":
      visual = <Workflow {...props} time={time} scene={scene} />;
      break;
    case "climb":
      visual = <ClimbFeature {...props} />;
      break;
    case "close":
      visual = <Close {...props} />;
      break;
    default:
      throw Error(`Unknown scene ${scene.kind}`);
  }
  return (
    <AbsoluteFill
      style={{
        background: light ? C.paper : C.bg,
        color: light ? C.dark : C.ink,
        fontFamily: "InterFilm",
        fontOpticalSizing: "auto",
        overflow: "hidden",
        letterSpacing: -0.5,
      }}
    >
      {!hook && (
        <AbsoluteFill
          style={{ background: "radial-gradient(ellipse at 85% 55%, #52603b25, transparent 60%)" }}
        />
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: hook || workflow || scene.kind === "summit" ? 1 : ramp(t, 0, 0.28),
        }}
      >
        {visual}
      </div>
      {!fullCheckout && !workflow && (
        <div
          style={{
            ...pos(p ? 60 : 100, 54, p ? 960 : 1720, 50),
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: light ? C.dark : C.ink,
          }}
        >
          <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: -1 }}>
            AEK
            <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 18, fontSize: 26 }}>
              Agent Eval Kit
            </span>
          </div>
          <span style={{ fontSize: p ? 19 : 21, letterSpacing: 1.2 }}>{scene.label}</span>
        </div>
      )}
      {!hook && !workflow && !fullCheckout && scene.kind !== "close" && (
        <div
          style={{
            ...pos(
              p ? 60 : scene.kind === "judges" ? 1030 : scene.kind === "evidence" ? 1150 : 100,
              p ? 165 : scene.kind === "judges" ? 185 : scene.kind === "evidence" ? 190 : 165,
              p ? 960 : scene.kind === "judges" ? 790 : scene.kind === "evidence" ? 655 : 1720,
              160,
            ),
            fontSize: p ? 61 : scene.kind === "judges" ? 65 : scene.kind === "evidence" ? 68 : 73,
            fontWeight: 520,
            textWrap: scene.kind === "summit" ? "balance" : "wrap",
            lineHeight: 1.08,
            letterSpacing: -3.5,
          }}
        >
          {scene.title}
        </div>
      )}
      <div
        style={{
          ...pos(p ? 60 : 100, p ? 1292 : 1031, p ? 960 : 1720, 28),
          fontSize: 18,
          color: light ? "#59634f" : C.muted,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>Illustrative demo · fictional store, code and scores</span>
        <span>
          {String(Math.floor(time)).padStart(2, "0")} / {DURATION}
        </span>
      </div>
      <div
        style={{
          ...pos(0, p ? 1346 : 1076, `${(time / DURATION) * 100}%`, 4),
          background: light ? C.dark : C.lime,
        }}
      />
    </AbsoluteFill>
  );
}
