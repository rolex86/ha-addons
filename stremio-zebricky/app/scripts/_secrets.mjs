import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.join(__dirname, "..");
const SECRETS_PATH = path.join(ROOT, "config", "secrets.json");

export async function loadSecrets() {
  try {
    const raw = await fs.readFile(SECRETS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function getTraktKeys() {
  const secrets = await loadSecrets();
  const clientId = (process.env.TRAKT_CLIENT_ID || secrets?.trakt?.client_id || "").trim();
  const clientSecret = (process.env.TRAKT_CLIENT_SECRET || secrets?.trakt?.client_secret || "").trim();
  return { clientId, clientSecret };
}
