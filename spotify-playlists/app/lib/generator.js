// app/lib/generator.js
// Generator with:
// - Spotify API retry/backoff on 429/5xx
// - Optional Last.fm discovery via LASTFM_API_KEY
// - Discovery strategies: deep_cuts / recent_albums / lastfm_toptracks
// - Spotify Recommendations (seed genres + tempo) for freshness
// - Optional exclude of saved tracks for discovery ("unknown" feeling)
// - Fallback to configured Spotify sources pool
// - No-repeat via excludedSet
// - Diversity constraints enforced ACROSS the whole final list:
//   max_per_artist, max_per_album, avoid_same_artist_in_row
// - Tempo filtering via Spotify audio features when needed

const { loadCatalog, observeGenres, saveCatalog } = require("./genre_catalog");
const {
  loadArtistGenresMap,
  mergeFromGenresMap,
  saveArtistGenresStore,
} = require("./artist_genres_cache");

const LOG_RANK = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
function normLevel(x) {
  const s = String(x || "info").toLowerCase();
  return LOG_RANK[s] ? s : "info";
}
function rank(level) {
  return LOG_RANK[normLevel(level)] ?? LOG_RANK.info;
}
function shouldLog(level) {
  const cur = normLevel(process.env.LOG_LEVEL || "info");
  return rank(level) >= rank(cur);
}
function genLog(level, meta, msg) {
  if (!shouldLog(level)) return;
  const rid = meta?.recipe_id || meta?.recipe?.id || "-";
  console.log(`[gen][${normLevel(level)}][${rid}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function spRetry(
  fn,
  { maxRetries = 6, baseDelayMs = 400, label = "", meta = null } = {},
) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.statusCode || e?.status;
      const headers = e?.headers || e?.response?.headers;
      const ra = headers?.["retry-after"] || headers?.["Retry-After"];

      // Retry-After is seconds per spec, but be tolerant if already ms
      let retryAfterMs = null;
      if (ra != null) {
        const n = Number(ra);
        if (Number.isFinite(n)) retryAfterMs = n > 1000 ? n : n * 1000;
      }

      const isRetryable =
        status === 429 || status === 502 || status === 503 || status === 504;

      if (!isRetryable || attempt >= maxRetries) {
        genLog(
          "debug",
          meta,
          `spRetry FAIL ${label ? `[${label}] ` : ""}status=${status ?? "?"} attempt=${attempt}/${maxRetries} retryable=${isRetryable ? 1 : 0}`,
        );
        throw e;
      }

      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
      const waitMs = retryAfterMs ?? backoff;

      if (status === 429) {
        genLog(
          "trace",
          meta,
          `spRetry 429 ${label ? `[${label}] ` : ""}attempt=${attempt + 1}/${maxRetries} retryAfter=${Math.round(waitMs / 1000)}s (${waitMs}ms)`,
        );
      } else {
        genLog(
          "debug",
          meta,
          `spRetry HTTP ${status} ${label ? `[${label}] ` : ""}attempt=${attempt + 1}/${maxRetries} waitMs=${waitMs}`,
        );
      }

      await sleep(waitMs);
      attempt += 1;
    }
  }
}

function stepsOn(meta) {
  // 1) prefer flag poslaný ze serveru (podle log_level)
  if (meta?.debugSteps === true) return true;
  // 2) fallback pro lokální dev
  return process.env.DEBUG_STEPS === "1";
}

function step(meta, msg) {
  if (!stepsOn(meta)) return;
  const ts = new Date().toISOString();
  const rid = meta?.recipe_id || "-";
  console.log(`[steps] ${ts} [${rid}] ${msg}`);
}

async function timeStep(meta, label, fn) {
  const t0 = Date.now();
  step(meta, `START ${label}`);
  try {
    return await fn();
  } finally {
    step(meta, `END   ${label} (+${Date.now() - t0}ms)`);
  }
}

async function httpJsonRetry(url, { maxRetries = 5, baseDelayMs = 500 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          accept: "application/json",
          "user-agent": "spotify-playlists-ha-addon/1.0",
        },
      });

      // retry na rate-limit / 5xx
      if (r.status === 429 || r.status >= 500) {
        const ra = r.headers.get("retry-after");
        const retryAfterMs = ra ? Number(ra) * 1000 : null;

        if (attempt >= maxRetries) {
          const body = await r.text().catch(() => "");
          throw new Error(
            `HTTP ${r.status} (retries exhausted) for ${url}: ${body.slice(0, 300)}`,
          );
        }

        const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
        await sleep(retryAfterMs ?? backoff);
        attempt += 1;
        continue;
      }

      const body = await r.text().catch(() => "");

      if (!r.ok) {
        throw new Error(`HTTP ${r.status} for ${url}: ${body.slice(0, 300)}`);
      }

      try {
        return JSON.parse(body || "{}");
      } catch {
        throw new Error(
          `Invalid JSON for ${url}: ${(body || "").slice(0, 300)}`,
        );
      }
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
      await sleep(backoff);
      attempt += 1;
    }
  }
}

function parsePlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  return m ? m[1] : s;
}

function parseYearFromReleaseDate(rd) {
  if (!rd) return null;
  const m = String(rd).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const k = String(x || "").trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function uniqIds(ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids || []) {
    if (!id) continue;
    const s = String(id);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function getRecipeSources(recipe) {
  const src = recipe.sources || {};
  return {
    playlists: Array.isArray(src.playlists) ? src.playlists : [],
    search: Array.isArray(src.search) ? src.search : [],
    liked: Boolean(src.liked),
    top_tracks:
      src.top_tracks && typeof src.top_tracks === "object"
        ? src.top_tracks
        : null,
    max_candidates: Number(src.max_candidates || 1500),
  };
}

function getRecipeFilters(recipe) {
  const f = recipe.filters || {};
  const explicitPolicy = String(f.explicit ?? "allow").toLowerCase(); // allow|exclude|only

  // Genre filtering is based on Spotify *artist* genres.
  // mode:
  // - ignore: do not fetch genres / do not filter
  // - include: keep only tracks where artist genres match any include
  // - exclude: remove tracks where artist genres match any exclude
  // - include_exclude: apply both rules
  const genresMode = String(f.genres_mode ?? "ignore").toLowerCase();
  const genresInclude = Array.isArray(f.genres_include)
    ? f.genres_include
    : typeof f.genres_include === "string"
      ? String(f.genres_include)
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
  const genresExclude = Array.isArray(f.genres_exclude)
    ? f.genres_exclude
    : typeof f.genres_exclude === "string"
      ? String(f.genres_exclude)
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];

  // If true, tracks where we fail to determine artist genres may still pass
  // include/include_exclude filters.
  const allowUnknownGenres =
    f.allow_unknown_genres === undefined || f.allow_unknown_genres === null
      ? true
      : f.allow_unknown_genres === true ||
        f.allow_unknown_genres === "true" ||
        f.allow_unknown_genres === "1" ||
        f.allow_unknown_genres === 1;

  return {
    explicit: explicitPolicy,
    year_min:
      f.year_min === null || f.year_min === "" || f.year_min === undefined
        ? null
        : Number(f.year_min),
    year_max:
      f.year_max === null || f.year_max === "" || f.year_max === undefined
        ? null
        : Number(f.year_max),
    tempo_min:
      f.tempo_min === null || f.tempo_min === "" || f.tempo_min === undefined
        ? null
        : Number(f.tempo_min),
    tempo_max:
      f.tempo_max === null || f.tempo_max === "" || f.tempo_max === undefined
        ? null
        : Number(f.tempo_max),

    genres_mode: genresMode,
    genres_include: genresInclude,
    genres_exclude: genresExclude,
    allow_unknown_genres: allowUnknownGenres,
  };
}

function getRecipeLimits(recipe) {
  const d = recipe.diversity || {};
  const maxPerArtist = d.max_per_artist ?? null;
  const maxPerAlbum = d.max_per_album ?? null;
  const avoidSameArtistInRow = d.avoid_same_artist_in_row ?? false;

  return {
    max_per_artist:
      maxPerArtist === null || maxPerArtist === "" || maxPerArtist === undefined
        ? null
        : Number(maxPerArtist),
    max_per_album:
      maxPerAlbum === null || maxPerAlbum === "" || maxPerAlbum === undefined
        ? null
        : Number(maxPerAlbum),
    avoid_same_artist_in_row: Boolean(avoidSameArtistInRow),
  };
}

function getAdvanced(recipe) {
  const a = recipe.advanced || {};
  return {
    recommendation_attempts: Number(a.recommendation_attempts ?? 10),
  };
}

function getRecommendationsCfg(recipe) {
  const r = recipe.recommendations || {};
  return {
    enabled: Boolean(r.enabled),
    seed_genres: Array.isArray(r.seed_genres) ? r.seed_genres : [],
    // legacy path (some older configs might have it elsewhere)
    legacy_seed_genres: Array.isArray(recipe?.source?.seed_genres)
      ? recipe.source.seed_genres
      : [],
  };
}

function getDiscovery(recipe) {
  const d = recipe.discovery || {};
  return {
    enabled: Boolean(d.enabled),

    // Strategy:
    // - "deep_cuts" (default): take album tracks + shuffle
    // - "recent_albums": take newest albums/singles tracks first
    // - "lastfm_toptracks": last.fm top tracks -> spotify search
    strategy: String(d.strategy ?? "deep_cuts"),

    // Seed artists from Spotify top artists
    seed_top_artists_limit: Number(
      d.seed_top_artists_limit ?? d.seed_top_artists?.limit ?? 5,
    ),
    seed_top_artists_time_range: String(
      d.seed_top_artists_time_range ??
        d.seed_top_artists?.time_range ??
        "short_term",
    ),

    // Last.fm similar
    similar_per_seed: Number(d.similar_per_seed ?? 30),
    take_artists: Number(d.take_artists ?? 80),

    // Important: by default don't include seeds (to avoid "known" artists)
    include_seed_artists: Boolean(d.include_seed_artists ?? false),

    // How many tracks per discovered artist to try
    tracks_per_artist: Number(d.tracks_per_artist ?? 2),

    // Popularity shaping (Spotify popularity 0..100)
    max_track_popularity:
      d.max_track_popularity === null || d.max_track_popularity === undefined
        ? 60
        : Number(d.max_track_popularity),
    min_track_popularity:
      d.min_track_popularity === null || d.min_track_popularity === undefined
        ? null
        : Number(d.min_track_popularity),

    // Exclude tracks already in Liked Songs
    exclude_saved_tracks: Boolean(d.exclude_saved_tracks ?? true),

    // For album-based strategies
    albums_per_artist: Number(d.albums_per_artist ?? 2),
    albums_limit_fetch: Number(d.albums_limit_fetch ?? 8),

    // Spotify search cap safety (used by lastfm_toptracks strategy)
    search_limit_per_track: Number(d.search_limit_per_track ?? 5),

    // Additional external signals
    use_tastedive: Boolean(d.use_tastedive ?? false),
    tastedive_limit: Number(d.tastedive_limit ?? 80),

    // Charts / rankings (TheAudioDB)
    use_audiodb_trending: Boolean(d.use_audiodb_trending ?? false),
    audiodb_country: String(d.audiodb_country ?? ""),
    audiodb_limit: Number(d.audiodb_limit ?? 30),
    audiodb_fill:
      d.audiodb_fill === null ||
      d.audiodb_fill === "" ||
      d.audiodb_fill === undefined
        ? null
        : Number(d.audiodb_fill),

    // Songkick events (upcoming concerts) -> additional artist pool
    use_songkick_events: Boolean(d.use_songkick_events ?? false),
    songkick_location_query: String(d.songkick_location_query ?? ""),
    songkick_metro_area_id: String(d.songkick_metro_area_id ?? ""),
    songkick_days_ahead: Number(d.songkick_days_ahead ?? 30),
    songkick_take_artists: Number(d.songkick_take_artists ?? 60),
  };
}

function normalizeTrack(t) {
  return {
    id: t?.id,
    explicit: Boolean(t?.explicit),
    release_date: t?.album?.release_date || null,
    popularity: typeof t?.popularity === "number" ? t.popularity : null,
    tempo: typeof t?.tempo === "number" ? t.tempo : null, // enriched if needed
    album_id: t?.album?.id || null,
    artists: Array.isArray(t?.artists)
      ? t.artists.map((a) => ({ id: a.id, name: a.name }))
      : [],
    name: t?.name || "",
  };
}

function tempoWanted(filters) {
  return filters && (filters.tempo_min !== null || filters.tempo_max !== null);
}

function applyFiltersAndDedup(rawTracks, { excludedSet, filters, popularity }) {
  const out = [];
  const seen = new Set();

  for (const rt of rawTracks) {
    const t = normalizeTrack(rt);
    if (!t.id) continue;

    if (seen.has(t.id)) continue;
    seen.add(t.id);

    if (excludedSet && excludedSet.has(t.id)) continue;

    // explicit policy
    if (filters.explicit === "exclude" && t.explicit) continue;
    if (filters.explicit === "only" && !t.explicit) continue;

    // year range
    const y = parseYearFromReleaseDate(t.release_date);
    if (filters.year_min !== null && y !== null && y < filters.year_min)
      continue;
    if (filters.year_max !== null && y !== null && y > filters.year_max)
      continue;

    // tempo range (requires enrichment)
    if (
      filters.tempo_min !== null &&
      typeof t.tempo === "number" &&
      t.tempo < filters.tempo_min
    )
      continue;
    if (
      filters.tempo_max !== null &&
      typeof t.tempo === "number" &&
      t.tempo > filters.tempo_max
    )
      continue;

    // popularity shaping (optional)
    if (popularity) {
      const p = t.popularity;
      if (typeof p === "number") {
        if (
          popularity.max !== null &&
          popularity.max !== undefined &&
          p > popularity.max
        )
          continue;
        if (
          popularity.min !== null &&
          popularity.min !== undefined &&
          p < popularity.min
        )
          continue;
      }
    }

    out.push(t);
  }

  return out;
}

/* -------- diversity across whole list -------- */

function diversityKeyArtist(t) {
  return t.artists?.[0]?.id || t.artists?.[0]?.name || null;
}

function diversityKeyAlbum(t) {
  return t.album_id || null;
}

function createDiversityState(initialChosen = []) {
  const state = {
    chosen: [],
    chosenIds: new Set(),
    artistCounts: new Map(),
    albumCounts: new Map(),
    lastArtistKey: null,
  };

  for (const t of initialChosen) {
    if (!t?.id) continue;
    if (state.chosenIds.has(t.id)) continue;

    state.chosen.push(t);
    state.chosenIds.add(t.id);

    const a0 = diversityKeyArtist(t);
    const al = diversityKeyAlbum(t);

    if (a0) state.artistCounts.set(a0, (state.artistCounts.get(a0) || 0) + 1);
    if (al) state.albumCounts.set(al, (state.albumCounts.get(al) || 0) + 1);
    state.lastArtistKey = a0 || state.lastArtistKey;
  }

  return state;
}

function canTakeWithLimits(state, t, limits) {
  const a0 = diversityKeyArtist(t);
  const al = diversityKeyAlbum(t);

  if (
    limits.avoid_same_artist_in_row &&
    state.lastArtistKey &&
    a0 &&
    String(a0) === String(state.lastArtistKey)
  ) {
    return false;
  }

  if (limits.max_per_artist && limits.max_per_artist > 0 && a0) {
    const c = state.artistCounts.get(a0) || 0;
    if (c >= limits.max_per_artist) return false;
  }

  if (limits.max_per_album && limits.max_per_album > 0 && al) {
    const c = state.albumCounts.get(al) || 0;
    if (c >= limits.max_per_album) return false;
  }

  return true;
}

function takeFromCandidates(state, candidates, takeN, limits) {
  for (const t of candidates) {
    if (state.chosen.length >= takeN) break;
    if (!t?.id) continue;
    if (state.chosenIds.has(t.id)) continue;

    if (!canTakeWithLimits(state, t, limits)) continue;

    state.chosen.push(t);
    state.chosenIds.add(t.id);

    const a0 = diversityKeyArtist(t);
    const al = diversityKeyAlbum(t);

    if (a0) state.artistCounts.set(a0, (state.artistCounts.get(a0) || 0) + 1);
    if (al) state.albumCounts.set(al, (state.albumCounts.get(al) || 0) + 1);
    state.lastArtistKey = a0 || state.lastArtistKey;
  }

  return state;
}

/* -------- audio features (tempo) -------- */

async function enrichTempoIfNeeded(sp, tracks, filters) {
  if (!tempoWanted(filters)) return { tracks, ok: true };

  const ids = uniqIds(tracks.map((t) => t?.id).filter(Boolean));
  if (!ids.length) return { tracks, ok: true };

  const tempoById = new Map();

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const resp = await spRetry(() => sp.getAudioFeaturesForTracks(chunk));
    const feats = resp.body?.audio_features || [];
    for (const f of feats) {
      if (!f?.id) continue;
      if (typeof f.tempo === "number") tempoById.set(f.id, f.tempo);
    }
  }

  const out = tracks.map((t) => {
    if (!t?.id) return t;
    const tempo = tempoById.get(t.id);
    if (typeof tempo === "number") return { ...t, tempo };
    return t;
  });

  return { tracks: out, ok: true };
}

/* -------- Spotify pool sources -------- */

async function fetchAllPlaylistTrackItems(sp, playlistId, maxCandidates) {
  const items = [];
  let offset = 0;
  const limit = 100;

  while (items.length < maxCandidates) {
    const resp = await spRetry(() =>
      sp.getPlaylistTracks(playlistId, {
        limit,
        offset,
        fields:
          "items(track(id,uri,name,explicit,popularity,album(id,release_date),artists(id,name))),next",
      }),
    );

    const batch = resp.body?.items || [];
    for (const it of batch) {
      if (it?.track) items.push(it.track);
      if (items.length >= maxCandidates) break;
    }

    if (!resp.body?.next) break;
    offset += limit;
  }

  return items;
}

async function fetchLikedTracks(sp, maxCandidates) {
  const items = [];
  let offset = 0;
  const limit = 50;

  while (items.length < maxCandidates) {
    const resp = await spRetry(() => sp.getMySavedTracks({ limit, offset }));

    const batch = resp.body?.items || [];
    for (const it of batch) {
      if (it?.track) items.push(it.track);
      if (items.length >= maxCandidates) break;
    }

    if (!resp.body?.next) break;
    offset += limit;
  }

  return items;
}

async function fetchTopTracks(sp, timeRange, maxCandidates, limitPerPage = 50) {
  const items = [];
  let offset = 0;
  const limit = Math.max(1, Math.min(50, Number(limitPerPage || 50)));

  while (items.length < maxCandidates) {
    const resp = await spRetry(() =>
      sp.getMyTopTracks({
        time_range: timeRange || "short_term",
        limit,
        offset,
      }),
    );

    const batch = resp.body?.items || [];
    for (const t of batch) {
      if (t) items.push(t);
      if (items.length >= maxCandidates) break;
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  return items;
}

async function fetchSearchTracks(sp, query, market, maxCandidates) {
  const items = [];
  let offset = 0;
  const limit = 50;

  while (items.length < maxCandidates) {
    const resp = await spRetry(() =>
      sp.searchTracks(query, {
        market,
        limit,
        offset,
      }),
    );

    const batch = resp.body?.tracks?.items || [];
    for (const t of batch) {
      if (t) items.push(t);
      if (items.length >= maxCandidates) break;
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  return items;
}

/* -------- Spotify Recommendations (seed genres + tempo) -------- */

async function fetchRecommendations(
  sp,
  { market, seed_genres, tempo_min, tempo_max },
) {
  const params = {
    market,
    limit: 100,
    seed_genres: (seed_genres || []).slice(0, 5),
  };

  // Spotify supports min_tempo/max_tempo directly on recommendations
  if (tempo_min !== null && tempo_min !== undefined)
    params.min_tempo = Number(tempo_min);
  if (tempo_max !== null && tempo_max !== undefined)
    params.max_tempo = Number(tempo_max);

  const resp = await spRetry(() => sp.getRecommendations(params));
  return resp.body?.tracks || [];
}

async function poolFromRecommendations({
  sp,
  recipe,
  market,
  excludedSet,
  historyOnlySet,
  meta,
}) {
  const filters = getRecipeFilters(recipe);
  const limits = getRecipeLimits(recipe);
  const adv = getAdvanced(recipe);
  const rcfg = getRecommendationsCfg(recipe);

  const trackCount = Number(recipe.track_count ?? 50);
  const attempts = Math.max(1, Math.min(50, adv.recommendation_attempts || 10));

  const seedGenres = uniq([
    ...(rcfg.seed_genres || []),
    ...(rcfg.legacy_seed_genres || []),
  ]).slice(0, 10);

  if (!seedGenres.length) {
    meta?.notes?.push("recommendations_no_seed_genres");
    return [];
  }

  const raw = [];
  for (let i = 0; i < attempts; i++) {
    const got = await fetchRecommendations(sp, {
      market,
      seed_genres: seedGenres,
      tempo_min: filters.tempo_min,
      tempo_max: filters.tempo_max,
    });
    raw.push(...got);
  }

  // enrich tempo if filters demand it (reco already tries, but we keep consistent)
  try {
    const enr = await enrichTempoIfNeeded(sp, raw, filters);
    raw.splice(0, raw.length, ...(enr.tracks || raw));
  } catch {
    meta?.notes?.push("tempo_enrich_failed_recommendations");
  }

  // Baseline pool (filters + dedup, but WITHOUT exclusion) so server.js can judge
  // how much of the available sources are blocked by history.
  let poolAll = [];
  try {
    poolAll = applyFiltersAndDedup(raw, {
      excludedSet: new Set(),
      filters,
      popularity: null,
    });
  } catch {
    poolAll = [];
  }

  // Now apply real excludedSet (history + playlist + already-chosen, etc.)
  let candidates = applyFiltersAndDedup(raw, {
    excludedSet: excludedSet || new Set(),
    filters,
    popularity: null,
  });

  // Telemetry for auto-flush
  if (meta && meta.counts) {
    meta.counts.sources_pool_total = poolAll.length;
    meta.counts.sources_pool_after_excluded = candidates.length;

    if (historyOnlySet && historyOnlySet.size && poolAll.length) {
      let hits = 0;
      for (const t of poolAll) {
        const id = t && t.id;
        if (id && historyOnlySet.has(id)) hits += 1;
      }
      meta.counts.sources_pool_history_hits = hits;
    }
  }

  shuffleInPlace(candidates);
  return candidates.slice(0, Math.max(trackCount * 10, 600));
}

/* -------- Last.fm discovery -------- */

function lastfmKey() {
  return process.env.LASTFM_API_KEY
    ? String(process.env.LASTFM_API_KEY).trim()
    : "";
}

function lastfmUrl(params) {
  const usp = new URLSearchParams({
    format: "json",
    api_key: lastfmKey(),
    ...params,
  });
  return `https://ws.audioscrobbler.com/2.0/?${usp.toString()}`;
}

async function lastfmGetSimilarArtists(artistName, limit) {
  const url = lastfmUrl({
    method: "artist.getsimilar",
    artist: artistName,
    limit: String(limit || 30),
    autocorrect: "1",
  });

  const js = await httpJsonRetry(url);
  const items = js?.similarartists?.artist || [];
  return items.map((a) => a?.name).filter(Boolean);
}

async function lastfmGetTopTracks(artistName, limit) {
  const url = lastfmUrl({
    method: "artist.gettoptracks",
    artist: artistName,
    limit: String(limit || 5),
    autocorrect: "1",
  });

  const js = await httpJsonRetry(url);
  const items = js?.toptracks?.track || [];
  return items.map((t) => t?.name).filter(Boolean);
}

/* -------- TasteDive similarity -------- */

function tastediveKey() {
  return process.env.TASTEDIVE_API_KEY
    ? String(process.env.TASTEDIVE_API_KEY).trim()
    : "";
}

function tastediveUrl(params) {
  const usp = new URLSearchParams(params);
  return `https://tastedive.com/api/similar?${usp.toString()}`;
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeterministic(arr, seedStr) {
  const a = arr.slice();
  const rnd = mulberry32(fnv1a32(String(seedStr || "seed")));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function tastediveGetSimilarArtists(
  seedArtists,
  targetTotal = 80,
  opts = {},
) {
  const key = tastediveKey();
  if (!key) return [];

  const seedsRaw = Array.isArray(seedArtists)
    ? seedArtists.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (!seedsRaw.length) return [];

  // TasteDive per-request limit: MUST be < 20 → safest 19
  const perReq = 19;

  // cílový počet z UI (kolik interpretů celkem)
  const total = Math.max(1, Math.min(500, Number(targetTotal || 80)));

  // kolik requestů potřebujeme (ať je to šetrné)
  const needed = Math.max(1, Math.ceil(total / perReq));

  // tvrdý strop requestů (ať tě UI omylem nezabije)
  const maxQueries = Math.max(1, Math.min(30, Number(opts.maxQueries ?? 12)));

  const seedKey = String(opts.seedKey || "");
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const shuffleKey = seedKey ? `${seedKey}|${today}` : today;

  // Promíchat seed interprety deterministicky (podle recipe + dne)
  const seeds = shuffleDeterministic(seedsRaw, shuffleKey);

  // vybereme N seedů pro dotazy
  const querySeeds = seeds.slice(0, Math.min(seeds.length, needed, maxQueries));

  // Váhování: interpret, který se opakuje napříč dotazy, dostane vyšší score
  const counts = new Map(); // normName -> count
  const canon = new Map(); // normName -> displayName

  const seedSet = new Set(seedsRaw.map((s) => s.toLowerCase()));

  for (const seed of querySeeds) {
    const url = tastediveUrl({
      q: seed,
      type: "music",
      limit: String(perReq),
      info: "0",
      k: key,
    });

    const js = await httpJsonRetry(url);

    // TasteDive může vracet různé casingy:
    const items =
      js?.Similar?.Results ||
      js?.Similar?.results ||
      js?.similar?.Results ||
      js?.similar?.results ||
      [];

    for (const r of items) {
      const name = String(r?.Name ?? r?.name ?? "").trim();
      if (!name) continue;

      const norm = name.toLowerCase();

      // nevracej seed interprety zpátky jako doporučení
      if (seedSet.has(norm)) continue;

      counts.set(norm, (counts.get(norm) || 0) + 1);
      if (!canon.has(norm)) canon.set(norm, name);
    }
  }

  if (!counts.size) return [];

  // Seřadit podle váhy (výskytů), ties rozseknout deterministicky
  const rnd = mulberry32(fnv1a32(`ties|${shuffleKey}`));
  const scored = [...counts.entries()].map(([norm, c]) => ({
    name: canon.get(norm) || norm,
    count: c,
    tie: rnd(),
  }));

  scored.sort((a, b) => b.count - a.count || a.tie - b.tie);

  return scored.slice(0, total).map((x) => x.name);
}

/* -------- TheAudioDB charts / trending -------- */

function audiodbKey() {
  const raw =
    process.env.AUDIODB_API_KEY != null
      ? String(process.env.AUDIODB_API_KEY).trim()
      : "";
  return raw || "2";
}

function audiodbTrendingUrl(country) {
  const usp = new URLSearchParams({
    country: String(country || "us").toLowerCase(),
    type: "itunes",
    format: "singles",
  });
  return `https://www.theaudiodb.com/api/v1/json/${audiodbKey()}/trending.php?${usp.toString()}`;
}

async function audiodbGetTrendingTracks(country, limit) {
  const url = audiodbTrendingUrl(country);
  const js = await httpJsonRetry(url);
  const items = js?.trending || [];

  const out = [];
  for (const it of items) {
    const artist = it?.strArtist || it?.artist || null;
    const track = it?.strTrack || it?.track || null;
    if (artist && track) out.push({ artist, track });
    if (out.length >= (limit || 50)) break;
  }

  return out;
}

/* -------- Songkick events (upcoming concerts) -------- */

function songkickKey() {
  return process.env.SONGKICK_API_KEY
    ? String(process.env.SONGKICK_API_KEY).trim()
    : "";
}

function songkickLocationSearchUrl(query) {
  const usp = new URLSearchParams({
    query: String(query || "").trim(),
    apikey: songkickKey(),
  });
  return `https://api.songkick.com/api/3.0/search/locations.json?${usp.toString()}`;
}

function songkickMetroCalendarUrl(
  metroAreaId,
  { min_date, max_date, page, per_page } = {},
) {
  const usp = new URLSearchParams({
    apikey: songkickKey(),
  });
  if (min_date) usp.set("min_date", String(min_date));
  if (max_date) usp.set("max_date", String(max_date));
  if (page) usp.set("page", String(page));
  if (per_page) usp.set("per_page", String(per_page));

  return `https://api.songkick.com/api/3.0/metro_areas/${encodeURIComponent(
    String(metroAreaId),
  )}/calendar.json?${usp.toString()}`;
}

function fmtDateYYYYMMDD(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

async function songkickResolveMetroAreaId(locationQuery) {
  const q = String(locationQuery || "").trim();
  if (!q) return null;
  const url = songkickLocationSearchUrl(q);
  const js = await httpJsonRetry(url);
  const loc = js?.resultsPage?.results?.location?.[0] || null;
  const metroId = loc?.metroArea?.id || null;
  return metroId ? Number(metroId) : null;
}

async function songkickGetUpcomingEventArtists({
  metroAreaId,
  minDate,
  maxDate,
  takeArtists = 60,
}) {
  const key = songkickKey();
  if (!key) return [];
  if (!metroAreaId) return [];

  const min_date = fmtDateYYYYMMDD(minDate);
  const max_date = fmtDateYYYYMMDD(maxDate);
  if (!min_date || !max_date) return [];

  const wanted = Math.max(1, Math.min(500, Number(takeArtists || 60)));
  const per_page = 50;
  const seen = new Set();
  const artists = [];

  let page = 1;
  let maxPage = 1;

  while (artists.length < wanted && page <= maxPage && page <= 20) {
    const url = songkickMetroCalendarUrl(metroAreaId, {
      min_date,
      max_date,
      page,
      per_page,
    });

    const js = await httpJsonRetry(url);
    const rp = js?.resultsPage || {};
    const events = rp?.results?.event || [];

    const total = Number(rp?.totalEntries || 0);
    const per = Number(rp?.perPage || per_page);
    if (total > 0 && per > 0) maxPage = Math.max(1, Math.ceil(total / per));

    for (const ev of events) {
      const perfs = Array.isArray(ev?.performance) ? ev.performance : [];
      for (const p of perfs) {
        const nm =
          p?.artist?.displayName || p?.displayName || p?.artist?.name || null;
        if (!nm) continue;
        const k = normalizeForMatch(nm);
        if (!k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        artists.push(nm);
        if (artists.length >= wanted) break;
      }
      if (artists.length >= wanted) break;
    }

    if (events.length === 0) break;
    page += 1;
  }

  return artists;
}

async function spotifySearchArtistId(sp, artistName, market, meta) {
  const q = `artist:"${artistName}"`;
  const resp = await spRetry(
    () => sp.searchArtists(q, { market, limit: 1, offset: 0 }),
    { label: "searchArtists", meta },
  );

  const a0 = resp.body?.artists?.items?.[0];
  return a0?.id || null;
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

/* -------- genre filtering (Spotify artist genres) -------- */

function genresWanted(filters) {
  if (!filters) return false;
  const mode = String(filters.genres_mode || "ignore").toLowerCase();
  if (mode === "ignore") return false;

  const inc = Array.isArray(filters.genres_include)
    ? filters.genres_include
    : [];
  const exc = Array.isArray(filters.genres_exclude)
    ? filters.genres_exclude
    : [];
  return inc.length > 0 || exc.length > 0;
}

function normalizeGenrePatterns(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => normalizeForMatch(x))
    .filter(Boolean);
}

function anyGenreMatch(artistGenres, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const gs = Array.isArray(artistGenres) ? artistGenres : [];
  for (const g of gs) {
    const gn = normalizeForMatch(g);
    if (!gn) continue;
    for (const p of patterns) {
      if (!p) continue;
      if (gn === p) return true;
      if (gn.includes(p) || p.includes(gn)) return true;
    }
  }
  return false;
}

async function spotifyGetArtistGenresCached(sp, artistIds, cache) {
  const ids = uniqIds(artistIds || []).filter(Boolean);
  const missing = ids.filter((id) => !cache.has(id));
  if (!missing.length) return;

  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const resp = await spRetry(() => sp.getArtists(chunk));
    const items = resp.body?.artists || [];

    // Spotify keeps order, but be robust
    for (let j = 0; j < items.length; j++) {
      const a = items[j];
      if (!a?.id) continue;
      const genres = Array.isArray(a.genres) ? a.genres : [];
      cache.set(a.id, genres);
    }
  }
}

async function observeGenresFromCandidates(sp, tracks, cache, meta, label) {
  // šetrné limity: chceme katalog plnit, ale nechceme přidusit Spotify API
  const TAKE_TRACKS = 120; // dřív 250
  const TAKE_ARTISTS_PER_TRACK = 1; // dřív 2
  const MAX_UNIQUE_ARTISTS = 200; // hard cap na jeden observe (šetří 429)

  const arr = Array.isArray(tracks) ? tracks : [];
  if (!arr.length) return 0;

  const sample = arr.slice(0, TAKE_TRACKS);

  // collect + dedupe + cap
  const idsSet = new Set();
  for (const t of sample) {
    const arts = Array.isArray(t?.artists) ? t.artists : [];
    for (const a of arts.slice(0, TAKE_ARTISTS_PER_TRACK)) {
      if (a?.id) idsSet.add(a.id);
      if (idsSet.size >= MAX_UNIQUE_ARTISTS) break;
    }
    if (idsSet.size >= MAX_UNIQUE_ARTISTS) break;
  }

  const artistIds = Array.from(idsSet);
  if (!artistIds.length) return 0;

  try {
    await spotifyGetArtistGenresCached(sp, artistIds, cache);
  } catch {
    meta?.notes?.push("genres_observe_fetch_failed");
    return 0;
  }

  const allGenres = [];
  // projdeme jen ty artistIds, co jsme chtěli (cache už má missing dofetchované)
  for (const id of artistIds) {
    const gs = cache.get(id);
    if (Array.isArray(gs) && gs.length) allGenres.push(...gs);
  }

  if (!allGenres.length) return 0;

  const updates = observeGenres(allGenres);

  if (updates > 0 && label) {
    // jen krátká poznámka (ať to nespamuje)
    meta?.notes?.push(`genres_observed:${label}:${updates}`);
  }

  return updates;
}

async function filterByGenresIfNeeded(
  sp,
  tracks,
  filters,
  cache,
  meta,
  opts = {},
) {
  if (!genresWanted(filters)) return tracks;

  let mode = String(filters.genres_mode || "ignore").toLowerCase();
  if (mode === "ignore") return tracks;

  const includeP = normalizeGenrePatterns(filters.genres_include);
  const excludeP = normalizeGenrePatterns(filters.genres_exclude);
  const allowUnknown =
    filters?.allow_unknown_genres === undefined ||
    filters?.allow_unknown_genres === null
      ? true
      : Boolean(filters.allow_unknown_genres);

  // If the user filled both include + exclude lists, apply both even if they
  // selected include/exclude mode.
  if (includeP.length && excludeP.length) mode = "include_exclude";

  if (!includeP.length && !excludeP.length) return tracks;

  // Fetch genres for relevant artists
  const artistIds = [];
  for (const t of tracks || []) {
    const arts = Array.isArray(t?.artists) ? t.artists : [];
    for (const a of arts.slice(0, 3)) {
      if (a?.id) artistIds.push(a.id);
    }
  }

  try {
    const uniqArtistIds = uniqIds(artistIds);
    if (!opts.cacheOnly) {
      await spotifyGetArtistGenresCached(sp, uniqArtistIds, cache);
    }
  } catch {
    meta?.notes?.push("genre_fetch_failed");
    // Don't hard-fail generation – just skip genre filtering.
    return tracks;
  }

  let unknownTotal = 0;
  let unknownKept = 0;
  const out = [];
  for (const t of tracks || []) {
    const arts = Array.isArray(t?.artists) ? t.artists : [];
    const genres = [];
    for (const a of arts.slice(0, 3)) {
      if (!a?.id) continue;
      const g = cache.get(a.id);
      if (Array.isArray(g)) genres.push(...g);
    }

    const isUnknown = (genres || []).length === 0;
    if (isUnknown) unknownTotal += 1;

    let hasInclude = includeP.length ? anyGenreMatch(genres, includeP) : true;
    // Allow unknown genres to pass include/include_exclude (opt-in per recipe)
    // default = true (bez cache by include jinak vyprázdnil seznam)
    if (isUnknown && allowUnknown) hasInclude = true;

    const hasExclude = excludeP.length
      ? anyGenreMatch(genres, excludeP)
      : false;

    // include-only
    if (mode === "include" && !hasInclude) continue;
    // exclude-only
    if (mode === "exclude" && hasExclude) continue;
    // include_exclude: both rules
    if (mode === "include_exclude") {
      if (!hasInclude) continue;
      if (hasExclude) continue;
    }

    // Unknown mode => behave as include_exclude-ish
    if (!["include", "exclude", "include_exclude"].includes(mode)) {
      if (!hasInclude) continue;
      if (hasExclude) continue;
    }

    if (isUnknown && allowUnknown) unknownKept += 1;
    out.push(t);
  }

  meta?.notes?.push(
    `genre_filter:${mode}:in=${includeP.length}:ex=${excludeP.length}:unknown_allow=${allowUnknown ? 1 : 0}:unknown_kept=${unknownKept}/${unknownTotal}:kept=${out.length}/${(tracks || []).length}`,
  );
  return out;
}

function scoreSpotifyTrackCandidate(item, artistName, trackName) {
  const tn = normalizeForMatch(item?.name);
  const ta = normalizeForMatch(trackName);
  const an0 = normalizeForMatch(item?.artists?.[0]?.name);
  const aa = normalizeForMatch(artistName);

  let score = 0;

  if (tn && ta) {
    if (tn == ta) score += 80;
    else if (tn.startsWith(ta) || ta.startsWith(tn)) score += 60;
    else if (tn.includes(ta) || ta.includes(tn)) score += 45;
  }

  if (an0 && aa) {
    if (an0 == aa) score += 60;
    else if (an0.includes(aa) || aa.includes(an0)) score += 35;
  }

  // If any of the first few artists match exactly, give a small boost
  const artists = Array.isArray(item?.artists) ? item.artists : [];
  for (const a of artists.slice(0, 3)) {
    const an = normalizeForMatch(a?.name);
    if (an && aa && an == aa) {
      score += 20;
      break;
    }
  }

  const pop = typeof item?.popularity === "number" ? item.popularity : 0;
  score += Math.round(pop / 10);

  return score;
}

async function spotifySearchTrackId(
  sp,
  artistName,
  trackName,
  market,
  limit = 8,
) {
  const aRaw = String(artistName || "")
    .replaceAll('"', " ")
    .trim();
  const tRaw = String(trackName || "")
    .replaceAll('"', " ")
    .trim();
  if (!aRaw || !tRaw) return null;

  // očistit track (feat/remaster/brackets často rozbijí match)
  const a = aRaw.replace(/\s+/g, " ").trim();
  const t = tRaw
    .replace(/\s+/g, " ")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s*\[.*?\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const lim = Math.max(1, Math.min(50, Number(limit || 8)));

  const queries = [`artist:"${a}" track:"${t}"`, `${a} ${t}`, `"${t}"`];

  for (const q of queries) {
    const resp = await spRetry(
      () => sp.searchTracks(q, { market, limit: lim, offset: 0 }),
      { label: "searchTracks", meta: null },
    );

    const items = resp.body?.tracks?.items || [];
    if (!items.length) continue;

    let best = null;
    let bestScore = -1;
    for (const it of items) {
      const sc = scoreSpotifyTrackCandidate(it, a, t);
      if (sc > bestScore) {
        bestScore = sc;
        best = it;
      }
    }

    const threshold = q.startsWith('artist:"') ? 60 : 50;
    if (bestScore >= threshold) return best?.id || null;
  }

  return null;
}

async function spotifyGetFullTracks(sp, ids, market) {
  const fullTracks = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const resp = await spRetry(() => sp.getTracks(chunk, { market }));
    fullTracks.push(...(resp.body?.tracks || []).filter(Boolean));
  }
  return fullTracks;
}

async function spotifyFilterOutSavedTracks(sp, trackIds) {
  const out = [];
  for (let i = 0; i < trackIds.length; i += 50) {
    const chunk = trackIds.slice(i, i + 50);
    const resp = await spRetry(() => sp.containsMySavedTracks(chunk));
    const flags = resp.body || [];
    for (let j = 0; j < chunk.length; j++) {
      if (!flags[j]) out.push(chunk[j]);
    }
  }
  return out;
}

async function spotifyGetArtistAlbumTrackIds(sp, artistId, market, disc, meta) {
  const albumsResp = await spRetry(
    () =>
      sp.getArtistAlbums(artistId, {
        include_groups: "album,single",
        market,
        limit: Math.max(1, Math.min(50, disc.albums_limit_fetch)),
        offset: 0,
      }),
    { label: "getArtistAlbums", meta: null },
  );

  let albums = albumsResp.body?.items || [];
  albums = albums.sort((a, b) =>
    String(b?.release_date || "").localeCompare(String(a?.release_date || "")),
  );

  const take = Math.max(1, Math.min(10, disc.albums_per_artist));
  const chosenAlbums = albums.slice(0, take);

  const trackIds = [];
  for (const al of chosenAlbums) {
    const albumId = al?.id;
    if (!albumId) continue;

    let offset = 0;
    const limit = 50;
    while (true) {
      const tr = await spRetry(
        () => sp.getAlbumTracks(albumId, { limit, offset }),
        { label: "getAlbumTracks", meta },
      );

      const items = tr.body?.items || [];
      for (const t of items) {
        if (t?.id) trackIds.push(t.id);
      }
      if (!tr.body?.next) break;
      offset += limit;
      if (offset > 200) break;
    }
  }

  return uniqIds(trackIds);
}

async function discoverWithAudioDbTrending({
  sp,
  market,
  excludedSet,
  recipe,
  meta,
}) {
  const disc = getDiscovery(recipe);

  if (!disc.enabled || !disc.use_audiodb_trending) {
    return [];
  }

  const key = audiodbKey();
  if (!key) {
    meta?.notes?.push("missing_audiodb_api_key");
    return [];
  }

  const countryRaw = String(disc.audiodb_country || market || "US").trim();
  const country = countryRaw ? countryRaw.toLowerCase() : "us";
  const limit = Math.max(1, Math.min(200, disc.audiodb_limit || 30));

  let pairs = [];
  try {
    pairs = await audiodbGetTrendingTracks(country, limit);

    // fallback, když pro zemi nic není
    if (!pairs.length && country !== "us") {
      pairs = await audiodbGetTrendingTracks("us", limit);
      meta?.notes?.push("audiodb_fallback_us");
    }

    if (!pairs.length && country !== "gb") {
      pairs = await audiodbGetTrendingTracks("gb", limit);
      meta?.notes?.push("audiodb_fallback_gb");
    }
  } catch (e) {
    meta?.notes?.push("audiodb_fetch_failed");
    console.warn("[audiodb] failed:", e?.message || e);
    return [];
  }

  if (!pairs.length) {
    meta?.notes?.push("audiodb_no_results");
    return [];
  }

  const candidates = [];
  const seenIds = new Set();
  const searchLimit = Math.max(
    1,
    Math.min(50, Number(disc.search_limit_per_track || 5)),
  );

  for (const it of pairs.slice(0, limit)) {
    const artistName = it.artist;
    const trackName = it.track;

    const id = await spotifySearchTrackId(
      sp,
      artistName,
      trackName,
      market,
      searchLimit,
    );

    if (!id) continue;
    if (excludedSet && excludedSet.has(id)) continue;
    if (seenIds.has(id)) continue;

    seenIds.add(id);
    candidates.push(id);
  }

  if (!candidates.length) {
    meta?.notes?.push("audiodb_no_spotify_matches");
    return [];
  }

  let ids = candidates;

  if (disc.exclude_saved_tracks) {
    ids = await spotifyFilterOutSavedTracks(sp, ids);
    meta?.notes?.push("exclude_saved_tracks_audiodb");
  }

  if (!ids.length) {
    meta?.notes?.push("audiodb_all_candidates_were_saved");
    return [];
  }

  const fullTracks = await spotifyGetFullTracks(sp, ids, market);
  return fullTracks;
}

async function discoverWithLastFm({ sp, market, excludedSet, recipe, meta }) {
  const disc = getDiscovery(recipe);

  if (!disc.enabled) {
    meta?.notes?.push("discovery_disabled");
    return [];
  }

  const hasLastfm = Boolean(lastfmKey());
  const hasTaste = disc.use_tastedive && Boolean(tastediveKey());
  const hasSongkick = disc.use_songkick_events && Boolean(songkickKey());

  if (!hasLastfm && disc.strategy === "lastfm_toptracks") {
    meta?.notes?.push("lastfm_toptracks_requires_lastfm");
  }

  if (disc.use_tastedive && !tastediveKey()) {
    meta?.notes?.push("missing_tastedive_api_key");
  }

  if (disc.use_songkick_events && !songkickKey()) {
    meta?.notes?.push("missing_songkick_api_key");
  }

  if (!hasLastfm && !hasTaste && !hasSongkick) {
    meta?.notes?.push("missing_lastfm_tastedive_songkick");
    return [];
  }

  // Spotify top artists are only needed when we want to query similar artists
  // via Last.fm / TasteDive. Songkick can run independently.
  let seeds = [];
  if (hasLastfm || hasTaste) {
    const top = await spRetry(() =>
      sp.getMyTopArtists({
        limit: Math.max(1, Math.min(50, disc.seed_top_artists_limit)),
        time_range: disc.seed_top_artists_time_range,
      }),
    );

    seeds = (top.body?.items || []).map((a) => a?.name).filter(Boolean);
    genLog("debug", meta, `seeds(top artists) count=${seeds.length}`);

    if (!seeds.length) {
      meta?.notes?.push("no_top_artists");
      // Still allow Songkick-only discovery
      if (!hasSongkick) return [];
    }
  }

  const similarAll = [];

  if (hasLastfm && seeds.length) {
    for (const s of seeds) {
      const sim = await lastfmGetSimilarArtists(s, disc.similar_per_seed);
      similarAll.push(...sim);
    }
  }

  if (hasTaste && seeds.length) {
    try {
      const tdTarget = Math.max(
        1,
        Math.min(200, Number(disc.tastedive_limit ?? 80)),
      );

      const sim = await tastediveGetSimilarArtists(seeds, tdTarget, {
        seedKey: String(recipe?.id || "recipe"),
        // volitelné: když v configu nemáš, nech to být
        maxQueries: disc.tastedive_max_queries,
      });

      if (sim.length) {
        similarAll.push(...sim);
        meta?.notes?.push("tastedive_used");
      } else {
        meta?.notes?.push("tastedive_no_results");
      }
    } catch (e) {
      meta?.notes?.push("tastedive_fetch_failed");
      console.warn("[tastedive] failed:", e?.message || e);
    }
  } else if (hasTaste && !seeds.length) {
    meta?.notes?.push("tastedive_requires_seed_artists");
  }

  // Songkick upcoming event artists (optional)
  let songkickArtists = [];
  if (disc.use_songkick_events && songkickKey()) {
    try {
      let metroId = null;
      const rawId = String(disc.songkick_metro_area_id || "").trim();
      if (rawId && /^\d+$/.test(rawId)) metroId = Number(rawId);

      if (!metroId && disc.songkick_location_query) {
        metroId = await songkickResolveMetroAreaId(
          disc.songkick_location_query,
        );
        if (metroId) meta?.notes?.push(`songkick_location_resolved:${metroId}`);
      }

      if (!metroId) {
        meta?.notes?.push("songkick_missing_metro_area");
      } else {
        const days = Math.max(
          1,
          Math.min(365, Number(disc.songkick_days_ahead || 30)),
        );
        const minDate = new Date();
        const maxDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

        songkickArtists = await songkickGetUpcomingEventArtists({
          metroAreaId: metroId,
          minDate,
          maxDate,
          takeArtists: disc.songkick_take_artists,
        });

        if (songkickArtists.length) meta?.notes?.push("songkick_used");
        else meta?.notes?.push("songkick_no_results");
      }
    } catch {
      meta?.notes?.push("songkick_fetch_failed");
      songkickArtists = [];
    }
  }

  let artistPool = uniq([...songkickArtists, ...similarAll]);
  if (disc.include_seed_artists && seeds.length)
    artistPool = uniq([...seeds, ...artistPool]);
  artistPool = artistPool.slice(0, Math.max(5, disc.take_artists));
  step(
    meta,
    `lastfm:discover artistPool=${artistPool.length} take_artists=${disc.take_artists}`,
  );

  if (!artistPool.length) {
    meta?.notes?.push("no_artist_pool");
    return [];
  }

  const candidates = [];
  const seenIds = new Set();

  let strategy = disc.strategy || "deep_cuts";
  if (strategy === "lastfm_toptracks" && !hasLastfm) {
    strategy = "deep_cuts";
    meta?.notes?.push("strategy_fallback_deep_cuts");
  }

  if (strategy === "lastfm_toptracks") {
    for (const artistName of artistPool) {
      const topTracks = await lastfmGetTopTracks(
        artistName,
        Math.max(1, disc.tracks_per_artist),
      );

      for (const tn of topTracks.slice(0, disc.tracks_per_artist)) {
        const id = await spotifySearchTrackId(
          sp,
          artistName,
          tn,
          market,
          disc.search_limit_per_track,
        );
        if (!id) continue;
        if (excludedSet && excludedSet.has(id)) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        candidates.push(id);
      }
    }
  } else {
    const artistIds = [];
    let i = 0;

    for (const name of artistPool) {
      i += 1;
      const aid = await spotifySearchArtistId(sp, name, market, meta);
      if (aid) artistIds.push({ name, id: aid });

      if (i % 25 === 0 || i === artistPool.length) {
        step(
          meta,
          `spotifySearchArtistId progress ${i}/${artistPool.length} hits=${artistIds.length}`,
        );
      }
    }

    if (!artistIds.length) {
      meta?.notes?.push("spotify_artist_search_no_hits");
      return [];
    }
    step(
      meta,
      `spotifyGetArtistAlbumTrackIds start artists=${artistIds.length} strategy=${strategy}`,
    );

    let j = 0;
    for (const a of artistIds) {
      j += 1;
      if (j % 10 === 0 || j === artistIds.length) {
        step(
          meta,
          `spotifyGetArtistAlbumTrackIds progress ${j}/${artistIds.length}`,
        );
      }

      const ids = await spotifyGetArtistAlbumTrackIds(
        sp,
        a.id,
        market,
        disc,
        meta,
      );

      if (!ids.length) continue;

      const pickN = Math.max(1, disc.tracks_per_artist * 8);
      const pool = strategy === "deep_cuts" ? shuffleInPlace([...ids]) : ids;

      for (const tid of pool.slice(0, pickN)) {
        if (excludedSet && excludedSet.has(tid)) continue;
        if (seenIds.has(tid)) continue;
        seenIds.add(tid);
        candidates.push(tid);
      }
    }
  }

  if (!candidates.length) {
    meta?.notes?.push("discovery_no_matches");
    return [];
  }

  let ids = candidates;

  if (disc.exclude_saved_tracks) {
    ids = await spotifyFilterOutSavedTracks(sp, ids);
    meta?.notes?.push("exclude_saved_tracks_discovery");
  }

  if (!ids.length) {
    meta?.notes?.push("all_candidates_were_saved");
    return [];
  }

  const fullTracks = await spotifyGetFullTracks(sp, ids, market);
  return fullTracks;
}

/* -------- sources fallback (playlists/liked/top/search) -------- */

async function poolFromSources({
  sp,
  recipe,
  market,
  excludedSet,
  historyOnlySet,
  meta,
}) {
  const sources = getRecipeSources(recipe);
  const filters = getRecipeFilters(recipe);

  const trackCount = Number(recipe.track_count ?? 50);
  const maxCandidates = Math.max(
    50,
    Math.min(10000, sources.max_candidates || 1500),
  );

  const raw = [];

  if (sources.playlists.length) {
    const per = Math.floor(
      maxCandidates / Math.max(1, sources.playlists.length),
    );
    for (const p of sources.playlists) {
      const pid = parsePlaylistId(p);
      if (!pid) continue;
      const got = await fetchAllPlaylistTrackItems(sp, pid, per);
      raw.push(...got);
    }
  }

  if (sources.search.length) {
    const per = Math.floor(maxCandidates / Math.max(1, sources.search.length));
    for (const q of sources.search) {
      const got = await fetchSearchTracks(sp, String(q), market, per);
      raw.push(...got);
    }
  }

  if (sources.liked) {
    const got = await fetchLikedTracks(sp, Math.floor(maxCandidates / 2));
    raw.push(...got);
  }

  if (sources.top_tracks?.enabled) {
    const tr = sources.top_tracks?.time_range || "short_term";
    const lim = sources.top_tracks?.limit ?? 50;
    const got = await fetchTopTracks(
      sp,
      tr,
      Math.floor(maxCandidates / 2),
      lim,
    );
    raw.push(...got);
  }

  if (raw.length === 0) {
    meta?.notes?.push("sources_empty_using_default_pool");
    const liked = await fetchLikedTracks(sp, Math.floor(maxCandidates / 2));
    const top = await fetchTopTracks(
      sp,
      "short_term",
      Math.floor(maxCandidates / 2),
      50,
    );
    raw.push(...liked, ...top);
  }

  // tempo enrichment if needed
  try {
    const enr = await enrichTempoIfNeeded(sp, raw, filters);
    raw.splice(0, raw.length, ...(enr.tracks || raw));
  } catch {
    meta?.notes?.push("tempo_enrich_failed_sources");
  }

  let candidates = applyFiltersAndDedup(raw, {
    excludedSet: excludedSet || new Set(),
    filters,
    popularity: null,
  });

  shuffleInPlace(candidates);

  return candidates.slice(0, Math.max(trackCount * 10, 600));
}

/* -------- public API -------- */

async function generateTracksWithMeta({
  sp,
  recipe,
  market,
  excludedSet,
  historyOnlySet,
  debugSteps = false,
}) {
  const need = Number(recipe.track_count ?? 50);

  const meta = {
    need,
    provider: "sources",
    used_provider: "sources",
    debugSteps: Boolean(debugSteps),
    recipe_id: recipe?.id || recipe?.recipe_id || recipe?.name || "unknown",
    counts: {
      audiodb_selected: 0,
      lastfm_selected: 0,
      reco_selected: 0,
      sources_selected: 0,
      observed_genres_updates: 0,

      // debug/telemetry for history auto-flush (computed in poolFromSources)
      sources_pool_total: 0,
      sources_pool_after_excluded: 0,
      sources_pool_history_hits: 0,
    },
    notes: [],
  };

  const filters = getRecipeFilters(recipe);
  const limits = getRecipeLimits(recipe);
  const disc = getDiscovery(recipe);
  const rcfg = getRecommendationsCfg(recipe);

  // IMPORTANT: Strict separation — no genre calls during generation.
  // If user has genre filters configured, we just note that they were deferred.
  if (genresWanted(filters)) {
    meta.notes.push("genres_filter_cache_only");
  }

  // Genre cache (persistent). During generation we ONLY use cache (no Spotify calls).
  const genreCache = genresWanted(filters) ? loadArtistGenresMap() : new Map();

  const state = createDiversityState([]);

  // 1) Discovery / external sources first
  if (disc.enabled) {
    meta.provider = "discovery";

    // 1a) Charts: TheAudioDB trending (optional)
    if (disc.use_audiodb_trending) {
      let chartTracks = [];
      try {
        chartTracks = await timeStep(meta, "audiodb:discover", () =>
          discoverWithAudioDbTrending({
            sp,
            market,
            excludedSet,
            recipe,
            meta,
          }),
        );
      } catch (e) {
        meta.notes.push("audiodb_discovery_failed");
        console.warn("[audiodb] discovery wrapper failed:", e?.message || e);
        if (e?.stack) console.warn(e.stack);
        chartTracks = [];
      }

      // tempo enrichment if needed
      try {
        const enr = await timeStep(meta, "audiodb:tempo_enrich", () =>
          enrichTempoIfNeeded(sp, chartTracks, filters),
        );
        chartTracks = enr.tracks || chartTracks;
      } catch {
        meta.notes.push("tempo_enrich_failed_audiodb");
      }

      // apply filters (no popularity shaping for charts)
      chartTracks = applyFiltersAndDedup(chartTracks, {
        excludedSet: excludedSet || new Set(),
        filters,
        popularity: null,
      });

      if (genresWanted(filters)) {
        chartTracks = await filterByGenresIfNeeded(
          null,
          chartTracks,
          filters,
          genreCache,
          meta,
          { cacheOnly: true },
        );
      }

      // keep chart ordering (do not shuffle)
      const desired =
        disc.audiodb_fill != null
          ? Math.max(0, Number(disc.audiodb_fill))
          : Math.max(0, Math.round(need * 0.3));

      const before = state.chosen.length;
      takeFromCandidates(
        state,
        chartTracks,
        Math.min(need, Math.max(0, desired)),
        limits,
      );
      meta.counts.audiodb_selected = state.chosen.length - before;

      if (state.chosen.length >= need) {
        meta.used_provider = "audiodb";
        return { tracks: state.chosen.slice(0, need), meta };
      }
    }

    // 1b) Similar-artist discovery (Last.fm + optional TasteDive)
    let discovered = [];
    try {
      discovered = await timeStep(meta, "lastfm:discover", () =>
        discoverWithLastFm({
          sp,
          market,
          excludedSet: new Set([
            ...(excludedSet || []),
            ...state.chosen.map((t) => t.id),
          ]),
          recipe,
          meta,
        }),
      );
    } catch (e) {
      meta.notes.push("discovery_failed");
      console.warn("[discovery] failed:", e?.message || e);
      if (e?.stack) console.warn(e.stack);
      discovered = [];
    }

    // tempo enrichment if needed
    try {
      const enr = await timeStep(meta, "discovery:tempo_enrich", () =>
        enrichTempoIfNeeded(sp, discovered, filters),
      );
      discovered = enr.tracks || discovered;
    } catch {
      meta.notes.push("tempo_enrich_failed_discovery");
    }

    // apply filters (including popularity shaping for discovery)
    discovered = applyFiltersAndDedup(discovered, {
      excludedSet: new Set([
        ...(excludedSet || []),
        ...state.chosen.map((t) => t.id),
      ]),
      filters,
      popularity: {
        max: disc.max_track_popularity,
        min: disc.min_track_popularity,
      },
    });

    if (genresWanted(filters)) {
      discovered = await filterByGenresIfNeeded(
        null,
        discovered,
        filters,
        genreCache,
        meta,
        { cacheOnly: true },
      );
    }

    if (disc.strategy === "deep_cuts") shuffleInPlace(discovered);

    const before = state.chosen.length;
    takeFromCandidates(state, discovered, need, limits);
    meta.counts.lastfm_selected = state.chosen.length - before;

    if (state.chosen.length >= need) {
      meta.used_provider =
        meta.counts.audiodb_selected > 0 ? "mixed" : "discovery";
      return { tracks: state.chosen.slice(0, need), meta };
    }
  } else {
    meta.provider = "sources";
  }

  // 2) Fill from Spotify Recommendations (if enabled)
  const remainingAfterDiscovery = need - state.chosen.length;
  if (remainingAfterDiscovery > 0 && rcfg.enabled) {
    meta.notes.push("fill_from_recommendations");

    let recoPool = [];
    try {
      recoPool = await timeStep(meta, "reco:pool", () =>
        poolFromRecommendations({
          sp,
          recipe,
          market,
          excludedSet: new Set([
            ...(excludedSet || []),
            ...state.chosen.map((t) => t.id),
          ]),
          historyOnlySet,
          meta,
        }),
      );

      shuffleInPlace(recoPool);
    } catch {
      meta.notes.push("recommendations_failed");
      recoPool = [];
    }

    if (genresWanted(filters)) {
      recoPool = await filterByGenresIfNeeded(
        null,
        recoPool,
        filters,
        genreCache,
        meta,
        { cacheOnly: true },
      );
    }

    const before = state.chosen.length;
    takeFromCandidates(state, recoPool, need, limits);
    meta.counts.reco_selected = state.chosen.length - before;

    if (state.chosen.length >= need) {
      meta.used_provider = disc.enabled ? "mixed" : "recommendations";
      return { tracks: state.chosen.slice(0, need), meta };
    }
  }

  // 3) Fill from sources fallback
  const remaining = need - state.chosen.length;
  if (remaining > 0) {
    meta.notes.push("fill_from_sources");

    let srcPool = [];
    try {
      srcPool = await timeStep(meta, "sources:pool", () =>
        poolFromSources({
          sp,
          recipe,
          market,
          excludedSet: new Set([
            ...(excludedSet || []),
            ...state.chosen.map((t) => t.id),
          ]),
          historyOnlySet,
          meta,
        }),
      );

      shuffleInPlace(srcPool);
    } catch {
      meta.notes.push("sources_failed");
      srcPool = [];
    }

    if (genresWanted(filters)) {
      srcPool = await filterByGenresIfNeeded(
        null,
        srcPool,
        filters,
        genreCache,
        meta,
        { cacheOnly: true },
      );
    }

    const before = state.chosen.length;
    takeFromCandidates(state, srcPool, need, limits);
    meta.counts.sources_selected = state.chosen.length - before;
  }

  const hasDiscovery =
    (meta.counts.audiodb_selected || 0) > 0 ||
    (meta.counts.lastfm_selected || 0) > 0;

  if (hasDiscovery) meta.used_provider = "mixed";
  else if (rcfg.enabled && meta.counts.reco_selected > 0)
    meta.used_provider = "recommendations";
  else meta.used_provider = "sources";

  return { tracks: state.chosen.slice(0, need), meta };
}

async function updateGenresCatalogFromTracks({ sp, tracks, meta, label }) {
  // Runs strictly AFTER playlist write (server.js schedules it async)
  const m = meta || { notes: [], counts: {} };
  const cache = new Map();

  try {
    loadCatalog();
  } catch {
    // ignore
  }

  let updates = 0;
  try {
    updates = await observeGenresFromCandidates(
      sp,
      Array.isArray(tracks) ? tracks : [],
      cache,
      m,
      label || "post_write",
    );
  } catch {
    m?.notes?.push("genres_observe_fetch_failed");
    updates = 0;
  }

  if (updates > 0) {
    m.counts = m.counts || {};
    m.counts.observed_genres_updates =
      Number(m.counts.observed_genres_updates || 0) + updates;
  }

  // Persist artist->genres cache for next runs (so include/exclude can work without Spotify calls)
  try {
    const merged = mergeFromGenresMap(cache);
    if (merged > 0) saveArtistGenresStore();
  } catch {
    m?.notes?.push("artist_genres_cache_save_failed");
  }

  try {
    await saveCatalog();
  } catch {
    m?.notes?.push("genres_catalog_save_failed");
  }

  return updates;
}

async function replacePlaylistItems({ sp, playlistId, trackUris }) {
  const pid = String(playlistId || "").trim();
  const uris = Array.isArray(trackUris) ? trackUris : [];

  const first = uris.slice(0, 100);
  await spRetry(() => sp.replaceTracksInPlaylist(pid, first));

  let offset = 100;
  while (offset < uris.length) {
    const chunk = uris.slice(offset, offset + 100);
    await spRetry(() => sp.addTracksToPlaylist(pid, chunk));
    offset += 100;
  }
}

module.exports = {
  generateTracksWithMeta,
  replacePlaylistItems,
  updateGenresCatalogFromTracks,
};
