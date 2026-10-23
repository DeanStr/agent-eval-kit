import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const criterion = process.argv[2];
if (!["DATA", "TASK", "PHONE"].includes(criterion)) throw Error("Specify DATA, TASK or PHONE");
const directory = path.join(process.env.AEK_RUN_DIR, "WORKFLOW");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
const file = evidence.files.find((f) => f.label === "observations");
if (!file) throw Error("Missing observations");
const resolved = path.resolve(directory, file.path);
if (!resolved.startsWith(directory + path.sep)) throw Error("Evidence escapes scenario");
const bytes = fs.readFileSync(resolved);
if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
  throw Error("Observation integrity mismatch");
const observed = JSON.parse(bytes);
const issues = [];
const fail = (message) => issues.push(message);

// Independent expectations for the fixed synthetic scenario.
const ids = ["RL-2045", "RL-2046", "RL-2047", "RL-2048", "RL-2049", "RL-2050", "RL-2051", "RL-2052", "RL-2053"];
const loads = {
  original: { Maya: [3, 6], Leo: [2, 5], Nina: [2, 4] },
  assigned: { Maya: [1, 6], Leo: [4, 5], Nina: [2, 4] },
};
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const parseRow = (row) => {
  const deadline = row.text.match(/\b(?:by|due)\s*(\d{2}:\d{2})/i)?.[1];
  const eta = row.text.replace(/\b(?:by|due)\s*\d{2}:\d{2}/i, "").match(/\b\d{2}:\d{2}\b/)?.[0];
  return {
    id: row.id,
    eta,
    deadline,
    driver: row.text.match(/\b(Maya|Leo|Nina)\b/)?.[1] ?? null,
    delivered: /delivered/i.test(row.text),
    flagged: /at risk|late/i.test(row.text),
  };
};
const count = (summary, label) => Number(summary.match(new RegExp(`(\\d+)\\s*${label}`, "i"))?.[1]);
const driverLoads = (text) =>
  Object.fromEntries(
    ["Maya", "Leo", "Nina"].map((name) => {
      const match = text.match(new RegExp(`${name}[^\\d]*(\\d+)\\s*/\\s*(\\d+)`));
      return [name, match ? [Number(match[1]), Number(match[2])] : null];
    }),
  );
const consistent = (key, state) => {
  const rows = state.rows.map(parseRow);
  if (rows.some((r) => !r.eta || !r.deadline)) fail(`${key}: a delivery lacks a readable arrival or deadline`);
  const late = rows.filter((r) => !r.delivered && r.eta && minutes(r.eta) > minutes(r.deadline));
  const s = state.summary;
  if (count(s, "scheduled") !== rows.length) fail(`${key}: scheduled count does not match the queue`);
  if (count(s, "completed") !== rows.filter((r) => r.delivered).length)
    fail(`${key}: completed count does not match delivered rows`);
  if (count(s, "in transit") !== rows.filter((r) => !r.delivered).length)
    fail(`${key}: in-transit count does not match active rows`);
  if (count(s, "at risk") !== late.length) fail(`${key}: at-risk count does not match late rows`);
  for (const r of rows)
    if (r.flagged !== late.some((l) => l.id === r.id))
      fail(`${key}: ${r.id} status label disagrees with its arrival and deadline`);
  return rows;
};
const sameRows = (key, state, reference, except = []) => {
  if (state.rows.length !== reference.rows.length) return fail(`${key}: delivery count changed`);
  for (const row of reference.rows)
    if (!except.includes(row.id) && state.rows.find((r) => r.id === row.id)?.text !== row.text)
      fail(`${key}: ${row.id} changed unexpectedly`);
};
const expectLoads = (key, state, expected) => {
  const actual = driverLoads(state.drivers);
  for (const [name, value] of Object.entries(expected))
    if (JSON.stringify(actual[name]) !== JSON.stringify(value))
      fail(`${key}: ${name} load is ${actual[name]?.join("/") ?? "missing"}; expected ${value.join("/")}`);
};
const step = (size, name) => observed[size].steps.find((s) => s.name === name);

