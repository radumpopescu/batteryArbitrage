const els = {
  startDate: document.querySelector("#startDate"),
  endDate: document.querySelector("#endDate"),
  powerKw: document.querySelector("#powerKw"),
  capacityKwh: document.querySelector("#capacityKwh"),
  efficiency: document.querySelector("#efficiency"),
  yearButton: document.querySelector("#yearButton"),
  runButton: document.querySelector("#runButton"),
  statusLabel: document.querySelector("#statusLabel"),
  headlineProfit: document.querySelector("#headlineProfit"),
  totalProfit: document.querySelector("#totalProfit"),
  summaryScope: document.querySelector("#summaryScope"),
  chargedEnergy: document.querySelector("#chargedEnergy"),
  dischargedEnergy: document.querySelector("#dischargedEnergy"),
  bestSpread: document.querySelector("#bestSpread"),
  batteryCycles: document.querySelector("#batteryCycles"),
  breakEven: document.querySelector("#breakEven"),
  zoomStart: document.querySelector("#zoomStart"),
  zoomEnd: document.querySelector("#zoomEnd"),
  zoomLabel: document.querySelector("#zoomLabel"),
  applyZoom: document.querySelector("#applyZoom"),
  resetZoom: document.querySelector("#resetZoom"),
  cacheSummary: document.querySelector("#cacheSummary"),
  cacheRun: document.querySelector("#cacheRun"),
  simTab: document.querySelector("#simTab"),
  configTab: document.querySelector("#configTab"),
  simView: document.querySelector("#simView"),
  configView: document.querySelector("#configView"),
  inverterCost: document.querySelector("#inverterCost"),
  batteryCost: document.querySelector("#batteryCost"),
  capexValue: document.querySelector("#capexValue"),
};

let fullResult;
let activeZoom = null;
let isSyncingZoom = false;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function setDefaultDates() {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  els.startDate.value = isoDate(start);
  els.endDate.value = isoDate(end);
}

function eur(value, digits = 0) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: digits,
  }).format(value);
}

function number(value, digits = 1) {
  return new Intl.NumberFormat("en-IE", {
    maximumFractionDigits: digits,
  }).format(value);
}

function currentConfig() {
  return {
    powerKw: Number(els.powerKw.value),
    capacityKwh: Number(els.capacityKwh.value),
    roundTripEfficiency: Number(els.efficiency.value) / 100,
    inverterCostEur: Number(els.inverterCost.value),
    batteryCostEur: Number(els.batteryCost.value),
  };
}

