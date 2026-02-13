// tools/config-ui/client.js
// Config UI – client (no dependencies)
// Edits config/lists.trakt.json + config/secrets.json and supports click-UI for Lists + SmartPicks.
// Also supports "Run update" streaming log/progress (if server.js implements /api/run-update + SSE).

(function () {
  // =========================
  // helpers
  // =========================
  function $(id) {
    return document.getElementById(id);
  }

  function on(id, ev, fn) {
    const el = $(id);
    if (!el) return false;
    el.addEventListener(ev, fn);
    return true;
  }

  function clamp(n, a, b) {
    n = Number(n);
    a = Number(a);
    b = Number(b);
    if (!Number.isFinite(n)) n = a;
    return Math.max(a, Math.min(b, n));
  }

  function parseCsv(csv) {
    return String(csv || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function uniqLower(list) {
    return Array.from(
      new Set(
        (list || [])
          .map((s) =>
            String(s || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    );
  }

  function setCsvToEl(el, list) {
    if (!el) return;
    el.value = uniqLower(list).join(",");
  }

  function numOrUndef(v) {
    if (v === "" || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  function setStatus(msg) {
    const el = $("status");
    if (el)
      el.innerHTML = "Status: <strong>" + String(msg || "—") + "</strong>";
  }

  function headersWithToken() {
    const token = String($("token")?.value || "").trim();
    const h = { "content-type": "application/json" };
    if (token) h["x-config-token"] = token;
    return h;
  }

  function safeStr(x) {
    return x === null || x === undefined ? "" : String(x);
  }

  // =========================
  // constants (list sources + smartpicks seeds)
  // =========================
  const SOURCES_MOVIE = [
    { value: "/movies/watched/all", label: "movies/watched/all (klasiky)" },
    { value: "/movies/collected/all", label: "movies/collected/all (sbírky)" },
    { value: "/movies/played/all", label: "movies/played/all" },
    { value: "/movies/popular", label: "movies/popular" },
    { value: "/movies/trending", label: "movies/trending" },
    { value: "/movie/popular", label: "TMDB movie/popular" },
    { value: "/trending/movie/day", label: "TMDB trending/movie/day" },
  ];

  const SOURCES_SERIES = [
    { value: "/shows/trending", label: "shows/trending" },
    { value: "/shows/popular", label: "shows/popular" },
    { value: "/shows/played/all", label: "shows/played/all" },
    { value: "/shows/watched/all", label: "shows/watched/all" },
    { value: "/shows/collected/all", label: "shows/collected/all" },
    { value: "/tv/popular", label: "TMDB tv/popular" },
    { value: "/trending/tv/day", label: "TMDB trending/tv/day" },
  ];

  // SmartPicks: 10 "seed" endpoints per type
  const SP_TRAKT_MOVIE = [
    "/movies/trending",
    "/movies/popular",
    "/movies/recommended",
    "/movies/anticipated",
    "/movies/boxoffice",
    "/movies/watched/all",
    "/movies/collected/all",
    "/movies/played/all",
    "/movies/collected/weekly",
    "/movies/watched/weekly",
  ];

  const SP_TRAKT_SERIES = [
    "/shows/trending",
    "/shows/popular",
    "/shows/recommended",
    "/shows/anticipated",
    "/shows/watched/all",
    "/shows/collected/all",
    "/shows/played/all",
    "/shows/watched/weekly",
    "/shows/collected/weekly",
    "/shows/played/weekly",
  ];

  // Genres fallback (if Trakt fetch fails)
  const GENRES_FALLBACK = [
    { slug: "action", name: "Action" },
    { slug: "adventure", name: "Adventure" },
    { slug: "animation", name: "Animation" },
    { slug: "comedy", name: "Comedy" },
    { slug: "crime", name: "Crime" },
    { slug: "documentary", name: "Documentary" },
    { slug: "drama", name: "Drama" },
    { slug: "family", name: "Family" },
    { slug: "fantasy", name: "Fantasy" },
    { slug: "history", name: "History" },
    { slug: "horror", name: "Horror" },
    { slug: "music", name: "Music" },
    { slug: "mystery", name: "Mystery" },
    { slug: "romance", name: "Romance" },
    { slug: "science-fiction", name: "Science Fiction" },
    { slug: "thriller", name: "Thriller" },
    { slug: "war", name: "War" },
    { slug: "western", name: "Western" },
  ];

  // CZ labels for common Trakt genres (used in both pickers)
  const GENRE_CS = {
    action: "Akční",
    adventure: "Dobrodružný",
    animation: "Animovaný",
    comedy: "Komedie",
    crime: "Krimi",
    documentary: "Dokumentární",
    drama: "Drama",
    family: "Rodinný",
    fantasy: "Fantasy",
    history: "Historický",
    horror: "Horor",
    music: "Hudební",
    mystery: "Mysteriózní",
    romance: "Romantický",
    "science-fiction": "Sci-fi",
    thriller: "Thriller",
    war: "Válečný",
    western: "Western",
  };

  function prettifySlug(slug) {
    const s = String(slug || "")
      .trim()
      .toLowerCase();
    if (!s) return "";
    // "science-fiction" -> "Science Fiction"
    return s
      .split("-")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function genreLabel(slug, fallbackName) {
    const s = String(slug || "")
      .trim()
      .toLowerCase();
    if (!s) return "";

    if (GENRE_CS[s]) return GENRE_CS[s];

    const fb = String(fallbackName || "").trim();
    // když Trakt name dává smysl a není to stejné jako slug, použij ho
    if (fb && fb.toLowerCase() !== s) return fb;

    // jinak aspoň “zlidšti” slug
    return prettifySlug(s);
  }

  // =========================
  // state
  // =========================
  let state = {
    lists: { defaults: { dupRules: {} }, lists: [], smartPicks: null },
    secrets: {
      trakt: { client_id: "", client_secret: "" },
      tmdb: { access_token: "", api_key: "" },
    },
  };

  let genresCache = {
    movie: { items: GENRES_FALLBACK.slice(), loaded: false, lastError: "" },
    series: { items: GENRES_FALLBACK.slice(), loaded: false, lastError: "" },
  };

  // =========================
  // API
  // =========================
  async function apiGetConfig() {
    const res = await fetch("/api/config", { headers: headersWithToken() });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error("Load failed: " + res.status + " " + txt);
    }
    return res.json();
  }

  async function apiSaveConfig(payload) {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: headersWithToken(),
      body: JSON.stringify(payload),
    });
    const txt = await res.text().catch(() => "");
    let data = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = null;
    }
    if (!res.ok)
      throw new Error(data?.error || txt || "Save failed: " + res.status);
    return data;
  }

  async function apiRestartAddon() {
    const res = await fetch("/api/restart-addon", {
      method: "POST",
      headers: headersWithToken(),
    });
    const txt = await res.text().catch(() => "");
    let data = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = null;
    }
    if (!res.ok)
      throw new Error(data?.error || txt || "Restart failed: " + res.status);
    return data;
  }

  async function apiGetTraktGenres(type) {
    const res = await fetch(
      `/api/trakt-genres?type=${encodeURIComponent(type)}`,
      {
        headers: headersWithToken(),
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error("Genres load failed: " + res.status + " " + txt);
    }
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error || "Genres load failed");
    return data;
  }

  // Update runner API (optional; only if server has it)
  async function apiRunUpdate() {
    const res = await fetch("/api/run-update", {
      method: "POST",
      headers: headersWithToken(),
    });
    const txt = await res.text().catch(() => "");
    let data = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = null;
    }
    if (!res.ok)
      throw new Error(data?.error || txt || "Run update failed: " + res.status);
    return data;
  }

  async function apiStopUpdate() {
    const res = await fetch("/api/stop-update", {
      method: "POST",
      headers: headersWithToken(),
    });
    const txt = await res.text().catch(() => "");
    let data = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = null;
    }
    if (!res.ok)
      throw new Error(
        data?.error || txt || "Stop update failed: " + res.status,
      );
    return data;
  }

  async function apiUpdateStatus() {
    const res = await fetch("/api/update-status", {
      headers: headersWithToken(),
    });
    const txt = await res.text().catch(() => "");
    let data = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = null;
    }
    if (!res.ok)
      throw new Error(
        data?.error || txt || "Update status failed: " + res.status,
      );
    return data;
  }

  // =========================
  // genres loader (shared)
  // =========================
  async function ensureGenresLoaded(type) {
    type = type === "series" ? "series" : "movie";
    const bucket = type === "series" ? genresCache.series : genresCache.movie;
    if (bucket.loaded) return;

    try {
      const data = await apiGetTraktGenres(type);
      const arr = Array.isArray(data?.genres) ? data.genres : [];
      const cleaned = arr
        .map((g) => ({
          slug: String(g.slug || "")
            .trim()
            .toLowerCase(),
          name: String(g.name || g.slug || "").trim(),
        }))
        .filter((g) => g.slug);

      if (cleaned.length) {
        cleaned.sort((a, b) => a.name.localeCompare(b.name, "en"));
        bucket.items = cleaned;
        bucket.loaded = true;
        bucket.lastError = "";
        return;
      }
      bucket.loaded = true;
      bucket.lastError = "Trakt genres empty; fallback used.";
    } catch (e) {
      bucket.loaded = true;
      bucket.lastError = String(e?.message || e);
      // keep fallback
    }
  }

  function getGenresForType(type) {
    return type === "series"
      ? genresCache.series.items || GENRES_FALLBACK
      : genresCache.movie.items || GENRES_FALLBACK;
  }

  // =========================
  // LISTS: sources + CSFD row
  // =========================
  function ensureListModeField() {
    let sel = $("f_mode");
    if (sel) return sel;

    const typeEl = $("f_type");
    if (!typeEl) return null;

    const wrap = document.createElement("label");
    wrap.className = "field";
    wrap.id = "f_mode_wrap";

    const cap = document.createElement("span");
    cap.className = "cap";
    cap.textContent = "Rezim";

    sel = document.createElement("select");
    sel.id = "f_mode";
    sel.innerHTML = `
      <option value="">Vychozi (balanced)</option>
      <option value="stable">Stable</option>
      <option value="balanced">Balanced</option>
      <option value="fresh">Fresh</option>
    `;

    wrap.appendChild(cap);
    wrap.appendChild(sel);

    const host = typeEl.closest(".formGrid") || typeEl.parentElement;
    if (host && host.appendChild) host.appendChild(wrap);
    else typeEl.insertAdjacentElement("afterend", wrap);

    return sel;
  }

  function inferSourceProviderFromPath(sourcePath) {
    const p = String(sourcePath || "")
      .trim()
      .toLowerCase();
    if (
      p.startsWith("/movie/") ||
      p.startsWith("/tv/") ||
      p.startsWith("/trending/movie/") ||
      p.startsWith("/trending/tv/") ||
      p.startsWith("/discover/movie") ||
      p.startsWith("/discover/tv")
    ) {
      return "tmdb";
    }
    return "trakt";
  }

  function normalizeListSourceEntry(entry, idx = 0) {
    const src =
      typeof entry === "string"
        ? { path: entry }
        : entry && typeof entry === "object"
          ? entry
          : null;
    if (!src) return null;

    let sourcePath = String(src.path || "").trim();
    if (!sourcePath) return null;
    if (!sourcePath.startsWith("/")) sourcePath = "/" + sourcePath;

    const providerRaw = String(src.provider || "")
      .trim()
      .toLowerCase();
    const provider = providerRaw || inferSourceProviderFromPath(sourcePath);
    if (provider !== "trakt" && provider !== "tmdb") {
      throw new Error(
        `sources[${idx}].provider musí být 'trakt' nebo 'tmdb'.`,
      );
    }

    const out = { path: sourcePath };
    if (provider === "tmdb") out.provider = "tmdb";

    const id = String(src.id || "").trim();
    if (id) out.id = id;

    if (src.weight !== undefined) {
      const weight = Number(src.weight);
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`sources[${idx}].weight musí být kladné číslo.`);
      }
      out.weight = weight;
    }

    if (src.candidatePages !== undefined) {
      const pages = Number(src.candidatePages);
      if (!Number.isFinite(pages) || pages <= 0) {
        throw new Error(`sources[${idx}].candidatePages musí být kladné číslo.`);
      }
      out.candidatePages = Math.floor(pages);
    }

    return out;
  }

  function normalizeListSourcesArray(arr) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < (arr || []).length; i++) {
      const normalized = normalizeListSourceEntry(arr[i], i);
      if (!normalized) continue;
      const provider = normalized.provider || "trakt";
      const key = `${provider}|${normalized.path}|${normalized.id || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  function ensureListSourcesJsonField() {
    let ta = $("f_sourcesJson");
    if (ta) return ta;

    const sourceEl = $("f_source");
    if (!sourceEl) return null;
    const row = sourceEl.closest(".row2");
    if (!row || !row.parentElement) return null;

    const wrap = document.createElement("div");
    wrap.id = "f_sourcesJson_wrap";
    wrap.style.marginTop = "12px";
    wrap.innerHTML = `
      <label class="small">sources[] (multi-source, per-list, volitelné)</label>
      <textarea
        id="f_sourcesJson"
        style="min-height:120px"
        placeholder='[
  {"id":"trakt_trending","path":"/movies/trending","weight":1.4,"candidatePages":5},
  {"id":"tmdb_trending_day","provider":"tmdb","path":"/trending/movie/day","weight":0.55,"candidatePages":2}
]'
      ></textarea>
      <details class="help">
        <summary>
          <span>Jak to funguje</span><span class="k">lists[].sources[]</span>
        </summary>
        <div class="helpBody">
          Zdroje se nastavují <strong>pro konkrétní list</strong>. Když necháš prázdné,
          použije se single <code>source.path</code> výše.
        </div>
      </details>
    `;

    row.insertAdjacentElement("afterend", wrap);
    ta = $("f_sourcesJson");
    return ta;
  }

  function readListSourcesFromUi() {
    const ta = ensureListSourcesJsonField();
    const raw = String(ta?.value || "").trim();
    if (!raw) return { custom: false, sources: [] };

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("sources[] musí být validní JSON pole.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("sources[] musí být JSON pole.");
    }

    const sources = normalizeListSourcesArray(parsed);
    if (!sources.length) {
      throw new Error("sources[] je prázdné nebo neplatné.");
    }
    return { custom: true, sources };
  }

  function fillSources() {
    const type = $("f_type")?.value || "movie";
    const sel = $("f_source");
    if (!sel) return;

    sel.innerHTML = "";
    const srcs = type === "series" ? SOURCES_SERIES : SOURCES_MOVIE;

    for (const s of srcs) {
      const opt = document.createElement("option");
      opt.value = s.value;
      opt.textContent = s.label;
      sel.appendChild(opt);
    }

    const csfdRow = $("csfdRow");
    if (csfdRow) csfdRow.style.display = type === "movie" ? "" : "none";
  }

  function setSelectValueEnsured(selectEl, value) {
    if (!selectEl) return;
    const v = String(value || "").trim();
    if (!v) return;
    const has = Array.from(selectEl.options || []).some((o) => o.value === v);
    if (!has) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      selectEl.appendChild(opt);
    }
    selectEl.value = v;
  }

  // =========================
  // LISTS: years slider UI
  // =========================
  const YEARS = { minYear: 1950, maxYear: 2026 };

  function initYearsUI() {
    const minR = $("yearMin");
    const maxR = $("yearMax");
    const minN = $("yearMinNum");
    const maxN = $("yearMaxNum");
    const txt = $("f_years");
    if (!minR || !maxR || !minN || !maxN || !txt) return;

    const nowYear = new Date().getFullYear();
    YEARS.minYear = 1950;
    YEARS.maxYear = clamp(nowYear + 1, 2026, 2100);

    for (const el of [minR, maxR, minN, maxN]) {
      el.min = String(YEARS.minYear);
      el.max = String(YEARS.maxYear);
      el.step = "1";
    }

    function syncToText() {
      const a = Number(minR.value);
      const b = Number(maxR.value);
      const isFull = a === YEARS.minYear && b === YEARS.maxYear;
      txt.value = isFull ? "" : `${a}-${b}`;
    }

    function setMin(v) {
      v = clamp(v, YEARS.minYear, Number(maxR.value));
      minR.value = String(v);
      minN.value = String(v);
      syncToText();
    }

    function setMax(v) {
      v = clamp(v, Number(minR.value), YEARS.maxYear);
      maxR.value = String(v);
      maxN.value = String(v);
      syncToText();
    }

    minR.addEventListener("input", () => setMin(minR.value));
    maxR.addEventListener("input", () => setMax(maxR.value));
    minN.addEventListener("input", () => setMin(minN.value));
    maxN.addEventListener("input", () => setMax(maxN.value));

    // when hidden text changes -> update sliders
    txt.addEventListener("change", () => {
      const v = String(txt.value || "").trim();
      if (!v) {
        minR.value = String(YEARS.minYear);
        maxR.value = String(YEARS.maxYear);
        minN.value = String(YEARS.minYear);
        maxN.value = String(YEARS.maxYear);
        syncToText();
        return;
      }
      const m = v.match(/^(\d{4})\s*-\s*(\d{4})$/);
      if (!m) return;
      setMin(m[1]);
      setMax(m[2]);
    });

    // init full range
    minR.value = String(YEARS.minYear);
    maxR.value = String(YEARS.maxYear);
    minN.value = String(YEARS.minYear);
    maxN.value = String(YEARS.maxYear);
    syncToText();
  }

  function syncYearsUIFromText() {
    const txt = $("f_years");
    if (!txt) return;
    txt.dispatchEvent(new Event("change"));
  }

  // =========================
  // LISTS: genres picker UI (NOW TRI-STATE like SmartPicks)
  // - include  -> filters.genres
  // - exclude  -> filters.genresExclude (new optional field)
  // =========================
  function ensureListExcludeHidden() {
    const inc = $("f_genres");
    if (!inc) return null;

    let ex = $("f_genres_exclude");
    if (ex) return ex;

    // create hidden input right after f_genres so we don't need index.html change
    ex = document.createElement("input");
    ex.type = "hidden";
    ex.id = "f_genres_exclude";
    ex.value = "";

    inc.insertAdjacentElement("afterend", ex);
    return ex;
  }

  function setListIncludeExcludeToHidden(include, exclude) {
    if ($("f_genres")) $("f_genres").value = uniqLower(include).join(",");
    const ex = ensureListExcludeHidden();
    if (ex) ex.value = uniqLower(exclude).join(",");
  }

  function readListIncludeExcludeFromHidden() {
    const include = parseCsv($("f_genres")?.value || "");
    const ex = ensureListExcludeHidden();
    const exclude = parseCsv(ex?.value || "");
    return { include, exclude };
  }

  function renderListGenresUI() {
    const box = $("genreBox");
    const searchEl = $("genreSearch");
    const hiddenInc = $("f_genres");
    if (!box || !searchEl || !hiddenInc) return;

    // ensure exclude hidden exists
    ensureListExcludeHidden();

    const type = $("f_type")?.value || "movie";
    const all = getGenresForType(type);

    const search = String(searchEl.value || "")
      .trim()
      .toLowerCase();

    const { include, exclude } = readListIncludeExcludeFromHidden();
    const setInc = new Set(include);
    const setExc = new Set(exclude);

    box.innerHTML = "";

    for (const g of all) {
      const slug = String(g.slug || "")
        .trim()
        .toLowerCase();
      if (!slug) continue;

      const display = genreLabel(slug, g.name);
      const hay = (slug + " " + String(g.name || "") + " " + display)
        .toLowerCase()
        .trim();

      if (search && !hay.includes(search)) continue;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "genreTri";

      const st = setInc.has(slug)
        ? "include"
        : setExc.has(slug)
          ? "exclude"
          : "none";

      btn.dataset.state = st;
      btn.dataset.slug = slug;

      // Show only Czech label (no slug text)
      const span = document.createElement("span");
      span.textContent = display;

      btn.appendChild(span);

      btn.addEventListener("click", () => {
        const cur = btn.dataset.state;

        if (cur === "none") {
          setInc.add(slug);
          setExc.delete(slug);
          btn.dataset.state = "include";
        } else if (cur === "include") {
          setInc.delete(slug);
          setExc.add(slug);
          btn.dataset.state = "exclude";
        } else {
          setExc.delete(slug);
          setInc.delete(slug);
          btn.dataset.state = "none";
        }

        setListIncludeExcludeToHidden(Array.from(setInc), Array.from(setExc));
        btn.blur();
      });

      box.appendChild(btn);
    }

    // keep hidden fields normalized (lowercase/unique)
    setListIncludeExcludeToHidden(Array.from(setInc), Array.from(setExc));
  }

  async function syncListGenresUI() {
    const box = $("genreBox");
    if (!box) return;
    const type = $("f_type")?.value || "movie";
    await ensureGenresLoaded(type);
    renderListGenresUI();
  }

  function initListGenresUI() {
    if (!$("genreBox") || !$("genreSearch") || !$("f_genres")) return;

    ensureListExcludeHidden();

    on("genreSearch", "input", () => renderListGenresUI());

    on("btnAddGenre", "click", () => {
      const v = String($("genreCustom")?.value || "")
        .trim()
        .toLowerCase();
      if (!v) return;

      const { include, exclude } = readListIncludeExcludeFromHidden();
      include.push(v);

      // if user manually adds something that was excluded -> move to include
      const exSet = new Set(exclude);
      exSet.delete(v);

      setListIncludeExcludeToHidden(include, Array.from(exSet));

      if ($("genreCustom")) $("genreCustom").value = "";
      renderListGenresUI();
    });

    on("btnClearGenres", "click", () => {
      setListIncludeExcludeToHidden([], []);
      renderListGenresUI();
    });

    // if user edits hidden CSV manually (rare), keep UI in sync
    on("f_genres", "input", () => renderListGenresUI());
    on("f_genres_exclude", "input", () => renderListGenresUI());
  }

  // =========================
  // Defaults + Secrets
  // =========================
  function readDefaultsFromUI() {
    state.lists.defaults = state.lists.defaults || {};
    state.lists.defaults.dupRules = state.lists.defaults.dupRules || {};

    state.lists.defaults.candidatePages = Number(
      $("d_candidatePages")?.value || 5,
    );
    state.lists.defaults.pageLimit = Number($("d_pageLimit")?.value || 100);
    state.lists.defaults.finalSize = Number($("d_finalSize")?.value || 140);
    state.lists.defaults.sleepMs = Number($("d_sleepMs")?.value || 120);
    state.lists.defaults.timeoutMs = Number($("d_timeoutMs")?.value || 15000);
    state.lists.defaults.csfdCacheTtlDays = Number($("d_csfdTtl")?.value || 30);

    state.lists.defaults.dupRules.hardBlockTop = Number(
      $("d_hardTop")?.value || 45,
    );
    state.lists.defaults.dupRules.penaltyPerHit = Number(
      $("d_penalty")?.value || 80,
    );
  }

  function writeDefaultsToUI() {
    const d = state.lists.defaults || {};
    const dr = d.dupRules || {};

    if ($("d_candidatePages"))
      $("d_candidatePages").value = d.candidatePages ?? 5;
    if ($("d_pageLimit")) $("d_pageLimit").value = d.pageLimit ?? 100;
    if ($("d_finalSize")) $("d_finalSize").value = d.finalSize ?? 140;
    if ($("d_sleepMs")) $("d_sleepMs").value = d.sleepMs ?? 120;
    if ($("d_timeoutMs")) $("d_timeoutMs").value = d.timeoutMs ?? 15000;
    if ($("d_csfdTtl")) $("d_csfdTtl").value = d.csfdCacheTtlDays ?? 30;

    if ($("d_hardTop")) $("d_hardTop").value = dr.hardBlockTop ?? 45;
    if ($("d_penalty")) $("d_penalty").value = dr.penaltyPerHit ?? 80;
  }

  function writeSecretsToUI() {
    if ($("traktId"))
      $("traktId").value = state.secrets?.trakt?.client_id ?? "";
    if ($("traktSecret"))
      $("traktSecret").value = state.secrets?.trakt?.client_secret ?? "";
    if ($("tmdbToken"))
      $("tmdbToken").value =
        state.secrets?.tmdb?.access_token ?? state.secrets?.tmdb?.bearer_token ?? "";
    if ($("tmdbApiKey"))
      $("tmdbApiKey").value = state.secrets?.tmdb?.api_key ?? "";
  }

  function readSecretsFromUI() {
    state.secrets = state.secrets || {};
    state.secrets.trakt = state.secrets.trakt || {};
    state.secrets.tmdb = state.secrets.tmdb || {};
    state.secrets.trakt.client_id = String($("traktId")?.value || "");
    state.secrets.trakt.client_secret = String($("traktSecret")?.value || "");
    state.secrets.tmdb.access_token = String($("tmdbToken")?.value || "");
    state.secrets.tmdb.api_key = String($("tmdbApiKey")?.value || "");
    if (!state.secrets.tmdb.access_token && !state.secrets.tmdb.api_key) {
      delete state.secrets.tmdb;
    }
  }

  // =========================
  // Lists table + editor
  // =========================
  function formatListGenresCell(filters) {
    const inc = String(filters?.genres || "").trim();
    const exc = String(filters?.genresExclude || "").trim();
    if (inc && exc) return `+${inc}  |  -${exc}`;
    if (exc) return `-${exc}`;
    return inc || "";
  }

  function renderListsTable() {
    const pill = $("countPill");
    if (pill) pill.textContent = String(state.lists.lists.length);

    const body = $("tblBody");
    if (!body) return;

    body.innerHTML = "";

    for (const x of state.lists.lists) {
      const tr = document.createElement("tr");

      function td(text, cls) {
        const c = document.createElement("td");
        if (cls) c.className = cls;
        c.textContent = text === undefined || text === null ? "" : String(text);
        return c;
      }

      tr.appendChild(td(x.id, "mono"));
      tr.appendChild(td(x.name));
      tr.appendChild(td(x.type));
      tr.appendChild(
        td(
          x.source?.path ||
            (Array.isArray(x.sources) && x.sources[0]?.path
              ? x.sources[0].path
              : ""),
          "mono",
        ),
      );
      tr.appendChild(td(x.filters?.years || ""));
      tr.appendChild(td(formatListGenresCell(x.filters || {}), "mono"));

      const action = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "tableBtn";
      btn.type = "button";
      btn.textContent = "Edit";
      btn.addEventListener("click", () => loadListToForm(x.id));
      action.appendChild(btn);

      tr.appendChild(action);
      body.appendChild(tr);
    }
  }

  function upsertList() {
    const id = String($("f_id")?.value || "").trim();
    const name = String($("f_name")?.value || "").trim();
    const type = $("f_type")?.value || "movie";
    const mode = String(ensureListModeField()?.value || "")
      .trim()
      .toLowerCase();

    if (!id || !name) {
      alert("Vyplň id a name.");
      return;
    }

    const collidesWithProfile = (state.lists?.smartPicks?.profiles || []).some(
      (p) => String(p?.id || "").trim() === id,
    );
    if (collidesWithProfile) {
      alert(
        `ID koliduje se SmartPicks profilem (${id}). Pouzij jine id listu.`,
      );
      return;
    }

    const sourcePathUi = String($("f_source")?.value || "").trim();
    const obj = {
      id,
      name,
      type,
      source: { path: sourcePathUi },
      filters: {},
    };

    let listSources = { custom: false, sources: [] };
    try {
      listSources = readListSourcesFromUi();
    } catch (e) {
      alert(String(e?.message || e));
      return;
    }
    if (listSources.custom && listSources.sources.length) {
      obj.sources = listSources.sources;
      obj.source = { path: listSources.sources[0].path };
    }

    if (mode === "stable" || mode === "balanced" || mode === "fresh") {
      obj.mode = mode;
    }

    const years = String($("f_years")?.value || "").trim();
    if (years) obj.filters.years = years;

    // genres include/exclude
    const inc = String($("f_genres")?.value || "").trim();
    const exEl = ensureListExcludeHidden();
    const exc = String(exEl?.value || "").trim();

    if (inc) obj.filters.genres = inc;
    if (exc) obj.filters.genresExclude = exc;

    // overrides
    const overrides = {
      candidatePages: numOrUndef($("f_candidatePages")?.value),
      pageLimit: numOrUndef($("f_pageLimit")?.value),
      finalSize: numOrUndef($("f_finalSize")?.value),
      sleepMs: numOrUndef($("f_sleepMs")?.value),
      timeoutMs: numOrUndef($("f_timeoutMs")?.value),
    };
    for (const k in overrides)
      if (overrides[k] !== undefined) obj[k] = overrides[k];

    const hardTop = numOrUndef($("f_hardTop")?.value);
    const penalty = numOrUndef($("f_penalty")?.value);
    if (hardTop !== undefined || penalty !== undefined) {
      obj.dupRules = {};
      if (hardTop !== undefined) obj.dupRules.hardBlockTop = hardTop;
      if (penalty !== undefined) obj.dupRules.penaltyPerHit = penalty;
    }

    if (type === "movie") {
      const minR = numOrUndef($("f_minRating")?.value);
      const minC = numOrUndef($("f_minCount")?.value);
      const maxC = numOrUndef($("f_maxCount")?.value);
      if (minR !== undefined || minC !== undefined || maxC !== undefined) {
        obj.csfdRules = {};
        if (minR !== undefined) obj.csfdRules.minRating = minR;
        if (minC !== undefined) obj.csfdRules.minCount = minC;
        if (maxC !== undefined) obj.csfdRules.maxCount = maxC;
      }
    }

    const idx = state.lists.lists.findIndex((x) => x.id === id);
    if (idx >= 0) {
      const prev = state.lists.lists[idx] || {};
      const preserved = {};
      for (const k of [
        "mode",
        "sources",
        "stability",
        "diversity",
        "novelty",
        "sourcePolicy",
        "debugItems",
      ]) {
        if (prev[k] !== undefined) preserved[k] = prev[k];
      }
      state.lists.lists[idx] = { ...preserved, ...obj };
    } else {
      state.lists.lists.push(obj);
    }

    renderListsTable();
    renderSmartPicksSourcesUI(); // lists -> smartpicks list pickers
    setStatus("list uložen v UI");
    alert("List uložen v UI (nezapomeň „Uložit vše na disk“).");
  }

  function deleteList() {
    const id = String($("f_id")?.value || "").trim();
    if (!id) return;
    state.lists.lists = state.lists.lists.filter((x) => x.id !== id);
    renderListsTable();
    renderSmartPicksSourcesUI();
    setStatus("list smazán v UI");
  }

  async function clearListForm() {
    if ($("f_id")) $("f_id").value = "";
    if ($("f_name")) $("f_name").value = "";
    if ($("f_type")) $("f_type").value = "movie";
    if (ensureListModeField()) ensureListModeField().value = "";

    fillSources();
    if ($("f_source")) $("f_source").value = SOURCES_MOVIE[0].value;
    if (ensureListSourcesJsonField()) ensureListSourcesJsonField().value = "";

    if ($("f_years")) $("f_years").value = "";

    // clear include/exclude
    setListIncludeExcludeToHidden([], []);

    if ($("genreSearch")) $("genreSearch").value = "";
    if ($("genreCustom")) $("genreCustom").value = "";

    const ids = [
      "candidatePages",
      "pageLimit",
      "finalSize",
      "sleepMs",
      "timeoutMs",
      "hardTop",
      "penalty",
      "minRating",
      "minCount",
      "maxCount",
    ];
    for (const k of ids) {
      const el = $("f_" + k);
      if (el) el.value = "";
    }

    syncYearsUIFromText();
    await syncListGenresUI();
  }

  async function loadListToForm(id) {
    const x = state.lists.lists.find((z) => z.id === id);
    if (!x) return;

    if ($("f_id")) $("f_id").value = x.id || "";
    if ($("f_name")) $("f_name").value = x.name || "";
    if ($("f_type")) $("f_type").value = x.type || "movie";
    if (ensureListModeField()) {
      const m = String(x.mode || "")
        .trim()
        .toLowerCase();
      ensureListModeField().value =
        m === "stable" || m === "balanced" || m === "fresh" ? m : "";
    }

    fillSources();
    const normalizedSources = normalizeListSourcesArray(
      Array.isArray(x.sources) ? x.sources : [],
    );
    if (ensureListSourcesJsonField()) {
      ensureListSourcesJsonField().value = normalizedSources.length
        ? JSON.stringify(normalizedSources, null, 2)
        : "";
    }
    if ($("f_source")) {
      const fallback =
        x.type === "series" ? SOURCES_SERIES[0].value : SOURCES_MOVIE[0].value;
      const selectedPath =
        x.source?.path ||
        (normalizedSources.length ? normalizedSources[0].path : "") ||
        fallback;
      setSelectValueEnsured($("f_source"), selectedPath);
    }

    if ($("f_years")) $("f_years").value = x.filters?.years || "";

    // include/exclude
    const inc = x.filters?.genres || "";
    const exc = x.filters?.genresExclude || "";
    setListIncludeExcludeToHidden(parseCsv(inc), parseCsv(exc));

    if ($("f_candidatePages"))
      $("f_candidatePages").value = x.candidatePages ?? "";
    if ($("f_pageLimit")) $("f_pageLimit").value = x.pageLimit ?? "";
    if ($("f_finalSize")) $("f_finalSize").value = x.finalSize ?? "";
    if ($("f_sleepMs")) $("f_sleepMs").value = x.sleepMs ?? "";
    if ($("f_timeoutMs")) $("f_timeoutMs").value = x.timeoutMs ?? "";

    if ($("f_hardTop")) $("f_hardTop").value = x.dupRules?.hardBlockTop ?? "";
    if ($("f_penalty")) $("f_penalty").value = x.dupRules?.penaltyPerHit ?? "";

    if ($("f_minRating")) $("f_minRating").value = x.csfdRules?.minRating ?? "";
    if ($("f_minCount")) $("f_minCount").value = x.csfdRules?.minCount ?? "";
    if ($("f_maxCount")) $("f_maxCount").value = x.csfdRules?.maxCount ?? "";

    syncYearsUIFromText();
    await syncListGenresUI();
  }

  // =========================
  // SmartPicks normalization (IMPORTANT)
  // We always SAVE legacy format:
  //   fromTrakt[], fromLists[], filters{years,genres,genresExclude}, + (optional csfdRules)
  // =========================
  function ensureSmartPicksExists() {
    if (!state.lists.smartPicks || typeof state.lists.smartPicks !== "object") {
      state.lists.smartPicks = { enabled: true, defaultSize: 10, profiles: [] };
    }
    if (!Array.isArray(state.lists.smartPicks.profiles))
      state.lists.smartPicks.profiles = [];
    if (typeof state.lists.smartPicks.enabled !== "boolean")
      state.lists.smartPicks.enabled = true;

    const ds = Number(state.lists.smartPicks.defaultSize);
    state.lists.smartPicks.defaultSize =
      Number.isFinite(ds) && ds >= 1 ? ds : 10;

    // normalize existing profiles (best-effort)
    state.lists.smartPicks.profiles = state.lists.smartPicks.profiles
      .filter((p) => p && typeof p === "object")
      .map((p) => normalizeSmartPickProfileOnRead(p));
  }

  function smartPickDefaultProfile() {
    return {
      id: "",
      name: "",
      type: "movie",
      size: 10,
      // UI view model
      years: "",
      sources: { traktPaths: [], listIds: [] },
      includeGenres: [],
      excludeGenres: [],
      // legacy disk model
      fromTrakt: [],
      fromLists: [],
      filters: {},
    };
  }

  // Read any shape from disk -> UI model (and keep legacy fields populated too)
  function normalizeSmartPickProfileOnRead(p) {
    const out = { ...(p || {}) };

    out.id = safeStr(out.id).trim();
    out.name = safeStr(out.name).trim();

    const t = safeStr(out.type).trim().toLowerCase();
    out.type =
      t === "series" || t === "show" || t === "shows" ? "series" : "movie";

    const sz = Number(out.size);
    out.size = Number.isFinite(sz) && sz >= 1 ? sz : 10;

    // Legacy sources
    const fromTrakt = Array.isArray(out.fromTrakt)
      ? out.fromTrakt
          .map(safeStr)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const fromLists = Array.isArray(out.fromLists)
      ? out.fromLists
          .map(safeStr)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // "New-ish" sources (if present from past)
    const sTrakt = Array.isArray(out?.sources?.traktPaths)
      ? out.sources.traktPaths
          .map(safeStr)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const sLists = Array.isArray(out?.sources?.listIds)
      ? out.sources.listIds
          .map(safeStr)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const traktPaths = fromTrakt.length ? fromTrakt : sTrakt;
    const listIds = fromLists.length ? fromLists : sLists;

    out.sources = { traktPaths, listIds };

    // Legacy filters
    const filters =
      out.filters && typeof out.filters === "object" ? out.filters : {};
    const years = safeStr(filters.years || out.years || "").trim();
    out.years = years;

    // Genres:
    // - legacy: filters.genres CSV (include) + filters.genresExclude CSV (exclude)
    // - new-ish: includeGenres/excludeGenres arrays
    let include = Array.isArray(out.includeGenres) ? out.includeGenres : null;
    let exclude = Array.isArray(out.excludeGenres) ? out.excludeGenres : null;

    if (!include) include = parseCsv(filters.genres || "");
    else include = uniqLower(include);

    if (!exclude) {
      exclude = parseCsv(filters.genresExclude || filters.excludeGenres || "");
    } else {
      exclude = uniqLower(exclude);
    }

    // safety: if something is both include+exclude -> keep include
    const incSet = new Set(include);
    exclude = (exclude || []).filter((g) => !incSet.has(g));

    out.includeGenres = include;
    out.excludeGenres = exclude;

    // Rebuild legacy fields so they're always present in state
    out.fromTrakt = traktPaths.slice();
    out.fromLists = listIds.slice();
    out.filters = { ...(filters || {}) };
    if (years) out.filters.years = years;
    else delete out.filters.years;

    const incCsv = include.length ? include.join(",") : "";
    if (incCsv) out.filters.genres = incCsv;
    else delete out.filters.genres;

    const exCsv = exclude.length ? exclude.join(",") : "";
    if (exCsv) out.filters.genresExclude = exCsv;
    else delete out.filters.genresExclude;

    return out;
  }

  // Save UI model -> legacy disk model
  function toLegacySmartPickProfile(uiProfile, existingOnDisk) {
    const base =
      existingOnDisk && typeof existingOnDisk === "object"
        ? { ...existingOnDisk }
        : {};

    // Preserve unknown fields + csfdRules if present
    const out = { ...base };

    out.id = safeStr(uiProfile.id).trim();
    out.name = safeStr(uiProfile.name).trim();

    const t = safeStr(uiProfile.type).trim().toLowerCase();
    out.type = t === "series" ? "series" : "movie";

    const sz = Number(uiProfile.size);
    out.size = Number.isFinite(sz) && sz >= 1 ? sz : Number(out.size) || 10;

    // Sources
    const traktPaths = Array.isArray(uiProfile?.sources?.traktPaths)
      ? uiProfile.sources.traktPaths
          .map(safeStr)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const listIds = Array.isArray(uiProfile?.sources?.listIds)
      ? uiProfile.sources.listIds
          .map(safeStr)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    out.fromTrakt = traktPaths.slice();
    out.fromLists = listIds.slice();

    // Filters: years + include/exclude genres as CSV (legacy stable)
    out.filters =
      out.filters && typeof out.filters === "object" ? { ...out.filters } : {};
    const years = safeStr(uiProfile.years).trim();
    if (years) out.filters.years = years;
    else delete out.filters.years;

    const include = Array.isArray(uiProfile.includeGenres)
      ? uniqLower(uiProfile.includeGenres)
      : [];

    const excludeRaw = Array.isArray(uiProfile.excludeGenres)
      ? uniqLower(uiProfile.excludeGenres)
      : [];

    // safety: exclude can't contain included
    const incSet = new Set(include);
    const exclude = excludeRaw.filter((g) => !incSet.has(g));

    const incCsv = include.length ? include.join(",") : "";
    if (incCsv) out.filters.genres = incCsv;
    else delete out.filters.genres;

    const exCsv = exclude.length ? exclude.join(",") : "";
    if (exCsv) out.filters.genresExclude = exCsv;
    else delete out.filters.genresExclude;

    // Remove UI-only fields
    delete out.sources;
    delete out.years;
    delete out.includeGenres;
    delete out.excludeGenres;

    if (!out.filters || typeof out.filters !== "object") out.filters = {};
    if (Object.keys(out.filters).length === 0) out.filters = {};

    return out;
  }

  function writeSmartPicksTopToUI() {
    if (!$("sp_enabled")) return;
    ensureSmartPicksExists();
    $("sp_enabled").checked = !!state.lists.smartPicks.enabled;
    if ($("sp_defaultSize"))
      $("sp_defaultSize").value = String(
        state.lists.smartPicks.defaultSize ?? 10,
      );
  }

  function readSmartPicksTopFromUI() {
    if (!$("sp_enabled")) return;
    ensureSmartPicksExists();
    state.lists.smartPicks.enabled = !!$("sp_enabled").checked;

    const n = Number($("sp_defaultSize")?.value || 10);
    state.lists.smartPicks.defaultSize = Number.isFinite(n) && n >= 1 ? n : 10;
  }

  function getSpTraktSeeds(type) {
    return type === "series" ? SP_TRAKT_SERIES : SP_TRAKT_MOVIE;
  }

  function setSpIncludeExcludeToHidden(include, exclude) {
    if ($("sp_includeGenres"))
      $("sp_includeGenres").value = uniqLower(include).join(",");
    if ($("sp_excludeGenres"))
      $("sp_excludeGenres").value = uniqLower(exclude).join(",");
  }

  function readSpIncludeExcludeFromHidden() {
    const include = parseCsv($("sp_includeGenres")?.value || "");
    const exclude = parseCsv($("sp_excludeGenres")?.value || "");
    return { include, exclude };
  }

  // =========================
  // SmartPicks years slider UI (same UX as lists)
  // =========================
  const SP_YEARS = { minYear: 1950, maxYear: 2026 };

  function initSpYearsUI() {
    const minR = $("spYearMin");
    const maxR = $("spYearMax");
    const minN = $("spYearMinNum");
    const maxN = $("spYearMaxNum");
    const hidden = $("sp_years");

    if (!minR || !maxR || !minN || !maxN || !hidden) return;

    const nowYear = new Date().getFullYear();
    SP_YEARS.minYear = 1950;
    SP_YEARS.maxYear = clamp(nowYear + 1, 2026, 2100);

    for (const el of [minR, maxR, minN, maxN]) {
      el.min = String(SP_YEARS.minYear);
      el.max = String(SP_YEARS.maxYear);
      el.step = "1";
    }

    function syncHiddenFromSliders() {
      const a = Number(minR.value);
      const b = Number(maxR.value);
      const isFull = a === SP_YEARS.minYear && b === SP_YEARS.maxYear;
      hidden.value = isFull ? "" : `${a}-${b}`;
    }

    function setMin(v) {
      v = clamp(v, SP_YEARS.minYear, Number(maxR.value));
      minR.value = String(v);
      minN.value = String(v);
      syncHiddenFromSliders();
    }

    function setMax(v) {
      v = clamp(v, Number(minR.value), SP_YEARS.maxYear);
      maxR.value = String(v);
      maxN.value = String(v);
      syncHiddenFromSliders();
    }

    minR.addEventListener("input", () => setMin(minR.value));
    maxR.addEventListener("input", () => setMax(maxR.value));
    minN.addEventListener("input", () => setMin(minN.value));
    maxN.addEventListener("input", () => setMax(maxN.value));

    hidden.addEventListener("change", () => {
      const v = String(hidden.value || "").trim();
      if (!v) {
        minR.value = String(SP_YEARS.minYear);
        maxR.value = String(SP_YEARS.maxYear);
        minN.value = String(SP_YEARS.minYear);
        maxN.value = String(SP_YEARS.maxYear);
        syncHiddenFromSliders();
        return;
      }
      const m = v.match(/^(\d{4})\s*-\s*(\d{4})$/);
      if (!m) return;
      setMin(m[1]);
      setMax(m[2]);
    });

    minR.value = String(SP_YEARS.minYear);
    maxR.value = String(SP_YEARS.maxYear);
    minN.value = String(SP_YEARS.minYear);
    maxN.value = String(SP_YEARS.maxYear);
    syncHiddenFromSliders();
  }

  function syncSpYearsUIFromHidden() {
    const hidden = $("sp_years");
    const minR = $("spYearMin");
    if (hidden && minR) hidden.dispatchEvent(new Event("change"));
  }

  function resetSpYearsUI() {
    const hidden = $("sp_years");
    if (!hidden) return;
    hidden.value = "";
    syncSpYearsUIFromHidden();
  }

  // =========================
  // SmartPicks UI: table + editor
  // =========================
  function getProfileSourceSummary(p) {
    const tp = Array.isArray(p?.fromTrakt) ? p.fromTrakt.length : 0;
    const li = Array.isArray(p?.fromLists) ? p.fromLists.length : 0;
    return `${tp}× Trakt + ${li}× list`;
  }

  function renderSmartPicksTable() {
    const body = $("sp_tblBody");
    const pill = $("sp_countPill");
    if (!body) return;

    ensureSmartPicksExists();
    if (pill) pill.textContent = String(state.lists.smartPicks.profiles.length);

    body.innerHTML = "";

    for (const p of state.lists.smartPicks.profiles) {
      const tr = document.createElement("tr");

      function td(text, cls) {
        const c = document.createElement("td");
        if (cls) c.className = cls;
        c.textContent = text === undefined || text === null ? "" : String(text);
        return c;
      }

      tr.appendChild(td(p.id || "", "mono"));
      tr.appendChild(td(p.name || ""));
      tr.appendChild(td(p.type || ""));
      tr.appendChild(td(p.size ?? ""));
      tr.appendChild(td(getProfileSourceSummary(p)));

      const action = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "tableBtn";
      btn.type = "button";
      btn.textContent = "Edit";
      btn.addEventListener("click", () => loadSmartPickToForm(p.id));
      action.appendChild(btn);
      tr.appendChild(action);

      body.appendChild(tr);
    }
  }

  // UI form -> UI model (not legacy yet)
  function getSmartPickFromForm(validate = true) {
    if (!$("sp_id")) return null;

    const id = String($("sp_id").value || "").trim();
    const name = String($("sp_name").value || "").trim();
    const type = String($("sp_type").value || "movie").trim();
    const size = Number(
      $("sp_size")?.value || state.lists.smartPicks?.defaultSize || 10,
    );
    const years = String($("sp_years")?.value || "").trim();

    if (validate) {
      if (!id) throw new Error("SmartPicks profil: chybí ID.");
      if (!name) throw new Error("SmartPicks profil: chybí název.");
      if (!["movie", "series"].includes(type))
        throw new Error("SmartPicks profil: typ musí být movie/series.");
      if (!Number.isFinite(size) || size < 1)
        throw new Error("SmartPicks profil: počet musí být číslo >= 1.");
      if (years && !/^(\d{4})\s*-\s*(\d{4})$/.test(years))
        throw new Error(
          "SmartPicks profil: roky musí být ve formátu YYYY-YYYY nebo prázdné.",
        );
    }

    const traktPaths = Array.from(
      document.querySelectorAll('#sp_src_trakt input[type="checkbox"]:checked'),
    )
      .map((cb) => String(cb.value || "").trim())
      .filter(Boolean);

    const listIds = Array.from(
      document.querySelectorAll('#sp_src_lists input[type="checkbox"]:checked'),
    )
      .map((cb) => String(cb.value || "").trim())
      .filter(Boolean);

    const { include, exclude } = readSpIncludeExcludeFromHidden();

    return {
      id,
      name,
      type,
      size,
      years,
      sources: { traktPaths, listIds },
      includeGenres: include,
      excludeGenres: exclude,
    };
  }

  function renderSmartPicksSourcesUI() {
    const boxTrakt = $("sp_src_trakt");
    if (!boxTrakt) return;

    const type = $("sp_type")?.value || "movie";
    const seeds = getSpTraktSeeds(type);

    const curProfile = getSmartPickFromForm(false) || smartPickDefaultProfile();
    const selectedTrakt = new Set(
      (curProfile?.sources?.traktPaths || []).map(String),
    );

    boxTrakt.innerHTML = "";

    for (const p of seeds) {
      const label = document.createElement("label");
      label.className = "chip";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p;
      cb.checked = selectedTrakt.has(p);

      const span = document.createElement("span");
      span.className = "mono";
      span.textContent = p;

      label.appendChild(cb);
      label.appendChild(span);
      boxTrakt.appendChild(label);
    }

    // lists (by type)
    const boxLists = $("sp_src_lists");
    if (!boxLists) return;

    boxLists.innerHTML = "";

    const listIds = (state.lists.lists || [])
      .filter((l) => (l.type || "movie") === type)
      .map((l) => ({ id: l.id, name: l.name }));

    const selectedListIds = new Set(
      (curProfile?.sources?.listIds || []).map(String),
    );

    if (!listIds.length) {
      const p = document.createElement("div");
      p.className = "muted";
      p.textContent = "Žádné listy tohoto typu zatím nemáš.";
      boxLists.appendChild(p);
      return;
    }

    for (const li of listIds) {
      const row = document.createElement("label");
      row.className = "chkRow";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = li.id;
      cb.checked = selectedListIds.has(li.id);

      const txt = document.createElement("span");
      txt.textContent = `${li.name} (${li.id})`;

      row.appendChild(cb);
      row.appendChild(txt);
      boxLists.appendChild(row);
    }
  }

  async function renderSmartPicksGenresUI() {
    const box = $("sp_genreBox");
    if (!box) return;

    const type = $("sp_type")?.value || "movie";
    await ensureGenresLoaded(type);

    const all = getGenresForType(type);
    const search = String($("sp_genreSearch")?.value || "")
      .trim()
      .toLowerCase();

    const { include, exclude } = readSpIncludeExcludeFromHidden();
    const setInc = new Set(include);
    const setExc = new Set(exclude);

    box.innerHTML = "";

    for (const g of all) {
      const slug = String(g.slug || "").toLowerCase();
      const display = genreLabel(slug, g.name);
      const hay = (slug + " " + String(g.name || "") + " " + display)
        .toLowerCase()
        .trim();
      if (search && !hay.includes(search)) continue;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "genreTri";

      const st = setInc.has(slug)
        ? "include"
        : setExc.has(slug)
          ? "exclude"
          : "none";

      btn.dataset.state = st;
      btn.dataset.slug = slug;

      // show CZ label only (no slug text)
      const span = document.createElement("span");
      span.textContent = display;

      btn.appendChild(span);

      btn.addEventListener("click", () => {
        const cur = btn.dataset.state;
        if (cur === "none") {
          setInc.add(slug);
          setExc.delete(slug);
          btn.dataset.state = "include";
        } else if (cur === "include") {
          setInc.delete(slug);
          setExc.add(slug);
          btn.dataset.state = "exclude";
        } else {
          setExc.delete(slug);
          setInc.delete(slug);
          btn.dataset.state = "none";
        }

        setSpIncludeExcludeToHidden(Array.from(setInc), Array.from(setExc));
        btn.blur();
      });

      box.appendChild(btn);
    }

    // keep hidden normalized + safety (exclude can't contain include)
    const incArr = Array.from(setInc);
    const incSet = new Set(incArr);
    const excArr = Array.from(setExc).filter((g) => !incSet.has(g));
    setSpIncludeExcludeToHidden(incArr, excArr);
  }

  function clearSmartPickForm() {
    if (!$("sp_id")) return;

    const p = smartPickDefaultProfile();
    $("sp_id").value = p.id;
    $("sp_name").value = p.name;
    $("sp_type").value = p.type;
    $("sp_size").value = String(p.size);

    if ($("sp_years")) $("sp_years").value = "";
    resetSpYearsUI();

    if ($("sp_customSource")) $("sp_customSource").value = "";
    if ($("sp_genreSearch")) $("sp_genreSearch").value = "";

    setSpIncludeExcludeToHidden([], []);
    renderSmartPicksSourcesUI();
    renderSmartPicksGenresUI();
  }

  function loadSmartPickToForm(profileId) {
    ensureSmartPicksExists();
    const raw = state.lists.smartPicks.profiles.find((x) => x.id === profileId);
    if (!raw) return;

    const p = normalizeSmartPickProfileOnRead(raw);

    $("sp_id").value = p.id || "";
    $("sp_name").value = p.name || "";
    $("sp_type").value = p.type || "movie";
    $("sp_size").value = String(
      p.size ?? state.lists.smartPicks.defaultSize ?? 10,
    );

    if ($("sp_years")) $("sp_years").value = p.years || "";
    syncSpYearsUIFromHidden();

    setSpIncludeExcludeToHidden(p.includeGenres || [], p.excludeGenres || []);
    renderSmartPicksSourcesUI();
    renderSmartPicksGenresUI();
  }

  function upsertSmartPickProfile() {
    ensureSmartPicksExists();

    const uiProfile = getSmartPickFromForm(true);
    const collidesWithList = (state.lists?.lists || []).some(
      (l) => String(l?.id || "").trim() === uiProfile.id,
    );
    if (collidesWithList) {
      throw new Error(
        `ID koliduje s beznym listem (${uiProfile.id}). Pouzij jine id profilu.`,
      );
    }

    // find existing (to preserve csfdRules + unknown fields)
    const idx = state.lists.smartPicks.profiles.findIndex(
      (x) => x.id === uiProfile.id,
    );
    const existing = idx >= 0 ? state.lists.smartPicks.profiles[idx] : null;

    // Convert to LEGACY disk model (stable)
    const legacy = toLegacySmartPickProfile(uiProfile, existing);

    if (idx >= 0) state.lists.smartPicks.profiles[idx] = legacy;
    else state.lists.smartPicks.profiles.push(legacy);

    renderSmartPicksTable();
    setStatus("SmartPicks profil uložen v UI");
    alert("SmartPicks profil uložen v UI (nezapomeň uložit na disk).");
  }

  function deleteSmartPickProfile() {
    ensureSmartPicksExists();
    const id = String($("sp_id")?.value || "").trim();
    if (!id) return;

    state.lists.smartPicks.profiles = state.lists.smartPicks.profiles.filter(
      (p) => p.id !== id,
    );
    renderSmartPicksTable();
    clearSmartPickForm();
    setStatus("SmartPicks profil smazán v UI");
  }

  function sortSmartPicksProfiles() {
    ensureSmartPicksExists();
    state.lists.smartPicks.profiles.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "cs"),
    );
    renderSmartPicksTable();
  }

  function renderSmartPicksAll() {
    if (!$("sp_enabled")) return;
    ensureSmartPicksExists();
    writeSmartPicksTopToUI();
    renderSmartPicksTable();
    renderSmartPicksSourcesUI();
    renderSmartPicksGenresUI();
  }

  // =========================
  // Load / Save
  // =========================
  function collectProfileListRefs(profile) {
    const legacy = Array.isArray(profile?.fromLists) ? profile.fromLists : [];
    const modern = Array.isArray(profile?.sources?.listIds)
      ? profile.sources.listIds
      : [];

    return Array.from(
      new Set(
        [...legacy, ...modern]
          .map((x) => String(x || "").trim())
          .filter(Boolean),
      ),
    );
  }

  function validateStateBeforeSave() {
    const lists = Array.isArray(state.lists?.lists) ? state.lists.lists : [];
    const profiles = Array.isArray(state.lists?.smartPicks?.profiles)
      ? state.lists.smartPicks.profiles
      : [];

    const listIds = new Set();
    for (const l of lists) {
      const id = String(l?.id || "").trim();
      if (!id) throw new Error("List ma prazdne id.");
      if (listIds.has(id)) throw new Error(`Duplicitni list id: ${id}.`);
      listIds.add(id);
    }

    const profileIds = new Set();
    for (const p of profiles) {
      const pid = String(p?.id || "").trim();
      if (!pid) throw new Error("SmartPicks profil ma prazdne id.");
      if (profileIds.has(pid))
        throw new Error(`Duplicitni SmartPicks profil id: ${pid}.`);
      if (listIds.has(pid))
        throw new Error(`Kolize id: ${pid} je v lists i smartPicks.`);

      const refs = collectProfileListRefs(p);
      for (const ref of refs) {
        if (!listIds.has(ref))
          throw new Error(
            `SmartPicks ${pid} odkazuje na neexistujici list '${ref}'.`,
          );
      }

      profileIds.add(pid);
    }
  }

  async function loadFromDisk() {
    setStatus("loading…");
    const data = await apiGetConfig();

    state.lists = data.lists || { defaults: { dupRules: {} }, lists: [] };
    state.secrets = data.secrets || {
      trakt: { client_id: "", client_secret: "" },
      tmdb: { access_token: "", api_key: "" },
    };
    state.secrets.trakt = state.secrets.trakt || {
      client_id: "",
      client_secret: "",
    };
    state.secrets.tmdb = state.secrets.tmdb || {
      access_token: "",
      api_key: "",
    };

    state.lists.defaults = state.lists.defaults || {};
    state.lists.defaults.dupRules = state.lists.defaults.dupRules || {};
    state.lists.lists = Array.isArray(state.lists.lists)
      ? state.lists.lists
      : [];

    ensureSmartPicksExists();

    writeDefaultsToUI();
    writeSecretsToUI();

    renderListsTable();
    renderSmartPicksAll();

    syncYearsUIFromText();
    await syncListGenresUI();

    setStatus("loaded from disk");
  }

  async function saveToDisk() {
    readDefaultsFromUI();
    readSecretsFromUI();

    readSmartPicksTopFromUI();
    ensureSmartPicksExists();

    setStatus("saving…");
    validateStateBeforeSave();
    const resp = await apiSaveConfig({
      lists: state.lists,
      secrets: state.secrets,
    });

    setStatus(
      "saved: " +
        (resp?.wrote?.lists || "lists.trakt.json") +
        " + " +
        (resp?.wrote?.secrets || "secrets.json"),
    );
  }

  // =========================
  // Demo (UI only)
  // =========================
  function loadDemoIntoUIOnly() {
    state.lists = {
      defaults: {
        candidatePages: 5,
        pageLimit: 100,
        finalSize: 140,
        sleepMs: 120,
        timeoutMs: 15000,
        csfdCacheTtlDays: 30,
        dupRules: { hardBlockTop: 45, penaltyPerHit: 80 },
      },
      lists: [
        {
          id: "vhs_era",
          name: "VHS éra (1985–2000)",
          type: "movie",
          source: { path: "/movies/watched/all" },
          filters: {
            years: "1985-2000",
            genres: "action,thriller,crime",
            genresExclude: "horror",
          },
          csfdRules: { minRating: 70, minCount: 800, maxCount: 60000 },
        },
      ],
      smartPicks: {
        enabled: true,
        defaultSize: 10,
        profiles: [
          {
            id: "me",
            name: "Pro mě",
            type: "movie",
            size: 10,
            fromTrakt: ["/movies/trending", "/movies/recommended"],
            fromLists: ["vhs_era"],
            filters: { years: "1990-2026", genres: "thriller,crime" },
          },
        ],
      },
    };
    state.secrets = {
      trakt: { client_id: "", client_secret: "" },
      tmdb: { access_token: "", api_key: "" },
    };

    writeDefaultsToUI();
    writeSecretsToUI();
    renderListsTable();
    renderSmartPicksAll();

    syncYearsUIFromText();
    syncSpYearsUIFromHidden();
    syncListGenresUI().catch(() => {});

    setStatus("DEMO loaded (UI only)");
  }

  // =========================
  // Update runner UI (optional)
  // =========================
  let updateES = null;

  function nowStamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function appendUpdateLog(line) {
    const box = $("updateLog");
    if (!box) return;
    const el = document.createElement("div");
    el.textContent = `[${nowStamp()}] ${String(line || "")}`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function humanProgress(progress) {
    const label = String(progress?.label || "").trim();
    const phase = String(progress?.phase || "").trim();
    const done = Number(progress?.done || 0);
    const total = Number(progress?.total || 0);

    const bits = [];
    if (phase) bits.push(phase);
    if (label) bits.push(label);

    if (total > 0) {
      const pct = Math.round((done / total) * 100);
      bits.push(`${done}/${total} (${pct}%)`);
    } else if (label || phase) {
      // nothing else
    } else {
      bits.push("—");
    }
    return bits.join(" · ");
  }

  function setUpdateUIStatus(st) {
    const updPill = $("updatePill");
    const r = $("updRunning");
    const p = $("updProgress");
    const running = !!st?.running;

    if (updPill)
      updPill.innerHTML = `Update: <strong>${running ? "běží" : "stojí"}</strong>`;
    if (r) r.textContent = running ? "ANO" : "NE";
    if (p) p.textContent = humanProgress(st?.progress || {});
  }

  function openUpdateStream() {
    if (updateES) {
      try {
        updateES.close();
      } catch {}
      updateES = null;
    }

    const token = String($("token")?.value || "").trim();
    const u = token
      ? `/api/update-stream?token=${encodeURIComponent(token)}`
      : "/api/update-stream";

    updateES = new EventSource(u);

    updateES.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.line) appendUpdateLog(msg.line);
        if (msg?.progress)
          setUpdateUIStatus({ running: true, progress: msg.progress });
      } catch {
        appendUpdateLog(String(ev.data || ""));
      }
    };

    updateES.addEventListener("status", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        setUpdateUIStatus(msg);
      } catch {}
    });

    updateES.addEventListener("done", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        appendUpdateLog(`== HOTOVO · ok=${msg?.ok} · code=${msg?.code} ==`);
      } catch {
        appendUpdateLog("== HOTOVO ==");
      }
      setTimeout(async () => {
        try {
          setUpdateUIStatus(await apiUpdateStatus());
        } catch {}
      }, 300);
    });

    updateES.onerror = () => {
      // common on restart; ignore
    };
  }

  // =========================
  // WIRE
  // =========================
  // Lists editor
  on("f_type", "change", async () => {
    fillSources();
    syncYearsUIFromText();
    await syncListGenresUI();
  });

  on("btnNew", "click", async () => {
    try {
      await clearListForm();
    } catch (e) {
      alert(e.message);
    }
  });

  on("btnUpsert", "click", () => upsertList());
  on("btnDelete", "click", () => deleteList());

  on("btnSort", "click", () => {
    state.lists.lists.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "cs"),
    );
    renderListsTable();
    renderSmartPicksSourcesUI();
  });

  on("btnLoad", "click", async () => {
    try {
      await loadFromDisk();
    } catch (e) {
      alert(e.message);
    }
  });

  on("btnSaveAll", "click", async () => {
    try {
      await saveToDisk();
    } catch (e) {
      alert(e.message);
    }
  });

  on("btnRestartAddon", "click", async () => {
    try {
      setStatus("restarting addon…");
      const out = await apiRestartAddon();
      setStatus("addon restarted");
      alert("Restart hotov.\n\n" + (out?.stdout || "").trim());
    } catch (e) {
      alert(e.message);
      setStatus("restart failed");
    }
  });

  // list genres picker init
  initListGenresUI();

  // SmartPicks wire
  on("btnSpNew", "click", () => clearSmartPickForm());
  on("btnSpSort", "click", () => sortSmartPicksProfiles());
  on("btnSpUpsert", "click", () => {
    try {
      upsertSmartPickProfile();
    } catch (e) {
      alert(e.message);
    }
  });
  on("btnSpDelete", "click", () => deleteSmartPickProfile());

  on("sp_type", "change", async () => {
    try {
      renderSmartPicksSourcesUI();
      await renderSmartPicksGenresUI();
      syncSpYearsUIFromHidden();
    } catch {}
  });

  on("sp_genreSearch", "input", () => renderSmartPicksGenresUI());
  on("btnSpClearGenres", "click", async () => {
    setSpIncludeExcludeToHidden([], []);
    await renderSmartPicksGenresUI();
  });

  on("btnSpAddSource", "click", () => {
    const v = String($("sp_customSource")?.value || "").trim();
    if (!v) return;

    const seedBox = $("sp_src_trakt");
    if (!seedBox) return;

    const exists = Array.from(
      seedBox.querySelectorAll('input[type="checkbox"]'),
    ).some((cb) => cb.value === v);

    if (!exists) {
      const label = document.createElement("label");
      label.className = "chip";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = v;
      cb.checked = true;

      const span = document.createElement("span");
      span.className = "mono";
      span.textContent = v;

      label.appendChild(cb);
      label.appendChild(span);

      seedBox.prepend(label);
    } else {
      const cb = Array.from(
        seedBox.querySelectorAll('input[type="checkbox"]'),
      ).find((cb) => cb.value === v);
      if (cb) cb.checked = true;
    }

    if ($("sp_customSource")) $("sp_customSource").value = "";
  });

  // Update runner wire (only if buttons exist)
  on("btnRunUpdate", "click", async () => {
    try {
      setStatus("starting update…");
      appendUpdateLog("Spouštím update…");
      await apiRunUpdate();
      openUpdateStream();
      try {
        const st = await apiUpdateStatus();
        setUpdateUIStatus(st);
      } catch {}
      setStatus("update started");
    } catch (e) {
      alert(e.message);
      appendUpdateLog("Chyba: " + e.message);
      setStatus("update failed");
    }
  });

  on("btnStopUpdate", "click", async () => {
    try {
      await apiStopUpdate();
      appendUpdateLog("== STOP požadavek odeslán ==");
      try {
        const st = await apiUpdateStatus();
        setUpdateUIStatus(st);
      } catch {}
    } catch (e) {
      alert(e.message);
    }
  });

  on("btnClearUpdateLog", "click", () => {
    const box = $("updateLog");
    if (box) box.innerHTML = "";
  });

  // =========================
  // INIT
  // =========================
  (async () => {
    ensureListModeField();
    ensureListSourcesJsonField();
    fillSources();
    initYearsUI();
    initSpYearsUI();

    try {
      const st = await apiUpdateStatus();
      setUpdateUIStatus(st);
      openUpdateStream();
    } catch {
      // server might not have update endpoints yet; ignore
    }

    try {
      await loadFromDisk();

      if ($("sp_id")) clearSmartPickForm();

      syncYearsUIFromText();
      await syncListGenresUI();
      syncSpYearsUIFromHidden();
    } catch {
      state.lists = {
        defaults: { dupRules: {} },
        lists: [],
        smartPicks: { enabled: true, defaultSize: 10, profiles: [] },
      };
      state.secrets = {
        trakt: { client_id: "", client_secret: "" },
        tmdb: { access_token: "", api_key: "" },
      };

      writeDefaultsToUI();
      writeSecretsToUI();

      renderListsTable();
      renderSmartPicksAll();

      syncYearsUIFromText();
      await syncListGenresUI();
      syncSpYearsUIFromHidden();

      if ($("sp_id")) clearSmartPickForm();
      setStatus("no config found yet (create + save)");
    }
  })();
})();
