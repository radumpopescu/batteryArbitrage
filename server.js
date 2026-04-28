const http = require("node:http");
const { mkdir, readFile, readdir, stat, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = __dirname;
const publicDir = path.join(root, "public");
const cacheDir = path.join(root, "data", "opcom-pzu");
const port = Number(process.env.PORT || 4173);
const maxDays = 366;
const opcomCache = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatOpcomDate(date) {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return { day, month, year };
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function dateIsoFromDate(date) {
  const { day, month, year } = formatOpcomDate(date);
  return `${year}-${month}-${day}`;
}

function cachePath(dateIso) {
  return path.join(cacheDir, `${dateIso}.csv`);
}

function dateFromCacheFile(file) {
  const match = file.match(/^(\d{4}-\d{2}-\d{2})\.csv$/);
  return match ? match[1] : null;
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(value);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }

  return rows;
}

function parseOpcomCsv(text, dateIso) {
  const rows = csvRows(text);
  const headerIndex = rows.findIndex((row) => row.includes("Trading Zone") && row.includes("Interval"));
  if (headerIndex === -1) return [];

  const header = rows[headerIndex];
  const intervalIndex = header.indexOf("Interval");
  const priceIndex = header.indexOf("Market Clearing Price (MCP) [Euro/MWh]");
  const volumeIndex = header.indexOf("Traded Volume [MW]");
  const resolutionIndex = header.indexOf("Resolution");

  const marketRows = rows.slice(headerIndex + 1)
    .filter((row) => row[0] === "Romania");
  const inferredResolution = resolutionIndex >= 0 ? null : marketRows.length > 25 ? "PT15M" : "PT60M";

  const parsed = marketRows
    .map((row) => {
      const interval = Number(row[intervalIndex]);
      const resolution = resolutionIndex >= 0 ? row[resolutionIndex] : inferredResolution;
      const durationHours = resolution === "PT15M" ? 0.25 : 1;
      const minutes = Math.round((interval - 1) * durationHours * 60);
      return {
        date: dateIso,
        interval,
        time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
        priceEurMwh: Number(row[priceIndex]),
        volumeMw: Number(row[volumeIndex]),
        resolution,
        durationHours,
      };
    })
    .filter((point) => Number.isFinite(point.priceEurMwh));

  return parsed;
}

async function fetchOpcomDay(date) {
  const { day, month, year } = formatOpcomDate(date);
  const dateIso = dateIsoFromDate(date);
  if (opcomCache.has(dateIso)) {
    const result = opcomCache.get(dateIso);
    return { ...result, cacheStatus: existsSync(cachePath(dateIso)) ? "cached" : result.cacheStatus };
  }

  const sourceUrl = `https://www.opcom.ro/rapoarte-pzu-raportPIP-export-csv/${day}/${month}/${year}/en`;
  const filePath = cachePath(dateIso);

  if (existsSync(filePath)) {
    const text = await readFile(filePath, "utf8");
    const points = parseOpcomCsv(text, dateIso);
    if (points.length) {
      const result = { date: dateIso, sourceUrl, points, cacheStatus: "cached" };
      opcomCache.set(dateIso, result);
      return result;
    }
  }

  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "Romania battery arbitrage simulator",
      accept: "text/csv,text/plain,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`OPCOM returned ${response.status} for ${dateIso}`);
  }

  const text = await response.text();
  const points = parseOpcomCsv(text, dateIso);
  if (!points.length) {
    throw new Error(`No Romanian PZU rows found for ${dateIso}`);
  }

  await mkdir(cacheDir, { recursive: true });
  await writeFile(filePath, text, "utf8");

  const result = { date: dateIso, sourceUrl, points, cacheStatus: "downloaded" };
  opcomCache.set(dateIso, result);
  return result;
}

function summarizeDateRanges(dates) {
  if (!dates.length) return [];

  const ranges = [];
  let start = dates[0];
  let previous = dates[0];

  for (const date of dates.slice(1)) {
    const expected = dateIsoFromDate(addDays(parseDate(previous), 1));
    if (date === expected) {
      previous = date;
    } else {
      ranges.push({ start, end: previous });
      start = date;
      previous = date;
    }
  }

  ranges.push({ start, end: previous });
  return ranges;
}

async function getCacheSummary() {
  await mkdir(cacheDir, { recursive: true });
  const files = await readdir(cacheDir);
  const entries = [];

  for (const file of files) {
    const date = dateFromCacheFile(file);
    if (!date) continue;
    const filePath = path.join(cacheDir, file);
    const info = await stat(filePath);
    entries.push({
      date,
      file,
      sizeBytes: info.size,
      downloadedAt: info.mtime.toISOString(),
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  const dates = entries.map((entry) => entry.date);

  return {
    directory: cacheDir,
    count: entries.length,
    firstDate: dates[0] || null,
    lastDate: dates.at(-1) || null,
    sizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    ranges: summarizeDateRanges(dates),
    entries,
  };
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map(mapper));
    results.push(...settled);
  }
  return results;
}

async function handlePrices(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const start = parseDate(url.searchParams.get("start"));
  const end = parseDate(url.searchParams.get("end"));

  if (!start || !end || start > end) {
    send(res, 400, JSON.stringify({ error: "Use start and end as YYYY-MM-DD, with start <= end." }), {
      "content-type": "application/json; charset=utf-8",
    });
    return;
  }

  const days = Math.round((end - start) / 86400000) + 1;
  if (days > maxDays) {
    send(res, 400, JSON.stringify({ error: `Please request ${maxDays} days or fewer at once.` }), {
      "content-type": "application/json; charset=utf-8",
    });
    return;
  }

  try {
    const requestedDays = Array.from({ length: days }, (_, offset) => addDays(start, offset));
    const settled = await mapInBatches(requestedDays, 8, fetchOpcomDay);
    const results = [];
    const errors = [];

    for (const item of settled) {
      if (item.status === "fulfilled") {
        results.push(item.value);
      } else {
        errors.push(item.reason.message);
      }
    }

    if (!results.length) {
      throw new Error(errors[0] || "No OPCOM days returned data.");
    }

    send(res, 200, JSON.stringify({
      market: "OPCOM Day-Ahead Market PZU Romania",
      unit: "EUR/MWh",
      resolution: [...new Set(results.flatMap((day) => day.points.map((point) => point.resolution)))].join(", "),
      fetchedAt: new Date().toISOString(),
      requestedDays: days,
      returnedDays: results.length,
      cachedDays: results.filter((day) => day.cacheStatus === "cached").length,
      downloadedDays: results.filter((day) => day.cacheStatus === "downloaded").length,
      errors,
      days: results,
      points: results.flatMap((day) => day.points),
    }), {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message }), {
      "content-type": "application/json; charset=utf-8",
    });
  }
}

async function handleCache(req, res) {
  try {
    const summary = await getCacheSummary();
    send(res, 200, JSON.stringify(summary), {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }), {
      "content-type": "application/json; charset=utf-8",
    });
  }
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const fullPath = path.normalize(path.join(publicDir, pathname));

  if (!fullPath.startsWith(publicDir) || !existsSync(fullPath)) {
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  const ext = path.extname(fullPath);
  const body = await readFile(fullPath);
  send(res, 200, body, { "content-type": mimeTypes[ext] || "application/octet-stream" });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/prices")) {
    handlePrices(req, res);
  } else if (req.url.startsWith("/api/cache")) {
    handleCache(req, res);
  } else {
    handleStatic(req, res);
  }
});

server.listen(port, () => {
  console.log(`Battery simulator running at http://localhost:${port}`);
});
