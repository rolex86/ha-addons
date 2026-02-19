import express from "express";
import { buildManifest } from "./manifest.js";
import { buildConfigToken, readConfig } from "./config.js";
import { CatalogService } from "./services/catalogService.js";
import { MetaService } from "./services/metaService.js";
import { StreamService } from "./services/streamService.js";
import { ENV } from "./env.js";

const CONFIG_QUERY_KEYS = new Set(["email", "password", "limit", "premium", "cfg"]);

export function buildRouter() {
  const r = express.Router();
  r.use(express.json());

  r.get("/", (req, res) => {
    res
      .type("text/plain")
      .send(
        "Stremio Prehraj.to Addon is running. Use /manifest.json or /configure",
      );
  });

  r.get("/manifest.json", (req, res) => {
    res.json(buildManifest());
  });

  // Simple configuration UI: generate manifest URL with encrypted cfg token.
  r.get("/configure", (req, res) => {
    res.type("html").send(renderConfigureHtml());
  });

  r.post("/configure/manifest-url", (req, res) => {
    try {
      const base = ENV.BASE_URL.replace(/\/+$/g, "");
      const token = buildConfigToken(req.body || {});
      const manifestUrl = `${base}/manifest.json?cfg=${encodeURIComponent(token)}`;
      res.json({ manifestUrl });
    } catch (e) {
      res
        .status(400)
        .json({ error: "Invalid configuration payload", detail: String(e) });
    }
  });

  const catalogHandler = async (req, res) => {
    try {
      const config = readConfig(req);
      const { type, id } = req.params;
      const extra = parseCatalogExtra(req);
      const data = await CatalogService.catalog(id, type, extra, config);
      res.json(data);
    } catch (e) {
      res.status(500).json({ metas: [], error: String(e?.message || e) });
    }
  };
  r.get("/catalog/:type/:id.json", catalogHandler);
  r.get("/catalog/:type/:id/:extra.json", catalogHandler);

  r.get("/meta/:type/:id.json", async (req, res) => {
    try {
      const { type, id } = req.params;
      const data = await MetaService.metaForId(type, id);
      if (!data.meta) return res.json({ meta: null });
      res.json(data);
    } catch (e) {
      res.status(500).json({ meta: null, error: String(e?.message || e) });
    }
  });

  r.get("/stream/:type/:id.json", async (req, res) => {
    try {
      const config = readConfig(req);
      const { id } = req.params;

      const data = await StreamService.streamsForId(id, config);
      res.json(data);
    } catch (e) {
      res.status(500).json({ streams: [], error: String(e?.message || e) });
    }
  });

  return r;
}

function parseCatalogExtra(req) {
  const extra = {};

  const rawPathExtra = req.params?.extra;
  if (typeof rawPathExtra === "string" && rawPathExtra.length > 0) {
    for (const [k, v] of new URLSearchParams(rawPathExtra)) {
      extra[k] = v;
    }
  }

  for (const [k, v] of Object.entries(req.query || {})) {
    if (CONFIG_QUERY_KEYS.has(k)) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) extra[k] = String(v[v.length - 1]);
      continue;
    }
    if (v !== undefined && v !== null) extra[k] = String(v);
  }

  return extra;
}

function renderConfigureHtml() {
  const base = ENV.BASE_URL.replace(/\/+$/g, "");
  const manifest = `${base}/manifest.json`;

  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Prehraj.to Addon – Konfigurace</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; max-width: 860px; margin: 0 auto; }
    .card { border: 1px solid #e6e6e6; border-radius: 12px; padding: 16px; margin: 12px 0; }
    label { display:block; margin: 10px 0 6px; font-weight: 600; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 10px; }
    .row { display:flex; gap: 12px; }
    .row > div { flex: 1; }
    button { padding: 10px 14px; border-radius: 10px; border: 0; background: #2f8dfc; color: #fff; font-weight: 700; cursor:pointer; }
    code { display:block; background:#f6f6f6; padding: 12px; border-radius: 10px; overflow:auto; }
    .hint { color:#555; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>Prehraj.to Addon (Node) – Konfigurace</h1>

  <div class="card">
    <div class="hint">
      Vygeneruješ si instalační URL pro Stremio.<br/>
      Přihlašovací údaje se neposílají v URL v čistém textu.
    </div>

    <div class="row">
      <div>
        <label>Email (premium)</label>
        <input id="email" placeholder="email"/>
      </div>
      <div>
        <label>Heslo (premium)</label>
        <input id="password" type="password" placeholder="password"/>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Limit výsledků hledání</label>
        <input id="limit" value="${ENV.DEFAULT_SEARCH_LIMIT}" />
      </div>
      <div>
        <label>Premium režim</label>
        <input id="premium" type="checkbox" ${ENV.DEFAULT_PREMIUM ? "checked" : ""} />
      </div>
    </div>

    <div style="margin-top:14px;">
      <button onclick="gen()">Vygenerovat instalační URL</button>
    </div>
  </div>

  <div class="card">
    <h3>Instalační URL</h3>
    <code id="out">${manifest}</code>
    <div class="hint" style="margin-top:10px;">
      Otevři ve Stremio: Add-ons → Community → Install via URL → vlož sem vygenerovanou URL.
    </div>
  </div>

<script>
  async function gen() {
    const out = document.getElementById("out");
    const payload = {
      email: document.getElementById("email").value.trim(),
      password: document.getElementById("password").value,
      limit: document.getElementById("limit").value.trim(),
      premium: document.getElementById("premium").checked
    };

    try {
      const res = await fetch("/configure/manifest-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error("Nepodařilo se vytvořit manifest URL");
      const data = await res.json();
      out.textContent = data.manifestUrl || "${manifest}";
    } catch (e) {
      out.textContent = "Chyba: " + (e && e.message ? e.message : String(e));
    }
  }
</script>
</body>
</html>`;
}
