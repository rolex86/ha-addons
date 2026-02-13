// tools/restart-addon.js
// Restart addon process under s6 supervision (HA runtime-safe).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PID_PATH = path.join(ROOT, "runtime", "addon.pid");

const S6_SVC_BIN = process.env.S6_SVC_BIN || "s6-svc";
const DEV_FALLBACK =
  String(process.env.RESTART_ADDON_DEV_FALLBACK || "").trim() === "1";

const SERVICE_DIR_CANDIDATES = [
  "/run/service/stremio",
  "/run/s6/services/stremio",
  "/var/run/s6/services/stremio",
  "/run/s6-rc/servicedirs/stremio",
];

function readPid() {
  try {
    const raw = fs.readFileSync(PID_PATH, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function findServiceDir() {
  for (const p of SERVICE_DIR_CANDIDATES) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function restartViaS6() {
  const serviceDir = findServiceDir();
  if (!serviceDir) {
    throw new Error(
      `s6 service dir for 'stremio' not found (checked: ${SERVICE_DIR_CANDIDATES.join(", ")})`,
    );
  }

  const out = spawnSync(S6_SVC_BIN, ["-r", serviceDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (out.error) throw out.error;
  if (out.status !== 0) {
    throw new Error(
      `${S6_SVC_BIN} -r ${serviceDir} failed (code=${out.status}): ${String(out.stderr || out.stdout || "").trim()}`,
    );
  }

  return {
    serviceDir,
    stdout: String(out.stdout || "").trim(),
    stderr: String(out.stderr || "").trim(),
  };
}

(function main() {
  try {
    const out = restartViaS6();
    console.log("[restart] s6 restart requested for service dir:", out.serviceDir);
    if (out.stdout) console.log("[restart] s6 stdout:", out.stdout);
    if (out.stderr) console.log("[restart] s6 stderr:", out.stderr);
    return;
  } catch (e) {
    console.warn("[restart] s6 restart failed:", String(e?.message || e));
  }

  if (!DEV_FALLBACK) {
    throw new Error(
      "Restart via s6 failed and dev fallback is disabled. Set RESTART_ADDON_DEV_FALLBACK=1 only for local dev without s6.",
    );
  }

  const pid = readPid();
  if (!pid) {
    throw new Error(
      `Dev fallback: addon PID not found (${PID_PATH}). Cannot request restart safely.`,
    );
  }

  const killed = killPid(pid);
  if (!killed) {
    throw new Error(`Dev fallback: failed to SIGTERM pid=${pid}`);
  }

  console.log(
    `[restart] dev fallback: sent SIGTERM to pid=${pid}. Supervisor should restart it.`,
  );
})();
