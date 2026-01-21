const $ = (id) => document.getElementById(id);

let CURRENT_CONFIG = { recipes: [] };

// accordion: který recipe je rozbalený
let openId = null;

// logs polling
let pollTimer = null;
let lastLogI = 0;
let currentRunId = null;

/* ---------------- helpers ---------------- */

function setMsg(text, kind) {
  const el = $("msg");
  if (!text) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.textContent = text;
  el.className = "msg " + (kind || "");
}

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  const ct = r.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");
  const body = isJson
    ? await r.json().catch(() => null)
    : await r.text().catch(() => null);

  if (!r.ok) {
    const e = new Error("Request failed");
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return body;
}

function safeStr(x) {
  try {
    return typeof x === "string" ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function fmtTs(ts) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

function asBool(v) {
  return v === true || v === "true" || v === "1" || v === 1;
}

function toNumOrNull(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function splitComma(v) {
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function ensurePath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  return { cur, key: parts[parts.length - 1] };
}

function setValueByPath(obj, path, value) {
  const { cur, key } = ensurePath(obj, path);
  cur[key] = value;
}

/* ---------------- recipe template ---------------- */

function recipeTemplate() {
  return {
    id: "r_" + rid(),
    name: "Daily playlist",
    target_playlist_id: "",
    track_count: 50,

    discovery: {
      enabled: false,
      provider: "lastfm_similar_artists",
      seed_top_artists: { time_range: "short_term", limit: 10 },
      similar_per_seed: 50,
      take_artists: 150,
      tracks_per_artist: 2,
    },

    sources: {
      search: [],
      playlists: [],
      liked: false,
      max_candidates: 1500,
      top_tracks: { enabled: true, time_range: "short_term", limit: 50 },
    },

    filters: {
      explicit: "allow", // allow|exclude|only
      year_min: null,
      year_max: null,
    },

    diversity: {
      max_per_artist: 2,
    },

    advanced: {
      recommendation_attempts: 10,
    },
  };
}

/* ---------------- status + logs ---------------- */

function setRunPill(state) {
  const el = $("runState");
  if (state?.running) {
    el.textContent = `running #${state.run_id}`;
    el.className = "pill warn";
    return;
  }
  if (state?.ok === false) {
    el.textContent = "error";
    el.className = "pill err";
    return;
  }
  el.textContent = "idle";
  el.className = "pill";
}

function appendLogLines(lines) {
  const box = $("logBox");
  for (const l of lines) {
    const dt = new Date(l.ts).toLocaleTimeString();
    const level = String(l.level || "info").toUpperCase();
    box.textContent += `[${dt}] ${level}: ${l.msg}\n`;
  }
  box.scrollTop = box.scrollHeight;
}

async function pollLogs() {
  try {
    const st = await api("/api/run/status");
    const state = st?.state || {};
    setRunPill(state);
    currentRunId = state.run_id || currentRunId;

    const qs = new URLSearchParams();
    if (lastLogI) qs.set("since", String(lastLogI));
    if (currentRunId) qs.set("run_id", String(currentRunId));

    const lg = await api("/api/run/logs?" + qs.toString());
    if (lg?.lines?.length) appendLogLines(lg.lines);
    lastLogI = lg?.latest_i || lastLogI;
  } catch {
    // silent
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollLogs, 800);
  pollLogs();
}

async function loadStatus() {
  const st = await api("/api/status");
  $("stPort").textContent = st.port ?? "-";
  $("stBase").textContent = st.base_url ?? "-";
  $("stMarket").textContent = st.market ?? "-";
  $("stAuth").textContent = st.auth?.has_refresh_token
    ? `OK (refreshed ${fmtTs(st.auth.refreshed_at)})`
    : "NOT AUTHORIZED";

  $("stLastRun").textContent = st.last_run?.at
    ? `${fmtTs(st.last_run.at)} • ok=${st.last_run.ok}`
    : "-";

  if (st.last_run?.ok === false && st.last_run?.error) {
    $("stLastRun").textContent += ` • error=${safeStr(st.last_run.error)}`;
  }

  setRunPill(st.run_state || {});
}

/* ---------------- config load/save ---------------- */

async function loadConfig() {
  const r = await api("/api/config");
  CURRENT_CONFIG = r.config || { recipes: [] };
  if (!Array.isArray(CURRENT_CONFIG.recipes)) CURRENT_CONFIG.recipes = [];

  // keep openId if exists
  if (openId && !CURRENT_CONFIG.recipes.some((x) => x.id === openId)) {
    openId = null;
  }
  if (!openId && CURRENT_CONFIG.recipes[0]) {
    openId = CURRENT_CONFIG.recipes[0].id;
  }

  renderAccordion();
}

async function saveAll() {
  await api("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: CURRENT_CONFIG }),
  });
  setMsg("Uloženo.", "ok");
}

async function authStart() {
  const r = await api("/api/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (r?.url) window.open(r.url, "_blank", "noopener,noreferrer");
  setMsg("OAuth otevřen v novém okně. Po dokončení dej Reload.", "ok");
}

async function runNow() {
  return await api("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

/* ---------------- accordion rendering ---------------- */

function getRecipeById(id) {
  return (CURRENT_CONFIG.recipes || []).find((x) => x.id === id) || null;
}

function recipeBadges(r) {
  const provider = r.discovery?.enabled ? "last.fm" : "sources";
  const tracks = Number(r.track_count || 0);
  return `
    <span class="riBadge">${tracks} tracks</span>
    <span class="riBadge">${escapeHtml(provider)}</span>
  `;
}

function renderRecipeEditor(r) {
  const disc = r.discovery || {};
  const sources = r.sources || {};
  const filters = r.filters || {};
  const diversity = r.diversity || {};
  const adv = r.advanced || {};

  return `
    <div class="formgrid">
      <label class="field">
        <div class="label">Name</div>
        <input data-k="name" value="${escapeHtml(r.name || "")}">
      </label>

      <label class="field">
        <div class="label">Target playlist ID</div>
        <input data-k="target_playlist_id" value="${escapeHtml(r.target_playlist_id || "")}" placeholder="Spotify playlist id">
      </label>

      <label class="field">
        <div class="label">Track count</div>
        <input data-k="track_count" type="number" min="1" max="500" value="${Number(r.track_count || 50)}">
      </label>
    </div>

    <div class="section-title">Discovery (Last.fm)</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Enabled</div>
        <select data-k="discovery.enabled">
          <option value="true" ${disc.enabled === true ? "selected" : ""}>true</option>
          <option value="false" ${disc.enabled !== true ? "selected" : ""}>false</option>
        </select>
      </label>

      <label class="field">
        <div class="label">Seed top artists time_range</div>
        <select data-k="discovery.seed_top_artists.time_range">
          <option value="short_term" ${(disc.seed_top_artists?.time_range || "short_term") === "short_term" ? "selected" : ""}>short_term</option>
          <option value="medium_term" ${(disc.seed_top_artists?.time_range || "") === "medium_term" ? "selected" : ""}>medium_term</option>
          <option value="long_term" ${(disc.seed_top_artists?.time_range || "") === "long_term" ? "selected" : ""}>long_term</option>
        </select>
      </label>

      <label class="field">
        <div class="label">Seed top artists limit</div>
        <input data-k="discovery.seed_top_artists.limit" type="number" min="1" max="50" value="${Number(disc.seed_top_artists?.limit ?? 10)}">
      </label>

      <label class="field">
        <div class="label">Similar per seed</div>
        <input data-k="discovery.similar_per_seed" type="number" min="1" max="500" value="${Number(disc.similar_per_seed ?? 50)}">
      </label>

      <label class="field">
        <div class="label">Take artists (cap)</div>
        <input data-k="discovery.take_artists" type="number" min="1" max="5000" value="${Number(disc.take_artists ?? 150)}">
      </label>

      <label class="field">
        <div class="label">Tracks per artist</div>
        <input data-k="discovery.tracks_per_artist" type="number" min="1" max="20" value="${Number(disc.tracks_per_artist ?? 2)}">
      </label>
    </div>

    <div class="section-title">Sources (fallback / pool)</div>
    <div class="formgrid">
      <label class="field span2">
        <div class="label">Search queries (comma)</div>
        <input data-k="sources.search" value="${escapeHtml((sources.search || []).join(", "))}">
      </label>

      <label class="field span2">
        <div class="label">Playlists (IDs nebo URLs, comma)</div>
        <input data-k="sources.playlists" value="${escapeHtml((sources.playlists || []).join(", "))}">
      </label>

      <label class="field">
        <div class="label">Liked tracks</div>
        <select data-k="sources.liked">
          <option value="true" ${sources.liked === true ? "selected" : ""}>true</option>
          <option value="false" ${sources.liked !== true ? "selected" : ""}>false</option>
        </select>
      </label>

      <label class="field">
        <div class="label">Max candidates</div>
        <input data-k="sources.max_candidates" type="number" min="50" max="10000" value="${Number(sources.max_candidates ?? 1500)}">
      </label>

      <label class="field">
        <div class="label">Top tracks enabled</div>
        <select data-k="sources.top_tracks.enabled">
          <option value="true" ${sources.top_tracks?.enabled !== false ? "selected" : ""}>true</option>
          <option value="false" ${sources.top_tracks?.enabled === false ? "selected" : ""}>false</option>
        </select>
      </label>

      <label class="field">
        <div class="label">Top tracks time_range</div>
        <select data-k="sources.top_tracks.time_range">
          <option value="short_term" ${(sources.top_tracks?.time_range || "short_term") === "short_term" ? "selected" : ""}>short_term</option>
          <option value="medium_term" ${(sources.top_tracks?.time_range || "") === "medium_term" ? "selected" : ""}>medium_term</option>
          <option value="long_term" ${(sources.top_tracks?.time_range || "") === "long_term" ? "selected" : ""}>long_term</option>
        </select>
      </label>

      <label class="field">
        <div class="label">Top tracks limit</div>
        <input data-k="sources.top_tracks.limit" type="number" min="1" max="50" value="${Number(sources.top_tracks?.limit ?? 50)}">
      </label>
    </div>

    <div class="section-title">Filters</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Explicit</div>
        <select data-k="filters.explicit">
          <option value="allow" ${(filters.explicit || "allow") === "allow" ? "selected" : ""}>allow</option>
          <option value="exclude" ${(filters.explicit || "") === "exclude" ? "selected" : ""}>exclude</option>
          <option value="only" ${(filters.explicit || "") === "only" ? "selected" : ""}>only</option>
        </select>
      </label>

      <label class="field">
        <div class="label">Year min</div>
        <input data-k="filters.year_min" type="number" value="${escapeHtml(filters.year_min ?? "")}">
      </label>

      <label class="field">
        <div class="label">Year max</div>
        <input data-k="filters.year_max" type="number" value="${escapeHtml(filters.year_max ?? "")}">
      </label>
    </div>

    <div class="section-title">Diversity</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Max per artist</div>
        <input data-k="diversity.max_per_artist" type="number" min="1" max="50" value="${Number(diversity.max_per_artist ?? 2)}">
      </label>
    </div>

    <div class="section-title">Advanced</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Recommendation attempts</div>
        <input data-k="advanced.recommendation_attempts" type="number" min="1" max="50" value="${Number(adv.recommendation_attempts ?? 10)}">
      </label>
    </div>
  `;
}

function saveRecipeFromBlock(recipeId) {
  const r = getRecipeById(recipeId);
  if (!r) return;

  // ensure sub-objects
  const tpl = recipeTemplate();
  if (!r.discovery) r.discovery = tpl.discovery;
  if (!r.sources) r.sources = tpl.sources;
  if (!r.filters) r.filters = tpl.filters;
  if (!r.diversity) r.diversity = tpl.diversity;
  if (!r.advanced) r.advanced = tpl.advanced;

  const root = document.querySelector(
    `.recipeBlock[data-id="${CSS.escape(recipeId)}"]`,
  );
  if (!root) return;

  root.querySelectorAll("[data-k]").forEach((el) => {
    const k = el.getAttribute("data-k");
    let v = el.value;

    if (k === "sources.search" || k === "sources.playlists") {
      setValueByPath(r, k, splitComma(v));
      return;
    }

    if (
      k === "discovery.enabled" ||
      k === "sources.liked" ||
      k === "sources.top_tracks.enabled"
    ) {
      setValueByPath(r, k, asBool(v));
      return;
    }

    if (k === "filters.year_min" || k === "filters.year_max") {
      setValueByPath(r, k, toNumOrNull(v));
      return;
    }

    if (
      k === "track_count" ||
      k === "discovery.seed_top_artists.limit" ||
      k === "discovery.similar_per_seed" ||
      k === "discovery.take_artists" ||
      k === "discovery.tracks_per_artist" ||
      k === "sources.max_candidates" ||
      k === "sources.top_tracks.limit" ||
      k === "diversity.max_per_artist" ||
      k === "advanced.recommendation_attempts"
    ) {
      const n = Number(v);
      setValueByPath(r, k, Number.isFinite(n) ? n : 0);
      return;
    }

    setValueByPath(r, k, v);
  });
}

function renderAccordion() {
  const list = $("recipeList");
  const recipes = CURRENT_CONFIG.recipes || [];

  if (recipes.length === 0) {
    list.innerHTML = `<div class="muted small">No recipes yet. Click Add.</div>`;
    return;
  }

  list.innerHTML = recipes
    .map((r) => {
      const isOpen = r.id === openId;
      const name = escapeHtml(r.name || "Recipe");
      const pid = escapeHtml(r.target_playlist_id || "");
      const caret = isOpen ? "▾" : "▸";

      return `
        <div class="recipeBlock ${isOpen ? "open" : ""}" data-id="${escapeHtml(r.id)}">
          <button class="recipeHead" type="button" data-action="toggle" data-id="${escapeHtml(r.id)}">
            <div class="rhLeft">
              <div class="rhTitle">
                <span class="caret">${caret}</span>
                <span class="titleText">${name}</span>
              </div>
              <div class="rhMeta">
                <span class="mono">${escapeHtml(r.id)}</span>
                ${pid ? `<span class="dot">•</span><span class="mono">${pid}</span>` : ""}
              </div>
            </div>
            <div class="rhRight">
              ${recipeBadges(r)}
            </div>
          </button>

          <div class="recipeBody" ${isOpen ? "" : 'style="display:none"'}>

            <div class="row" style="justify-content: space-between; align-items:center; margin-bottom:10px;">
              <div class="small muted">Edituješ přímo tento recipe. Uložení je až po “Save all”.</div>
              <div class="btns">
                <button class="danger" data-action="delete" data-id="${escapeHtml(r.id)}">Delete</button>
                <button data-action="dup" data-id="${escapeHtml(r.id)}">Duplicate</button>
                <button class="primary" data-action="saveone" data-id="${escapeHtml(r.id)}">Save recipe</button>
              </div>
            </div>

            ${renderRecipeEditor(r)}
          </div>
        </div>
      `;
    })
    .join("");

  // wire actions
  list.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const action = el.getAttribute("data-action");
      const id = el.getAttribute("data-id");
      if (!id) return;

      if (action === "toggle") {
        openId = openId === id ? null : id;
        renderAccordion();

        // pokud se otevřel, sroluj ho do view
        if (openId === id) {
          const block = document.querySelector(
            `.recipeBlock[data-id="${CSS.escape(id)}"]`,
          );
          block?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }

      if (action === "saveone") {
        saveRecipeFromBlock(id);
        setMsg("Recipe uložen do UI. Teď dej Save all.", "ok");
        // refresh badges/title
        renderAccordion();
        return;
      }

      if (action === "delete") {
        const r = getRecipeById(id);
        if (!r) return;
        if (!confirm(`Smazat recipe "${r.name}"?`)) return;
        CURRENT_CONFIG.recipes = (CURRENT_CONFIG.recipes || []).filter(
          (x) => x.id !== id,
        );
        if (openId === id) openId = CURRENT_CONFIG.recipes[0]?.id || null;
        renderAccordion();
        setMsg("Recipe smazán. Nezapomeň Save all.", "warn");
        return;
      }

      if (action === "dup") {
        const r = getRecipeById(id);
        if (!r) return;

        // vezmi poslední změny z editoru
        saveRecipeFromBlock(id);

        const copy = JSON.parse(JSON.stringify(r));
        copy.id = "r_" + rid();
        copy.name = (copy.name || "Recipe") + " (copy)";
        CURRENT_CONFIG.recipes.push(copy);

        openId = copy.id;
        renderAccordion();
        setMsg("Recipe zduplikován. Nezapomeň Save all.", "ok");
        return;
      }
    });
  });
}

/* ---------------- buttons ---------------- */

$("btnReload").addEventListener("click", async () => {
  try {
    await loadStatus();
    await loadConfig();
    setMsg("Reload OK.", "ok");
  } catch (e) {
    setMsg(
      `Reload failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
      "err",
    );
  }
});

$("btnLoad").addEventListener("click", async () => {
  try {
    await loadConfig();
    setMsg("Load OK.", "ok");
  } catch (e) {
    setMsg(
      `Load failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
      "err",
    );
  }
});

$("btnSaveAll").addEventListener("click", async () => {
  try {
    // před uložením stáhni změny z otevřeného bloku (pokud je)
    if (openId) saveRecipeFromBlock(openId);
    await saveAll();
    await loadStatus().catch(() => {});
  } catch (e) {
    setMsg(
      `Save failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
      "err",
    );
  }
});

$("btnAdd").addEventListener("click", () => {
  CURRENT_CONFIG.recipes = CURRENT_CONFIG.recipes || [];
  const r = recipeTemplate();
  CURRENT_CONFIG.recipes.push(r);
  openId = r.id;
  renderAccordion();
  setMsg("Recipe přidán. Uprav a dej Save all.", "ok");
});

$("btnAuth").addEventListener("click", async () => {
  try {
    await authStart();
  } catch (e) {
    setMsg(
      `Auth start failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
      "err",
    );
  }
});

$("btnClearLogs").addEventListener("click", async () => {
  try {
    await api("/api/run/logs/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    $("logBox").textContent = "";
    lastLogI = 0;
    currentRunId = null;
    setMsg("Logs cleared.", "ok");
  } catch (e) {
    setMsg(
      `Clear logs failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
      "err",
    );
  }
});

$("btnRun").addEventListener("click", async () => {
  try {
    setMsg("", "");
    $("logBox").textContent = "";
    lastLogI = 0;

    startPolling();

    await runNow();

    await pollLogs();
    await loadStatus();

    setMsg("Run finished. Viz logy výše.", "ok");
  } catch (e) {
    await pollLogs();
    await loadStatus().catch(() => {});
    setMsg(
      `Run failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
      "err",
    );
  }
});

/* ---------------- init ---------------- */

(async () => {
  try {
    await loadStatus();
    await loadConfig();
  } catch (e) {
    setMsg(
      `Init failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
      "err",
    );
  } finally {
    startPolling();
  }
})();
