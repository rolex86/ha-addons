#!/usr/bin/env node

const { serveHTTP } = require("stremio-addon-sdk");
const fs = require("fs");
const path = require("path");

const addonInterface = require("./addon");

const PORT = Number(process.env.PORT || 7000);

// uložíme PID, aby ho config-ui umělo restartnout
const RUNTIME_DIR = path.join(__dirname, "runtime");
const PID_PATH = path.join(RUNTIME_DIR, "addon.pid");

try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
  console.log("[pid] wrote", PID_PATH, "=", process.pid);
} catch (e) {
  console.warn("[pid] failed to write pid:", e?.message || e);
}

serveHTTP(addonInterface, { port: PORT });

console.log(`[addon] listening on port ${PORT}`);
