import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// HA add-on persistent paths
const DATA_DIR = process.env.DATA_DIR || "/data";
const SECRETS_PATH_DATA = path.join(DATA_DIR, "config", "secrets.json");

// Optional dev fallback (repo-local)
const ROOT = path.join(__dirname, "..");
const SECRETS_PATH_APP = path.join(ROOT, "config", "secrets.json");

async function readJsonIfExists(p) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadSecrets() {
  // 1) HA persistent
  const fromData = await readJsonIfExists(SECRETS_PATH_DATA);
  if (fromData && typeof fromData === "object") return fromData;

  // 2) dev fallback
  const fromApp = await readJsonIfExists(SECRETS_PATH_APP);
  if (fromApp && typeof fromApp === "object") return fromApp;

  return {};
}

export async function getTraktKeys() {
  const secrets = await loadSecrets();

  const clientId = String(
    process.env.TRAKT_CLIENT_ID || secrets?.trakt?.client_id || "",
  ).trim();

  const clientSecret = String(
    process.env.TRAKT_CLIENT_SECRET || secrets?.trakt?.client_secret || "",
  ).trim();

  return { clientId, clientSecret };
}
