// app/public/app.js
const $ = (id) => document.getElementById(id);

let CURRENT_CONFIG = { recipes: [] };

// Snapshot configu tak, jak je na serveru (po Load / Save all)
let SERVER_CONFIG_SNAPSHOT = "";

// accordion: který recipe je rozbalený
let openId = null;

// logs polling
let pollTimer = null;
let lastLogI = 0;
let currentRunId = null;
let RAW_OPEN = {};

// Spotify genre seeds cache for Genre Picker UI
let SPOTIFY_GENRE_SEEDS = null; // array of strings
let SPOTIFY_GENRE_SEEDS_META = {
  loaded_at: null,
  fetched_at: null,
  cached: null,
  count: 0,
};

// Auto-roots cache (derived from SPOTIFY_GENRE_SEEDS)
let AUTO_ROOTS_CACHE = null;

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

function flashEl(el, kind /* ok|err|no */) {
  if (!el) return;
  const cls =
    kind === "ok"
      ? "sidFlashOk"
      : kind === "err"
        ? "sidFlashErr"
        : "sidFlashNo";
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 260);
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

function setAuthButtonVisible(isAuthorized) {
  const btn = $("btnAuth");
  if (!btn) return;
  btn.style.display = isAuthorized ? "none" : "";
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

function setMsgHtml(html, kind) {
  const el = $("msg");
  if (!html) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "";
  el.innerHTML = html;
  el.className = "msg " + (kind || "");
}

function promptUnsavedRun() {
  return new Promise((resolve) => {
    const html = `
      <div style="display:flex; flex-direction:column; gap:10px;">
        <div style="font-weight:800;">Neuložené změny</div>
        <div style="line-height:1.55;">
          Máš neuložené změny v konfiguraci (neproběhl <strong>Save all</strong>).<br/>
          <strong>Run</strong> použije poslední uložený config na serveru.
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:2px;">
          <button id="btnUnsavedSaveRun" class="primary">Uložit vše a spustit</button>
          <button id="btnUnsavedRunAnyway">Spustit i tak</button>
          <button id="btnUnsavedCancel">Zrušit</button>
        </div>
      </div>
    `;

    setMsgHtml(html, "warn");

    const once = (id, value) => {
      const b = $(id);
      if (!b) return;
      b.addEventListener(
        "click",
        () => {
          setMsgHtml("", "");
          resolve(value);
        },
        { once: true },
      );
    };

    once("btnUnsavedSaveRun", "save_run");
    once("btnUnsavedRunAnyway", "run_anyway");
    once("btnUnsavedCancel", "cancel");
  });
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

function toNumOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function splitComma(v) {
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\[.*?\]/g, " ")
    .replace(/feat\.?/g, " ")
    .replace(/ft\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqCaseInsensitive(arr) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(arr) ? arr : []) {
    const s = String(x || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// Curated root genres (hand-picked, stable & readable)
const CURATED_ROOTS = [
  "rock",
  "metal",
  "pop",
  "hip hop",
  "electronic",
  "house",
  "techno",
  "trance",
  "drum and bass",
  "dubstep",
  "ambient",
  "jazz",
  "classical",
  "reggae",
  "latin",
  "rnb",
  "soul",
  "funk",
  "punk",
  "blues",
  "folk",
  "country",
];

function computeAutoRootsFromSeeds(seeds) {
  if (!Array.isArray(seeds) || !seeds.length) return [];

  // Very small stopword list for tokenization
  const stop = new Set([
    "and",
    "the",
    "of",
    "for",
    "to",
    "a",
    "an",
    "la",
    "le",
    "de",
    "da",
    "do",
    "del",
    "los",
    "las",
    "y",
  ]);

  const allowShort = new Set([
    "rnb",
    "edm",
    "ska",
    "emo",
    "idm",
    "jpop",
    "kpop",
  ]);

  const tokenCounts = new Map();
  const bigramCounts = new Map();

  for (const s of seeds) {
    const norm = normalizeForMatch(s);
    if (!norm) continue;
    const tokens = norm.split(/\s+/).filter(Boolean);

    for (const t of tokens) {
      if (stop.has(t)) continue;
      if (t.length < 3 && !allowShort.has(t)) continue;
      tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
    }

    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      if (!a || !b) continue;
      if (stop.has(a) || stop.has(b)) continue;
      if (
        (a.length < 2 && !allowShort.has(a)) ||
        (b.length < 2 && !allowShort.has(b))
      )
        continue;

      const bi = `${a} ${b}`;
      bigramCounts.set(bi, (bigramCounts.get(bi) || 0) + 1);
    }
  }

  const candidates = [];

  // Prefer meaningful phrases if frequent enough
  const MIN_PHRASE = 10;
  for (const [p, c] of bigramCounts.entries()) {
    if (c < MIN_PHRASE) continue;
    // Filter obvious noise words
    if (
      p.startsWith("deep ") ||
      p.startsWith("classic ") ||
      p.startsWith("modern ")
    )
      continue;
    candidates.push({ k: p, c: c + 0.25 }); // tiny boost for phrases
  }

  const MIN_TOKEN = 18;
  for (const [t, c] of tokenCounts.entries()) {
    if (c < MIN_TOKEN) continue;
    if (["deep", "classic", "modern", "new", "old"].includes(t)) continue;
    candidates.push({ k: t, c });
  }

  // Ensure a few useful multi-word roots exist if Spotify uses them
  const normAll = seeds.map((x) => normalizeForMatch(x)).join(" | ");
  if (normAll.includes("hip hop")) candidates.push({ k: "hip hop", c: 999 });
  if (normAll.includes("drum bass") || normAll.includes("drum and bass"))
    candidates.push({ k: "drum and bass", c: 998 });
  if (normAll.includes("k pop") || normAll.includes("kpop"))
    candidates.push({ k: "k pop", c: 997 });

  // Sort by frequency desc, then alpha
  candidates.sort((a, b) => b.c - a.c || a.k.localeCompare(b.k));

  // Deduplicate and cap
  const roots = [];
  const seen = new Set();
  for (const it of candidates) {
    const k = String(it.k || "").trim();
    if (!k) continue;
    const kk = k.toLowerCase();
    if (seen.has(kk)) continue;
    seen.add(kk);
    roots.push(k);
    if (roots.length >= 24) break;
  }

  return roots;
}

function getRootsByMode(mode) {
  const m = String(mode || "curated").toLowerCase();
  if (m !== "auto") return CURATED_ROOTS;

  if (!Array.isArray(SPOTIFY_GENRE_SEEDS) || !SPOTIFY_GENRE_SEEDS.length) {
    return CURATED_ROOTS;
  }

  if (!AUTO_ROOTS_CACHE) {
    AUTO_ROOTS_CACHE = computeAutoRootsFromSeeds(SPOTIFY_GENRE_SEEDS);
  }
  return AUTO_ROOTS_CACHE && AUTO_ROOTS_CACHE.length
    ? AUTO_ROOTS_CACHE
    : CURATED_ROOTS;
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

function getValueByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

/* ---------------- inline help ---------------- */

function helpBlock(title, html) {
  return `
    <details class="help">
      <summary>${escapeHtml(title || "Nápověda")}</summary>
      <div class="helpBody">${html}</div>
    </details>
  `;
}

function helpFor(k) {
  switch (k) {
    case "name":
      return helpBlock(
        "Co je to?",
        `
          <div>Název recipe jen pro UI. Na generování nemá přímý vliv.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>Daily playlist</code></div>
        `,
      );

    case "target_playlist_id":
      return helpBlock(
        "Co sem dát?",
        `
          <div>Cílový playlist, který se při běhu přepíše (replace).</div>
          <div>Můžeš zadat <strong>ID</strong> nebo celou <strong>URL</strong> (pokud backend umí URL parsovat).</div>
          <div class="helpExample">
            <strong>Příklad:</strong><br>
            <code>https://open.spotify.com/playlist/4POAK6kCMZRU4AHadzOXv4</code><br>
            nebo jen <code>4POAK6kCMZRU4AHadzOXv4</code>
          </div>
        `,
      );

    case "track_count":
      return helpBlock(
        "Co to ovlivňuje?",
        `
          <div>Kolik tracků má výsledný playlist po běhu.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>30</code> pro daily, <code>50</code> pro větší mix</div>
        `,
      );

    case "enabled":
      return helpBlock(
        "K čemu je to?",
        `
      <div>Když je <code>false</code>, recipe se při běžném běhu (<code>/api/run</code> bez výběru) přeskočí.</div>
      <div>Ruční tlačítko “Spustit jen tento” ho spustí i když je disabled.</div>
    `,
      );

    // Discovery
    case "discovery.enabled":
      return helpBlock(
        "K čemu je Discovery?",
        `
          <div>Zapne Last.fm discovery. Bez toho se bere jen z fallback zdrojů (a případně Spotify Recommendations).</div>
          <div>Vyžaduje <code>LASTFM_API_KEY</code> v options/env.</div>
        `,
      );

    case "discovery.strategy":
      return helpBlock(
        "Strategie",
        `
          <div><code>deep_cuts</code> – vezme alba/singly a vybírá tracky (často “méně profláklé”).</div>
          <div><code>recent_albums</code> – preferuje novější releasy (rychlejší “fresh”).</div>
          <div><code>lastfm_toptracks</code> – vezme top tracky z Last.fm a dohledá je přes Spotify search.</div>
          <div class="helpExample"><strong>Tip:</strong> Pro “unknown” typicky <code>deep_cuts</code> + popularity cap.</div>
        `,
      );

    case "discovery.seed_top_artists_time_range":
      return helpBlock(
        "Seed top artists",
        `
          <div>Jaké období se použije pro Spotify “Top artists” (seed).</div>
          <ul>
            <li><code>short_term</code> – aktuálně</li>
            <li><code>medium_term</code> – cca měsíce</li>
            <li><code>long_term</code> – dlouhodobě</li>
          </ul>
        `,
      );

    case "discovery.seed_top_artists_limit":
      return helpBlock(
        "Kolik seed interpretů?",
        `
          <div>Více seedů = širší záběr, ale víc requestů a delší běh.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>5</code> až <code>15</code></div>
        `,
      );

    case "discovery.similar_per_seed":
      return helpBlock(
        "Podobní interpreti",
        `
          <div>Kolik similar artists se vezme z Last.fm pro každý seed.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>30–80</code></div>
        `,
      );

    case "discovery.take_artists":
      return helpBlock(
        "Limit poolu interpretů",
        `
          <div>Strop, kolik interpretů se vezme do “poolu” (aby runtime neutekl).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>80–200</code></div>
        `,
      );

    case "discovery.include_seed_artists":
      return helpBlock(
        "Zahrnout seed interprety?",
        `
          <div>Když <code>false</code>, seed interpreti se vynechají (méně “známé věci”).</div>
          <div>Když <code>true</code>, seed interpreti se mohou dostat do výsledku.</div>
        `,
      );

    case "discovery.tracks_per_artist":
      return helpBlock(
        "Kolik tracků na interpreta?",
        `
          <div>Kolik tracků se zkusí získat pro každého discovered interpreta.</div>
          <div>Nižší = více interpretů, vyšší = víc tracků od stejných.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>1–3</code></div>
        `,
      );

    case "discovery.max_track_popularity":
      return helpBlock(
        "Popularity cap",
        `
          <div>Horní limit Spotify popularity (0–100). Vyšší = známější věci.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>60</code> pro “méně profláklé”, <code>80</code> pro mix</div>
        `,
      );

    case "discovery.min_track_popularity":
      return helpBlock(
        "Min popularity (volitelné)",
        `
          <div>Spodní limit popularity (0–100). Když necháš prázdné, nefiltruje se.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>10</code> (vyhodí úplné “nuly”)</div>
        `,
      );

    case "discovery.exclude_saved_tracks":
      return helpBlock(
        "Vyhodit Liked Songs?",
        `
          <div>Když <code>true</code>, odstraní tracky, které už máš v Liked Songs.</div>
          <div>To je hlavní trik pro “unknown feeling”.</div>
        `,
      );

    case "discovery.albums_per_artist":
      return helpBlock(
        "Alba na interpreta",
        `
          <div>Kolik alb/singlů na interpreta se prochází (hlavně pro album-based strategie).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>2</code></div>
        `,
      );

    case "discovery.albums_limit_fetch":
      return helpBlock(
        "Kolik alb vůbec stáhnout",
        `
          <div>Kolik alb/singlů se max stáhne ze Spotify pro interpreta před výběrem.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>8</code> až <code>20</code></div>
        `,
      );

    case "discovery.search_limit_per_track":
      return helpBlock(
        "Search limit (lastfm_toptracks)",
        `
          <div>Kolik výsledků Spotify search zkusí pro jeden track (bezpečnostní limit).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>5</code></div>
        `,
      );

    case "discovery.use_tastedive":
      return helpBlock(
        "TasteDive similar artists",
        `
          <div>Alternativa / doplněk k Last.fm podobným interpretům (vyžaduje <code>tastedive_api_key</code> v add-on options).</div>
          <div>Hodí se pro rozšíření poolu, když už Last.fm začíná docházet.</div>
        `,
      );

    case "discovery.tastedive_limit":
      return helpBlock(
        "TasteDive limit",
        `
          <div>Kolik interpretů max vzít z TasteDive (přes všechny seed interprety).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>50–200</code></div>
        `,
      );

    case "discovery.use_audiodb_trending":
      return helpBlock(
        "TheAudioDB trending",
        `
          <div>Přidá chart/trending tracky z TheAudioDB jako další zdroj kandidátů (vyžaduje <code>audiodb_api_key</code>).</div>
          <div>Vhodné pro “žebříčky” a pro rozšíření zásoby nových tracků.</div>
        `,
      );

    case "discovery.audiodb_country":
      return helpBlock(
        "TheAudioDB country",
        `
          <div>2‑písmenný kód země pro trending (např. <code>us</code>, <code>gb</code>, <code>cz</code>). Když je prázdné, použije se market.</div>
        `,
      );

    case "discovery.audiodb_limit":
      return helpBlock(
        "TheAudioDB limit",
        `
          <div>Kolik položek z trending vůbec zkusit namapovat na Spotify (Spotify search = pomalejší, tak drž rozumně).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>20–50</code></div>
        `,
      );

    case "discovery.audiodb_fill":
      return helpBlock(
        "TheAudioDB fill (volitelné)",
        `
          <div>Kolik tracků se má pokusit nacpat z TheAudioDB ještě před podobnými interprety.</div>
          <div>Když necháš prázdné, použije se automaticky ~30% z track_count.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>10</code></div>
        `,
      );

    case "discovery.use_songkick_events":
      return helpBlock(
        "Songkick (upcoming concerts)",
        `
          <div>Přidá interprety z lokálních koncertů (Songkick) jako další zdroj pro discovery pool.</div>
          <div>Vhodné na “žebříčky / co se hraje v okolí” a objevování něčeho mimo tvoje top artists.</div>
          <div>Vyžaduje <code>songkick_api_key</code> v addon options.</div>
        `,
      );

    case "discovery.songkick_location_query":
      return helpBlock(
        "Songkick location query",
        `
          <div>Textový dotaz na lokaci (město/oblast), ze kterého se vezme metro area ID.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>Prague</code> / <code>Brno</code></div>
          <div class="helpExample"><strong>Tip:</strong> Když vyplníš přímo <code>metro_area_id</code>, query se nepoužije.</div>
        `,
      );

    case "discovery.songkick_metro_area_id":
      return helpBlock(
        "Songkick metro area id",
        `
          <div>Číselné ID metro area v Songkick. Když je vyplněné, použije se přednostně (nevolá se location search).</div>
          <div class="helpExample"><strong>Tip:</strong> Když si nejsi jistý ID, vyplň <code>location_query</code> a addon si ho zkusí dohledat.</div>
        `,
      );

    case "discovery.songkick_days_ahead":
      return helpBlock(
        "Songkick days ahead",
        `
          <div>Kolik dní dopředu brát koncerty do kalendáře.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>30</code></div>
        `,
      );

    case "discovery.songkick_take_artists":
      return helpBlock(
        "Songkick take artists",
        `
          <div>Kolik interpretů max vytáhnout ze Songkick eventů (unikátně).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>50–150</code></div>
        `,
      );

    // Recommendations
    case "recommendations.enabled":
      return helpBlock(
        "K čemu je Recommendations?",
        `
          <div>Spotify Recommendations slouží jako “doplňovač”, když discovery nestačí do počtu.</div>
          <div>Je potřeba nastavit <code>seed_genres</code> (max 5 se používá v jednom requestu).</div>
        `,
      );

    case "recommendations.seed_genres":
      return helpBlock(
        "Seed genres",
        `
          <div>Seznam Spotify žánrů (comma). V jednom requestu se použije prvních 5.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>techno, ambient, rock</code></div>
        `,
      );

    // Sources
    case "sources.search":
      return helpBlock(
        "Fallback: Search queries",
        `
          <div>Dotazy pro Spotify search, které se použijí jako fallback pool.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>genre:techno year:2020-2024</code></div>
        `,
      );

    case "sources.playlists":
      return helpBlock(
        "Fallback: Playlists",
        `
          <div>Playlisty (ID nebo URL), ze kterých se bere fallback pool.</div>
          <div class="helpExample">
            <strong>Příklad:</strong><br>
            <code>https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M</code><br>
            nebo jen <code>37i9dQZF1DXcBWIGoYBM5M</code>
          </div>
        `,
      );

    case "sources.liked":
      return helpBlock(
        "Fallback: Liked tracks",
        `
          <div>Když <code>true</code>, přidá do poolu i tvoje Liked Songs.</div>
          <div>Hodí se jako záchrana, ale může to být “méně unknown”.</div>
        `,
      );

    case "sources.max_candidates":
      return helpBlock(
        "Max candidates",
        `
          <div>Strop, kolik kandidátů se max natahá do poolu ze zdrojů.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>1500</code> (vyšší = pomalejší, ale víc výběru)</div>
        `,
      );

    case "sources.top_tracks.enabled":
      return helpBlock(
        "Fallback: Top tracks",
        `
          <div>Zapne přidání Spotify “Top tracks” do poolu.</div>
        `,
      );

    case "sources.top_tracks.time_range":
      return helpBlock(
        "Období pro Top tracks",
        `
          <ul>
            <li><code>short_term</code> – aktuálně</li>
            <li><code>medium_term</code> – cca měsíce</li>
            <li><code>long_term</code> – dlouhodobě</li>
          </ul>
        `,
      );

    case "sources.top_tracks.limit":
      return helpBlock(
        "Top tracks limit",
        `
          <div>Kolik top tracků Spotify endpoint vrací na stránku (1–50).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>50</code></div>
        `,
      );

    // Filters
    case "filters.explicit":
      return helpBlock(
        "Explicit policy",
        `
          <ul>
            <li><code>allow</code> – vše</li>
            <li><code>exclude</code> – bez explicit</li>
            <li><code>only</code> – jen explicit</li>
          </ul>
        `,
      );

    case "filters.year_min":
      return helpBlock(
        "Min rok",
        `
          <div>Filtr podle roku vydání (album.release_date). Prázdné = bez filtru.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>2015</code></div>
        `,
      );

    case "filters.year_max":
      return helpBlock(
        "Max rok",
        `
          <div>Filtr podle roku vydání (album.release_date). Prázdné = bez filtru.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>2024</code></div>
        `,
      );

    case "filters.tempo_min":
      return helpBlock(
        "Tempo min",
        `
          <div>Tempo (BPM). Nejlépe funguje pro Spotify Recommendations (kde se dá přímo říct min/max tempo).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>120</code></div>
        `,
      );

    case "filters.tempo_max":
      return helpBlock(
        "Tempo max",
        `
          <div>Tempo (BPM). Nejlépe funguje pro Spotify Recommendations.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>140</code></div>
        `,
      );

    case "filters.genres_mode":
      return helpBlock(
        "Genre filtering mode",
        `
          <div>Filtruje podle žánrů interpretů (Spotify artist genres).</div>
          <div>
            <ul>
              <li><code>ignore</code> = žánry se neřeší</li>
              <li><code>include</code> = zůstanou jen tracky, které odpovídají include listu</li>
              <li><code>exclude</code> = vyhodí tracky, které odpovídají exclude listu</li>
              <li><code>include_exclude</code> = musí projít include a zároveň nesmí být v exclude</li>
            </ul>
          </div>
        `,
      );

    case "filters.genres_include":
      return helpBlock(
        "Genres include",
        `
          <div>Seznam žánrů (comma). Match je “fuzzy” (např. <code>metal</code> chytí <code>swedish doom metal</code>).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>techno, ambient, indie pop</code></div>
        `,
      );

    case "filters.genres_exclude":
      return helpBlock(
        "Genres exclude",
        `
          <div>Seznam žánrů (comma), které se mají vyhodit.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>death metal, hardstyle</code></div>
        `,
      );

    case "filters.allow_unknown_genres":
      return helpBlock(
        "Allow unknown genres",
        `
          <div>Když Spotify u interpreta nevrátí žádné žánry (prázdné), tak track může i tak projít filtrem.</div>
          <div>Užitečné hlavně pro režimy <code>include</code>/<code>include_exclude</code>, aby ses nepřipravil o dobré tracky.</div>
        `,
      );

    case "filters.genres_root_mode":
      return helpBlock(
        "Root genres",
        `
          <div>Jen pro UI picker: jak se mají nabídnout “hlavní” žánry.</div>
          <ul>
            <li><code>curated</code> = ručně vybraný seznam (stabilní, přehledný)</li>
            <li><code>auto</code> = odvozeno z reálných Spotify genre seeds (může obsahovat i méně užitečné položky)</li>
          </ul>
        `,
      );

    case "history.scope":
      return helpBlock(
        "History scope (no-repeat)",
        `
          <div>Určuje, jestli se “už jednou zahrané” tracky filtrují globálně, nebo jen v rámci tohoto recipe.</div>
          <div>
            <ul>
              <li><code>inherit</code> = použije addon options (<code>history.scope</code>)</li>
              <li><code>per_recipe</code> = historie se vede zvlášť pro každý recipe</li>
              <li><code>global</code> = jedna společná historie pro všechny recipe</li>
            </ul>
          </div>
        `,
      );
    case "history.enabled":
      return helpBlock(
        "History enabled",
        `
          <div>Když <code>false</code>, historie se pro recipe vůbec nepoužije (může se opakovat).</div>
          <div>Když <code>true</code>, chová se to jako doteď (no-repeat).</div>
        `,
      );

    case "history.rolling_days":
      return helpBlock(
        "Rolling days (override)",
        `
          <div>Kolik dní držet historii pro tohle recipe.</div>
          <div>Prázdné = použije se globální nastavení z addon options (<code>history.rolling_days</code>).</div>
        `,
      );

    case "history.auto_flush.enabled":
      return helpBlock(
        "Auto-flush history",
        `
          <div>Když je historie “příliš plná”, umí se sama vyčistit.</div>
          <div>Doporučené používat jen se scope <code>per_recipe</code>.</div>
        `,
      );

    case "history.auto_flush.threshold_pct":
      return helpBlock(
        "Auto-flush threshold %",
        `
          <div>Pokud historie blokuje ≥ X % zdrojového poolu (sources), může se vyflushnout.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>80</code></div>
        `,
      );

    case "history.auto_flush.min_pool":
      return helpBlock(
        "Auto-flush min pool",
        `
          <div>Auto-flush se začne vyhodnocovat až když má pool aspoň tolik tracků (aby to nedělalo falešné poplachy na malých poolech).</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>200</code></div>
        `,
      );

    // Diversity
    case "diversity.max_per_artist":
      return helpBlock(
        "Max per artist",
        `
          <div>Omezí, kolikrát se může opakovat stejný interpret.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>2</code></div>
        `,
      );

    case "diversity.max_per_album":
      return helpBlock(
        "Max per album",
        `
          <div>Omezí, kolik tracků se může vzít z jednoho alba. Prázdné = bez omezení.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>1</code> nebo <code>2</code></div>
        `,
      );

    case "diversity.avoid_same_artist_in_row":
      return helpBlock(
        "Avoid same artist in a row",
        `
          <div>Když <code>true</code>, nedovolí dát dva tracky po sobě od stejného interpreta.</div>
        `,
      );

    // Advanced
    case "advanced.recommendation_attempts":
      return helpBlock(
        "Recommendation attempts",
        `
          <div>Kolikrát se zkusí zavolat Spotify Recommendations (pokud jsou zapnuté).</div>
          <div>Víc = víc kandidátů, ale víc requestů a pomalejší běh.</div>
          <div class="helpExample"><strong>Příklad:</strong> <code>10</code></div>
        `,
      );

    default:
      return "";
  }
}

/* ---------------- migration/normalize ---------------- */

function normalizeRecipe(r) {
  if (!r || typeof r !== "object") return r;
  // Per-recipe enable/disable (default: enabled)
  if (r.enabled == null) r.enabled = true;

  // ensure objects
  if (!r.discovery || typeof r.discovery !== "object") r.discovery = {};
  if (!r.sources || typeof r.sources !== "object") r.sources = {};
  if (!r.filters || typeof r.filters !== "object") r.filters = {};
  if (!r.diversity || typeof r.diversity !== "object") r.diversity = {};
  if (!r.advanced || typeof r.advanced !== "object") r.advanced = {};
  if (!r.history || typeof r.history !== "object") r.history = {};
  if (!r.recommendations || typeof r.recommendations !== "object")
    r.recommendations = {};

  const d = r.discovery;

  // Legacy seed_top_artists {time_range, limit} -> flat keys
  if (d.seed_top_artists && typeof d.seed_top_artists === "object") {
    if (d.seed_top_artists_time_range == null) {
      d.seed_top_artists_time_range = String(
        d.seed_top_artists.time_range ?? "short_term",
      );
    }
    if (d.seed_top_artists_limit == null) {
      d.seed_top_artists_limit = toNumOrZero(d.seed_top_artists.limit ?? 10);
    }
  }

  // Legacy "provider" mapping -> strategy
  // Old values seen: "lastfm_similar_artists"
  if (!d.strategy && d.provider) {
    const p = String(d.provider || "").toLowerCase();
    // "similar artists" + album tracks => closest to deep_cuts
    if (p.includes("similar")) d.strategy = "deep_cuts";
  }

  // Defaults if missing
  if (d.enabled == null) d.enabled = false;
  if (!d.strategy) d.strategy = "deep_cuts";

  if (d.seed_top_artists_time_range == null)
    d.seed_top_artists_time_range = "short_term";
  if (d.seed_top_artists_limit == null) d.seed_top_artists_limit = 5;

  if (d.similar_per_seed == null) d.similar_per_seed = 30;
  if (d.take_artists == null) d.take_artists = 80;
  if (d.include_seed_artists == null) d.include_seed_artists = false;
  if (d.tracks_per_artist == null) d.tracks_per_artist = 2;

  // popularity shaping defaults (match generator.js)
  if (d.max_track_popularity == null) d.max_track_popularity = 60;
  if (d.min_track_popularity == null) d.min_track_popularity = null;

  if (d.exclude_saved_tracks == null) d.exclude_saved_tracks = true;

  if (d.albums_per_artist == null) d.albums_per_artist = 2;
  if (d.albums_limit_fetch == null) d.albums_limit_fetch = 8;
  if (d.search_limit_per_track == null) d.search_limit_per_track = 5;

  // External discovery / charts (optional)
  if (d.use_tastedive == null) d.use_tastedive = false;
  if (d.tastedive_limit == null) d.tastedive_limit = 80;
  if (d.use_audiodb_trending == null) d.use_audiodb_trending = false;
  if (d.audiodb_country == null) d.audiodb_country = "";
  if (d.audiodb_limit == null) d.audiodb_limit = 30;
  if (d.audiodb_fill === undefined) d.audiodb_fill = null;

  // Songkick events (optional)
  if (d.use_songkick_events == null) d.use_songkick_events = false;
  if (d.songkick_location_query == null) d.songkick_location_query = "";
  if (d.songkick_metro_area_id == null) d.songkick_metro_area_id = "";
  if (d.songkick_days_ahead == null) d.songkick_days_ahead = 30;
  if (d.songkick_take_artists == null) d.songkick_take_artists = 60;

  // Recommendations defaults
  if (r.recommendations.enabled == null) r.recommendations.enabled = false;
  if (!Array.isArray(r.recommendations.seed_genres))
    r.recommendations.seed_genres = [];

  // Filters defaults
  if (!r.filters.explicit) r.filters.explicit = "allow";
  if (r.filters.year_min === undefined) r.filters.year_min = null;
  if (r.filters.year_max === undefined) r.filters.year_max = null;
  if (r.filters.tempo_min === undefined) r.filters.tempo_min = null;
  if (r.filters.tempo_max === undefined) r.filters.tempo_max = null;

  // Genre filtering (Spotify artist genres)
  if (r.filters.genres_mode == null) r.filters.genres_mode = "ignore";
  if (!Array.isArray(r.filters.genres_include)) r.filters.genres_include = [];
  if (!Array.isArray(r.filters.genres_exclude)) r.filters.genres_exclude = [];
  if (r.filters.allow_unknown_genres == null)
    r.filters.allow_unknown_genres = true;
  if (r.filters.genres_root_mode == null)
    r.filters.genres_root_mode = "curated";

  // Per-recipe history scope override
  if (r.history.scope == null) r.history.scope = "inherit"; // inherit|per_recipe|global

  // Per-recipe history retention (optional)
  if (r.history.enabled == null) r.history.enabled = true;
  if (r.history.rolling_days === undefined) r.history.rolling_days = null; // null => inherit addon options

  if (!r.history.auto_flush || typeof r.history.auto_flush !== "object")
    r.history.auto_flush = {};
  if (r.history.auto_flush.enabled == null)
    r.history.auto_flush.enabled = false;
  if (r.history.auto_flush.threshold_pct == null)
    r.history.auto_flush.threshold_pct = 80;
  if (r.history.auto_flush.min_pool == null)
    r.history.auto_flush.min_pool = 200;

  // Diversity defaults
  if (r.diversity.max_per_artist === undefined) r.diversity.max_per_artist = 2;
  if (r.diversity.max_per_album === undefined) r.diversity.max_per_album = null;
  if (r.diversity.avoid_same_artist_in_row === undefined)
    r.diversity.avoid_same_artist_in_row = false;

  // Sources defaults
  const s = r.sources;
  if (!Array.isArray(s.search)) s.search = [];
  if (!Array.isArray(s.playlists)) s.playlists = [];
  if (s.liked == null) s.liked = false;
  if (s.max_candidates == null) s.max_candidates = 1500;
  if (!s.top_tracks || typeof s.top_tracks !== "object") s.top_tracks = {};
  if (s.top_tracks.enabled == null) s.top_tracks.enabled = true;
  if (!s.top_tracks.time_range) s.top_tracks.time_range = "short_term";
  if (s.top_tracks.limit == null) s.top_tracks.limit = 50;

  // Advanced defaults
  if (r.advanced.recommendation_attempts == null)
    r.advanced.recommendation_attempts = 10;

  return r;
}

/* ---------------- recipe template ---------------- */

function recipeTemplate() {
  return normalizeRecipe({
    id: "r_" + rid(),
    name: "Daily playlist",
    target_playlist_id: "",
    track_count: 50,
    enabled: true,

    discovery: {
      enabled: false,

      // generator.js uses "strategy" and flat seed_top_artists_* keys:
      strategy: "deep_cuts", // deep_cuts | recent_albums | lastfm_toptracks
      seed_top_artists_time_range: "short_term",
      seed_top_artists_limit: 5,

      similar_per_seed: 30,
      take_artists: 80,
      include_seed_artists: false,
      tracks_per_artist: 2,

      max_track_popularity: 60,
      min_track_popularity: null,
      exclude_saved_tracks: true,

      albums_per_artist: 2,
      albums_limit_fetch: 8,
      search_limit_per_track: 5,

      // Optional external signals
      use_tastedive: false,
      tastedive_limit: 80,
      use_audiodb_trending: false,
      audiodb_country: "",
      audiodb_limit: 30,
      audiodb_fill: null,

      // Songkick upcoming events
      use_songkick_events: false,
      songkick_location_query: "",
      songkick_metro_area_id: "",
      songkick_days_ahead: 30,
      songkick_take_artists: 60,
    },

    recommendations: {
      enabled: false,
      seed_genres: [],
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
      tempo_min: null,
      tempo_max: null,

      // Spotify artist genres filtering
      genres_mode: "ignore", // ignore|include|exclude|include_exclude
      genres_include: [],
      genres_exclude: [],
    },

    history: {
      enabled: true,
      scope: "inherit", // inherit|per_recipe|global
      rolling_days: null, // null => inherit addon options
      auto_flush: {
        enabled: false,
        threshold_pct: 80,
        min_pool: 200,
      },
    },

    diversity: {
      max_per_artist: 2,
      max_per_album: null,
      avoid_same_artist_in_row: false,
    },

    advanced: {
      recommendation_attempts: 10,
    },
  });
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

  const isAuthed = !!st.auth?.has_refresh_token;

  $("stAuth").textContent = isAuthed
    ? `OK (refreshed ${fmtTs(st.auth.refreshed_at)})`
    : "NOT AUTHORIZED";

  // schovej/ukaž tlačítko "Authorize Spotify"
  setAuthButtonVisible(isAuthed);

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

  // normalize/migrate recipes in-place
  CURRENT_CONFIG.recipes = CURRENT_CONFIG.recipes.map((x) =>
    normalizeRecipe(x),
  );

  // keep openId if exists
  if (openId && !CURRENT_CONFIG.recipes.some((x) => x.id === openId)) {
    openId = null;
  }
  if (!openId && CURRENT_CONFIG.recipes[0]) {
    openId = CURRENT_CONFIG.recipes[0].id;
  }

  renderAccordion();

  SERVER_CONFIG_SNAPSHOT = JSON.stringify(CURRENT_CONFIG);
}

async function saveAll() {
  await api("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: CURRENT_CONFIG }),
  });
  setMsg("Uloženo.", "ok");
  SERVER_CONFIG_SNAPSHOT = JSON.stringify(CURRENT_CONFIG);
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

async function runOne(recipeId) {
  return await api("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipe_id: recipeId }),
  });
}

/* ---------------- accordion rendering ---------------- */

function getRecipeById(id) {
  return (CURRENT_CONFIG.recipes || []).find((x) => x.id === id) || null;
}

function recipeBadges(r) {
  const d = r.discovery || {};
  const provider = d.enabled
    ? `discovery:${escapeHtml(d.strategy || "-")}`
    : "sources";
  const tracks = Number(r.track_count || 0);
  const reco = r.recommendations?.enabled
    ? `<span class="riBadge">reco:on</span>`
    : "";
  const hs = r.history?.scope || "inherit";
  const histBadge =
    hs && hs !== "inherit"
      ? `<span class="riBadge">hist:${escapeHtml(hs)}</span>`
      : "";
  return `
    <span class="riBadge">${tracks} tracks</span>
    <span class="riBadge">${escapeHtml(provider)}</span>
    ${reco}
    ${histBadge}
  `;
}

function renderRecipeEditor(r) {
  normalizeRecipe(r);

  const disc = r.discovery || {};
  const sources = r.sources || {};
  const filters = r.filters || {};
  const hist = r.history || {};
  const hflush = hist.auto_flush || {};
  const diversity = r.diversity || {};
  const adv = r.advanced || {};
  const reco = r.recommendations || {};

  return `
    <div class="formgrid">
      <label class="field">
        <div class="label">Name</div>
        <input data-k="name" value="${escapeHtml(r.name || "")}">
        ${helpFor("name")}
      </label>
      
      <label class="field">
  <div class="label">Enabled</div>
  <select data-k="enabled">
    <option value="true" ${r.enabled !== false ? "selected" : ""}>true</option>
    <option value="false" ${r.enabled === false ? "selected" : ""}>false</option>
  </select>
  ${helpFor("enabled")}
</label>


      <label class="field">
        <div class="label">Target playlist ID (nebo URL)</div>
        <input data-k="target_playlist_id" value="${escapeHtml(
          r.target_playlist_id || "",
        )}" placeholder="Spotify playlist id / open.spotify.com/playlist/...">
        ${helpFor("target_playlist_id")}
      </label>

      <label class="field">
        <div class="label">Track count</div>
        <input data-k="track_count" type="number" min="1" max="500" value="${Number(
          r.track_count || 50,
        )}">
        ${helpFor("track_count")}
      </label>
    </div>

        <div class="section-title">History / No-repeat</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Enabled</div>
        <select data-k="history.enabled">
          <option value="true" ${hist.enabled !== false ? "selected" : ""}>true</option>
          <option value="false" ${hist.enabled === false ? "selected" : ""}>false</option>
        </select>
        ${helpFor("history.enabled")}
      </label>

      <label class="field">
        <div class="label">History scope</div>
        <select data-k="history.scope">
          <option value="inherit" ${
            (hist.scope || "inherit") === "inherit" ? "selected" : ""
          }>inherit (from addon options)</option>
          <option value="per_recipe" ${
            (hist.scope || "") === "per_recipe" ? "selected" : ""
          }>per_recipe</option>
          <option value="global" ${
            (hist.scope || "") === "global" ? "selected" : ""
          }>global (shared across all lists)</option>
        </select>
        ${helpFor("history.scope")}
      </label>

      <label class="field">
        <div class="label">Rolling days (override)</div>
        <input
          data-k="history.rolling_days"
          type="number"
          min="1"
          max="3650"
          value="${hist.rolling_days == null ? "" : Number(hist.rolling_days)}"
          placeholder="(inherit)"
        >
        ${helpFor("history.rolling_days")}
      </label>

      <label class="field">
        <div class="label">Auto-flush (only per_recipe)</div>
        <select data-k="history.auto_flush.enabled">
          <option value="true" ${hflush.enabled === true ? "selected" : ""}>true</option>
          <option value="false" ${hflush.enabled !== true ? "selected" : ""}>false</option>
        </select>
        ${helpFor("history.auto_flush.enabled")}
      </label>

      <label class="field">
        <div class="label">Auto-flush threshold %</div>
        <input
          data-k="history.auto_flush.threshold_pct"
          type="number"
          min="1"
          max="100"
          value="${hflush.threshold_pct == null ? "" : Number(hflush.threshold_pct)}"
          placeholder="80"
        >
        ${helpFor("history.auto_flush.threshold_pct")}
      </label>

      <label class="field">
        <div class="label">Auto-flush min pool</div>
        <input
          data-k="history.auto_flush.min_pool"
          type="number"
          min="0"
          max="50000"
          value="${hflush.min_pool == null ? "" : Number(hflush.min_pool)}"
          placeholder="200"
        >
        ${helpFor("history.auto_flush.min_pool")}
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
        ${helpFor("discovery.enabled")}
      </label>

      <label class="field">
        <div class="label">Strategy</div>
        <select data-k="discovery.strategy">
          <option value="deep_cuts" ${
            (disc.strategy || "deep_cuts") === "deep_cuts" ? "selected" : ""
          }>deep_cuts (album tracks)</option>
          <option value="recent_albums" ${
            (disc.strategy || "") === "recent_albums" ? "selected" : ""
          }>recent_albums</option>
          <option value="lastfm_toptracks" ${
            (disc.strategy || "") === "lastfm_toptracks" ? "selected" : ""
          }>lastfm_toptracks (search)</option>
        </select>
        ${helpFor("discovery.strategy")}
      </label>

      <label class="field">
        <div class="label">Seed top artists time_range</div>
        <select data-k="discovery.seed_top_artists_time_range">
          <option value="short_term" ${
            (disc.seed_top_artists_time_range || "short_term") === "short_term"
              ? "selected"
              : ""
          }>short_term</option>
          <option value="medium_term" ${
            (disc.seed_top_artists_time_range || "") === "medium_term"
              ? "selected"
              : ""
          }>medium_term</option>
          <option value="long_term" ${
            (disc.seed_top_artists_time_range || "") === "long_term"
              ? "selected"
              : ""
          }>long_term</option>
        </select>
        ${helpFor("discovery.seed_top_artists_time_range")}
      </label>

      <label class="field">
        <div class="label">Seed top artists limit</div>
        <input data-k="discovery.seed_top_artists_limit" type="number" min="1" max="50" value="${Number(
          disc.seed_top_artists_limit ?? 5,
        )}">
        ${helpFor("discovery.seed_top_artists_limit")}
      </label>

      <label class="field">
        <div class="label">Similar per seed</div>
        <input data-k="discovery.similar_per_seed" type="number" min="1" max="500" value="${Number(
          disc.similar_per_seed ?? 30,
        )}">
        ${helpFor("discovery.similar_per_seed")}
      </label>

      <label class="field">
        <div class="label">Take artists (cap)</div>
        <input data-k="discovery.take_artists" type="number" min="1" max="5000" value="${Number(
          disc.take_artists ?? 80,
        )}">
        ${helpFor("discovery.take_artists")}
      </label>

      <label class="field">
        <div class="label">Include seed artists</div>
        <select data-k="discovery.include_seed_artists">
          <option value="true" ${
            disc.include_seed_artists === true ? "selected" : ""
          }>true</option>
          <option value="false" ${
            disc.include_seed_artists !== true ? "selected" : ""
          }>false</option>
        </select>
        ${helpFor("discovery.include_seed_artists")}
      </label>

      <label class="field">
        <div class="label">Tracks per artist</div>
        <input data-k="discovery.tracks_per_artist" type="number" min="1" max="20" value="${Number(
          disc.tracks_per_artist ?? 2,
        )}">
        ${helpFor("discovery.tracks_per_artist")}
      </label>

      <label class="field">
        <div class="label">Max track popularity (0-100)</div>
        <input data-k="discovery.max_track_popularity" type="number" min="0" max="100" value="${escapeHtml(
          disc.max_track_popularity ?? 60,
        )}">
        ${helpFor("discovery.max_track_popularity")}
      </label>

      <label class="field">
        <div class="label">Min track popularity (0-100, optional)</div>
        <input data-k="discovery.min_track_popularity" type="number" min="0" max="100" value="${escapeHtml(
          disc.min_track_popularity ?? "",
        )}">
        ${helpFor("discovery.min_track_popularity")}
      </label>

      <label class="field">
        <div class="label">Exclude saved tracks (Liked Songs)</div>
        <select data-k="discovery.exclude_saved_tracks">
          <option value="true" ${
            disc.exclude_saved_tracks !== false ? "selected" : ""
          }>true</option>
          <option value="false" ${
            disc.exclude_saved_tracks === false ? "selected" : ""
          }>false</option>
        </select>
        ${helpFor("discovery.exclude_saved_tracks")}
      </label>

      <label class="field">
        <div class="label">Albums per artist</div>
        <input data-k="discovery.albums_per_artist" type="number" min="1" max="10" value="${Number(
          disc.albums_per_artist ?? 2,
        )}">
        ${helpFor("discovery.albums_per_artist")}
      </label>

      <label class="field">
        <div class="label">Albums limit fetch</div>
        <input data-k="discovery.albums_limit_fetch" type="number" min="1" max="50" value="${Number(
          disc.albums_limit_fetch ?? 8,
        )}">
        ${helpFor("discovery.albums_limit_fetch")}
      </label>

      <label class="field">
        <div class="label">Search limit per track (lastfm_toptracks)</div>
        <input data-k="discovery.search_limit_per_track" type="number" min="1" max="50" value="${Number(
          disc.search_limit_per_track ?? 5,
        )}">
        ${helpFor("discovery.search_limit_per_track")}
      </label>

      <label class="field">
        <div class="label">Use TasteDive (similar artists)</div>
        <select data-k="discovery.use_tastedive">
          <option value="true" ${disc.use_tastedive === true ? "selected" : ""}>true</option>
          <option value="false" ${disc.use_tastedive !== true ? "selected" : ""}>false</option>
        </select>
        ${helpFor("discovery.use_tastedive")}
      </label>

      <label class="field">
        <div class="label">TasteDive limit</div>
        <input data-k="discovery.tastedive_limit" type="number" min="1" max="200" value="${Number(
          disc.tastedive_limit ?? 80,
        )}">
        ${helpFor("discovery.tastedive_limit")}
      </label>

      <label class="field">
        <div class="label">Use TheAudioDB trending (charts)</div>
        <select data-k="discovery.use_audiodb_trending">
          <option value="true" ${disc.use_audiodb_trending === true ? "selected" : ""}>true</option>
          <option value="false" ${disc.use_audiodb_trending !== true ? "selected" : ""}>false</option>
        </select>
        ${helpFor("discovery.use_audiodb_trending")}
      </label>

      <label class="field">
        <div class="label">TheAudioDB country (optional)</div>
        <input data-k="discovery.audiodb_country" value="${escapeHtml(
          disc.audiodb_country ?? "",
        )}" placeholder="cz / us / gb ...">
        ${helpFor("discovery.audiodb_country")}
      </label>

      <label class="field">
        <div class="label">TheAudioDB limit</div>
        <input data-k="discovery.audiodb_limit" type="number" min="1" max="200" value="${Number(
          disc.audiodb_limit ?? 30,
        )}">
        ${helpFor("discovery.audiodb_limit")}
      </label>

      <label class="field">
        <div class="label">TheAudioDB fill (optional)</div>
        <input data-k="discovery.audiodb_fill" type="number" min="0" max="200" value="${escapeHtml(
          disc.audiodb_fill ?? "",
        )}" placeholder="auto">
        ${helpFor("discovery.audiodb_fill")}
      </label>

      <label class="field">
        <div class="label">Use Songkick events</div>
        <select data-k="discovery.use_songkick_events">
          <option value="true" ${disc.use_songkick_events === true ? "selected" : ""}>true</option>
          <option value="false" ${disc.use_songkick_events !== true ? "selected" : ""}>false</option>
        </select>
        ${helpFor("discovery.use_songkick_events")}
      </label>

      <label class="field">
        <div class="label">Songkick location query (optional)</div>
        <input data-k="discovery.songkick_location_query" value="${escapeHtml(
          disc.songkick_location_query ?? "",
        )}" placeholder="Prague / Brno ...">
        ${helpFor("discovery.songkick_location_query")}
      </label>

      <label class="field">
        <div class="label">Songkick metro area id (optional)</div>
        <input data-k="discovery.songkick_metro_area_id" type="number" min="1" max="999999" value="${escapeHtml(
          disc.songkick_metro_area_id ?? "",
        )}" placeholder="" />
        ${helpFor("discovery.songkick_metro_area_id")}
      </label>

      <label class="field">
        <div class="label">Songkick days ahead</div>
        <input data-k="discovery.songkick_days_ahead" type="number" min="1" max="365" value="${Number(
          disc.songkick_days_ahead ?? 30,
        )}">
        ${helpFor("discovery.songkick_days_ahead")}
      </label>

      <label class="field">
        <div class="label">Songkick take artists (cap)</div>
        <input data-k="discovery.songkick_take_artists" type="number" min="1" max="500" value="${Number(
          disc.songkick_take_artists ?? 60,
        )}">
        ${helpFor("discovery.songkick_take_artists")}
      </label>
    </div>

    <div class="section-title">Recommendations (Spotify)</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Enabled</div>
        <select data-k="recommendations.enabled">
          <option value="true" ${reco.enabled === true ? "selected" : ""}>true</option>
          <option value="false" ${reco.enabled !== true ? "selected" : ""}>false</option>
        </select>
        ${helpFor("recommendations.enabled")}
      </label>

      <label class="field span2">
        <div class="label">Seed genres (comma)</div>
        <input data-k="recommendations.seed_genres" value="${escapeHtml(
          (reco.seed_genres || []).join(", "),
        )}" placeholder="rock, techno, ambient, ...">
        ${helpFor("recommendations.seed_genres")}
      </label>
    </div>

    <div class="section-title">Sources (fallback / pool)</div>
    <div class="formgrid">
      <label class="field span2">
        <div class="label">Search queries (comma)</div>
        <input data-k="sources.search" value="${escapeHtml(
          (sources.search || []).join(", "),
        )}">
        ${helpFor("sources.search")}
      </label>

      <label class="field span2">
        <div class="label">Playlists (IDs nebo URLs, comma)</div>
        <input data-k="sources.playlists" value="${escapeHtml(
          (sources.playlists || []).join(", "),
        )}">
        ${helpFor("sources.playlists")}
      </label>

      <label class="field">
        <div class="label">Liked tracks</div>
        <select data-k="sources.liked">
          <option value="true" ${
            sources.liked === true ? "selected" : ""
          }>true</option>
          <option value="false" ${
            sources.liked !== true ? "selected" : ""
          }>false</option>
        </select>
        ${helpFor("sources.liked")}
      </label>

      <label class="field">
        <div class="label">Max candidates</div>
        <input data-k="sources.max_candidates" type="number" min="50" max="10000" value="${Number(
          sources.max_candidates ?? 1500,
        )}">
        ${helpFor("sources.max_candidates")}
      </label>

      <label class="field">
        <div class="label">Top tracks enabled</div>
        <select data-k="sources.top_tracks.enabled">
          <option value="true" ${
            sources.top_tracks?.enabled !== false ? "selected" : ""
          }>true</option>
          <option value="false" ${
            sources.top_tracks?.enabled === false ? "selected" : ""
          }>false</option>
        </select>
        ${helpFor("sources.top_tracks.enabled")}
      </label>

      <label class="field">
        <div class="label">Top tracks time_range</div>
        <select data-k="sources.top_tracks.time_range">
          <option value="short_term" ${
            (sources.top_tracks?.time_range || "short_term") === "short_term"
              ? "selected"
              : ""
          }>short_term</option>
          <option value="medium_term" ${
            (sources.top_tracks?.time_range || "") === "medium_term"
              ? "selected"
              : ""
          }>medium_term</option>
          <option value="long_term" ${
            (sources.top_tracks?.time_range || "") === "long_term"
              ? "selected"
              : ""
          }>long_term</option>
        </select>
        ${helpFor("sources.top_tracks.time_range")}
      </label>

      <label class="field">
        <div class="label">Top tracks limit</div>
        <input data-k="sources.top_tracks.limit" type="number" min="1" max="50" value="${Number(
          sources.top_tracks?.limit ?? 50,
        )}">
        ${helpFor("sources.top_tracks.limit")}
      </label>
    </div>

    <div class="section-title">Filters</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Explicit</div>
        <select data-k="filters.explicit">
          <option value="allow" ${
            (filters.explicit || "allow") === "allow" ? "selected" : ""
          }>allow</option>
          <option value="exclude" ${
            (filters.explicit || "") === "exclude" ? "selected" : ""
          }>exclude</option>
          <option value="only" ${
            (filters.explicit || "") === "only" ? "selected" : ""
          }>only</option>
        </select>
        ${helpFor("filters.explicit")}
      </label>

      <label class="field">
        <div class="label">Year min</div>
        <input data-k="filters.year_min" type="number" value="${escapeHtml(
          filters.year_min ?? "",
        )}">
        ${helpFor("filters.year_min")}
      </label>

      <label class="field">
        <div class="label">Year max</div>
        <input data-k="filters.year_max" type="number" value="${escapeHtml(
          filters.year_max ?? "",
        )}">
        ${helpFor("filters.year_max")}
      </label>

      <label class="field">
        <div class="label">Tempo min (BPM)</div>
        <input data-k="filters.tempo_min" type="number" value="${escapeHtml(
          filters.tempo_min ?? "",
        )}">
        ${helpFor("filters.tempo_min")}
      </label>

      <label class="field">
        <div class="label">Tempo max (BPM)</div>
        <input data-k="filters.tempo_max" type="number" value="${escapeHtml(
          filters.tempo_max ?? "",
        )}">
        ${helpFor("filters.tempo_max")}
      </label>

      <label class="field">
        <div class="label">Genres mode</div>
        <select data-k="filters.genres_mode">
          <option value="ignore" ${
            (filters.genres_mode || "ignore") === "ignore" ? "selected" : ""
          }>ignore</option>
          <option value="include" ${
            (filters.genres_mode || "") === "include" ? "selected" : ""
          }>include</option>
          <option value="exclude" ${
            (filters.genres_mode || "") === "exclude" ? "selected" : ""
          }>exclude</option>
          <option value="include_exclude" ${
            (filters.genres_mode || "") === "include_exclude" ? "selected" : ""
          }>include_exclude</option>
        </select>
        ${helpFor("filters.genres_mode")}
      </label>

      <label class="field span2">
        <div class="label">Genres include (comma)</div>
        <input data-k="filters.genres_include" value="${escapeHtml(
          (filters.genres_include || []).join(", "),
        )}" placeholder="techno, ambient, indie pop">
        ${helpFor("filters.genres_include")}
      </label>

<label class="field">
  <div class="label">Allow unknown genres</div>
  <select data-k="filters.allow_unknown_genres">
    <option value="true" ${filters.allow_unknown_genres !== false ? "selected" : ""}>true</option>
    <option value="false" ${filters.allow_unknown_genres === false ? "selected" : ""}>false</option>
  </select>
  ${helpFor("filters.allow_unknown_genres")}
</label>


      <label class="field span2">
        <div class="label">Genres exclude (comma)</div>
        <input data-k="filters.genres_exclude" value="${escapeHtml(
          (filters.genres_exclude || []).join(", "),
        )}" placeholder="death metal, hardstyle">
        ${helpFor("filters.genres_exclude")}
      </label>

      <div class="field span2">
        <div class="label">Observed genres</div>

        <div class="gpPanel observedGenres" data-recipe-id="${escapeHtml(r.id)}">
  <div class="row" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
    <div style="font-weight:700;">Observed genres</div>

    <button class="btn ogReload" type="button">Load</button>

    <label style="opacity:.8;">min count</label>
    <select class="ogMinCount">
      <option value="1">1</option>
      <option value="2">2</option>
      <option value="3" selected>3</option>
      <option value="5">5</option>
    </select>

    <label style="opacity:.8;">limit</label>
    <select class="ogLimit">
      <option value="50">50</option>
      <option value="100">100</option>
      <option value="200" selected>200</option>
      <option value="500">500</option>
    </select>

    <input class="ogSearch" type="text" placeholder="search (e.g. trance)" style="flex:1; min-width:180px;" />

    <label style="opacity:.8;">mode</label>
    <select class="ogMode">
      <option value="include" selected>add to include</option>
      <option value="exclude">add to exclude</option>
    </select>
  </div>

  <div class="row" style="display:flex; gap:10px; align-items:center; margin-top:10px; flex-wrap:wrap;">
    <button class="btn ogAddSelectedInclude" type="button">Add selected → include</button>
    <button class="btn ogAddSelectedExclude" type="button">Add selected → exclude</button>
    <button class="btn ogClearSel" type="button">Clear selection</button>
    <div class="ogStatus" style="opacity:.8;"></div>
  </div>

  <div class="gpPills ogPills" style="margin-top:10px;"></div>
</div>


        
        
        

    
        ${helpFor("filters.allow_unknown_genres")}
      </div>

    </div>

    <div class="section-title">Diversity</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Max per artist</div>
        <input data-k="diversity.max_per_artist" type="number" min="1" max="50" value="${escapeHtml(
          diversity.max_per_artist ?? 2,
        )}">
        ${helpFor("diversity.max_per_artist")}
      </label>

      <label class="field">
        <div class="label">Max per album</div>
        <input data-k="diversity.max_per_album" type="number" min="1" max="50" value="${escapeHtml(
          diversity.max_per_album ?? "",
        )}">
        ${helpFor("diversity.max_per_album")}
      </label>

      <label class="field">
        <div class="label">Avoid same artist in row</div>
        <select data-k="diversity.avoid_same_artist_in_row">
          <option value="true" ${
            diversity.avoid_same_artist_in_row === true ? "selected" : ""
          }>true</option>
          <option value="false" ${
            diversity.avoid_same_artist_in_row !== true ? "selected" : ""
          }>false</option>
        </select>
        ${helpFor("diversity.avoid_same_artist_in_row")}
      </label>
    </div>

    <div class="section-title">Advanced</div>
    <div class="formgrid">
      <label class="field">
        <div class="label">Recommendation attempts</div>
        <input data-k="advanced.recommendation_attempts" type="number" min="1" max="50" value="${Number(
          adv.recommendation_attempts ?? 10,
        )}">
        ${helpFor("advanced.recommendation_attempts")}
      </label>
    </div>
  `;
}

function saveRecipeFromBlock(recipeId) {
  const r = getRecipeById(recipeId);
  if (!r) return;

  normalizeRecipe(r);

  const root = document.querySelector(
    `.recipeBlock[data-id="${CSS.escape(recipeId)}"]`,
  );
  if (!root) return;

  root.querySelectorAll("[data-k]").forEach((el) => {
    const k = el.getAttribute("data-k");
    let v = el.value;

    if (
      k === "sources.search" ||
      k === "sources.playlists" ||
      k === "filters.genres_include" ||
      k === "filters.genres_exclude"
    ) {
      setValueByPath(r, k, splitComma(v));
      return;
    }

    if (k === "recommendations.seed_genres") {
      setValueByPath(r, k, splitComma(v));
      return;
    }

    if (
      k === "enabled" ||
      k === "discovery.enabled" ||
      k === "discovery.use_tastedive" ||
      k === "history.enabled" ||
      k === "history.auto_flush.enabled" ||
      k === "discovery.use_audiodb_trending" ||
      k === "discovery.use_songkick_events" ||
      k === "discovery.include_seed_artists" ||
      k === "discovery.exclude_saved_tracks" ||
      k === "recommendations.enabled" ||
      k === "sources.liked" ||
      k === "sources.top_tracks.enabled" ||
      k === "diversity.avoid_same_artist_in_row" ||
      k === "filters.allow_unknown_genres"
    ) {
      setValueByPath(r, k, asBool(v));
      return;
    }

    if (
      k === "filters.year_min" ||
      k === "filters.year_max" ||
      k === "history.rolling_days" ||
      k === "history.auto_flush.threshold_pct" ||
      k === "history.auto_flush.min_pool" ||
      k === "filters.tempo_min" ||
      k === "filters.tempo_max" ||
      k === "discovery.min_track_popularity" ||
      k === "discovery.audiodb_fill" ||
      k === "discovery.songkick_metro_area_id" ||
      k === "discovery.songkick_days_ahead" ||
      k === "discovery.songkick_take_artists"
    ) {
      setValueByPath(r, k, toNumOrNull(v));
      return;
    }

    if (
      k === "track_count" ||
      k === "discovery.seed_top_artists_limit" ||
      k === "discovery.similar_per_seed" ||
      k === "discovery.take_artists" ||
      k === "discovery.tracks_per_artist" ||
      k === "discovery.max_track_popularity" ||
      k === "discovery.albums_per_artist" ||
      k === "discovery.albums_limit_fetch" ||
      k === "discovery.search_limit_per_track" ||
      k === "discovery.tastedive_limit" ||
      k === "discovery.audiodb_limit" ||
      k === "sources.max_candidates" ||
      k === "sources.top_tracks.limit" ||
      k === "diversity.max_per_artist" ||
      k === "diversity.max_per_album" ||
      k === "advanced.recommendation_attempts"
    ) {
      if (k === "diversity.max_per_album") {
        setValueByPath(r, k, toNumOrNull(v));
        return;
      }
      const n = Number(v);
      setValueByPath(r, k, Number.isFinite(n) ? n : 0);
      return;
    }

    setValueByPath(r, k, v);
  });

  // Keep legacy discovery.seed_top_artists in sync (optional)
  // so older builds / manual edits don't get confusing
  const d = r.discovery || {};
  d.seed_top_artists = {
    time_range: d.seed_top_artists_time_range,
    limit: d.seed_top_artists_limit,
  };

  // Remove accidental old keys if user had "limits"
  // (engine uses diversity, but we don't break the config)
}

/* ---------------- genre picker (Spotify seeds) ---------------- */

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function loadObservedGenres({ limit = 200, min_count = 3, q = "" } = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("min_count", String(min_count));
  if (q && String(q).trim()) params.set("q", String(q).trim());
  return api(`/api/genres/catalog?${params.toString()}`);
}

async function loadSpotifyGenreSeeds({ force = false } = {}) {
  const url = force
    ? "/api/spotify/genre-seeds?force=1"
    : "/api/spotify/genre-seeds";
  const data = await api(url);

  const genres = Array.isArray(data?.genres) ? data.genres : [];
  // Keep stable ordering for UI + search
  genres.sort((a, b) => String(a).localeCompare(String(b)));

  SPOTIFY_GENRE_SEEDS = genres;
  SPOTIFY_GENRE_SEEDS_META = {
    loaded_at: Date.now(),
    fetched_at: data?.fetched_at || null,
    cached: data?.cached === true,
    count: genres.length,
  };

  // Recompute auto roots after refresh
  AUTO_ROOTS_CACHE = null;

  return genres;
}

function getGenreListsFromBlock(block) {
  const incEl = block?.querySelector('input[data-k="filters.genres_include"]');
  const excEl = block?.querySelector('input[data-k="filters.genres_exclude"]');

  const include = splitComma(incEl?.value || "");
  const exclude = splitComma(excEl?.value || "");

  return { incEl, excEl, include, exclude };
}

function setGenreListsToBlock(block, include, exclude) {
  const { incEl, excEl } = getGenreListsFromBlock(block);

  const inc = uniqCaseInsensitive(include);
  const exc = uniqCaseInsensitive(exclude);

  if (incEl) incEl.value = inc.join(", ");
  if (excEl) excEl.value = exc.join(", ");

  // Helpful: if user starts selecting pills while mode is ignore,
  // auto-switch to a matching mode. But don't override when user already chose a mode.
  const modeEl = block?.querySelector('select[data-k="filters.genres_mode"]');
  if (modeEl) {
    const cur = String(modeEl.value || "ignore").toLowerCase();
    const computed =
      inc.length && exc.length
        ? "include_exclude"
        : inc.length
          ? "include"
          : exc.length
            ? "exclude"
            : "ignore";

    if (computed === "ignore") modeEl.value = "ignore";
    else if (cur === "ignore") modeEl.value = computed;
  }
}

function ensureGenreListContainers(block) {
  const { incEl, excEl } = getGenreListsFromBlock(block);
  if (!incEl || !excEl) return;

  let incBox = block.querySelector('[data-role="sid-genres-include-pills"]');
  let excBox = block.querySelector('[data-role="sid-genres-exclude-pills"]');

  if (!incBox) {
    incBox = document.createElement("div");
    incBox.className = "sidGenreList";
    incBox.setAttribute("data-role", "sid-genres-include-pills");
    incEl.insertAdjacentElement("afterend", incBox);
  }

  if (!excBox) {
    excBox = document.createElement("div");
    excBox.className = "sidGenreList";
    excBox.setAttribute("data-role", "sid-genres-exclude-pills");
    excEl.insertAdjacentElement("afterend", excBox);
  }
}

function removeGenreFromList(block, genre, kind /* include|exclude */) {
  const g = String(genre || "")
    .trim()
    .toLowerCase();
  if (!g) return false;

  const { include, exclude } = getGenreListsFromBlock(block);

  const inc = Array.isArray(include) ? include : [];
  const exc = Array.isArray(exclude) ? exclude : [];

  const inc2 = inc.filter(
    (x) =>
      String(x || "")
        .trim()
        .toLowerCase() !== g,
  );
  const exc2 = exc.filter(
    (x) =>
      String(x || "")
        .trim()
        .toLowerCase() !== g,
  );

  if (kind === "include") {
    if (inc2.length === inc.length) return false;
    setGenreListsToBlock(block, inc2, exc);
    return true;
  }

  if (exc2.length === exc.length) return false;
  setGenreListsToBlock(block, inc, exc2);
  return true;
}

function renderGenreLists(block) {
  if (!block) return;
  ensureGenreListContainers(block);

  const { include, exclude } = getGenreListsFromBlock(block);
  const incBox = block.querySelector('[data-role="sid-genres-include-pills"]');
  const excBox = block.querySelector('[data-role="sid-genres-exclude-pills"]');
  if (!incBox || !excBox) return;

  incBox.innerHTML = "";
  excBox.innerHTML = "";

  for (const g of include || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill gpPill ok sidGenreChip";
    btn.innerHTML = `${escapeHtml(g)} <span class="sidX">×</span>`;
    btn.title = "Remove from include";
    btn.addEventListener("click", () => {
      const changed = removeGenreFromList(block, g, "include");
      flashEl(btn, changed ? "ok" : "no");
      const gp = block.querySelector(".genrePicker");
      if (gp) populateGenrePicker(gp);
      const og = block.querySelector(".observedGenres");
      if (og) updateObservedPillClasses(og, block);
      renderGenreLists(block);
    });
    incBox.appendChild(btn);
  }

  for (const g of exclude || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill gpPill err sidGenreChip";
    btn.innerHTML = `${escapeHtml(g)} <span class="sidX">×</span>`;
    btn.title = "Remove from exclude";
    btn.addEventListener("click", () => {
      const changed = removeGenreFromList(block, g, "exclude");
      flashEl(btn, changed ? "err" : "no");
      const gp = block.querySelector(".genrePicker");
      if (gp) populateGenrePicker(gp);
      const og = block.querySelector(".observedGenres");
      if (og) updateObservedPillClasses(og, block);
      renderGenreLists(block);
    });
    excBox.appendChild(btn);
  }
}

function wireGenreListInputs() {
  const blocks = document.querySelectorAll(".recipeBlock");
  for (const block of blocks) {
    const { incEl, excEl } = getGenreListsFromBlock(block);
    if (!incEl || !excEl) continue;

    ensureGenreListContainers(block);
    renderGenreLists(block);

    incEl.addEventListener("input", () => renderGenreLists(block));
    excEl.addEventListener("input", () => renderGenreLists(block));
  }
}

function genreState(genre, include, exclude) {
  const g = String(genre || "")
    .trim()
    .toLowerCase();
  if (!g) return 0;
  if (
    (include || []).some(
      (x) =>
        String(x || "")
          .trim()
          .toLowerCase() === g,
    )
  )
    return 1;
  if (
    (exclude || []).some(
      (x) =>
        String(x || "")
          .trim()
          .toLowerCase() === g,
    )
  )
    return -1;
  return 0;
}

function setGenreInBlock(block, genre, target /* "include" | "exclude" */) {
  const g = String(genre || "")
    .trim()
    .toLowerCase();
  if (!g) return false;

  const { include, exclude } = getGenreListsFromBlock(block);

  const inc = Array.isArray(include)
    ? include.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const exc = Array.isArray(exclude)
    ? exclude.map((x) => String(x).trim()).filter(Boolean)
    : [];

  const hasInc = inc.some((x) => x.toLowerCase() === g);
  const hasExc = exc.some((x) => x.toLowerCase() === g);

  let changed = false;

  if (target === "include") {
    if (!hasInc) {
      inc.push(genre);
      changed = true;
    }
    if (hasExc) {
      const next = exc.filter((x) => x.toLowerCase() !== g);
      if (next.length !== exc.length) changed = true;
      setGenreListsToBlock(block, inc, next);
      return changed;
    }
    setGenreListsToBlock(block, inc, exc);
    return changed;
  }

  // target === "exclude"
  if (!hasExc) {
    exc.push(genre);
    changed = true;
  }
  if (hasInc) {
    const next = inc.filter((x) => x.toLowerCase() !== g);
    if (next.length !== inc.length) changed = true;
    setGenreListsToBlock(block, next, exc);
    return changed;
  }
  setGenreListsToBlock(block, inc, exc);
  return changed;
}

// ignore -> include -> exclude -> ignore
function toggleGenreInBlock(block, genre) {
  const g = String(genre || "").trim();
  if (!g) return;

  const { include, exclude } = getGenreListsFromBlock(block);

  const lower = g.toLowerCase();
  const hasInc = include.some(
    (x) =>
      String(x || "")
        .trim()
        .toLowerCase() === lower,
  );
  const hasExc = exclude.some(
    (x) =>
      String(x || "")
        .trim()
        .toLowerCase() === lower,
  );

  // remove from both first
  const inc2 = include.filter(
    (x) =>
      String(x || "")
        .trim()
        .toLowerCase() !== lower,
  );
  const exc2 = exclude.filter(
    (x) =>
      String(x || "")
        .trim()
        .toLowerCase() !== lower,
  );

  if (!hasInc && !hasExc) {
    // -> include
    inc2.push(g);
  } else if (hasInc) {
    // include -> exclude
    exc2.push(g);
  } else {
    // exclude -> ignore (already removed)
  }

  setGenreListsToBlock(block, inc2, exc2);
}

function countSeedsForRoot(root) {
  if (!Array.isArray(SPOTIFY_GENRE_SEEDS) || !SPOTIFY_GENRE_SEEDS.length)
    return null;

  const rn = normalizeForMatch(root);
  if (!rn) return null;

  let c = 0;
  for (const s of SPOTIFY_GENRE_SEEDS) {
    const sn = normalizeForMatch(s);
    if (!sn) continue;
    if (sn.includes(rn) || rn.includes(sn)) c += 1;
  }
  return c;
}

function populateGenrePicker(gp) {
  if (!gp) return;

  const block = gp.closest(".recipeBlock");
  const statusEl = gp.querySelector('[data-gp-role="status"]');
  const rootsEl = gp.querySelector('[data-gp-role="roots"]');
  const seedsEl = gp.querySelector('[data-gp-role="seeds"]');
  const searchEl = gp.querySelector('[data-gp-role="search"]');
  const rootModeEl = gp.querySelector(
    'select[data-k="filters.genres_root_mode"]',
  );

  const { include, exclude } = getGenreListsFromBlock(block);

  // Status
  if (!Array.isArray(SPOTIFY_GENRE_SEEDS) || !SPOTIFY_GENRE_SEEDS.length) {
    if (statusEl) {
      statusEl.className = "pill warn";
      statusEl.textContent = "not loaded";
    }
    if (rootsEl) {
      const roots = getRootsByMode(rootModeEl?.value || "curated");
      rootsEl.innerHTML = roots
        .map((g) => {
          const st = genreState(g, include, exclude);
          const cls = st === 1 ? "ok" : st === -1 ? "err" : "";
          return `<button type="button" class="pill gpPill ${cls}" data-genre="${escapeHtml(
            g,
          )}">${escapeHtml(g)}</button>`;
        })
        .join("");
    }
    if (seedsEl) {
      seedsEl.innerHTML = `<div class="muted small">Load Spotify genre seeds to get a full searchable list.</div>`;
    }
    return;
  }

  if (statusEl) {
    statusEl.className = "pill ok";
    const cached = SPOTIFY_GENRE_SEEDS_META.cached ? "cached" : "live";
    const when = SPOTIFY_GENRE_SEEDS_META.fetched_at
      ? new Date(SPOTIFY_GENRE_SEEDS_META.fetched_at).toLocaleString()
      : "-";
    statusEl.textContent = `genres: ${SPOTIFY_GENRE_SEEDS_META.count} (${cached}) • ${when}`;
  }

  // Roots
  const roots = getRootsByMode(rootModeEl?.value || "curated");
  if (rootsEl) {
    rootsEl.innerHTML = roots
      .map((g) => {
        const st = genreState(g, include, exclude);
        const cls = st === 1 ? "ok" : st === -1 ? "err" : "";
        const c = countSeedsForRoot(g);
        const cnt = Number.isFinite(Number(c))
          ? `<span class="gpCount">${Number(c)}</span>`
          : "";
        return `<button type="button" class="pill gpPill ${cls}" data-genre="${escapeHtml(
          g,
        )}">${escapeHtml(g)}${cnt}</button>`;
      })
      .join("");
  }

  // Seeds list
  const qRaw = String(searchEl?.value || "").trim();
  const q = normalizeForMatch(qRaw);

  let matches = SPOTIFY_GENRE_SEEDS;
  if (q) {
    matches = SPOTIFY_GENRE_SEEDS.filter((g) =>
      normalizeForMatch(g).includes(q),
    );
  }

  const limit = 220;
  const shown = matches.slice(0, limit);

  const hint = q
    ? `Matches: ${shown.length}/${matches.length}`
    : `Showing: ${shown.length}/${SPOTIFY_GENRE_SEEDS.length}`;

  if (seedsEl) {
    seedsEl.innerHTML = `
      <div class="gpHint">${escapeHtml(hint)}</div>
      ${shown
        .map((g) => {
          const st = genreState(g, include, exclude);
          const cls = st === 1 ? "ok" : st === -1 ? "err" : "";
          return `<button type="button" class="pill gpPill ${cls}" data-genre="${escapeHtml(
            g,
          )}">${escapeHtml(g)}</button>`;
        })
        .join("")}
    `;
  }
}

function wireGenrePickers() {
  document.querySelectorAll(".genrePicker").forEach((gp) => {
    // always refresh content (e.g., after SaveOne or manual edits)
    populateGenrePicker(gp);

    if (gp.dataset.wired === "1") return;
    gp.dataset.wired = "1";

    const block = gp.closest(".recipeBlock");

    // Search filter
    const searchEl = gp.querySelector('[data-gp-role="search"]');
    if (searchEl) {
      searchEl.addEventListener(
        "input",
        debounce(() => populateGenrePicker(gp), 120),
      );
    }

    // Root mode changes re-render roots
    const rootModeEl = gp.querySelector(
      'select[data-k="filters.genres_root_mode"]',
    );
    if (rootModeEl) {
      rootModeEl.addEventListener("change", () => {
        AUTO_ROOTS_CACHE = null;
        populateGenrePicker(gp);
      });
    }

    // Manual input edits -> repaint pill states
    const incEl = block?.querySelector(
      'input[data-k="filters.genres_include"]',
    );
    const excEl = block?.querySelector(
      'input[data-k="filters.genres_exclude"]',
    );
    if (incEl) incEl.addEventListener("change", () => populateGenrePicker(gp));
    if (excEl) excEl.addEventListener("change", () => populateGenrePicker(gp));

    gp.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-gp-action]");
      if (btn) {
        const action = btn.getAttribute("data-gp-action");
        try {
          if (action === "load") {
            await loadSpotifyGenreSeeds({ force: false });
            setMsg("Genre seeds loaded from Spotify.", "ok");
            populateGenrePicker(gp);
          }
          if (action === "refresh") {
            await loadSpotifyGenreSeeds({ force: true });
            setMsg("Genre seeds refreshed from Spotify.", "ok");
            populateGenrePicker(gp);
          }
        } catch (err) {
          setMsg(
            `Genre seeds fetch failed: ${safeStr(err?.body || err?.message)}`,
            "err",
          );
        }
        return;
      }

      const pill = e.target.closest("button.gpPill");
      if (pill) {
        const genre = pill.getAttribute("data-genre");
        toggleGenreInBlock(block, genre);
        populateGenrePicker(gp);
      }
    });
  });
}

function updateObservedPillClasses(panel, recipeBlock) {
  if (!panel || !recipeBlock) return;

  const { include, exclude } = getGenreListsFromBlock(recipeBlock);

  for (const pill of panel.querySelectorAll(".ogPill")) {
    const name = pill.dataset.genre;
    const st = genreState(name, include, exclude);

    pill.classList.remove("ok", "err");
    if (st === 1) pill.classList.add("ok");
    if (st === -1) pill.classList.add("err");
  }
}

function renderObservedPills(panel, items) {
  const pills = panel.querySelector(".ogPills");
  const status = panel.querySelector(".ogStatus");
  pills.innerHTML = "";

  if (!items || !items.length) {
    status.textContent = "No genres (try lower min count or clear search).";
    return;
  }

  status.textContent = `Loaded ${items.length} genres. Click to add (mode) or Shift+click to select for bulk.`;

  for (const it of items) {
    const name = it.name;
    const count = it.count;

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "gpPill ogPill";
    pill.dataset.genre = name;
    pill.dataset.count = String(count);
    pill.dataset.selected = "0";
    pill.textContent = `${name} (${count})`;

    pill.addEventListener("click", (ev) => {
      const mode = panel.querySelector(".ogMode")?.value || "include";

      // SHIFT = toggle selection for bulk
      if (ev.shiftKey) {
        const sel = pill.dataset.selected === "1";
        pill.dataset.selected = sel ? "0" : "1";
        pill.style.outline = sel ? "" : "2px solid rgba(255,255,255,0.25)";
        return;
      }

      // normal click = import immediately
      const recipeBlock = panel.closest(".recipeBlock");
      if (!recipeBlock) return;

      const changed = setGenreInBlock(recipeBlock, name, mode);

      // vizuální feedback (include zeleně, exclude červeně, už existuje = šedě)
      flashEl(pill, changed ? (mode === "include" ? "ok" : "err") : "no");

      // refresh UI: remove pills, seed picker, obarvení observed
      renderGenreLists(recipeBlock);

      const gp = recipeBlock.querySelector(".genrePicker");
      if (gp) populateGenrePicker(gp);

      updateObservedPillClasses(panel, recipeBlock);

      status.textContent = changed
        ? `Added "${name}" to ${mode}. Shift+click selects for bulk.`
        : `"${name}" already in ${mode}. Shift+click selects for bulk.`;
    });

    pills.appendChild(pill);
  }

  // initial coloring according to include/exclude lists
  const recipeBlock = panel.closest(".recipeBlock");
  if (recipeBlock) updateObservedPillClasses(panel, recipeBlock);
}

async function refreshObservedPanel(panel) {
  const status = panel.querySelector(".ogStatus");
  const limit = Number(panel.querySelector(".ogLimit")?.value || 200);
  const min_count = Number(panel.querySelector(".ogMinCount")?.value || 3);
  const q = String(panel.querySelector(".ogSearch")?.value || "").trim();

  status.textContent = "Loading observed genres...";

  try {
    const out = await loadObservedGenres({ limit, min_count, q });
    renderObservedPills(panel, out.items || []);
  } catch (e) {
    status.textContent = `Failed to load: ${e?.message || e}`;
  }
}

function getSelectedObserved(panel) {
  return Array.from(panel.querySelectorAll(".ogPill"))
    .filter((p) => p.dataset.selected === "1")
    .map((p) => p.dataset.genre)
    .filter(Boolean);
}

function clearSelectionObserved(panel) {
  for (const p of panel.querySelectorAll(".ogPill")) {
    p.dataset.selected = "0";
    p.style.outline = "";
  }
}

function wireObservedGenrePanels() {
  const panels = document.querySelectorAll(".observedGenres");
  for (const panel of panels) {
    const reloadBtn = panel.querySelector(".ogReload");
    const minCountSel = panel.querySelector(".ogMinCount");
    const limitSel = panel.querySelector(".ogLimit");
    const searchInp = panel.querySelector(".ogSearch");
    const addIncBtn = panel.querySelector(".ogAddSelectedInclude");
    const addExcBtn = panel.querySelector(".ogAddSelectedExclude");
    const clearBtn = panel.querySelector(".ogClearSel");

    // debounce search
    let t = null;
    const scheduleRefresh = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => refreshObservedPanel(panel), 250);
    };

    reloadBtn?.addEventListener("click", () => refreshObservedPanel(panel));
    minCountSel?.addEventListener("change", () => refreshObservedPanel(panel));
    limitSel?.addEventListener("change", () => refreshObservedPanel(panel));
    searchInp?.addEventListener("input", scheduleRefresh);

    addIncBtn?.addEventListener("click", () => {
      const sel = getSelectedObserved(panel);
      const recipeBlock = panel.closest(".recipeBlock");

      if (!recipeBlock) return;

      let changedAny = false;
      for (const g of sel)
        changedAny = setGenreInBlock(recipeBlock, g, "include") || changedAny;

      panel.querySelector(".ogStatus").textContent = changedAny
        ? `Added ${sel.length} genres to include.`
        : `Nothing changed.`;

      clearSelectionObserved(panel);
    });

    addExcBtn?.addEventListener("click", () => {
      const sel = getSelectedObserved(panel);
      if (!sel.length) return;
      const recipeBlock = panel.closest(".recipeBlock");

      if (!recipeBlock) return;

      let changedAny = false;
      for (const g of sel)
        changedAny = setGenreInBlock(recipeBlock, g, "exclude") || changedAny;

      panel.querySelector(".ogStatus").textContent = changedAny
        ? `Added ${sel.length} genres to exclude.`
        : `Nothing changed.`;

      clearSelectionObserved(panel);
    });

    clearBtn?.addEventListener("click", () => {
      clearSelectionObserved(panel);
      panel.querySelector(".ogStatus").textContent = "Selection cleared.";
    });

    // auto-load once when panel is wired
    refreshObservedPanel(panel);
  }
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
      normalizeRecipe(r);

      const isOpen = r.id === openId;
      const isRawOpen = !!RAW_OPEN[r.id];
      const name = escapeHtml(r.name || "Recipe");
      const pid = escapeHtml(r.target_playlist_id || "");
      const caret = isOpen ? "▾" : "▸";

      return `
        <div class="recipeBlock ${isOpen ? "open" : ""}" data-id="${escapeHtml(
          r.id,
        )}">
          <button class="recipeHead" type="button" data-action="toggle" data-id="${escapeHtml(
            r.id,
          )}">
            <div class="rhLeft">
              <div class="rhTitle">
                <span class="caret">${caret}</span>
                <span class="titleText">${name}</span>
              </div>
              <div class="rhMeta">
                <span class="mono">${escapeHtml(r.id)}</span>
                ${
                  pid
                    ? `<span class="dot">•</span><span class="mono">${pid}</span>`
                    : ""
                }
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
                <button data-action="dup" data-id="${escapeHtml(r.id)}">Kopírovat</button>
                <button data-action="rawtoggle" data-id="${escapeHtml(r.id)}">RAW</button>
                <button class="danger" data-action="clearhist" data-id="${escapeHtml(r.id)}">Vymazat historii</button>
                <button class="danger" data-action="delete" data-id="${escapeHtml(r.id)}">Smazat</button>
                <button data-action="runone" data-id="${escapeHtml(r.id)}">Spustit jen tento</button>
                <button class="primary" data-action="saveone" data-id="${escapeHtml(r.id)}">Uložit recept</button>
              </div>
            </div>

            <div class="rawBox" ${
              isRawOpen ? "" : 'style="display:none"'
            } data-rawbox-id="${escapeHtml(r.id)}">
              <div class="small muted" style="margin:10px 0 6px">
                RAW JSON (zkopíruj / pošli / uprav a dej „Použít“)
              </div>

              <textarea class="rawTextarea" data-raw-text data-id="${escapeHtml(
                r.id,
              )}" spellcheck="false">${escapeHtml(
                JSON.stringify(r, null, 2),
              )}</textarea>

              <div class="btns" style="margin-top:8px">
                <button data-action="rawcopy" data-id="${escapeHtml(
                  r.id,
                )}">Kopírovat</button>
                <button class="primary" data-action="rawapply" data-id="${escapeHtml(
                  r.id,
                )}">Použít</button>
              </div>

              <div class="hr" style="margin-top:12px"></div>
            </div>

            ${renderRecipeEditor(r)}
          </div>
        </div>
      `;
    })
    .join("");

  // wire actions
  list.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const action = el.getAttribute("data-action");
      const id = el.getAttribute("data-id");
      if (!id) return;

      // RAW toggle (jen UI, žádné ukládání)
      if (action === "rawtoggle") {
        RAW_OPEN[id] = !RAW_OPEN[id];
        renderAccordion();
        return;
      }

      // Copy RAW JSON
      if (action === "rawcopy") {
        const ta = document.querySelector(
          `textarea[data-raw-text][data-id="${CSS.escape(id)}"]`,
        );
        const txt = ta?.value || "";
        if (!txt.trim()) {
          setMsg("RAW JSON je prázdný.", "warn");
          return;
        }

        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(txt);
          } else {
            ta?.focus();
            ta?.select();
            document.execCommand("copy");
          }
          setMsg("Zkopírováno do schránky.", "ok");
        } catch (err) {
          setMsg("Kopírování selhalo.", "err");
        }
        return;
      }

      // Apply RAW JSON -> přepíše recipe v CURRENT_CONFIG a rerender
      if (action === "rawapply") {
        const ta = document.querySelector(
          `textarea[data-raw-text][data-id="${CSS.escape(id)}"]`,
        );
        const txt = ta?.value || "";

        let obj;
        try {
          obj = JSON.parse(txt);
        } catch (err) {
          setMsg("Neplatný JSON (nejde parsovat).", "err");
          return;
        }

        const newId = String(obj?.id || "").trim();
        if (!newId) {
          setMsg("RAW JSON musí obsahovat pole 'id'.", "err");
          return;
        }

        const idx = (CURRENT_CONFIG.recipes || []).findIndex(
          (x) => x.id === id,
        );
        if (idx < 0) {
          setMsg("Recipe nenalezen (v UI).", "err");
          return;
        }

        if (newId !== id) {
          const collision = (CURRENT_CONFIG.recipes || []).some(
            (x) => x.id === newId && x.id !== id,
          );
          if (collision) {
            setMsg(`ID '${newId}' už existuje.`, "err");
            return;
          }
          if (
            !confirm(
              `Měníš id receptu:\n\n${id} → ${newId}\n\nChceš pokračovat?`,
            )
          ) {
            return;
          }
        }

        try {
          normalizeRecipe(obj);
          CURRENT_CONFIG.recipes[idx] = obj;

          // přenést RAW state při změně id
          if (newId !== id) {
            RAW_OPEN[newId] = RAW_OPEN[id];
            delete RAW_OPEN[id];
            if (openId === id) openId = newId;
          }

          renderAccordion();
          setMsg("Recipe přepsán z RAW JSON. Nezapomeň Save all.", "ok");
        } catch (err) {
          setMsg(`Normalize selhalo: ${safeStr(err?.message || err)}`, "err");
        }
        return;
      }

      if (action === "toggle") {
        openId = openId === id ? null : id;
        renderAccordion();

        if (openId === id) {
          const block = document.querySelector(
            `.recipeBlock[data-id="${CSS.escape(id)}"]`,
          );
          block?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }

      if (action === "runone") {
        const r = getRecipeById(id);
        const title = r?.name || id;

        // Promítni změny z aktuálně otevřeného editoru do CURRENT_CONFIG (jen lokálně)
        if (openId) saveRecipeFromBlock(openId);

        // Detekce neuložených změn oproti server snapshotu
        const hasUnsaved =
          SERVER_CONFIG_SNAPSHOT &&
          JSON.stringify(CURRENT_CONFIG) !== SERVER_CONFIG_SNAPSHOT;

        if (hasUnsaved) {
          let choice = "cancel";
          try {
            choice = await promptUnsavedRun();
          } catch {
            choice = "cancel";
          }

          if (choice === "cancel") {
            setMsg("Zrušeno.", "ok");
            return;
          }

          if (choice === "save_run") {
            try {
              await saveAll(); // uloží na server + aktualizuje snapshot (díky kroku #3)
            } catch (e) {
              setMsg(
                `Save all failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
                "err",
              );
              return;
            }
          }
        }

        try {
          setMsg("", "");
          $("logBox").textContent = "";
          lastLogI = 0;

          startPolling();

          await runOne(id);

          await pollLogs();
          await loadStatus();

          setMsg(
            `Spuštěno: jen tento recept (${safeStr(title)}). Viz logy výše.`,
            "ok",
          );
        } catch (e) {
          await pollLogs();
          await loadStatus().catch(() => {});
          setMsg(
            `Run failed: ${e.status || ""} ${safeStr(e.body || e.message)}`,
            "err",
          );
        }
        return;
      }

      if (action === "saveone") {
        saveRecipeFromBlock(id);
        setMsg("Recipe uložen do UI. Teď dej Save all.", "ok");
        renderAccordion();
        return;
      }

      if (action === "clearhist") {
        const r = getRecipeById(id);
        if (!r) return;

        const title = r.name || r.id;
        if (!confirm(`Smazat historii jen pro recipe "${title}"?`)) return;

        try {
          await api("/api/history/clear-scope", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ history_scope: "recipe", recipe_id: id }),
          });
          setMsg(`Historie pro "${title}" smazána.`, "ok");
        } catch (err) {
          setMsg(
            `Smazání historie selhalo: ${err.status || ""} ${safeStr(
              err.body || err.message,
            )}`,
            "err",
          );
        }
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

        saveRecipeFromBlock(id);

        const copy = JSON.parse(JSON.stringify(r));
        copy.id = "r_" + rid();
        copy.name = (copy.name || "Recipe") + " (copy)";
        normalizeRecipe(copy);

        CURRENT_CONFIG.recipes.push(copy);

        openId = copy.id;
        renderAccordion();
        setMsg("Recipe zduplikován. Nezapomeň Save all.", "ok");
        return;
      }
    });
  });

  // Wire & populate per-recipe genre picker UI
  wireObservedGenrePanels();
  wireGenreListInputs();
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

$("btnClearHistoryGlobal").addEventListener("click", async () => {
  if (!confirm("Clear GLOBAL history (shared across recipes)?")) return;
  try {
    await api("/api/history/clear-scope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history_scope: "global" }),
    });
    setMsg("Global history cleared.", "ok");
  } catch (e) {
    setMsg(
      `Clear global history failed: ${e.status || ""} ${safeStr(
        e.body || e.message,
      )}`,
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