function capex(config = currentConfig()) {
  return config.inverterCostEur + config.batteryCostEur;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${number(bytes / 1024 ** index, index === 0 ? 0 : 1)} ${units[index]}`;
}

function longDate(value) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function groupByDate(points) {
  return points.reduce((days, point) => {
    days[point.date] ||= [];
    days[point.date].push(point);
    return days;
  }, {});
}

function simulateDay(points, config) {
  const sorted = [...points].sort((a, b) => a.interval - b.interval);
  const chargeEff = Math.sqrt(config.roundTripEfficiency);
  const dischargeEff = Math.sqrt(config.roundTripEfficiency);
  const capacity = config.capacityKwh;
  const step = Math.max(0.1, capacity / 120);
  const states = Math.max(1, Math.round(capacity / step));
  const stateValue = (index) => Math.min(capacity, index * step);
  const negative = -1e15;

  let dp = Array(states + 1).fill(negative);
  dp[0] = 0;
  const traces = [];

  for (const point of sorted) {
    const dt = point.durationHours || 1;
    const maxMove = config.powerKw * dt;
    const next = Array(states + 1).fill(negative);
    const trace = Array(states + 1).fill(null);

    for (let state = 0; state <= states; state += 1) {
      if (dp[state] <= negative / 2) continue;
      const soc = stateValue(state);
      const maxChargeState = Math.min(states, Math.floor((soc + maxMove + 1e-9) / step));
      const minDischargeState = Math.max(0, Math.ceil((soc - maxMove - 1e-9) / step));

      for (let target = minDischargeState; target <= maxChargeState; target += 1) {
        const nextSoc = stateValue(target);
        const storedDelta = nextSoc - soc;
        const chargeFromGrid = storedDelta > 0 ? storedDelta / chargeEff : 0;
        const dischargeToGrid = storedDelta < 0 ? -storedDelta * dischargeEff : 0;
        const value = (dischargeToGrid - chargeFromGrid) * point.priceEurMwh / 1000;
        const score = dp[state] + value;
        if (score > next[target]) {
          next[target] = score;
          trace[target] = { prev: state, storedDelta, chargeFromGrid, dischargeToGrid, value };
        }
      }
    }

    dp = next;
    traces.push(trace);
  }

  const endState = 0;

  const rows = [];
  let state = endState;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const trace = traces[index][state];
    if (!trace) break;
    rows.push({
      ...sorted[index],
      socKwh: stateValue(state),
      powerKw: trace.dischargeToGrid > 0 ? trace.dischargeToGrid / (sorted[index].durationHours || 1) : -trace.chargeFromGrid / (sorted[index].durationHours || 1),
      chargeFromGrid: trace.chargeFromGrid,
      dischargeToGrid: trace.dischargeToGrid,
      batteryDischargeKwh: trace.storedDelta < 0 ? -trace.storedDelta : 0,
      value: trace.value,
    });
    state = trace.prev;
  }
  rows.reverse();

  let charged = 0;
  let discharged = 0;
  let batteryDischarge = 0;
  let profit = 0;
  for (const row of rows) {
    charged += row.chargeFromGrid;
    discharged += row.dischargeToGrid;
    batteryDischarge += row.batteryDischargeKwh;
    profit += row.value;
  }

  const prices = sorted.map((point) => point.priceEurMwh);
  return {
    date: sorted[0]?.date,
    rows,
    charged,
    discharged,
    batteryDischarge,
    cycles: capacity > 0 ? batteryDischarge / capacity : 0,
    profit,
    spread: Math.max(...prices) - Math.min(...prices),
  };
}

function simulate(points) {
  const config = currentConfig();
  const days = Object.values(groupByDate(points));
  const daily = days.map((day) => simulateDay(day, config));
  return {
    config,
    daily,
    rows: daily.flatMap((day) => day.rows),
    totalProfit: daily.reduce((sum, day) => sum + day.profit, 0),
    charged: daily.reduce((sum, day) => sum + day.charged, 0),
    discharged: daily.reduce((sum, day) => sum + day.discharged, 0),
    batteryDischarge: daily.reduce((sum, day) => sum + day.batteryDischarge, 0),
    cycles: daily.reduce((sum, day) => sum + day.cycles, 0),
    bestSpread: Math.max(0, ...daily.map((day) => day.spread)),
  };
}

function summarize(daily, rows) {
  return {
    daily,
    rows,
    totalProfit: daily.reduce((sum, day) => sum + day.profit, 0),
    charged: daily.reduce((sum, day) => sum + day.charged, 0),
    discharged: daily.reduce((sum, day) => sum + day.discharged, 0),
    batteryDischarge: daily.reduce((sum, day) => sum + day.batteryDischarge, 0),
    cycles: daily.reduce((sum, day) => sum + day.cycles, 0),
    bestSpread: Math.max(0, ...daily.map((day) => day.spread)),
  };
}

function focusResult(result, zoom) {
  if (!zoom) return result;
  const daily = result.daily.filter((day) => {
    const time = dayTime(day.date);
    return time >= zoom.startMs && time <= zoom.endMs;
  });
  const rows = result.rows.filter((row) => row.xTime >= zoom.startMs && row.xTime <= zoom.endMs);
  return summarize(daily, rows);
}

function setZoomBounds(result) {
  const first = result.daily[0]?.date;
  const last = result.daily.at(-1)?.date;
  els.zoomStart.min = first || "";
  els.zoomStart.max = last || "";
  els.zoomEnd.min = first || "";
  els.zoomEnd.max = last || "";
  els.zoomStart.value = first || "";
  els.zoomEnd.value = last || "";
}

function chartLabels(rows) {
  return rows.map((row) => `${row.date} ${row.time}`);
}

function dayTime(date) {
  return new Date(`${date}T12:00:00Z`).getTime();
}

function rowTime(row) {
  const [year, month, day] = row.date.split("-").map(Number);
  const duration = row.durationHours || 1;
  return Date.UTC(year, month - 1, day) + (row.interval - 1) * duration * 3600000;
}

function enrichRows(rows) {
  for (const row of rows) {
    row.xTime = rowTime(row);
    row.xDate = new Date(row.xTime);
  }
}

function decimateRows(rows, maxPoints = 6000) {
  if (rows.length <= maxPoints) return rows;
  const stride = Math.ceil(rows.length / maxPoints);
  return rows.filter((_, index) => index % stride === 0);
}

function plotConfig() {
  return {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
    scrollZoom: true,
  };
}

function plotLayout(extra = {}) {
  return {
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    margin: { l: 64, r: 70, t: 18, b: 48 },
    hovermode: "x unified",
    dragmode: "zoom",
    font: {
      family: "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      color: "#18202a",
    },
    xaxis: {
      type: "date",
      gridcolor: "rgba(97,112,131,0.18)",
      zeroline: false,
      rangeslider: { visible: false },
    },
    yaxis: {
      gridcolor: "rgba(97,112,131,0.18)",
      zerolinecolor: "rgba(97,112,131,0.28)",
    },
    legend: {
      orientation: "h",
      x: 0,
      y: 1.14,
      xanchor: "left",
    },
    ...extra,
  };
}

function syncPlotsToRange(startMs, endMs, sourceId) {
  isSyncingZoom = true;
  const range = [new Date(startMs), new Date(endMs)];
  const updates = [];
  for (const id of ["priceSocChart", "powerChart", "profitChart"]) {
    if (id !== sourceId) {
      updates.push(Plotly.relayout(id, { "xaxis.range": range }));
    }
  }
  Promise.allSettled(updates).finally(() => {
    isSyncingZoom = false;
  });
}

function handlePlotZoom(event, sourceId) {
  if (isSyncingZoom || !fullResult) return;
  const start = event["xaxis.range[0]"] || event["xaxis.range"]?.[0];
  const end = event["xaxis.range[1]"] || event["xaxis.range"]?.[1];
  if (!start || !end) return;

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;

  activeZoom = { startMs, endMs };
  els.zoomStart.value = isoDate(new Date(startMs));
  els.zoomEnd.value = isoDate(new Date(endMs));
  renderSummary(focusResult(fullResult, activeZoom));
  renderZoomLabel(focusResult(fullResult, activeZoom));
  syncPlotsToRange(startMs, endMs, sourceId);
}

function attachPlotZoom(id) {
  const node = document.getElementById(id);
  node.removeAllListeners?.("plotly_relayout");
  node.on?.("plotly_relayout", (event) => handlePlotZoom(event, id));
}

function renderCharts(result) {
  const chartRows = decimateRows(result.rows, activeZoom ? 9000 : 4500);

  Plotly.react("priceSocChart", [
    {
      name: "Price EUR/MWh",
      x: chartRows.map((row) => row.xDate),
      y: chartRows.map((row) => row.priceEurMwh),
      type: "scattergl",
      mode: "lines",
      line: { color: "#2468d8", width: 1.5 },
      hovertemplate: "%{y:.2f} EUR/MWh<extra></extra>",
    },
    {
      name: "State of charge kWh",
      x: chartRows.map((row) => row.xDate),
      y: chartRows.map((row) => row.socKwh),
      type: "scattergl",
      mode: "lines",
      yaxis: "y2",
      fill: "tozeroy",
      line: { color: "#0c8f67", width: 1.7 },
      fillcolor: "rgba(12, 143, 103, 0.13)",
      hovertemplate: "%{y:.1f} kWh<extra></extra>",
    },
  ], plotLayout({
    yaxis: {
      title: "EUR/MWh",
      gridcolor: "rgba(97,112,131,0.18)",
      zerolinecolor: "rgba(97,112,131,0.28)",
    },
    yaxis2: {
      title: "kWh",
      overlaying: "y",
      side: "right",
      showgrid: false,
      zeroline: false,
    },
  }), plotConfig());

  Plotly.react("powerChart", [
    {
      name: "Discharge kW",
      x: chartRows.map((row) => row.xDate),
      y: chartRows.map((row) => Math.max(0, row.powerKw)),
      type: "bar",
      marker: { color: "rgba(12, 143, 103, 0.72)" },
      hovertemplate: "%{y:.2f} kW export<extra></extra>",
    },
    {
      name: "Charge kW",
      x: chartRows.map((row) => row.xDate),
      y: chartRows.map((row) => Math.min(0, row.powerKw)),
      type: "bar",
      marker: { color: "rgba(216, 74, 58, 0.52)" },
      hovertemplate: "%{y:.2f} kW charge<extra></extra>",
    },
  ], plotLayout({
    barmode: "relative",
    yaxis: {
      title: "kW",
      gridcolor: "rgba(97,112,131,0.18)",
      zerolinecolor: "rgba(97,112,131,0.45)",
    },
  }), plotConfig());

  const cumulative = [];
  for (const day of result.daily) {
    cumulative.push((cumulative.at(-1) || 0) + day.profit);
  }

  Plotly.react("profitChart", [
    {
      name: "Daily gross profit EUR",
      x: result.daily.map((day) => new Date(`${day.date}T12:00:00Z`)),
      y: result.daily.map((day) => day.profit),
      type: "bar",
      marker: { color: "rgba(189, 125, 18, 0.68)" },
      hovertemplate: "%{y:.2f} EUR/day<extra></extra>",
    },
    {
      name: "Cumulative EUR",
      x: result.daily.map((day) => new Date(`${day.date}T12:00:00Z`)),
      y: cumulative,
      type: "scatter",
      mode: "lines",
      yaxis: "y2",
      line: { color: "#18202a", width: 2 },
      hovertemplate: "%{y:.2f} EUR cumulative<extra></extra>",
    },
  ], plotLayout({
    yaxis: {
      title: "Daily EUR",
      gridcolor: "rgba(97,112,131,0.18)",
      zerolinecolor: "rgba(97,112,131,0.28)",
    },
    yaxis2: {
      title: "Cumulative EUR",
      overlaying: "y",
      side: "right",
      showgrid: false,
      zeroline: false,
    },
  }), plotConfig());

  for (const id of ["priceSocChart", "powerChart", "profitChart"]) {
    attachPlotZoom(id);
    if (activeZoom) {
      Plotly.relayout(id, {
        "xaxis.range": [new Date(activeZoom.startMs), new Date(activeZoom.endMs)],
      });
    }
  }
}

function renderSummary(result) {
  const totalCapex = capex();
  const intervalDays = result.daily.length || 0;
  const annualProfit = intervalDays > 0 ? result.totalProfit * 365 / intervalDays : 0;
  const breakEvenYears = annualProfit > 0 ? totalCapex / annualProfit : Infinity;

  els.summaryScope.textContent = activeZoom ? "Focused profit" : "Gross profit";
  els.headlineProfit.textContent = eur(result.totalProfit, 0);
  els.totalProfit.textContent = eur(result.totalProfit, 2);
  els.chargedEnergy.textContent = `${number(result.charged, 1)} kWh`;
  els.dischargedEnergy.textContent = `${number(result.discharged, 1)} kWh`;
  els.bestSpread.textContent = `${eur(result.bestSpread, 0)}/MWh`;
  els.batteryCycles.textContent = number(result.cycles, 1);
  els.breakEven.textContent = Number.isFinite(breakEvenYears) ? `${number(breakEvenYears, 1)} yrs` : "-";
  els.capexValue.textContent = eur(totalCapex, 0);
}

function renderZoomLabel(result) {
  if (!fullResult) {
    els.zoomLabel.textContent = "Full simulation";
    return;
  }

  if (!activeZoom) {
    const first = fullResult.daily[0]?.date;
    const last = fullResult.daily.at(-1)?.date;
    els.zoomLabel.textContent = first && last ? `Full simulation: ${longDate(first)} to ${longDate(last)}` : "Full simulation";
    return;
  }

  els.zoomLabel.textContent = `${longDate(isoDate(new Date(activeZoom.startMs)))} to ${longDate(isoDate(new Date(activeZoom.endMs)))} (${result.daily.length} days)`;
}

function formatRanges(ranges) {
  if (!ranges?.length) return "No downloaded files yet";
  return ranges
    .slice(-4)
    .map((range) => range.start === range.end ? longDate(range.start) : `${longDate(range.start)} to ${longDate(range.end)}`)
    .join("; ");
}

function renderCacheSummary(summary) {
  if (!summary || summary.error) {
    els.cacheSummary.textContent = "Cache unavailable";
    return;
  }

  els.cacheSummary.textContent = `${summary.count} days · ${formatBytes(summary.sizeBytes)}`;
}

async function refreshCacheSummary() {
  try {
    const response = await fetch("/api/cache");
    renderCacheSummary(await response.json());
  } catch (error) {
    renderCacheSummary({ error: error.message });
  }
}

function renderResult() {
  if (!fullResult) return;
  const visibleResult = focusResult(fullResult, activeZoom);
  renderSummary(visibleResult);
  renderCharts(visibleResult);
  renderZoomLabel(visibleResult);
}

function applyZoomFromControls() {
  if (!fullResult) return;
  const start = els.zoomStart.value;
  const end = els.zoomEnd.value;
  if (!start || !end || start > end) {
    alert("Choose a valid zoom start and end date.");
    return;
  }

  activeZoom = {
    startMs: new Date(`${start}T00:00:00Z`).getTime(),
    endMs: new Date(`${end}T23:59:59Z`).getTime(),
  };
  renderResult();
}

function resetZoom() {
  activeZoom = null;
  setZoomBounds(fullResult);
  renderResult();
}

function showView(view) {
  const isConfig = view === "config";
  els.simView.hidden = isConfig;
  els.configView.hidden = !isConfig;
  els.simTab.classList.toggle("active", !isConfig);
  els.configTab.classList.toggle("active", isConfig);
  if (!isConfig) {
    for (const id of ["priceSocChart", "powerChart", "profitChart"]) {
      if (document.getElementById(id)?.data) Plotly.Plots.resize(id);
    }
  }
}

async function run() {
  els.runButton.disabled = true;
  els.yearButton.disabled = true;
  els.applyZoom.disabled = true;
  els.resetZoom.disabled = true;
  els.statusLabel.textContent = "Fetching OPCOM data";

  try {
    const params = new URLSearchParams({
      start: els.startDate.value,
      end: els.endDate.value,
    });
    const response = await fetch(`/api/prices?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not fetch prices");
    if (!payload.points?.length) throw new Error("No prices returned for this range");

    const skipped = payload.errors?.length ? `, ${payload.errors.length} skipped` : "";
    const sourceNote = `${payload.cachedDays || 0} cached · ${payload.downloadedDays || 0} fresh`;
    els.statusLabel.textContent = `${payload.returnedDays} days, ${payload.points.length} intervals${skipped}`;
    els.cacheRun.textContent = sourceNote;
    fullResult = simulate(payload.points);
    enrichRows(fullResult.rows);
    activeZoom = null;
    setZoomBounds(fullResult);
    renderResult();
    refreshCacheSummary();
  } catch (error) {
    els.statusLabel.textContent = "Error";
    alert(error.message);
  } finally {
    els.runButton.disabled = false;
    els.yearButton.disabled = false;
    els.applyZoom.disabled = false;
    els.resetZoom.disabled = false;
  }
}

setDefaultDates();
refreshCacheSummary();
els.yearButton.addEventListener("click", () => {
  setDefaultDates();
  run();
});
els.runButton.addEventListener("click", run);
els.applyZoom.addEventListener("click", applyZoomFromControls);
els.resetZoom.addEventListener("click", resetZoom);
els.simTab.addEventListener("click", () => showView("sim"));
els.configTab.addEventListener("click", () => showView("config"));
els.inverterCost.addEventListener("input", () => {
  els.capexValue.textContent = eur(capex(), 0);
  if (fullResult) renderSummary(focusResult(fullResult, activeZoom));
});
els.batteryCost.addEventListener("input", () => {
  els.capexValue.textContent = eur(capex(), 0);
  if (fullResult) renderSummary(focusResult(fullResult, activeZoom));
});

window.addEventListener("load", () => {
  if (window.Plotly) run();
});