for (const size of ["desktop", "phone"]) {
  const { states, steps, errors } = observed[size];
  for (const key of ["initial", "assigned", "assignedReload", "undone", "undoneReload", "reset"])
    if (!states[key] || !Array.isArray(states[key].rows)) throw Error(`Missing ${size} ${key} state`);
  const late = (key) => consistent(`${size} ${key}`, states[key]).find((r) => r.id === "RL-2048");

  if (criterion === "DATA") {
    const initial = states.initial.rows.map((r) => r.id).sort();
    if (JSON.stringify(initial) !== JSON.stringify(ids)) fail(`${size}: expected the nine fixture deliveries`);
    const before = late("initial");
    if (before?.eta !== "14:52" || before?.deadline !== "14:30")
      fail(`${size}: RL-2048 should arrive 14:52 against a 14:30 deadline`);
    if (size === "desktop" && before?.driver !== "Maya") fail("desktop: RL-2048 should start with Maya");
    if (count(states.initial.summary, "at risk") !== 1) fail(`${size}: expected one shipment at risk`);
    expectLoads(`${size} initial`, states.initial, loads.original);
    const options = step(size, "openDialog")?.detail?.dialog?.options ?? [];
    const nina = options.find((o) => /Nina/.test(o.text)),
      leo = options.find((o) => /Leo/.test(o.text));
    if (!nina?.disabled || !/temperature|cold/i.test(nina.text))
      fail(`${size}: Nina must be shown as ineligible because the shipment needs cold chain`);
    if (!leo || leo.disabled) fail(`${size}: Leo must be an eligible option`);
    for (const key of ["assigned", "assignedReload"]) {
      const after = late(key);
      if (after?.eta !== "14:18") fail(`${size} ${key}: RL-2048 should arrive 14:18`);
      if (size === "desktop" && after?.driver !== "Leo") fail(`desktop ${key}: RL-2048 should be with Leo`);
      if (count(states[key].summary, "at risk") !== 0) fail(`${size} ${key}: at-risk count should clear`);
      if (!/Leo/.test(states[key].detail) || !/14:18/.test(states[key].detail))
        fail(`${size} ${key}: details should show Leo arriving 14:18`);
      expectLoads(`${size} ${key}`, states[key], loads.assigned);
      sameRows(`${size} ${key}`, states[key], states.initial, ["RL-2048"]);
    }
    for (const key of ["undone", "undoneReload", "reset"]) {
      sameRows(`${size} ${key}`, states[key], states.initial);
      if (states[key].summary !== states.initial.summary) fail(`${size} ${key}: summary not restored`);
      expectLoads(`${size} ${key}`, states[key], loads.original);
    }
  }

  if (criterion === "TASK") {
    for (const s of steps) if (!s.ok) fail(`${size}: could not complete ${s.name} (${s.error})`);
    for (const [name, rows] of [["filterAtRisk", 1], ["filterCompleted", 3], ["filterAll", 9]])
      if (step(size, name)?.ok && step(size, name).detail.rows !== rows)
        fail(`${size}: ${name} shows ${step(size, name).detail.rows} deliveries; expected ${rows}`);
    const empty = step(size, "emptySearch")?.detail;
    if (empty && (empty.rows !== 0 || empty.restoredRows !== 9 || empty.search !== ""))
      fail(`${size}: unmatched search and its recovery action do not behave as expected`);
    const onTime = step(size, "onTimeShipment")?.detail;
    if (onTime && (!/Studio August/.test(onTime.detail) || onTime.reassignControls !== 0))
      fail(`${size}: an on-time shipment should show its details without a reassignment action`);
    const escape = step(size, "escapeCloses")?.detail;
    if (escape && (escape.open || !escape.focus.insideDetail || !/^reassign/i.test(escape.focus.text)))
      fail(`${size}: Escape should close the dialog and return focus to the reassign control`);
    if (step(size, "enterReopens")?.detail?.open !== true) fail(`${size}: Enter did not reopen the dialog`);
    if (step(size, "confirmLeo")?.detail?.open !== false) fail(`${size}: confirming did not close the dialog`);
    if (!/14:18/.test(states.assigned.detail)) fail(`${size}: confirming did not update the shipment`);
    const kept = step(size, "resetCancel")?.detail?.summary;
    if (kept && count(kept, "at risk") !== 0) fail(`${size}: cancelling reset discarded the reassignment`);
    if (count(states.reset.summary, "at risk") !== 1) fail(`${size}: confirming reset did not restore`);
    if (errors.length) fail(`${size}: page errors: ${errors.join("; ")}`);
  }

  if (criterion === "PHONE" && size === "phone") {
    for (const key of ["initial", "selected", "assigned"])
      if (states[key].scrollWidth > states[key].width + 1)
        fail(`${key}: page is ${states[key].scrollWidth}px wide in a ${states[key].width}px viewport`);
    const trapped = states.initial.rows.filter((r) => r.trappedIn);
    if (trapped.length)
      fail(
        `the delivery queue is a nested scroll region showing ${trapped[0].trappedIn.visibleHeight}px of ${trapped[0].trappedIn.contentHeight}px, so some deliveries are hidden from page scrolling`,
      );
    const small = states.initial.rows.filter((r) => r.minFont < 12);
    if (small.length)
      fail(`queue text falls to ${Math.min(...small.map((r) => r.minFont))}px in ${small.length} deliveries`);
    if (!states.selected.detailTimeFonts.length || Math.min(...states.selected.detailTimeFonts) < 12)
      fail("selected arrival and deadline are missing or below 12px");
    const opened = step("phone", "openDialog")?.detail;
    if (!opened) fail("the recovery dialog could not be opened");
    else {
      const d = opened.dialog;
      if (!d.open || d.rect.left < 0 || d.rect.right > d.width + 1 || d.scrollWidth > d.width + 1)
        fail("the recovery dialog does not fit the phone width");
      if (!opened.confirmInView) fail("the confirm control cannot be brought into view");
      const optionFont = Math.min(...d.options.map((o) => o.minFont));
      if (optionFont < 12) fail(`driver option text falls to ${optionFont}px`);
      for (const [name, value] of [["reassign", opened.triggerHeight], ["confirm", opened.confirmHeight]])
        if (value < 40) fail(`${name} control is ${value}px tall`);
    }
    const undo = step("phone", "undoControl")?.detail?.height;
    if (!(undo >= 40)) fail(`undo control is ${undo ?? "missing"}${undo ? "px" : ""} tall`);
    if (step("phone", "selectLateShipment")?.detail?.detailInView !== true)
      fail("selecting a delivery does not bring its details into view");
  }
}
const passes = {
  DATA: "On desktop and phone, counts match the queue; the Leo reassignment changes only RL-2048, respects cold chain and capacity, survives reload and is fully reversed by undo and reset.",
  TASK: "Filters, empty search recovery, on-time inspection, keyboard cancel and reopen, confirmation, undo and confirmed reset all work on desktop and phone without page errors.",
  PHONE: "At 390px every delivery is reachable by page scrolling, essential text is at least 12px, task controls are at least 40px tall, details scroll into view and the dialog fits.",
};
console.log(
  JSON.stringify({
    verdict: issues.length ? "fail" : "pass",
    confidence: "high",
    reasoning: issues.length ? issues.join("; ") : passes[criterion],
    evidenceRefs: [`WORKFLOW/${file.path}`],
  }),
);
