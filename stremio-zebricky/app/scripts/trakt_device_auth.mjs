import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTraktKeys } from "./_secrets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache");
const TOKEN_PATH = path.join(CACHE_DIR, "trakt_token.json");

const TRAKT_BASE = "https://api.trakt.tv";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = data?.error_description || data?.error || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function main() {
  const { clientId, clientSecret } = await getTraktKeys();
  if (!clientId) throw new Error("Chybí TRAKT_CLIENT_ID (env nebo config/secrets.json).");
  if (!clientSecret) throw new Error("Chybí TRAKT_CLIENT_SECRET (env nebo config/secrets.json).");

  console.log("Requesting device code…");

  // 1) device code
  const code = await postJson(`${TRAKT_BASE}/oauth/device/code`, {
    client_id: clientId,
  });

  const userCode = code.user_code;
  const verificationUrl = code.verification_url || "https://trakt.tv/activate";
  const deviceCode = code.device_code;
  const expiresIn = Number(code.expires_in || 600);
  const interval = Number(code.interval || 5);

  console.log("\n=== TRAKT AUTH ===");
  console.log("Otevři:", verificationUrl);
  console.log("Zadej kód:", userCode);
  console.log(`Kód vyprší za ~${Math.round(expiresIn / 60)} minut.`);
  console.log("==================\n");

  // 2) polling token
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    try {
      const tok = await postJson(`${TRAKT_BASE}/oauth/device/token`, {
        code: deviceCode,
        client_id: clientId,
        client_secret: clientSecret,
      });

      await ensureCacheDir();
      tok.obtained_at = new Date().toISOString();
      await fs.writeFile(TOKEN_PATH, JSON.stringify(tok, null, 2), "utf8");

      console.log("✅ Hotovo! Token uložen do:", TOKEN_PATH);
      return;
    } catch (e) {
      const err = e?.data?.error || "";
      if (err === "authorization_pending") {
        await sleep(interval * 1000);
        continue;
      }
      if (err === "slow_down") {
        await sleep((interval + 5) * 1000);
        continue;
      }
      if (err === "expired_token") {
        throw new Error("Device code expiroval, spusť skript znovu.");
      }
      throw e;
    }
  }

  throw new Error("Vypršel čas na autorizaci (device code timeout).");
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});
