#!/usr/bin/env node
/**
 * check-live-die-reviews
 *
 * Verdict for Google Maps review links (maps.app.goo.gl/...):
 *   DEAD  -> the page renders "This review is no longer available" (.PbZDve .HlvSq)
 *   ALIVE -> the review panel renders a date (.rsqaWe)
 *
 * Both selectors are language independent, which matters because Google localises the page
 * from the link / IP (e.g. "8 tháng trước" instead of "a year ago").
 *
 * Usage:
 *   node check.js                      # check links from a Google Sheet, write columns J/K
 *   node check.js --dry                # check, print only
 *   node check.js --links links.json   # check an arbitrary JSON array of URLs
 *   node check.js --force              # ignore the 24h cache
 *
 * Env / config: see config.example.json and README.md
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const DEFAULTS = {
  spreadsheetId: process.env.SHEET_ID || "",
  sheets: ["review ko ảnh", "review ảnh"],
  credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
  playwrightCore: "playwright-core",
  googleapis: "googleapis",
  linksColumn: 1, // 0-based index of the link column (B)
  statusColumn: "J", // where to write the result
  dateColumn: "K",
  concurrency: 2,
  restartEvery: 20,
  verdictTimeout: 12000,
  minFreeMB: 700,
};

function loadConfig() {
  const p = path.join(ROOT, "config.json");
  if (!fs.existsSync(p)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "")) };
  } catch (e) {
    console.error("bad config.json:", e.message);
    process.exit(1);
  }
}

const CFG = loadConfig();
const { chromium } = require(CFG.playwrightCore);

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const FORCE = args.includes("--force");
const LINKS_FILE = (() => { const i = args.indexOf("--links"); return i >= 0 ? args[i + 1] : null; })();

const CONC = Math.max(1, Math.min(
  CFG.concurrency,
  os.freemem() / 1e9 < CFG.minFreeMB / 1000 ? 1 : 8
));
const STATE_FILE = path.join(ROOT, "state.json");
const PROFILE_DIR = path.join(ROOT, ".chrome-profile");
const STATE_TTL = 24 * 3600 * 1000;
const MAX_RETRY = 2;

const PROBE = () => {
  if (document.querySelector(".PbZDve .HlvSq")) return "DEAD";
  if (document.querySelector(".rsqaWe")) return "ALIVE";
  return "";
};

const BLOCK_TYPE = new Set(["image", "media", "font", "stylesheet", "manifest", "other"]);
const BLOCK_URL = /\/maps\/vt\/|\/maps\/stream\/|log204|gen_204|play\.google\.com\/log|clients6\.google\.com|googleadservices|doubleclick|gstatic\.com\/images/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killHeadlessChrome() {
  try {
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Where-Object { $_.CommandLine -like \'*--headless*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      { stdio: "ignore" }
    );
  } catch (e) {}
}

async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: true,
    viewport: { width: 800, height: 600 },
    locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: [
      "--single-process", "--no-zygote", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-extensions", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-sync", "--disable-translate",
      "--disable-back-forward-cache", "--disable-accelerated-2d-canvas", "--disable-software-rasterizer",
      "--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,BackForwardCache",
      "--blink-settings=imagesEnabled=false", "--js-flags=--max-old-space-size=192",
      "--disk-cache-size=67108864", "--window-size=800,600",
    ],
  });
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (BLOCK_TYPE.has(req.resourceType()) || BLOCK_URL.test(req.url())) return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  });
  return ctx;
}

async function checkAll(links, onResult) {
  killHeadlessChrome();
  let ctx = await launch();
  const results = [];
  let idx = 0;
  let batch = 0;

  async function checkOne(link) {
    const page = await ctx.newPage();
    const t0 = Date.now();
    try {
      await page.goto(link, { waitUntil: "commit", timeout: 15000 });
      await page.waitForFunction(PROBE, { timeout: CFG.verdictTimeout, polling: 120 }).catch(() => {});
      const verdict = await page.evaluate(PROBE).catch(() => "");
      return { link, status: verdict || "UNKNOWN", ms: Date.now() - t0 };
    } catch (e) {
      return { link, status: "ERROR", ms: Date.now() - t0, err: String(e.message || e).slice(0, 80) };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async function worker() {
    while (idx < links.length) {
      if (batch >= CFG.restartEvery) return;
      batch++;
      const link = links[idx++];
      let rec = await checkOne(link);
      for (let r = 1; r <= MAX_RETRY && rec.status !== "ALIVE" && rec.status !== "DEAD"; r++) rec = await checkOne(link);
      results.push(rec);
      onResult(rec);
    }
  }

  while (idx < links.length) {
    batch = 0;
    try {
      await Promise.all(Array.from({ length: CONC }, worker));
    } catch (e) {
      console.error("worker crash:", String(e.message || e).slice(0, 80));
    }
    if (idx < links.length) {
      try { await ctx.close(); } catch (e) {}
      await sleep(1200);
      killHeadlessChrome();
      ctx = await launch();
    }
  }
  try { await ctx.close(); } catch (e) {}
  return results;
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; } };
const saveState = (s) => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {} };

function sheetClient() {
  const { google } = require(CFG.googleapis);
  const auth = new google.auth.GoogleAuth({
    keyFile: CFG.credentials || undefined,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

const col = (letter, row) => `${letter}${row}`;

async function main() {
  const state = loadState();
  let rows = [];
  let checkList = [];

  if (LINKS_FILE) {
    checkList = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8").replace(/^\uFEFF/, ""));
  } else {
    if (!CFG.spreadsheetId) throw new Error("set spreadsheetId in config.json (or SHEET_ID env), or use --links file.json");
    const sheets = sheetClient();
    for (const name of CFG.sheets) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: CFG.spreadsheetId, range: `${name}!A2:Z1000` });
      (r.data.values || []).forEach((v, i) => {
        const link = (v[CFG.linksColumn] || "").trim();
        if (/^https?:\/\//.test(link)) { rows.push({ sheet: name, row: i + 2, link }); checkList.push(link); }
      });
    }
    checkList = [...new Set(checkList)];
  }

  const now = Date.now();
  const cached = new Set();
  const todo = [];
  for (const l of checkList) {
    const c = state[l];
    const ok = c && (c.status === "ALIVE" || c.status === "DEAD");
    if (!FORCE && ok && now - c.ts < STATE_TTL) cached.add(l);
    else todo.push(l);
  }
  console.log(`links=${checkList.length} cached=${cached.size} toCheck=${todo.length} workers=${CONC}`);

  if (todo.length) {
    await checkAll(todo, (r) => {
      if (r.status === "ALIVE" || r.status === "DEAD") state[r.link] = { status: r.status, ts: Date.now() };
      saveState(state);
      process.stdout.write(`  ${r.status} ${r.ms}ms ${r.link}\n`);
    });
  }

  const statusOf = (l) => {
    const c = state[l];
    return c && (c.status === "ALIVE" || c.status === "DEAD") ? c.status : null;
  };

  if (LINKS_FILE) {
    console.log(JSON.stringify(checkList.map((l) => ({ link: l, status: statusOf(l) || "UNKNOWN" })), null, 1));
    return;
  }

  const LABEL = { ALIVE: "SỐNG", DEAD: "CHẾT" };
  const DATE = new Date().toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const bySheet = {};
  for (const r of rows) (bySheet[r.sheet] ||= []).push(r);
  const sheets = sheetClient();
  const summary = [];
  for (const [name, list] of Object.entries(bySheet)) {
    const last = Math.max(...list.map((x) => x.row));
    const values = Array.from({ length: last - 1 }, () => ["", ""]);
    let alive = 0, dead = 0, unknown = 0;
    for (const r of list) {
      const st = statusOf(r.link);
      if (st === "ALIVE") alive++; else if (st === "DEAD") dead++; else unknown++;
      values[r.row - 2] = [st ? LABEL[st] : "?", DATE];
    }
    if (!DRY) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: CFG.spreadsheetId,
        range: `${name}!${CFG.statusColumn}1:${CFG.dateColumn}${last}`,
        valueInputOption: "RAW",
        requestBody: { values: [["Tình Trạng Review", "Ngày Check"], ...values] },
      });
    }
    summary.push({ sheet: name, rows: list.length, alive, dead, unknown });
  }
  console.log(JSON.stringify({ dry: DRY, summary }, null, 1));
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
