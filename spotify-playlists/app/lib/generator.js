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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function spRetry(fn, { maxRetries = 6, baseDelayMs = 400 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.statusCode || e?.status;
      const headers = e?.headers || e?.response?.headers;
      const ra = headers?.["retry-after"] || headers?.["Retry-After"];
      const retryAfterMs = ra ? Number(ra) * 1000 : null;

      const isRetryable =
        status === 429 || status === 502 || status === 503 || status === 504;

      if (!isRetryable || attempt >= maxRetries) throw e;

      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
      const waitMs = retryAfterMs ?? backoff;

      await sleep(waitMs);
      attempt += 1;
    }
  }
}

async function httpJsonRetry(url, { maxRetries = 5, baseDelayMs = 500 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.status === 429 || r.status >= 500) {
        const ra = r.headers.get("retry-after");
        const retryAfterMs = ra ? Number(ra) * 1000 : null;
        if (attempt >= maxRetries) throw new Error(`HTTP ${r.status}`);
        const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
        await sleep(retryAfterMs ?? backoff);
        attempt += 1;
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
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

  let candidates = applyFiltersAndDedup(raw, {
    excludedSet: excludedSet || new Set(),
    filters,
    popularity: null,
  });

  shuffleInPlace(candidates);

  // Return pool; final diversity selection happens centrally across providers
  return candidates.slice(0, Math.max(trackCount * 8, 400));
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

async function spotifySearchArtistId(sp, artistName, market) {
  const q = `artist:"${artistName}"`;
  const resp = await spRetry(() =>
    sp.searchArtists(q, { market, limit: 1, offset: 0 }),
  );
  const a0 = resp.body?.artists?.items?.[0];
  return a0?.id || null;
}

async function spotifySearchTrackId(sp, artistName, trackName, market) {
  const q = `artist:"${artistName}" track:"${trackName}"`;
  const resp = await spRetry(() =>
    sp.searchTracks(q, { market, limit: 5, offset: 0 }),
  );
  const items = resp.body?.tracks?.items || [];
  const t0 = items[0];
  return t0?.id || null;
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

async function spotifyGetArtistAlbumTrackIds(sp, artistId, market, disc) {
  const albumsResp = await spRetry(() =>
    sp.getArtistAlbums(artistId, {
      include_groups: "album,single",
      market,
      limit: Math.max(1, Math.min(50, disc.albums_limit_fetch)),
      offset: 0,
    }),
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
      const tr = await spRetry(() =>
        sp.getAlbumTracks(albumId, { limit, offset }),
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

async function discoverWithLastFm({ sp, market, excludedSet, recipe, meta }) {
  const disc = getDiscovery(recipe);

  if (!disc.enabled) {
    meta?.notes?.push("discovery_disabled");
    return [];
  }
  if (!lastfmKey()) {
    meta?.notes?.push("missing_lastfm_api_key");
    return [];
  }

  const top = await spRetry(() =>
    sp.getMyTopArtists({
      limit: Math.max(1, Math.min(50, disc.seed_top_artists_limit)),
      time_range: disc.seed_top_artists_time_range,
    }),
  );

  const seeds = (top.body?.items || []).map((a) => a?.name).filter(Boolean);
  if (!seeds.length) {
    meta?.notes?.push("no_top_artists");
    return [];
  }

  const similarAll = [];
  for (const s of seeds) {
    const sim = await lastfmGetSimilarArtists(s, disc.similar_per_seed);
    similarAll.push(...sim);
  }

  let artistPool = uniq(similarAll);
  if (disc.include_seed_artists) artistPool = uniq([...seeds, ...artistPool]);
  artistPool = artistPool.slice(0, Math.max(5, disc.take_artists));

  if (!artistPool.length) {
    meta?.notes?.push("no_similar_artists");
    return [];
  }

  const candidates = [];
  const seenIds = new Set();

  if (disc.strategy === "lastfm_toptracks") {
    for (const artistName of artistPool) {
      const topTracks = await lastfmGetTopTracks(
        artistName,
        Math.max(1, disc.tracks_per_artist),
      );

      for (const tn of topTracks.slice(0, disc.tracks_per_artist)) {
        const id = await spotifySearchTrackId(sp, artistName, tn, market);
        if (!id) continue;
        if (excludedSet && excludedSet.has(id)) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        candidates.push(id);
      }
    }
  } else {
    const artistIds = [];
    for (const name of artistPool) {
      const aid = await spotifySearchArtistId(sp, name, market);
      if (aid) artistIds.push({ name, id: aid });
    }

    if (!artistIds.length) {
      meta?.notes?.push("spotify_artist_search_no_hits");
      return [];
    }

    for (const a of artistIds) {
      const ids = await spotifyGetArtistAlbumTrackIds(sp, a.id, market, disc);
      if (!ids.length) continue;

      const pickN = Math.max(1, disc.tracks_per_artist * 8);
      const pool =
        disc.strategy === "deep_cuts" ? shuffleInPlace([...ids]) : ids;

      for (const tid of pool.slice(0, pickN)) {
        if (excludedSet && excludedSet.has(tid)) continue;
        if (seenIds.has(tid)) continue;
        seenIds.add(tid);
        candidates.push(tid);
      }
    }
  }

  if (!candidates.length) {
    meta?.notes?.push("lastfm_no_matches");
    return [];
  }

  let ids = candidates;

  if (disc.exclude_saved_tracks) {
    ids = await spotifyFilterOutSavedTracks(sp, ids);
    meta?.notes?.push("exclude_saved_tracks");
  }

  if (!ids.length) {
    meta?.notes?.push("all_candidates_were_saved");
    return [];
  }

  const fullTracks = await spotifyGetFullTracks(sp, ids, market);
  return fullTracks;
}

/* -------- sources fallback (playlists/liked/top/search) -------- */

async function poolFromSources({ sp, recipe, market, excludedSet, meta }) {
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

async function generateTracksWithMeta({ sp, recipe, market, excludedSet }) {
  const need = Number(recipe.track_count ?? 50);

  const meta = {
    need,
    provider: "sources",
    used_provider: "sources",
    counts: { lastfm_selected: 0, reco_selected: 0, sources_selected: 0 },
    notes: [],
  };

  const filters = getRecipeFilters(recipe);
  const limits = getRecipeLimits(recipe);
  const disc = getDiscovery(recipe);
  const rcfg = getRecommendationsCfg(recipe);

  const state = createDiversityState([]);

  // 1) Discovery (Last.fm) first (if enabled)
  if (disc.enabled) {
    meta.provider = "lastfm";

    let discovered = [];
    try {
      discovered = await discoverWithLastFm({
        sp,
        market,
        excludedSet,
        recipe,
        meta,
      });
    } catch (e) {
      meta.notes.push("lastfm_discovery_failed");
      discovered = [];
    }

    // tempo enrichment if needed
    try {
      const enr = await enrichTempoIfNeeded(sp, discovered, filters);
      discovered = enr.tracks || discovered;
    } catch {
      meta.notes.push("tempo_enrich_failed_lastfm");
    }

    // apply filters (including popularity shaping for discovery)
    discovered = applyFiltersAndDedup(discovered, {
      excludedSet: excludedSet || new Set(),
      filters,
      popularity: {
        max: disc.max_track_popularity,
        min: disc.min_track_popularity,
      },
    });

    if (disc.strategy === "deep_cuts") shuffleInPlace(discovered);

    const before = state.chosen.length;
    takeFromCandidates(state, discovered, need, limits);
    const pickedNow = state.chosen.length - before;

    meta.counts.lastfm_selected = pickedNow;

    if (state.chosen.length >= need) {
      meta.used_provider = "lastfm";
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
      recoPool = await poolFromRecommendations({
        sp,
        recipe,
        market,
        excludedSet: new Set([
          ...(excludedSet || []),
          ...state.chosen.map((t) => t.id),
        ]),
        meta,
      });
    } catch {
      meta.notes.push("recommendations_failed");
      recoPool = [];
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
      srcPool = await poolFromSources({
        sp,
        recipe,
        market,
        excludedSet: new Set([
          ...(excludedSet || []),
          ...state.chosen.map((t) => t.id),
        ]),
        meta,
      });
    } catch {
      meta.notes.push("sources_failed");
      srcPool = [];
    }

    const before = state.chosen.length;
    takeFromCandidates(state, srcPool, need, limits);
    meta.counts.sources_selected = state.chosen.length - before;
  }

  if (disc.enabled && meta.counts.lastfm_selected > 0)
    meta.used_provider = "mixed";
  else if (rcfg.enabled && meta.counts.reco_selected > 0)
    meta.used_provider = "recommendations";
  else meta.used_provider = "sources";

  return { tracks: state.chosen.slice(0, need), meta };
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
};
