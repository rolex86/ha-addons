import express from "express";
import { buildManifest } from "./manifest.js";
import { buildConfigToken, readConfig } from "./config.js";
import { StreamService } from "./services/streamService.js";
import { ENV } from "./env.js";
import { elapsedMs, errorMeta, log, summarizeId } from "./utils/log.js";

let reqSeq = 0;

export function buildRouter() {
  const r = express.Router();
  r.use(express.json());
  r.use((req, res, next) => {
    reqSeq += 1;
    const reqId = reqSeq;
    req._reqId = reqId;
    req._startedAt = Date.now();

    const q = { ...(req.query || {}) };
    if (q.cfg) q.cfg = "***";
    if (q.password) q.password = "***";

    log.debug(`REQ#${reqId} -> ${req.method} ${req.path}`, { query: q });
    res.on("finish", () => {
      log.info(`REQ#${reqId} <- ${res.statusCode} ${req.method} ${req.path}`, {
        ms: elapsedMs(req._startedAt),
      });
    });
    next();
  });

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
      log.debug(`REQ#${req._reqId} configure manifest generated`);
      res.json({ manifestUrl });
    } catch (e) {
      log.warn(`REQ#${req._reqId} configure manifest failed`, errorMeta(e));
      res
        .status(400)
        .json({ error: "Invalid configuration payload", detail: String(e) });
    }
  });

  r.get("/stream/:type/:id.json", async (req, res) => {
    try {
      const config = readConfig(req);
      const { type, id } = req.params;
      log.debug(`REQ#${req._reqId} stream start`, {
        type,
        id: summarizeId(id),
        limit: config.limit,
        streamLimit: config.streamLimit,
        premium: config.premium,
        sortBy: config.sortBy,
        maxSizeGb: config.maxSizeGb,
        audioPreference: config.audioPreference,
        qualityPreference: config.qualityPreference,
        hasEmail: Boolean(config.email),
      });

      const data = await StreamService.streamsForId(type, id, config);
      log.debug(`REQ#${req._reqId} stream result`, {
        streams: Array.isArray(data?.streams) ? data.streams.length : 0,
      });
      res.json(data);
    } catch (e) {
      log.error(`REQ#${req._reqId} stream failed`, errorMeta(e));
      res.json({ streams: [], error: String(e?.message || e) });
    }
  });

  return r;
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
    input, select { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 10px; }
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
        <label>Počet vrácených streamů</label>
        <input id="stream_limit" value="${ENV.DEFAULT_STREAMS_LIMIT}" />
      </div>
    </div>

    <div class="row">
      <div>
        <label>Premium režim</label>
        <input id="premium" type="checkbox" ${ENV.DEFAULT_PREMIUM ? "checked" : ""} />
      </div>
      <div>
        <label>Řazení výsledků</label>
        <select id="sort_by">
          <option value="size_desc" ${ENV.DEFAULT_SORT_BY === "size_desc" ? "selected" : ""}>Největší první</option>
          <option value="size_asc" ${ENV.DEFAULT_SORT_BY === "size_asc" ? "selected" : ""}>Nejmenší první</option>
          <option value="relevance_desc" ${ENV.DEFAULT_SORT_BY === "relevance_desc" ? "selected" : ""}>Nejlepší match první</option>
          <option value="balanced" ${ENV.DEFAULT_SORT_BY === "balanced" ? "selected" : ""}>Balanced</option>
        </select>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Maximální velikost souboru (GB)</label>
        <input id="max_size_gb" value="${ENV.DEFAULT_MAX_SIZE_GB > 0 ? ENV.DEFAULT_MAX_SIZE_GB : ""}" placeholder="např. 15" />
      </div>
      <div>
        <label>Preference audia</label>
        <select id="audio_preference">
          <option value="any" ${ENV.DEFAULT_AUDIO_PREFERENCE === "any" ? "selected" : ""}>Bez preference</option>
          <option value="prefer_cz_dub" ${ENV.DEFAULT_AUDIO_PREFERENCE === "prefer_cz_dub" ? "selected" : ""}>Preferovat CZ dabing</option>
          <option value="prefer_cz_sk" ${ENV.DEFAULT_AUDIO_PREFERENCE === "prefer_cz_sk" ? "selected" : ""}>Preferovat CZ/SK</option>
          <option value="prefer_original" ${ENV.DEFAULT_AUDIO_PREFERENCE === "prefer_original" ? "selected" : ""}>Preferovat originál</option>
        </select>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Preference kvality</label>
        <select id="quality_preference">
          <option value="any" ${ENV.DEFAULT_QUALITY_PREFERENCE === "any" ? "selected" : ""}>Bez preference</option>
          <option value="prefer_4k" ${ENV.DEFAULT_QUALITY_PREFERENCE === "prefer_4k" ? "selected" : ""}>Preferovat 4K</option>
          <option value="prefer_1080p" ${ENV.DEFAULT_QUALITY_PREFERENCE === "prefer_1080p" ? "selected" : ""}>Preferovat 1080p</option>
          <option value="prefer_720p" ${ENV.DEFAULT_QUALITY_PREFERENCE === "prefer_720p" ? "selected" : ""}>Preferovat 720p</option>
          <option value="avoid_4k" ${ENV.DEFAULT_QUALITY_PREFERENCE === "avoid_4k" ? "selected" : ""}>Upřednostnit ne-4K</option>
        </select>
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
      streamLimit: document.getElementById("stream_limit").value.trim(),
      premium: document.getElementById("premium").checked,
      sortBy: document.getElementById("sort_by").value,
      maxSizeGb: document.getElementById("max_size_gb").value.trim(),
      audioPreference: document.getElementById("audio_preference").value,
      qualityPreference: document.getElementById("quality_preference").value
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
