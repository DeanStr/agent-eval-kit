import { fixture, late, load, minutes, options, reassign } from "./data.js";

const $ = (selector) => document.querySelector(selector);
const key = "aek-relay-prototype-v1";
let shipments,
  recovered = false,
  selected = "RL-2048",
  filter = "all",
  search = "";
const driver = (id) => fixture.drivers.find((d) => d.id === id);
const avatar = (d) =>
  `<span class="avatar" style="background:${d.color}12;color:${d.color}">${d.initials}</span>`;
const status = (s) =>
  s.status === "delivered"
    ? '<span class="pill success">Delivered</span>'
    : late(s)
      ? '<span class="pill warning">At risk</span>'
      : '<span class="pill">On time</span>';

function restore() {
  const raw = localStorage.getItem(key);
  if (raw !== null) {
    const saved = JSON.parse(raw);
    if (
      !saved ||
      saved.version !== 1 ||
      typeof saved.recovered !== "boolean" ||
      Object.keys(saved).length !== 2
    )
      throw new Error("Saved demo state is invalid. Reset it to restore the original deliveries.");
    recovered = saved.recovered;
  }
  shipments = recovered
    ? reassign(fixture.shipments, "RL-2048", "leo")
    : structuredClone(fixture.shipments);
}

function commit(next) {
  const nextShipments = next
    ? reassign(fixture.shipments, "RL-2048", "leo")
    : structuredClone(fixture.shipments);
  // Persist before updating the interface. A failed write must not look successful.
  localStorage.setItem(key, JSON.stringify({ version: 1, recovered: next }));
  recovered = next;
  shipments = nextShipments;
}

function renderMap() {
  const routes = [
    {
      id: "maya",
      path: recovered ? "M474 218L460 245V314" : "M474 218L474 180L402 180V156M474 218L460 245V314",
    },
    {
      id: "leo",
      path: recovered
        ? "M261 278L303 278V205L402 205V156M402 156V205H303V330H192"
        : "M261 278L261 330H192",
    },
    { id: "nina", path: "M243 104L190 104L174 158" },
  ];
  $("#map-routes").innerHTML = routes
    .map(
      (r) =>
        `<path d="${r.path}" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="${r.path}" fill="none" stroke="${driver(r.id).color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" ${r.id === "maya" && !recovered ? 'stroke-dasharray="5 4"' : ""}/>`,
    )
    .join("");
  $("#map-pins").innerHTML =
    shipments
      .filter((s) => s.status !== "delivered")
      .map((s) => {
        const active = selected === s.id;
        const color = late(s) ? "#c57d2b" : driver(s.driver).color;
        return `<g transform="translate(${s.x} ${s.y})">${active ? `<circle r="20" fill="${color}18"/><circle r="13" fill="white" filter="url(#pin-shadow)"/>` : ""}<circle r="${active ? 9 : 5}" fill="${color}" stroke="white" stroke-width="2"/>${active ? '<path d="M-3 0h6M0-3v6" stroke="white" stroke-width="1.5"/>' : ""}</g>`;
      })
      .join("") +
    fixture.drivers
      .map(
        (d) =>
          `<g transform="translate(${d.x} ${d.y + 20})"><rect x="-17" y="-12" width="34" height="24" rx="7" fill="${d.color}" stroke="white" stroke-width="2"/><text y="4.5" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="12" font-weight="bold">${d.initials}</text></g>`,
      )
      .join("");
}

function renderDetail() {
  const s = shipments.find((s) => s.id === selected);
  if (!s) throw new Error("Selected delivery is missing. Reset the demo.");
  const d = driver(s.driver),
    delay = minutes(s.eta) - minutes(s.deadline);
  const isRecovered = s.id === "RL-2048" && recovered;
  $("#detail").innerHTML =
    `<div class="detail-top"><span class="eyebrow">${s.id}</span>${status(s)}</div>
    <h2 tabindex="-1" id="selected-title">${s.name}</h2><p class="detail-address">${s.address}</p>
    <div class="detail-tags"><span>${s.description}</span>${s.cold ? "<span>Cold chain required</span>" : ""}<span>${s.units} ${s.units === 1 ? "unit" : "units"}</span></div>
    <div class="arrival-strip"><div><span>${s.status === "delivered" ? "Delivered at" : "Estimated arrival"}</span><strong class="${late(s) ? "warning-text" : isRecovered ? "success-text" : ""}">${s.eta}${late(s) ? `<small>+${delay} min late</small>` : isRecovered ? "<small>12 min early</small>" : ""}</strong></div><div><span>Deliver by</span><strong>${s.deadline}</strong></div></div>
    ${late(s) ? `<div class="cause"><div><strong>Route delay</strong>${s.note}</div></div>` : isRecovered ? '<div class="cause recovered"><div><strong>Reassigned to Leo Chen</strong>Arrival 14:18. Studio August remains scheduled for 14:35.</div></div>' : ""}
    <div class="assigned">${avatar(d)}<div>${d.name}<small>${d.area} · ${d.cold ? "Temperature-controlled van" : "Standard van"}</small></div><span>${load(shipments, d.id)} / ${d.capacity} units</span></div>
    ${late(s) ? '<button class="primary" id="find-recovery">Reassign delivery</button>' : isRecovered ? '<button class="secondary" id="undo-detail">Undo reassignment</button><p class="action-note">Saved locally.</p>' : '<p class="action-note">' + (s.status === "delivered" ? "Delivery completed." : "No action required.") + "</p>"}`;
  $("#find-recovery")?.addEventListener("click", openRecovery);
  $("#undo-detail")?.addEventListener("click", undo);
}

