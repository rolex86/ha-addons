// tools/restart-addon.js
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PID_PATH = path.join(ROOT, "runtime", "addon.pid");

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
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

function startAddonDetached() {
  // spustíme "node server.js" na pozadí
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  return child.pid;
}

(async () => {
  const pid = readPid();
  if (pid) {
    const killed = killPid(pid);
    console.log("[restart] old pid:", pid, "killed:", killed);
  } else {
    console.log("[restart] no pid found, starting fresh");
  }

  // malá pauza aby se port uvolnil
  await new Promise(r => setTimeout(r, 400));

  const newPid = startAddonDetached();
  console.log("[restart] started new pid:", newPid);

  // NOTE: nový PID si server zapíše do runtime/addon.pid sám při startu
})();
