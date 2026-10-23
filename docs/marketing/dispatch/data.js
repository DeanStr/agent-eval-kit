// Fixed synthetic scenario for a working creative prototype, not live operations.
export const fixture = {
  version: 1,
  now: "13:45",
  drivers: [
    {
      id: "maya",
      name: "Maya Wilson",
      initials: "MW",
      color: "#315ce8",
      area: "East route",
      capacity: 6,
      cold: true,
      available: "14:25",
      travel: 27,
      x: 474,
      y: 218,
    },
    {
      id: "leo",
      name: "Leo Chen",
      initials: "LC",
      color: "#15796b",
      area: "Central route",
      capacity: 5,
      cold: true,
      available: "14:00",
      travel: 18,
      x: 261,
      y: 278,
    },
    {
      id: "nina",
      name: "Nina Patel",
      initials: "NP",
      color: "#9168b3",
      area: "North route",
      capacity: 4,
      cold: false,
      available: "13:55",
      travel: 13,
      x: 243,
      y: 104,
    },
  ],
  shipments: [
    {
      id: "RL-2048",
      name: "Riverton Medical",
      address: "18 Bridge Street",
      area: "East",
      driver: "maya",
      eta: "14:52",
      deadline: "14:30",
      units: 2,
      cold: true,
      status: "transit",
      x: 402,
      y: 156,
      description: "Diagnostic samples",
      note: "Eastbound bridge closure adds 27 minutes to Maya’s route.",
    },
    {
      id: "RL-2049",
      name: "Forma Studio",
      address: "42 Market Lane",
      area: "Central",
      driver: "leo",
      eta: "14:00",
      deadline: "14:20",
      units: 1,
      cold: false,
      status: "transit",
      x: 261,
      y: 278,
      description: "Material samples",
    },
    {
      id: "RL-2050",
      name: "Good Day Coffee",
      address: "7 Wellington Road",
      area: "North",
      driver: "nina",
      eta: "13:55",
      deadline: "14:15",
      units: 1,
      cold: false,
      status: "transit",
      x: 243,
      y: 104,
      description: "Coffee equipment",
    },
    {
      id: "RL-2051",
      name: "Arc & Co.",
      address: "86 High Street",
      area: "East",
      driver: "maya",
      eta: "15:15",
      deadline: "15:40",
      units: 1,
      cold: false,
      status: "transit",
      x: 460,
      y: 314,
      description: "Lighting components",
    },
    {
      id: "RL-2052",
      name: "Northside Books",
      address: "12 Carlton Avenue",
      area: "North",
      driver: "nina",
      eta: "14:25",
      deadline: "14:45",
      units: 1,
      cold: false,
      status: "transit",
      x: 174,
      y: 158,
      description: "Book delivery",
    },
    {
      id: "RL-2053",
      name: "Studio August",
      address: "35 Union Street",
      area: "Central",
      driver: "leo",
      eta: "14:35",
      deadline: "15:00",
      units: 1,
      cold: false,
      status: "transit",
      x: 192,
      y: 330,
      description: "Print materials",
    },
    {
      id: "RL-2045",
      name: "Fable Bakery",
      address: "9 Park Crescent",
      area: "Central",
      driver: "leo",
      eta: "13:32",
      deadline: "14:00",
      units: 1,
      cold: false,
      status: "delivered",
      x: 200,
      y: 239,
      description: "Packaging supplies",
    },
    {
      id: "RL-2046",
      name: "West End Pharmacy",
      address: "54 King Street",
      area: "North",
      driver: "nina",
      eta: "13:26",
      deadline: "13:45",
      units: 1,
      cold: false,
      status: "delivered",
      x: 115,
      y: 183,
      description: "Medical supplies",
    },
    {
      id: "RL-2047",
      name: "The Common",
      address: "29 Victoria Street",
      area: "East",
      driver: "maya",
      eta: "13:18",
      deadline: "13:30",
      units: 1,
      cold: false,
      status: "delivered",
      x: 406,
      y: 357,
      description: "Restaurant supplies",
    },
  ],
};

export const minutes = (time) => {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`Invalid time: ${time}`);
  const [h, m] = time.split(":").map(Number);
  if (h > 23 || m > 59) throw new Error(`Invalid time: ${time}`);
  return h * 60 + m;
};
export const time = (value) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
export const late = (s) => s.status !== "delivered" && minutes(s.eta) > minutes(s.deadline);
export const load = (shipments, id) =>
  shipments
    .filter((s) => s.driver === id && s.status !== "delivered")
    .reduce((n, s) => n + s.units, 0);
export function options(shipments, shipment) {
  return fixture.drivers
    .filter((d) => d.id !== shipment.driver)
    .map((driver) => {
      const eta = time(minutes(driver.available) + driver.travel);
      const projectedLoad = load(shipments, driver.id) + shipment.units;
      const reasons = [];
      if (shipment.cold && !driver.cold) reasons.push("No temperature-controlled vehicle");
      if (projectedLoad > driver.capacity) reasons.push("Insufficient vehicle capacity");
      if (minutes(eta) > minutes(shipment.deadline)) reasons.push("Would miss the delivery window");
      return { driver, eta, projectedLoad, eligible: reasons.length === 0, reasons };
    });
}

export function reassign(shipments, shipmentId, driverId) {
  const shipment = shipments.find((s) => s.id === shipmentId);
  if (!shipment || shipment.status === "delivered") throw new Error("Choose an active shipment.");
  // The fixture defines detours only to Riverton. Never invent routes for other stops.
  if (shipmentId !== "RL-2048")
    throw new Error("Recovery routes are only available for Riverton Medical in this demo.");
  const option = options(shipments, shipment).find((o) => o.driver.id === driverId);
  if (!option?.eligible) throw new Error(option?.reasons.join("; ") || "Choose another driver.");
  return shipments.map((s) =>
    s.id === shipmentId ? { ...s, driver: driverId, eta: option.eta, recovered: true } : { ...s },
  );
}