function render() {
  const attention = shipments.filter(late).length;
  const completed = shipments.filter((s) => s.status === "delivered").length;
  $("#total-count").textContent = shipments.length;
  $("#completed-count").textContent = completed;
  $("#transit-count").textContent = shipments.length - completed;
  $("#risk-count").textContent = attention;
  $("#risk-count").style.color = attention ? "" : "#31816c";
  $("#overview-message").textContent = attention
    ? `${attention} delivery at risk of missing its window.`
    : "No deliveries currently at risk.";
  $("#all-count").textContent = shipments.length;
  $("#attention-count").textContent = attention;
  $("#delivered-count").textContent = completed;
  for (const button of document.querySelectorAll("[data-filter]"))
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  const visible = shipments.filter(
    (s) =>
      (filter === "all" ||
        (filter === "attention" && late(s)) ||
        (filter === "delivered" && s.status === "delivered")) &&
      `${s.name} ${s.id} ${s.address} ${driver(s.driver).name}`.toLowerCase().includes(search),
  );
  $("#shipments").innerHTML = visible.length
    ? visible
        .map(
          (s) =>
            `<button class="delivery" data-shipment="${s.id}" aria-pressed="${s.id === selected}" aria-label="${s.name}, ${s.id}, ${s.status === "delivered" ? "delivered" : late(s) ? "at risk" : "on time"}, arrival ${s.eta}"><span class="customer"><span><span class="name">${s.name}</span><span class="identifier">${s.id} · ${s.area}</span></span></span><span class="driver-cell">${avatar(driver(s.driver))}${driver(s.driver).name.split(" ")[0]}</span><span class="eta ${late(s) ? "late" : ""}"><strong>${s.eta}</strong><small>by ${s.deadline}</small></span>${status(s)}</button>`,
        )
        .join("")
    : `<div class="empty"><h3>${filter === "attention" && !search ? "No deliveries at risk." : "No deliveries found."}</h3><p>${filter === "attention" && !search ? "No active delivery is expected to miss its window." : "Try a customer, delivery ID or driver name."}</p><button id="clear-filters">Show all deliveries</button></div>`;
  $("#clear-filters")?.addEventListener("click", () => {
    filter = "all";
    search = "";
    $("#search").value = "";
    render();
    $('[data-filter="all"]').focus();
  });
  for (const button of document.querySelectorAll("[data-shipment]"))
    button.addEventListener("click", () => {
      selected = button.dataset.shipment;
      render();
      if (matchMedia("(max-width:700px)").matches)
        $(".context").scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "instant" : "smooth",
          block: "start",
        });
      $("#selected-title").focus({ preventScroll: true });
    });
  $("#result-count").textContent =
    `${visible.length} ${visible.length === 1 ? "delivery" : "deliveries"}${visible.length !== shipments.length ? ` of ${shipments.length}` : ""}`;
  $("#driver-list").innerHTML = fixture.drivers
    .map(
      (d) =>
        `<div class="driver-summary">${avatar(d)}<div><strong>${d.name}</strong><small>${load(shipments, d.id)} / ${d.capacity} units</small></div></div>`,
    )
    .join("");
  renderMap();
  renderDetail();
}

