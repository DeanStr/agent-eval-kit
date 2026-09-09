import React from "react";
import { Img } from "remotion";
import { C, pos, ramp, Tag } from "./visuals.jsx";
import { carrierAt, panelState } from "./story.mjs";

const names = {
  rubric: "Define the target",
  sources: "Collect the evidence",
  judges: "Judge the experience",
  compare: "Select the improvement",
  loop: "Return to the agent",
  coverage: "Know what is unknown",
};

// A single mounted product carrier moves through every phase. Its clock does not
// restart when the surrounding evidence changes.
export function Workflow({ time, scene, p, lamp }) {
  const age = time - scene.start;
  const kind = scene.kind;
  const bounds = carrierAt(time, p);
  const compact = kind === "loop";
  const blocked = kind === "coverage";
  const revision = time >= 67 ? "04" : time >= 63 ? "03" : "02";
  const detailX = p ? 60 : kind === "sources" ? 100 : 980;
  const detailY = p ? 775 : 305;
  const detailW = p ? 960 : 840;
  const panel = panelState(age * 1.4);
  const headings = {
    rubric: "The target travels with the revision.",
    sources: "Three sources. One candidate.",
    judges: "Same screenshot. Fresh judgment.",
    compare: "A gain has to earn its place.",
    coverage: "This attempt needs more evidence.",
  };
  const progress = ["rubric", "sources", "judges", "compare", "loop", "coverage"].indexOf(kind);
  return (
    <>
      <div
        style={{
          ...pos(60, 60, p ? 960 : 1800, 70),
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 29 }}>
          <b>AEK</b> <span style={{ color: C.muted }}> / evidence for your coding agent</span>
        </span>
        <Tag color={C.lime}>REVISION {revision}</Tag>
      </div>
      <div
        style={{
          ...pos(60, 165, p ? 960 : 1800, 60),
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <span style={{ width: 12, height: 12, background: C.lime, borderRadius: "50%" }} />
        <span style={{ fontSize: p ? 40 : 44, letterSpacing: -1.5 }}>{names[kind]}</span>
        {!p && (
          <span style={{ marginLeft: "auto", fontSize: 27, color: C.muted }}>
            User stories → evidence → agent
          </span>
        )}
      </div>

      {compact && (
        <>
          <svg
            width={p ? 1080 : 1920}
            height={p ? 1350 : 1080}
            style={{ position: "absolute", inset: 0 }}
          >
            <path
              d={
                p
                  ? "M200 985H880C1000 985 1000 1135 880 1135H200C80 1135 80 985 200 985Z"
                  : "M1370 430L1630 590L1370 750C1220 750 1220 430 1370 430Z"
              }
              fill="none"
              stroke={C.line}
              strokeWidth="3"
            />
            <path
              d={
                p
                  ? "M200 985H880C1000 985 1000 1135 880 1135H200C80 1135 80 985 200 985Z"
                  : "M1370 430L1630 590L1370 750C1220 750 1220 430 1370 430Z"
              }
              fill="none"
              stroke={C.lime}
              strokeWidth="5"
              pathLength="1"
              strokeDasharray=".13 .87"
              strokeDashoffset={-((time - 63) % 4) / 4}
            />
          </svg>
          {(p
            ? [
                [200, 985],
                [540, 985],
                [880, 985],
              ]
            : [
                [1370, 430],
                [1630, 590],
                [1370, 750],
              ]
          ).map(([x, y], i) => (
            <div
              key={i}
              style={{
                ...pos(x - 140, y - 62, 280, 123),
                background: C.bg,
                textAlign: "center",
                paddingTop: 15,
                boxSizing: "border-box",
                borderTop: `2px solid ${Math.floor(((time - 63) % 4) / (4 / 3)) === i ? C.lime : C.line}`,
              }}
            >
              <Tag color={i === 1 ? C.blue : C.muted}>
                {i === 1 ? "AGENT EVAL KIT" : "CODING AGENT"}
              </Tag>
              <div style={{ fontSize: p ? 37 : 41, marginTop: 14 }}>
                {["Edit", "Evaluate", "Select"][i]}
              </div>
            </div>
          ))}
          <div
            style={{
              ...pos(p ? 60 : 1220, p ? 1170 : 900, p ? 960 : 610, 90),
              fontSize: p ? 28 : 31,
              color: C.lime,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            Evidence returns.
            <br />
            The next edit begins. ↻
          </div>
        </>
      )}

      <div
        style={{
          ...pos(bounds.x, bounds.y, bounds.w, bounds.h),
          zIndex: 2,
          background: C.paper,
          color: C.dark,
          borderRadius: 16,
          boxShadow: "0 32px 90px #0007",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            ...pos(0, 0, "100%", "100%"),
            transformOrigin: "top left",
            transform: `scale(${bounds.w / (p ? 960 : 740)})`,
            width: p ? 960 : 740,
            height: p ? 460 : 620,
          }}
        >
          <CandidateSurface kind={kind} p={p} lamp={lamp} time={time} revision={revision} />
        </div>
      </div>

      {!compact && (
        <div
          style={{
            ...pos(detailX, detailY, detailW, p ? 460 : 660),
            opacity: ramp(age, 0.55, 0.4),
          }}
        >
          <div
            style={{
              fontSize: p ? 45 : 57,
              lineHeight: 1.08,
              letterSpacing: -2.4,
              marginBottom: p ? 25 : 40,
            }}
          >
            {headings[kind]}
          </div>
          {kind === "rubric" && (
            <>
              {[
                ["Correctness", 50],
                ["Clarity", 30],
                ["Craft", 20],
              ].map(([name, value], i) => (
                <div
                  key={name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 20,
                    marginTop: p ? 16 : 23,
                    fontSize: p ? 30 : 34,
                  }}
                >
                  <span style={{ width: p ? 205 : 240 }}>{name}</span>
                  <div
                    style={{
                      height: 12,
                      width: value * (p ? 7 : 6) * ramp(age, i * 0.3),
                      background: i === 0 ? C.lime : i === 1 ? C.blue : "#8f9e7a",
                    }}
                  />
                  <b style={{ marginLeft: "auto" }}>{value}%</b>
                </div>
              ))}
              <div
                style={{
                  borderTop: `1px solid ${C.line}`,
                  marginTop: p ? 25 : 44,
                  paddingTop: 24,
                  fontSize: p ? 28 : 31,
                  color: C.lime,
                }}
              >
                ✓ Critical gate: shopper pays the correct total.
              </div>
              <div style={{ fontSize: p ? 25 : 28, color: C.muted, marginTop: 15 }}>
                Weights cannot override a failed gate.
              </div>
            </>
          )}
          {kind === "sources" && (
            <>
              {[
                ["Browser journey", "2 × Arc lamp → $240"],
                ["Repository check", "assert(total === 240)"],
                ["Exported report", "US-01 / expected 240 / observed 240"],
              ].map(([name, proof], i) => (
                <div
                  key={name}
                  style={{
                    borderTop: `1px solid ${C.line}`,
                    paddingTop: p ? 14 : 23,
                    marginTop: p ? 13 : 24,
                    opacity: ramp(age, 0.8 + i * 0.8),
                    transform: `translateX(${(1 - ramp(age, 0.8 + i * 0.8)) * -30}px)`,
                  }}
                >
                  <div style={{ fontSize: p ? 29 : 34, color: i === 1 ? C.blue : C.lime }}>
                    ✓ {name}
                  </div>
                  <div style={{ fontSize: p ? 25 : 28, marginTop: 9, color: C.muted }}>{proof}</div>
                </div>
              ))}
            </>
          )}
          {kind === "judges" && (
            <>
              <div style={{ fontSize: p ? 33 : 37, color: C.lime }}>“Can I see what I’ll pay?”</div>
              <div style={{ display: "flex", gap: p ? 20 : 25, marginTop: 32 }}>
                {Array.from({ length: panel.count }, (_, i) => (
                  <div key={i} style={{ textAlign: "center" }}>
                    <div
                      style={{
                        width: p ? 96 : 105,
                        height: p ? 96 : 105,
                        border: `2px solid ${panel.votes[i] === "FAIL" ? "#cf967d" : C.line}`,
                        borderRadius: "50%",
                        display: "grid",
                        placeItems: "center",
                        fontSize: 40,
                        color: panel.votes[i] === "FAIL" ? "#ffb49b" : C.lime,
                        background: "#242c23",
                      }}
                    >
                      {panel.votes[i] ? (panel.votes[i] === "PASS" ? "✓" : "×") : "·"}
                    </div>
                    <div style={{ fontSize: 20, marginTop: 12, color: C.muted }}>
                      {panel.votes[i] ?? "REVIEW"}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: p ? 30 : 37, marginTop: 25, color: C.lime }}>
                {panel.decision}
              </div>
              <div style={{ fontSize: p ? 24 : 28, color: C.muted, marginTop: 18 }}>
                Same evidence. Fixed rubric. Three first; up to five.
              </div>
              <div style={{ fontSize: 22, color: C.muted, marginTop: 10 }}>
                Illustrative, configurable panel policy.
              </div>
            </>
          )}
          {kind === "compare" && (
            <>
              {[
                ["Previously accepted", 68, "Gates passed"],
                ["Revision 01", 77, "× Checkout gate failed"],
                ["Revision 02", 82, "✓ Gates passed · agent keeps"],
              ].map(([label, score, result], i) => (
                <div
                  key={label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 25,
                    borderTop: `1px solid ${C.line}`,
                    paddingTop: p ? 12 : 20,
                    marginTop: p ? 12 : 20,
                    opacity: i === 2 ? ramp(age, 2) : 1,
                  }}
                >
                  <div
                    style={{
                      width: p ? 90 : 100,
                      fontSize: p ? 57 : 70,
                      letterSpacing: -3,
                      color: i === 1 ? "#ffb49b" : C.lime,
                    }}
                  >
                    {score}
                  </div>
                  <div>
                    <div style={{ fontSize: p ? 28 : 32 }}>{label}</div>
                    <div style={{ fontSize: p ? 24 : 26, color: C.muted, marginTop: 6 }}>
                      {result}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
          {kind === "coverage" && (
            <>
              <div style={{ fontSize: p ? 70 : 100, letterSpacing: -4, color: C.blue }}>
                — <span style={{ fontSize: p ? 42 : 50, letterSpacing: -2 }}>Score withheld</span>
              </div>
              <div style={{ display: "flex", gap: p ? 14 : 12, marginTop: 25 }}>
                {Array.from({ length: 12 }, (_, i) => (
                  <div
                    key={i}
                    style={{
                      width: p ? 57 : 50,
                      height: p ? 34 : 40,
                      background: i < 7 ? C.lime : "transparent",
                      border: `2px solid ${i < 7 ? C.lime : C.line}`,
                    }}
                  />
                ))}
              </div>
              <div style={{ fontSize: p ? 31 : 35, marginTop: 24 }}>
                7 / 12 checks observed · 58% coverage
              </div>
              <div
                style={{ fontSize: p ? 26 : 30, color: C.muted, lineHeight: 1.5, marginTop: 15 }}
              >
                Refund provider unavailable.
                <br />
                Accepted best stays at 82. Collect evidence, then rerun.
              </div>
            </>
          )}
        </div>
      )}
      {!compact && (
        <div style={{ ...pos(60, p ? 1240 : 980, p ? 960 : 1800, 6), display: "flex", gap: 12 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{ flex: 1, background: i <= progress ? C.lime : C.line }} />
          ))}
        </div>
      )}
    </>
  );
}

function CandidateSurface({ kind, p, lamp, time, revision }) {
  const W = p ? 960 : 740;
  const phase = Math.floor(((time - 63) % 4) / (4 / 3));
  const mode =
    kind === "loop"
      ? ["edit", "log", "confirm"][phase]
      : kind === "sources"
        ? "log"
        : kind === "judges"
          ? "total"
          : kind === "compare"
            ? "confirm"
            : kind === "coverage"
              ? "refund"
              : "cart";
  const later = time >= 67;
  const mono = mode === "edit" || mode === "log";
  const header = mono ? "aek / revision evidence" : "form® / checkout";
  return (
    <>
      <div
        style={{
          padding: p ? "24px 30px" : "26px 35px",
          fontSize: p ? 25 : 27,
          display: "flex",
          justifyContent: "space-between",
          borderBottom: "1px solid #c5c9be",
        }}
      >
        <b>{header}</b>
        <span>REV {revision}</span>
      </div>
      {mono ? (
        <>
          <div
            style={{
              ...pos(20, 95, W - 40, p ? 285 : 385),
              background: "#232b24",
              borderRadius: 9,
              color: C.lime,
              padding: p ? 26 : 30,
              boxSizing: "border-box",
            }}
          >
            <Tag color={C.blue}>
              {mode === "edit" ? "CODING AGENT / NEXT EDIT" : "REPOSITORY / ASSERTION LOG"}
            </Tag>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: p ? 30 : 31,
                lineHeight: 1.65,
                marginTop: 25,
              }}
            >
              {mode === "edit" ? (
                <>
                  {later ? "refund.ts" : "search.ts"}
                  <br />
                  <span style={{ color: "#ffb29b" }}>
                    − {later ? "provider unavailable" : "match(name)"}
                  </span>
                  <br />+ {later ? "reconnect provider" : "match(name, material)"}
                </>
              ) : (
                <>
                  cart.total
                  <br />
                  quantity: 2<br />
                  expected: 240
                  <br />
                  observed: 240 ✓
                </>
              )}
            </div>
            <Img
              src={lamp}
              style={{
                ...pos(W - (p ? 265 : 240), p ? 90 : 120, p ? 190 : 155, p ? 160 : 195),
                objectFit: "cover",
                borderRadius: 7,
              }}
            />
          </div>
        </>
      ) : mode === "total" ? (
        <>
          <Img
            src={lamp}
            style={{
              ...pos(30, 105, p ? 165 : 150, p ? 235 : 325),
              objectFit: "cover",
              borderRadius: 7,
            }}
          />
          <div style={{ ...pos(p ? 235 : 225, 110, p ? 690 : 480, p ? 250 : 330) }}>
            <div style={{ fontSize: p ? 30 : 32, color: "#65705b" }}>
              Order summary · 2 × Arc lamp
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: p ? 27 : 30,
                marginTop: p ? 16 : 24,
              }}
            >
              <span>Shipping</span>
              <span>Free</span>
            </div>
            <div
              style={{
                borderTop: "1px solid #b8c1aa",
                marginTop: 18,
                paddingTop: 18,
                fontSize: p ? 27 : 30,
              }}
            >
              Total to pay
            </div>
            <div style={{ fontSize: p ? 96 : 94, letterSpacing: -6, lineHeight: 1.1 }}>$240.00</div>
            <div
              style={{
                marginTop: 18,
                background: C.dark,
                color: C.paper,
                textAlign: "center",
                padding: p ? 10 : 13,
                fontSize: p ? 28 : 30,
              }}
            >
              Checkout ↗
            </div>
          </div>
        </>
      ) : mode === "confirm" ? (
        <>
          <Img
            src={lamp}
            style={{
              ...pos(0, 80, p ? 510 : 440, p ? 380 : 540),
              objectFit: "cover",
              objectPosition: "45% center",
            }}
          />
          <div
            style={{
              ...pos(p ? 430 : 325, p ? 130 : 200, p ? 480 : 370, p ? 235 : 270),
              background: C.paper,
              padding: p ? 28 : 25,
              boxSizing: "border-box",
              boxShadow: "0 18px 50px #26331c30",
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: p ? 33 : 31, color: "#60772d" }}>✓ Order confirmed</div>
            <div style={{ fontSize: p ? 28 : 26, marginTop: 17 }}>2 × Arc lamp</div>
            <div style={{ fontSize: p ? 81 : 73, letterSpacing: -5, marginTop: 10 }}>$240.00</div>
            <div style={{ fontSize: p ? 24 : 25, marginTop: 12 }}>
              {kind === "loop" ? "Return evidence to agent" : "Revision 02 · agent keeps"}
            </div>
          </div>
        </>
      ) : mode === "refund" ? (
        <>
          <Img
            src={lamp}
            style={{
              ...pos(25, 110, p ? 220 : 210, p ? 245 : 320),
              objectFit: "cover",
              borderRadius: 7,
            }}
          />
          <div style={{ ...pos(p ? 285 : 275, 115, p ? 635 : 430, 300) }}>
            <div style={{ fontSize: p ? 39 : 40 }}>Refund request</div>
            <div style={{ fontSize: p ? 28 : 29, color: "#667159", marginTop: 17 }}>
              US-03 · Order 02
            </div>
            <div style={{ fontSize: p ? 73 : 70, letterSpacing: -4, marginTop: 17 }}>$240.00</div>
            <div style={{ fontSize: p ? 26 : 28, marginTop: 20, color: C.red }}>
              Provider unavailable
            </div>
          </div>
        </>
      ) : (
        <>
          <Img
            src={lamp}
            style={{
              ...pos(25, 100, p ? 450 : 470, p ? 275 : 350),
              objectFit: "cover",
              borderRadius: 7,
            }}
          />
          <div
            style={{
              ...pos(p ? 435 : 360, p ? 125 : 150, p ? 490 : 345, 260),
              padding: 20,
              boxSizing: "border-box",
              background: C.paper,
              boxShadow: "0 16px 40px #26331c25",
              borderRadius: 7,
              fontSize: p ? 36 : 35,
              lineHeight: 1.2,
            }}
          >
            <b>2 × Arc lamp</b>
            <br />
            <span style={{ fontSize: p ? 28 : 27, color: "#68705c" }}>$120.00 each</span>
            <div style={{ fontSize: p ? 73 : 70, letterSpacing: -4, marginTop: 10 }}>$240.00</div>
            <div style={{ fontSize: p ? 25 : 24, color: "#52691d", marginTop: 8 }}>
              ✓ Correct total verified
            </div>
          </div>
        </>
      )}
      {mode !== "confirm" && mode !== "total" && (
        <div
          style={{
            ...pos(p ? 30 : 35, p ? 402 : 510, p ? 900 : 670, p ? 42 : 70),
            borderTop: "1px solid #c5c9be",
            paddingTop: p ? 12 : 20,
            fontSize: p ? 25 : 27,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            {mode === "refund" ? "Waiting for evidence" : "Same candidate · inspectable evidence"}
          </span>
          <b>{mode === "refund" ? "PENDING" : mode === "edit" ? "EDIT" : "US-01"}</b>
        </div>
      )}
    </>
  );
}
