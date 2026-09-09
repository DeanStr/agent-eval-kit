import React from "react";
import { Img, interpolate, Easing } from "remotion";
import { cartState, CHECKOUT_TIMING } from "./story.mjs";
export const C = {
  bg: "#171b1a",
  ink: "#f4f2e9",
  muted: "#a7afa9",
  lime: "#dbff79",
  paper: "#f3f0e8",
  dark: "#202722",
  red: "#b3442c",
  line: "#3a423d",
  blue: "#adcaff",
};
export const ramp = (t, start = 0, duration = 0.6) =>
  interpolate(t, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  });
export const pos = (left, top, width, height) => ({
  position: "absolute",
  left,
  top,
  width,
  height,
});
export function Tag({ children, color = C.lime, style = {} }) {
  return (
    <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: 1.3, color, ...style }}>
      {children}
    </div>
  );
}
export function Check({ ok = true, size = 28 }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: ok ? C.lime : "#f7c5b4",
        color: C.dark,
        fontSize: size * 0.65,
        fontWeight: 650,
        flexShrink: 0,
      }}
    >
      {ok ? "✓" : "×"}
    </span>
  );
}
function Cursor({ x, y, click = false }) {
  return (
    <div style={{ ...pos(x, y, 38, 48), zIndex: 5, filter: "drop-shadow(0 4px 5px #0005)" }}>
      {click && (
        <div
          style={{ ...pos(-13, -13, 52, 52), border: "3px solid #799c44", borderRadius: "50%" }}
        />
      )}
      <svg viewBox="0 0 30 40">
        <path d="M2 2 26 23 15 24 10 35Z" fill="#202722" stroke="white" strokeWidth="2" />
      </svg>
    </div>
  );
}
export function Store({
  lamp,
  quantity = 1,
  total = 120,
  confirmed = false,
  highlight = false,
  cursor = null,
  product = false,
  flat = false,
}) {
  return (
    <div
      style={{
        width: 1000,
        height: 650,
        background: C.paper,
        color: C.dark,
        borderRadius: flat ? 0 : 12,
        overflow: "hidden",
        boxShadow: flat ? "none" : "0 30px 70px #0004",
        position: "relative",
      }}
    >
      <div
        style={{
          height: 46,
          background: "#e2e1d9",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 20px",
          fontSize: 15,
          color: "#596157",
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 9, background: "#9fa59a" }} />
        <span style={{ width: 8, height: 8, borderRadius: 9, background: "#b7bbae" }} />
        <span style={{ width: 8, height: 8, borderRadius: 9, background: "#c7cabf" }} />
        <span style={{ margin: "0 auto", paddingRight: 40 }}>
          form.example / {product ? "objects" : "bag"}
        </span>
      </div>
      <div
        style={{
          height: 83,
          margin: "0 40px",
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid #cdd0c3",
          justifyContent: "space-between",
        }}
      >
        <b style={{ fontSize: 33, letterSpacing: -1.5 }}>
          form<span style={{ color: "#b35c35" }}>®</span>
        </b>
        <span style={{ fontSize: 17 }}>Example project · storefront</span>
        <span style={{ fontSize: 19 }}>Bag ({quantity})</span>
      </div>
      {product ? (
        <>
          <Img src={lamp} style={{ ...pos(0, 130, 600, 560), objectFit: "cover" }} />
          <div style={{ ...pos(650, 210, 310, 420) }}>
            <Tag color="#7b816f">LIGHT / 001</Tag>
            <div style={{ fontSize: 58, fontWeight: 500, letterSpacing: -3, marginTop: 22 }}>
              Arc lamp
            </div>
            <p style={{ fontSize: 22, lineHeight: 1.5, color: "#707768" }}>
              A little warmth.
              <br />A better everyday.
            </p>
            <div style={{ fontSize: 28, marginTop: 25 }}>$120</div>
            <div
              style={{
                marginTop: 36,
                padding: "20px 0",
                textAlign: "center",
                background: C.dark,
                color: C.ink,
                fontSize: 22,
              }}
            >
              Add to bag ↗
            </div>
          </div>
        </>
      ) : confirmed ? (
        <div style={{ textAlign: "center", paddingTop: 62 }}>
          <Check size={62} />
          <div style={{ fontSize: 49, letterSpacing: -2, marginTop: 23 }}>
            A brighter day is on its way.
          </div>
          <div style={{ fontSize: 24, color: "#626c5e", marginTop: 16 }}>
            Order confirmed · 2 × Arc lamp
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 30,
              marginTop: 37,
              padding: "18px 40px",
              border: "1px solid #bdc4b3",
            }}
          >
            <Img src={lamp} style={{ width: 120, height: 85, objectFit: "cover" }} />
            <div style={{ textAlign: "left", fontSize: 20 }}>
              Amount paid<div style={{ fontSize: 42, fontWeight: 550 }}>$240.00</div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div
            style={{ ...pos(40, 159, 540, 60), fontSize: 40, fontWeight: 500, letterSpacing: -1.7 }}
          >
            Your bag
            <span style={{ fontSize: 19, color: "#737d6b", marginLeft: 20 }}>
              {quantity} {quantity === 1 ? "object" : "objects"}
            </span>
          </div>
          <Img src={lamp} style={{ ...pos(40, 240, 270, 277), objectFit: "cover" }} />
          <div style={pos(337, 255, 225, 260)}>
            <div style={{ fontSize: 30, fontWeight: 550 }}>Arc lamp</div>
            <div style={{ fontSize: 19, color: "#737d6b", marginTop: 12 }}>
              Burnt orange / Aluminum
            </div>
            <div style={{ fontSize: 24, marginTop: 25 }}>$120.00 each</div>
            <div
              style={{
                display: "flex",
                width: 184,
                height: 59,
                border: "1px solid #aab19f",
                marginTop: 30,
                justifyContent: "space-around",
                alignItems: "center",
                fontSize: 25,
              }}
            >
              <span>−</span>
              <b>{quantity}</b>
              <span>+</span>
            </div>
          </div>
          <div
            style={{
              ...pos(623, 186, 337, 395),
              padding: "29px 25px",
              background: "#e6e9db",
              boxSizing: "border-box",
            }}
          >
            <div style={{ fontSize: 26, fontWeight: 550, marginBottom: 31 }}>Order summary</div>
            <div style={{ fontSize: 20, display: "flex", justifyContent: "space-between" }}>
              <span>Subtotal</span>
              <span>${total}.00</span>
            </div>
            <div
              style={{
                fontSize: 20,
                display: "flex",
                justifyContent: "space-between",
                marginTop: 18,
              }}
            >
              <span>Shipping</span>
              <span>Free</span>
            </div>
            <div
              style={{
                marginTop: 26,
                borderTop: "1px solid #b5beaa",
                paddingTop: 22,
                display: "flex",
                justifyContent: "space-between",
                fontSize: 28,
                fontWeight: 550,
                outline: highlight ? `3px solid ${C.red}` : "none",
                outlineOffset: 9,
              }}
            >
              <span>Total</span>
              <span>${total}.00</span>
            </div>
            <div
              style={{
                marginTop: 35,
                textAlign: "center",
                padding: "17px 0",
                background: C.dark,
                color: C.ink,
                fontSize: 22,
              }}
            >
              Checkout ↗
            </div>
          </div>
          {!flat && (
            <div style={{ ...pos(40, 572, 480, 40), fontSize: 18, color: "#727b68" }}>
              Made to last. Delivered with care.
            </div>
          )}
        </>
      )}
      {cursor && <Cursor {...cursor} />}
    </div>
  );
}
function Window({ x, y, width, children, style = {} }) {
  return (
    <div style={{ ...pos(x, y, width, width * 0.65), ...style }}>
      <div style={{ transform: `scale(${width / 1000})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}
function Detail({ x, y, width, height, zoom, originX, originY, children, angle = 0 }) {
  return (
    <div
      style={{
        ...pos(x, y, width, height),
        overflow: "hidden",
        background: C.paper,
        borderRadius: 10,
        boxShadow: "0 40px 85px #0005",
        transform: `perspective(1800px) rotateY(${angle}deg)`,
      }}
    >
      <div
        style={{
          transform: `translate(${-originX * zoom}px, ${-originY * zoom}px) scale(${zoom})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}
function Heading({ children, style = {} }) {
  return (
    <div style={{ fontSize: 46, fontWeight: 500, letterSpacing: -1.9, lineHeight: 1.1, ...style }}>
      {children}
    </div>
  );
}
export function Hook({ t, p, lamp }) {
  return (
    <>
      <div
        style={{
          ...pos(p ? 0 : 760, p ? 470 : 0, p ? 1080 : 1160, p ? 880 : 1080),
          overflow: "hidden",
        }}
      >
        <Img
          src={lamp}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${1.09 - 0.045 * ramp(t, 0, 4)})`,
          }}
        />
      </div>
      <div style={{ ...pos(p ? 60 : 100, p ? 178 : 265, p ? 960 : 930, 360), color: C.dark }}>
        <div
          style={{ fontSize: p ? 90 : 108, fontWeight: 540, lineHeight: 0.99, letterSpacing: -5 }}
        >
          Your agent
          <br />
          built this.
        </div>
        <div
          style={{
            fontSize: p ? 43 : 46,
            letterSpacing: -1.5,
            marginTop: 30,
            opacity: ramp(t, 0.6),
          }}
        >
          AEK finds what needs work.
        </div>
      </div>
      <div
        style={{
          ...pos(p ? 60 : 100, p ? 1130 : 825, p ? 670 : 560, 100),
          background: C.dark,
          color: C.ink,
          padding: "24px 30px",
          boxSizing: "border-box",
          fontSize: p ? 29 : 28,
          opacity: ramp(t, 1.1),
          transform: `translateY(${20 * (1 - ramp(t, 1.1))}px)`,
        }}
      >
        EXAMPLE PROJECT
        <br />
        <span style={{ color: C.lime }}>A storefront checkout ↗</span>
      </div>
    </>
  );
}
export function Story({ t, p, lamp }) {
  return (
    <>
      <div style={{ ...pos(p ? 60 : 100, p ? 295 : 320, p ? 960 : 520, p ? 275 : 520), zIndex: 2 }}>
        <Tag>EXAMPLE / CHECKOUT / US-01</Tag>
        <Heading style={{ fontSize: p ? 45 : 52, marginTop: 27 }}>
          “As a shopper,
          <br />I can change quantity
          <br />
          and pay the right total.”
        </Heading>
        <div style={{ marginTop: 30, fontSize: p ? 25 : 26, color: C.muted }}>2 × $120 = $240</div>
        <div style={{ marginTop: 22, fontSize: 23, color: C.lime }}>Critical gate · must pass</div>
      </div>
      <Window
        x={p ? 90 : 720}
        y={p ? 635 : 300}
        width={p ? 900 : 1060}
        style={{
          transform: `perspective(1600px) rotateY(${-6 * ramp(t)}deg) rotateZ(1deg) translateY(${22 * (1 - ramp(t))}px)`,
        }}
      >
        <Store lamp={lamp} product />
      </Window>
    </>
  );
}
export function Journey({ t, p, lamp, kind }) {
  const state = cartState(kind, t),
    fixed = kind === "retest",
    changed = state.quantity === 2;
  const qty = { x: p ? 445 : 740, y: p ? 520 : 530, w: 250, h: 80 };
  const summary = { x: p ? 60 : 1200, y: p ? 745 : 280, w: p ? 960 : 620, h: p ? 440 : 625 };
  const button = {
    x: summary.x + (p ? 40 : 45),
    y: summary.y + (p ? 320 : 440),
    w: summary.w - (p ? 80 : 90),
    h: p ? 80 : 100,
  };
  const move = ramp(t, 0.3, 1.7),
    pay = fixed ? ramp(t, CHECKOUT_TIMING.payStart, 0.9) : 0;
  const plus = { x: qty.x + 205, y: qty.y + 40 },
    end = { x: button.x + button.w / 2, y: button.y + button.h / 2 };
  const cursor = {
    x: plus.x + 180 * (1 - move) + (end.x - plus.x) * pay,
    y: plus.y + 150 * (1 - move) + (end.y - plus.y) * pay,
    click:
      (t >= CHECKOUT_TIMING.quantity - 0.1 && t < CHECKOUT_TIMING.quantity + 0.5) ||
      (fixed && t >= CHECKOUT_TIMING.confirm - 0.3 && t < CHECKOUT_TIMING.confirm),
  };
  return (
    <>
      <div
        style={{
          ...pos(0, 0, p ? 1080 : 1920, p ? 1350 : 1080),
          background: C.paper,
          color: C.dark,
        }}
      >
        <div
          style={{
            ...pos(0, 0, "100%", 82),
            background: C.dark,
            color: C.ink,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: p ? "0 60px" : "0 100px",
            boxSizing: "border-box",
            fontSize: 25,
          }}
        >
          <b>
            AEK{" "}
            <span style={{ fontWeight: 400, color: C.muted }}>
              {" "}
              / US-01 · {fixed ? "RETEST" : "BROWSER RUN"}
            </span>
          </b>
          {!p && <span>Your project. Evaluated against your story.</span>}
          <span style={{ color: changed ? (fixed ? C.lime : "#ffb29b") : C.muted }}>
            {changed ? (fixed ? "✓ PASS" : "× FAIL") : "Running…"}
          </span>
        </div>
        <div
          style={{
            ...pos(p ? 60 : 100, 112, p ? 960 : 1720, 91),
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid #cdd0c3",
          }}
        >
          <b style={{ fontSize: 45, letterSpacing: -2 }}>
            form<span style={{ color: "#b35c35" }}>®</span>
          </b>
          <span style={{ fontSize: p ? 23 : 27 }}>Example project · storefront</span>
          <span style={{ fontSize: 25 }}>Bag ({state.quantity})</span>
        </div>
        {state.confirmed ? (
          <>
            <Img
              src={lamp}
              style={{ ...pos(0, 204, p ? 1080 : 860, p ? 520 : 876), objectFit: "cover" }}
            />
            <div
              style={{
                ...pos(p ? 90 : 980, p ? 650 : 310, p ? 900 : 800, p ? 565 : 635),
                background: C.paper,
                padding: p ? 45 : 35,
                boxSizing: "border-box",
                boxShadow: p ? "0 25px 80px #35251030" : "none",
              }}
            >
              <Check size={p ? 65 : 78} />
              <div
                style={{
                  fontSize: p ? 58 : 75,
                  letterSpacing: -3,
                  marginTop: 28,
                  lineHeight: 1.05,
                }}
              >
                A brighter day
                <br />
                is on its way.
              </div>
              <div style={{ fontSize: p ? 28 : 32, color: "#65715f", marginTop: 24 }}>
                Order confirmed · 2 × Arc lamp
              </div>
              <div
                style={{
                  borderTop: "1px solid #b8c4ab",
                  marginTop: 35,
                  paddingTop: 25,
                  fontSize: 25,
                }}
              >
                Amount paid
                <div
                  style={{
                    fontSize: p ? 86 : 110,
                    letterSpacing: -5,
                    fontWeight: 550,
                    marginTop: 5,
                  }}
                >
                  $240.00
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                ...pos(p ? 60 : 100, 240, p ? 960 : 900, 85),
                fontSize: p ? 64 : 70,
                letterSpacing: -3,
                fontWeight: 500,
              }}
            >
              Your bag
              <span style={{ fontSize: 25, letterSpacing: 0, color: "#727b68", marginLeft: 25 }}>
                {state.quantity} {state.quantity === 1 ? "object" : "objects"}
              </span>
            </div>
            <Img
              src={lamp}
              style={{
                ...pos(p ? 60 : 100, 335, p ? 340 : 590, p ? 325 : 520),
                objectFit: "cover",
              }}
            />
            <div style={{ ...pos(p ? 445 : 740, 350, p ? 570 : 390, 150) }}>
              <div style={{ fontSize: 48, fontWeight: 550, letterSpacing: -2 }}>Arc lamp</div>
              <div style={{ fontSize: p ? 24 : 25, color: "#737d6b", marginTop: 16 }}>
                Burnt orange / Aluminum
              </div>
              <div style={{ fontSize: 32, marginTop: 29 }}>$120.00 each</div>
            </div>
            <div
              style={{
                ...pos(qty.x, qty.y, qty.w, qty.h),
                display: "flex",
                border: "1px solid #aab19f",
                justifyContent: "space-around",
                alignItems: "center",
                fontSize: 35,
              }}
            >
              <span>−</span>
              <b>{state.quantity}</b>
              <span>+</span>
            </div>
            <div
              style={{ ...pos(summary.x, summary.y, summary.w, summary.h), background: "#e6e9db" }}
            >
              <div
                style={{
                  ...pos(p ? 40 : 45, 35, summary.w - 90, 45),
                  fontSize: p ? 30 : 38,
                  fontWeight: 550,
                }}
              >
                Order summary
              </div>
              <div
                style={{
                  ...pos(p ? 40 : 45, p ? 105 : 135, summary.w - (p ? 80 : 90), 50),
                  fontSize: p ? 29 : 32,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>Subtotal</span>
                <span>${state.total}.00</span>
              </div>
              <div
                style={{
                  ...pos(p ? 40 : 45, p ? 155 : 205, summary.w - (p ? 80 : 90), 50),
                  fontSize: p ? 29 : 32,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>Shipping</span>
                <span>Free</span>
              </div>
              <div
                style={{
                  ...pos(p ? 40 : 45, p ? 220 : 290, summary.w - (p ? 80 : 90), 80),
                  borderTop: "1px solid #b5beaa",
                  paddingTop: 22,
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: p ? 46 : 50,
                  fontWeight: 550,
                  outline: !fixed && t > 3.5 ? `3px solid ${C.red}` : "none",
                  outlineOffset: 10,
                }}
              >
                <span>Total</span>
                <span>${state.total}.00</span>
              </div>
            </div>
            <div
              style={{
                ...pos(button.x, button.y, button.w, button.h),
                background: C.dark,
                color: C.ink,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: p ? 32 : 37,
              }}
            >
              Checkout ↗
            </div>
            <div
              style={{
                ...pos(p ? 60 : 740, p ? 685 : 680, p ? 960 : 400, p ? 45 : 130),
                fontSize: p ? 27 : 31,
                lineHeight: 1.4,
                color: changed ? (fixed ? "#527128" : C.red) : "#65715f",
                opacity: ramp(t, 3),
              }}
            >
              {fixed
                ? "Same story. Same acceptance test."
                : p
                  ? "Expected $240 · observed $120"
                  : "Expected $240.\nObserved $120."}
            </div>
            <Cursor {...cursor} />
          </>
        )}
      </div>
    </>
  );
}
export function Edit({ t, p, lamp }) {
  const patched = t > 2;
  return (
    <>
      <div
        style={{ ...pos(p ? 60 : 100, p ? 300 : 335, p ? 960 : 470, p ? 180 : 450), color: C.dark }}
      >
        <Tag color={C.red}>AGENT RECEIVES / US-01</Tag>
        <Heading style={{ marginTop: 24, fontSize: p ? 41 : 50 }}>
          Recalculate the total
          <br />
          when quantity changes.
        </Heading>
        {!p && (
          <Img
            src={lamp}
            style={{ width: 290, height: 195, objectFit: "cover", marginTop: 35, borderRadius: 5 }}
          />
        )}
      </div>
      <div
        style={{
          ...pos(p ? 60 : 655, p ? 555 : 305, p ? 960 : 1150, p ? 505 : 575),
          border: "1px solid #465044",
          borderRadius: 12,
          background: "#20261f",
          color: C.ink,
          boxShadow: "0 35px 80px #0004",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "26px 32px",
            borderBottom: "1px solid #465044",
            fontSize: 22,
            color: C.muted,
          }}
        >
          cart.ts <span style={{ float: "right", color: C.lime }}>CODING AGENT / REVISION 02</span>
        </div>
        <div
          style={{
            padding: "44px 30px",
            fontFamily: "monospace",
            fontSize: p ? 30 : 35,
            lineHeight: 1.9,
          }}
        >
          <div style={{ color: "#89977f" }}>function total(item, quantity) &#123;</div>
          <div
            style={{
              background: "#623d3255",
              color: "#f4b19b",
              paddingLeft: 15,
              textDecoration: patched ? "line-through" : "none",
            }}
          >
            − return item.price;
          </div>
          <div
            style={{
              opacity: ramp(t, 1.4),
              background: "#708f3450",
              color: C.lime,
              paddingLeft: 15,
            }}
          >
            + return item.price * quantity;
          </div>
          <div style={{ color: "#89977f" }}>&#125;</div>
        </div>
        <div
          style={{
            margin: "0 32px",
            borderTop: "1px solid #465044",
            paddingTop: 24,
            fontSize: 25,
            color: patched ? C.lime : C.muted,
          }}
        >
          {patched ? "✓ Patch ready → rerun US-01" : "Applying the evidence…"}
        </div>
      </div>
      <div
        style={{
          ...pos(p ? 60 : 100, p ? 1150 : 950, p ? 960 : 1720, 70),
          fontSize: p ? 26 : 29,
          color: "#59634f",
        }}
      >
        AEK evaluates. Your coding agent edits and selects.
      </div>
    </>
  );
}
export function Breadth({ t, p, lamp }) {
  const query = "aluminum".slice(0, Math.floor(ramp(t, 0.2, 1.1) * 8));
  return (
    <>
      <div style={{ ...pos(p ? 60 : 100, p ? 300 : 315, p ? 960 : 610, 300) }}>
        <Tag color={C.lime}>REVISION 02 KEPT → NEXT EVALUATION</Tag>
        <Heading style={{ fontSize: p ? 43 : 57, marginTop: 25 }}>
          “Find the lamp
          <br />
          by its material.”
        </Heading>
        <div style={{ fontSize: p ? 24 : 28, color: C.muted, marginTop: 24 }}>
          US-02 / Search · AEK runs again
        </div>
      </div>
      <div
        style={{
          ...pos(p ? 60 : 830, p ? 575 : 280, p ? 960 : 990, p ? 680 : 710),
          background: C.paper,
          color: C.dark,
          borderRadius: 12,
          boxShadow: "0 30px 80px #0004",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: 90,
            margin: "0 35px",
            borderBottom: "1px solid #cdd0c3",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <b style={{ fontSize: 34, letterSpacing: -1.5 }}>
            form<span style={{ color: "#b35c35" }}>®</span>
          </b>
          <span style={{ fontSize: 21 }}>Example project · storefront</span>
        </div>
        <div
          style={{
            ...pos(35, 120, p ? 890 : 920, 78),
            border: "1px solid #7c896d",
            display: "flex",
            alignItems: "center",
            padding: "0 25px",
            boxSizing: "border-box",
            fontSize: 34,
          }}
        >
          ⌕ <span style={{ marginLeft: 20 }}>{query}</span>
          <span style={{ width: 2, height: 36, background: C.dark, marginLeft: 2 }} />
        </div>
        <div
          style={{
            opacity: ramp(t, 1.4),
            ...pos(35, 235, p ? 890 : 920, p ? 340 : 370),
            display: "flex",
            gap: 35,
            alignItems: "center",
          }}
        >
          <Img
            src={lamp}
            style={{ width: p ? 435 : 470, height: p ? 330 : 350, objectFit: "cover" }}
          />
          <div>
            <Tag color="#69785b">1 RESULT / ALUMINUM</Tag>
            <div
              style={{ fontSize: p ? 43 : 49, fontWeight: 500, letterSpacing: -2, marginTop: 24 }}
            >
              Arc lamp
            </div>
            <div style={{ fontSize: 27, color: "#737d6b", marginTop: 18 }}>Burnt orange</div>
            <div style={{ fontSize: 33, marginTop: 25 }}>$120</div>
          </div>
        </div>
        <div
          style={{
            ...pos(35, p ? 590 : 630, p ? 890 : 920, 80),
            borderTop: "1px solid #bdc7b0",
            paddingTop: 18,
            fontSize: 21,
            color: "#66745a",
          }}
        >
          US-03 / Refund · provider unavailable → score withheld
        </div>
      </div>
    </>
  );
}
export function Close({ t, p }) {
  const q = (t % 3) / 3;
  const route = "M145 95H655Q735 95 692 165L450 385Q400 430 350 385L108 165Q65 95 145 95Z";
  return (
    <>
      <div
        style={{
          ...pos(p ? 60 : 100, p ? 215 : 275, p ? 960 : 1080, 360),
          fontSize: p ? 95 : 110,
          fontWeight: 510,
          letterSpacing: -5,
          lineHeight: 1.04,
        }}
      >
        Give your agent
        <br />
        <span style={{ color: C.lime }}>a way to get better.</span>
      </div>
      <div style={{ ...pos(p ? 60 : 1140, p ? 555 : 235, p ? 960 : 700, p ? 600 : 520) }}>
        <svg viewBox="0 0 800 480" width="100%" height="100%" style={{ overflow: "visible" }}>
          <defs>
            <radialGradient id="loop-aura">
              <stop stopColor="#baff4f" stopOpacity=".13" />
              <stop offset="1" stopColor="#baff4f" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse cx="400" cy="220" rx="370" ry="230" fill="url(#loop-aura)" />
          {[0.86, 1, 1.12].map((scale, i) => (
            <path
              key={scale}
              d={route}
              transform={`translate(400 220) scale(${scale}) translate(-400 -220)`}
              stroke={i === 1 ? "#8a9c65" : "#394632"}
              strokeWidth={i === 1 ? 2 : 1}
              fill="none"
            />
          ))}
          <path
            d={route}
            stroke={C.lime}
            strokeWidth="5"
            fill="none"
            pathLength="1"
            strokeDasharray=".12 .88"
            strokeDashoffset={-q}
          />
          {[
            [145, 95, "User stories"],
            [655, 95, "AEK evaluates"],
            [400, 394, "Agent improves"],
          ].map(([x, y, label]) => (
            <g key={label}>
              <circle cx={x} cy={y} r="11" fill={C.lime} />
              <rect x={x - 120} y={y - 63} width="240" height="43" rx="20" fill={C.bg} />
              <text
                x={x}
                y={y - 34}
                fill={C.ink}
                textAnchor="middle"
                fontFamily="InterFilm"
                fontSize="27"
              >
                {label}
              </text>
            </g>
          ))}
          <text
            x="400"
            y="245"
            fill={C.lime}
            textAnchor="middle"
            fontFamily="InterFilm"
            fontSize="94"
            fontWeight="520"
            letterSpacing="-6"
          >
            aek
          </text>
        </svg>
      </div>
      <div
        style={{ ...pos(p ? 60 : 100, p ? 1180 : 900, p ? 960 : 1720, 65), fontSize: p ? 33 : 36 }}
      >
        github.com/DeanStr/agent-eval-kit <span style={{ color: C.lime }}>↗</span>
      </div>
    </>
  );
}
