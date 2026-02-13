#!/usr/bin/env node
/**
 * tools/update-lists.js
 *
 * Orchestrator: spustí generování/aktualizaci listů + SmartPicks a (volitelně) enrich.
 *
 * HA add-on verze (persist /data):
 * - config:   /data/config/lists.trakt.json + /data/config/secrets.json
 * - lists:    /data/lists/*.json
 * - runtime:  /data/runtime/update-progress.json + /data/runtime/enrich-targets.json
 *
 * Odlehčení:
 * - enrich se spustí jen pokud se změnily "base" listy (tj. ids z config.lists[])
 * - denní SmartPicks změny samy o sobě enrich nespustí
 * - pokud se base změnily, enrich dostane seznam změněných souborů (base + případně smartpicks)
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

// Code root (/app)
const ROOT = path.resolve(__dirname, "..");

// Persistent storage root (/data)
const DATA_DIR = process.env.DATA_DIR || "/data";
const CONFIG_DIR = path.join(DATA_DIR, "config");
const LISTS_DIR = path.join(DATA_DIR, "lists");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");

const LISTS_PATH = path.join(CONFIG_DIR, "lists.trakt.json");
const SECRETS_PATH = path.join(CONFIG_DIR, "secrets.json");

// runtime outputs for UI
const PROGRESS_PATH = path.join(RUNTIME_DIR, "update-progress.json");
const ENRICH_TARGETS_PATH = path.join(RUNTIME_DIR, "enrich-targets.json");

function ts() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function log(line) {
  process.stdout.write(`[${ts()}] ${line}\n`);
}

async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p, fallback) {
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

let lastProgressWriteAt = 0;
async function writeProgress(progress) {
  const now = Date.now();
  if (now - lastProgressWriteAt < 200) return; // max ~5x/s
  lastProgressWriteAt = now;

  try {
    await fsp.mkdir(RUNTIME_DIR, { recursive: true });
    await fsp.writeFile(
      PROGRESS_PATH,
      JSON.stringify(progress, null, 2),
      "utf8",
    );
  } catch {
    // ignore
  }
}

function validateConfig(lists, secrets) {
  const err = (m) => new Error(m);

  if (!lists || typeof lists !== "object")
    throw err("Chybí /data/config/lists.trakt.json nebo není validní JSON.");
  if (!Array.isArray(lists.lists))
    throw err("lists.trakt.json: chybí pole lists[].");

  if (!secrets || typeof secrets !== "object")
    throw err("Chybí /data/config/secrets.json nebo není validní JSON.");
  if (!secrets.trakt || typeof secrets.trakt !== "object")
    throw err("secrets.json: chybí trakt objekt.");

  if (!String(secrets.trakt.client_id || "").trim())
    throw err("secrets.json: chybí trakt.client_id.");
  if (!String(secrets.trakt.client_secret || "").trim())
    throw err("secrets.json: chybí trakt.client_secret.");
}

function rel(p) {
  // for logging scripts within /app
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

async function listJsonFiles(dir) {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    return items
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".json"))
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

async function sha256File(p) {
  const buf = await fsp.readFile(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function snapshotListHashes() {
  const files = await listJsonFiles(LISTS_DIR);
  const out = {};
  for (const f of files) {
    try {
      out[path.basename(f)] = await sha256File(f);
    } catch {
      // ignore
    }
  }
  return out;
}

function diffHashes(before, after) {
  const changed = [];
  const allKeys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  for (const k of allKeys) {
    if ((before || {})[k] !== (after || {})[k]) changed.push(k);
  }
  return changed.sort();
}

function idFromFilename(fn) {
  return String(fn || "").replace(/\.json$/i, "");
}

async function runNodeScript(
  scriptAbsPath,
  args = [],
  label = "",
  stepMeta = null,
  envExtra = null,
) {
  const nice = rel(scriptAbsPath);
  const cmd = `${process.execPath} ${nice}${args.length ? " " + args.join(" ") : ""}`;

  log(`CMD: ${cmd}`);

  await writeProgress({
    running: true,
    phase: "running",
    label: label || nice,
    cmd,
    at: new Date().toISOString(),
    ...(stepMeta || {}),
  });

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptAbsPath, ...args], {
      cwd: ROOT, // run from /app
      env: { ...process.env, DATA_DIR, ...(envExtra || {}) }, // ensure scripts use /data
      stdio: ["ignore", "pipe", "pipe"],
    });

    function maybeProgressFromLine(line) {
      const m = line.match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) return null;

      const done = Number(m[1]);
      const total = Number(m[2]);
      if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0)
        return null;

      const idx = line.indexOf(m[0]);
      const head = idx > 0 ? line.slice(0, idx).trim() : "";
      const human = head ? head.replace(/^[\[\(].*?[\]\)]\s*/g, "").trim() : "";

      return { done, total, humanLabel: human || undefined };
    }

    function handleChunk(chunk) {
      const text = chunk.toString("utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);

      for (const line of lines) {
        // Pokud skript vypíše "PROGRESS {...}", necháme to bez prefixu,
        // aby to config-ui server (pushUpdateLine) poznal přes startsWith("PROGRESS ").
        if (line.startsWith("PROGRESS ")) {
          process.stdout.write(line + "\n");
        } else {
          log(line);
        }

        const p = maybeProgressFromLine(line);
        if (p) {
          writeProgress({
            running: true,
            phase: "running",
            label: label || nice,
            line,
            progress: {
              label: p.humanLabel || label || nice,
              done: p.done,
              total: p.total,
            },
            at: new Date().toISOString(),
            ...(stepMeta || {}),
          }).catch(() => {});
        }
      }
    }

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    child.on("close", async (code) => {
      const ok = code === 0;
      await writeProgress({
        running: false,
        phase: "done",
        ok,
        label: label || nice,
        code: code ?? 0,
        at: new Date().toISOString(),
        ...(stepMeta || {}),
      });

      resolve({ ok, code: code ?? 0 });
    });
  });
}

