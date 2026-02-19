export const CATALOGS = [
  // Movies
  {
    id: "movie_popular",
    type: "movie",
    name: "Prehraj.to (TMDB) • Filmy • Popular",
    extra: [{ name: "skip", isRequired: false }],
  },
  {
    id: "movie_trending",
    type: "movie",
    name: "Prehraj.to (TMDB) • Filmy • Trending",
    extra: [{ name: "skip", isRequired: false }],
  },
  {
    id: "movie_by_genre",
    type: "movie",
    name: "Prehraj.to (TMDB) • Filmy • Žánr",
    extra: [
      { name: "genre", isRequired: false },
      { name: "skip", isRequired: false },
    ],
  },
  {
    id: "movie_by_year",
    type: "movie",
    name: "Prehraj.to (TMDB) • Filmy • Rok",
    extra: [
      { name: "year", isRequired: false },
      { name: "skip", isRequired: false },
    ],
  },

  // Series
  {
    id: "series_popular",
    type: "series",
    name: "Prehraj.to (TMDB) • Seriály • Popular",
    extra: [{ name: "skip", isRequired: false }],
  },
  {
    id: "series_trending",
    type: "series",
    name: "Prehraj.to (TMDB) • Seriály • Trending",
    extra: [{ name: "skip", isRequired: false }],
  },
  {
    id: "series_by_genre",
    type: "series",
    name: "Prehraj.to (TMDB) • Seriály • Žánr",
    extra: [
      { name: "genre", isRequired: false },
      { name: "skip", isRequired: false },
    ],
  },
  {
    id: "series_by_year",
    type: "series",
    name: "Prehraj.to (TMDB) • Seriály • Rok",
    extra: [
      { name: "year", isRequired: false },
      { name: "skip", isRequired: false },
    ],
  },

  // Direct search on prehraj.to
  {
    id: "pt_search",
    type: "movie",
    name: "Prehraj.to • Hledání (přímé)",
    extra: [
      { name: "search", isRequired: true },
      { name: "skip", isRequired: false },
    ],
  },
];