function openRecovery() {
  const s = shipments.find((s) => s.id === selected);
  const choices = options(shipments, s);
  if (s.id !== "RL-2048" || recovered)
    throw new Error("This demo has no recovery plan for the selected delivery.");
  $("#recovery-content").innerHTML =
    `<div class="dialog-header"><h2 id="recovery-title">Reassign RL-2048</h2><p>Riverton Medical · Due 14:30. A temperature-controlled vehicle is required.</p><div class="shipment-brief"><span><b>RL-2048</b> Riverton Medical</span><span>Cold chain required</span><span>2 load units</span></div></div>
    <fieldset class="options" style="border:0;margin:0" aria-label="Available drivers">${choices.map((o) => `<label class="option"><span class="option-top"><input type="radio" name="driver" value="${o.driver.id}" ${o.eligible ? "checked" : "disabled"} aria-label="${o.driver.name}, arrival ${o.eta}${o.eligible ? "" : ", unavailable: " + o.reasons.join("; ")}">${avatar(o.driver)}<span><strong>${o.driver.name}</strong><span class="route">${o.driver.area}</span></span><span class="option-eta"><b>${o.eta}</b><span>${o.eligible ? `${minutes(s.deadline) - minutes(o.eta)} min before deadline` : "Not eligible"}</span></span></span><span class="option-details"><span>${load(shipments, o.driver.id)} → ${o.projectedLoad} / ${o.driver.capacity} units</span><span>${o.driver.cold ? "Temperature-controlled van" : "Standard van"}</span></span>${o.reasons.length ? `<span class="option-warning" style="display:block">${o.reasons.join(" · ")}</span>` : ""}</label>`).join("")}</fieldset>
    <div class="plan"><div><strong>Leo’s route after reassignment</strong><ol><li><time>14:00</time>Forma Studio</li><li class="added-stop"><time>14:18</time>Riverton Medical <span>Added</span></li><li><time>14:35</time>Studio August</li></ol></div></div>
    <p id="recovery-error" class="save-error" role="alert"></p><div class="dialog-actions"><span>Demo estimates. Changes are saved locally.</span><button class="primary" id="confirm-reassignment">Reassign to Leo</button></div>`;
  $("#confirm-reassignment").addEventListener("click", () => {
    const choice = $("#recovery input[name=driver]:checked");
    if (!choice) throw new Error("Select an eligible driver before confirming.");
    // Revalidate the selected assignment at commit, independently of the disabled control.
    reassign(shipments, selected, choice.value);
    if (choice.value !== "leo")
      throw new Error("This scenario only supports the verified Leo recovery plan.");
    try {
      commit(true);
    } catch (error) {
      $("#recovery-error").textContent =
        `Could not save: ${error.message}. The assignment has not changed.`;
      return;
    }
    $("#recovery").close();
    render();
    $("#selected-title").focus({ preventScroll: true });
    toast("RL-2048 reassigned to Leo. Arrival 14:18.", true);
  });
  $("#recovery").showModal();
}

function toast(message, withUndo) {
  $("#toast").replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  $("#toast").append(text);
  if (withUndo) {
    const button = document.createElement("button");
    button.textContent = "Undo";
    button.addEventListener("click", undo);
    $("#toast").append(button);
  } else {
    const button = document.createElement("button");
    button.textContent = "Dismiss";
    button.addEventListener("click", () => $("#toast").classList.remove("visible"));
    $("#toast").append(button);
  }
  $("#toast").classList.add("visible");
}

function undo() {
  try {
    commit(false);
  } catch (error) {
    toast(`Could not restore: ${error.message}`, false);
    return;
  }
  selected = "RL-2048";
  render();
  $("#find-recovery").focus({ preventScroll: true });
  toast("Original assignment restored. Riverton needs attention again.", false);
}

try {
  restore();
  render();
  for (const button of document.querySelectorAll("[data-filter]"))
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      render();
    });
  $("#search").addEventListener("input", (event) => {
    search = event.target.value.trim().toLowerCase();
    render();
  });
  $("#reset").addEventListener("click", () => {
    $("#reset-error").textContent = "";
    $("#reset-dialog").showModal();
  });
  $("#cancel-reset").addEventListener("click", () => $("#reset-dialog").close());
  $("#confirm-reset").addEventListener("click", () => {
    try {
      commit(false);
    } catch (error) {
      $("#reset-error").textContent =
        `Could not reset: ${error.message}. Your current assignment is unchanged.`;
      return;
    }
    $("#reset-dialog").close();
    filter = "all";
    search = "";
    selected = "RL-2048";
    $("#search").value = "";
    $("#toast").classList.remove("visible");
    render();
  });
} catch (error) {
  const main = document.querySelector("main");
  main.replaceChildren();
  main.className = "fatal";
  const title = document.createElement("h1");
  title.textContent = "This demo could not load.";
  const message = document.createElement("p");
  message.textContent = error.message;
  const reset = document.createElement("button");
  reset.textContent = "Clear saved demo and reload";
  reset.addEventListener("click", () => {
    localStorage.removeItem(key);
    location.reload();
  });
  main.append(title, message, reset);
  console.error(error);
}