async function detectScripts() {
  const SCRIPTS = path.join(ROOT, "scripts");

  const genListsCombined = path.join(SCRIPTS, "generate_lists_trakt_csfd.mjs");
  const genSmartPicks = path.join(SCRIPTS, "generate_smart_picks.mjs");

  const enrichPosterCinemetaCsfd = path.join(
    SCRIPTS,
    "enrich_poster_cinemeta_text_csfd.mjs",
  );
  const enrichCinemeta = path.join(SCRIPTS, "enrich_cinemeta.mjs");
  const enrichCsfdFirst = path.join(SCRIPTS, "enrich_csfd_first.mjs");

  return {
    genListsCombined: (await fileExists(genListsCombined))
      ? genListsCombined
      : null,
    genSmartPicks: (await fileExists(genSmartPicks)) ? genSmartPicks : null,
    enrichBest: (await fileExists(enrichPosterCinemetaCsfd))
      ? enrichPosterCinemetaCsfd
      : (await fileExists(enrichCinemeta))
        ? enrichCinemeta
        : (await fileExists(enrichCsfdFirst))
          ? enrichCsfdFirst
          : null,
  };
}

// Main
(async () => {
  log(`== UPDATE START ${new Date().toISOString()} ==`);
  log(`DATA_DIR=${DATA_DIR}`);

  // read config from /data
  const listsCfg = await readJson(LISTS_PATH, null);
  const secrets = await readJson(SECRETS_PATH, null);

  try {
    validateConfig(listsCfg, secrets);
  } catch (e) {
    log(`ERROR: ${e.message}`);
    log(
      `Tip: otevři Config UI, vyplň Trakt client_id/secret a dej "Uložit vše na disk".`,
    );
    process.exitCode = 2;
    await writeProgress({
      running: false,
      phase: "done",
      ok: false,
      code: 2,
      reason: "invalid config",
      at: new Date().toISOString(),
    });
    log(
      `== UPDATE END code=${process.exitCode} ${new Date().toISOString()} ==`,
    );
    return;
  }

  await fsp.mkdir(LISTS_DIR, { recursive: true });
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });

  const baseListIds = new Set(
    (Array.isArray(listsCfg?.lists) ? listsCfg.lists : [])
      .map((x) => String(x?.id || "").trim())
      .filter(Boolean),
  );

  const smartPickIds = new Set(
    (Array.isArray(listsCfg?.smartPicks?.profiles)
      ? listsCfg.smartPicks.profiles
      : []
    )
      .map((x) => String(x?.id || "").trim())
      .filter(Boolean),
  );

  const scripts = await detectScripts();

  if (
    !scripts.genListsCombined &&
    !scripts.genSmartPicks &&
    !scripts.enrichBest
  ) {
    log(
      "Nenalezen žádný generator/enricher skript v scripts/. (Nic se nespustilo.)",
    );
    process.exitCode = 3;
    await writeProgress({
      running: false,
      phase: "done",
      ok: false,
      code: 3,
      reason: "no steps detected",
      at: new Date().toISOString(),
    });
    log(
      `== UPDATE END code=${process.exitCode} ${new Date().toISOString()} ==`,
    );
    return;
  }

  const disableEnrich = String(process.env.DISABLE_ENRICH || "").trim() === "1";

  // snapshot before any work
  const beforeAll = await snapshotListHashes();

  // ----------------
  // STEP 1: generate base lists
  // ----------------
  let baseChanged = [];
  if (scripts.genListsCombined) {
    log(
      `--- STEP 1: Generuji listy (Trakt + CSFD): ${rel(scripts.genListsCombined)} ---`,
    );

    const out = await runNodeScript(
      scripts.genListsCombined,
      [],
      "Generuji listy (Trakt + CSFD)",
      { step: 1, steps: 3 },
    );

    if (!out.ok) {
      process.exitCode = out.code || 1;
      log(`STEP FAILED (code=${out.code}): ${rel(scripts.genListsCombined)}`);
      await writeProgress({
        running: false,
        phase: "done",
        ok: false,
        code: process.exitCode,
        at: new Date().toISOString(),
      });
      log(
        `== UPDATE END code=${process.exitCode} ${new Date().toISOString()} ==`,
      );
      return;
    }

    const afterGen = await snapshotListHashes();
    const changedAllAfterGen = diffHashes(beforeAll, afterGen);

    baseChanged = changedAllAfterGen.filter((fn) =>
      baseListIds.has(idFromFilename(fn)),
    );

    log(
      `Base list changes: ${baseChanged.length ? baseChanged.join(", ") : "(none)"}`,
    );
  } else {
    log("--- STEP 1: (skip) generate_lists_trakt_csfd.mjs not found ---");
  }

  // ----------------
  // STEP 2: SmartPicks
  // ----------------
  if (scripts.genSmartPicks) {
    log(`--- STEP 2: Generuji SmartPicks: ${rel(scripts.genSmartPicks)} ---`);

    const out = await runNodeScript(
      scripts.genSmartPicks,
      [],
      "Generuji SmartPicks",
      { step: 2, steps: 3 },
    );

    if (!out.ok) {
      process.exitCode = out.code || 1;
      log(`STEP FAILED (code=${out.code}): ${rel(scripts.genSmartPicks)}`);
      await writeProgress({
        running: false,
        phase: "done",
        ok: false,
        code: process.exitCode,
        at: new Date().toISOString(),
      });
      log(
        `== UPDATE END code=${process.exitCode} ${new Date().toISOString()} ==`,
      );
      return;
    }
  } else {
    log("--- STEP 2: (skip) generate_smart_picks.mjs not found ---");
  }

  const afterAll = await snapshotListHashes();
  const changedAfterAll = diffHashes(beforeAll, afterAll);
  const smartChanged = changedAfterAll.filter((fn) =>
    smartPickIds.has(idFromFilename(fn)),
  );

  // ----------------
  // STEP 3: Enrich
  // ----------------
  if (disableEnrich) {
    log("--- STEP 3: SKIP enrich (DISABLE_ENRICH=1) ---");
  } else if (!scripts.enrichBest) {
    log("--- STEP 3: (skip) no enrich script found ---");
  } else if (!baseChanged.length && !smartChanged.length) {
    log("--- STEP 3: SKIP enrich (base ani smartpicks listy se nezmenily) ---");
  } else {
    const lightMode = !baseChanged.length && smartChanged.length;
    log(
      `--- STEP 3: Enrich ${lightMode ? "(light smartpicks)" : "(full)"}: ${rel(scripts.enrichBest)} ---`,
    );

    // Full mode:
    // - base lists (ids in config.lists[])
    // - smartpicks lists (ids in smartPicks.profiles[]) if they changed in this run too
    // Light mode:
    // - only changed smartpicks outputs (no heavy full enrich pressure)
    const targets = changedAfterAll.filter((fn) => {
      const id = idFromFilename(fn);
      if (baseChanged.length) return baseListIds.has(id) || smartPickIds.has(id);
      return smartPickIds.has(id);
    });

    await fsp.writeFile(
      ENRICH_TARGETS_PATH,
      JSON.stringify({ listsDir: LISTS_DIR, files: targets }, null, 2),
      "utf8",
    );

    log(`Enrich targets: ${targets.length ? targets.join(", ") : "(none)"}`);

    if (!targets.length) {
      log("SKIP: Enrich – po filtraci není co enrichovat.");
    } else {
      const out = await runNodeScript(
        scripts.enrichBest,
        [],
        lightMode ? "Enrich (light smartpicks)" : "Enrich",
        { step: 3, steps: 3 },
        { ENRICH_TARGETS_PATH, ...(lightMode ? { ENRICH_LIGHT: "1" } : {}) },
      );

      if (!out.ok) {
        process.exitCode = out.code || 1;
        log(`STEP FAILED (code=${out.code}): ${rel(scripts.enrichBest)}`);
        await writeProgress({
          running: false,
          phase: "done",
          ok: false,
          code: process.exitCode,
          at: new Date().toISOString(),
        });
        log(
          `== UPDATE END code=${process.exitCode} ${new Date().toISOString()} ==`,
        );
        return;
      }
    }
  }

  process.exitCode = 0;
  log("OK: Update proběhl bez chyb.");
  await writeProgress({
    running: false,
    phase: "done",
    ok: true,
    code: 0,
    at: new Date().toISOString(),
  });
  log(`== UPDATE END code=0 ${new Date().toISOString()} ==`);
})().catch(async (e) => {
  process.exitCode = 1;
  log(`FATAL: ${String(e?.message || e)}`);
  await writeProgress({
    running: false,
    phase: "done",
    ok: false,
    code: 1,
    at: new Date().toISOString(),
    error: String(e?.message || e),
  }).catch(() => {});
  log(`== UPDATE END code=1 ${new Date().toISOString()} ==`);
});
