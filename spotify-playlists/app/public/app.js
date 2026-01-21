async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, raw: text };
  }
  if (!res.ok) throw new Error(json.error || "HTTP " + res.status);
  return json;
}

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

function recipeTemplate() {
  return {
    id: "r_" + rid(),
    name: "Daily playlist",
    target_playlist_id: "",
    track_count: 50,
    source: {
      seed_genres: ["techno"],
    },
    filters: {
      year_min: 2010,
      year_max: 2026,
      tempo_min: 120,
      tempo_max: 140,
      explicit_allowed: true,
    },
    diversity: {
      max_per_artist: 2,
      max_per_album: 2,
      avoid_same_artist_in_row: true,
    },
    advanced: {
      recommendation_attempts: 10,
    },
  };
}

function renderRecipe(r, idx) {
  return `
  <div class="recipe" data-id="${r.id}">
    <div class="row">
      <div><b>${r.name || "Recipe"}</b> <span class="small">(${r.id})</span></div>
      <div class="right">
        <button class="btnDel">Delete</button>
      </div>
    </div>

    <div class="grid" style="margin-top:10px;">
      <label>
        <div class="small">Name</div>
        <input data-k="name" value="${escapeHtml(r.name || "")}">
      </label>

      <label>
        <div class="small">Target playlist ID</div>
        <input data-k="target_playlist_id" placeholder="Spotify playlist id" value="${escapeHtml(r.target_playlist_id || "")}">
      </label>

      <label>
        <div class="small">Track count</div>
        <input data-k="track_count" type="number" min="1" max="500" value="${Number(r.track_count || 50)}">
      </label>

      <label>
        <div class="small">Seed genres (comma)</div>
        <input data-k="seed_genres" value="${escapeHtml((r.source?.seed_genres || []).join(","))}">
      </label>

      <label>
        <div class="small">Year min</div>
        <input data-k="year_min" type="number" value="${r.filters?.year_min ?? ""}">
      </label>

      <label>
        <div class="small">Year max</div>
        <input data-k="year_max" type="number" value="${r.filters?.year_max ?? ""}">
      </label>

      <label>
        <div class="small">Tempo min (BPM)</div>
        <input data-k="tempo_min" type="number" value="${r.filters?.tempo_min ?? ""}">
      </label>

      <label>
        <div class="small">Tempo max (BPM)</div>
        <input data-k="tempo_max" type="number" value="${r.filters?.tempo_max ?? ""}">
      </label>

      <label>
        <div class="small">Explicit allowed</div>
        <select data-k="explicit_allowed">
          <option value="true" ${r.filters?.explicit_allowed !== false ? "selected" : ""}>true</option>
          <option value="false" ${r.filters?.explicit_allowed === false ? "selected" : ""}>false</option>
        </select>
      </label>

      <label>
        <div class="small">Max per artist</div>
        <input data-k="max_per_artist" type="number" min="1" max="50" value="${r.diversity?.max_per_artist ?? 2}">
      </label>

      <label>
        <div class="small">Recommendation attempts</div>
        <input data-k="recommendation_attempts" type="number" min="1" max="50" value="${r.advanced?.recommendation_attempts ?? 10}">
      </label>
    </div>

    <div style="margin-top:10px;" class="right">
      <button class="btnSave">Save</button>
    </div>
  </div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let CURRENT_CONFIG = null;

async function refresh() {
  const st = await api("/api/status");
  document.getElementById("status").innerHTML = `
    <div>Auth: <b>${st.auth.has_refresh_token ? "OK" : "NOT AUTHORIZED"}</b></div>
    <div>Last run: ${st.last_run?.at ? new Date(st.last_run.at).toLocaleString() : "-"}</div>
  `;

  const cfg = await api("/api/config");
  CURRENT_CONFIG = cfg.config;
  const holder = document.getElementById("recipes");
  const recipes = CURRENT_CONFIG.recipes || [];
  holder.innerHTML = recipes.length
    ? recipes.map(renderRecipe).join("")
    : `<div class="muted">No recipes yet.</div>`;

  holder.querySelectorAll(".btnDel").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest(".recipe").dataset.id;
      CURRENT_CONFIG.recipes = CURRENT_CONFIG.recipes.filter(
        (x) => x.id !== id,
      );
      await api("/api/config", {
        method: "POST",
        body: JSON.stringify({ config: CURRENT_CONFIG }),
      });
      await refresh();
    });
  });

  holder.querySelectorAll(".btnSave").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const el = e.target.closest(".recipe");
      const id = el.dataset.id;
      const r = CURRENT_CONFIG.recipes.find((x) => x.id === id);
      if (!r) return;

      const get = (k) => el.querySelector(`[data-k="${k}"]`)?.value;

      r.name = get("name");
      r.target_playlist_id = get("target_playlist_id");
      r.track_count = Number(get("track_count") || 50);

      r.source = r.source || {};
      r.source.seed_genres = (get("seed_genres") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      r.filters = r.filters || {};
      r.filters.year_min = get("year_min") ? Number(get("year_min")) : null;
      r.filters.year_max = get("year_max") ? Number(get("year_max")) : null;
      r.filters.tempo_min = get("tempo_min") ? Number(get("tempo_min")) : null;
      r.filters.tempo_max = get("tempo_max") ? Number(get("tempo_max")) : null;
      r.filters.explicit_allowed = get("explicit_allowed") === "true";

      r.diversity = r.diversity || {};
      r.diversity.max_per_artist = Number(get("max_per_artist") || 2);

      r.advanced = r.advanced || {};
      r.advanced.recommendation_attempts = Number(
        get("recommendation_attempts") || 10,
      );

      await api("/api/config", {
        method: "POST",
        body: JSON.stringify({ config: CURRENT_CONFIG }),
      });
      await refresh();
    });
  });
}

document.getElementById("btnAdd").addEventListener("click", async () => {
  if (!CURRENT_CONFIG) return;
  CURRENT_CONFIG.recipes = CURRENT_CONFIG.recipes || [];
  CURRENT_CONFIG.recipes.push(recipeTemplate());
  await api("/api/config", {
    method: "POST",
    body: JSON.stringify({ config: CURRENT_CONFIG }),
  });
  await refresh();
});

document.getElementById("btnAuth").addEventListener("click", async () => {
  const r = await api("/api/auth/start", { method: "POST", body: "{}" });
  document.getElementById("authInfo").textContent =
    "Open authorize URL in a new tab…";
  window.open(r.url, "_blank");
});

document.getElementById("btnRun").addEventListener("click", async () => {
  await api("/api/run", { method: "POST", body: "{}" });
  await refresh();
});

document
  .getElementById("btnClearHistory")
  .addEventListener("click", async () => {
    if (!confirm("Opravdu smazat historii?")) return;
    await api("/api/history/clear", { method: "POST", body: "{}" });
    alert("OK");
  });

refresh().catch((e) => {
  document.getElementById("status").textContent = "Error: " + e.message;
});
