
'use strict';

const { redisGet, redisSet } = require('./persistence');

const ANIMAP_API = 'https://animap.id/api';
const JIMAKU_API = 'https://jimaku.cc/api';
const ANILIST_API = 'https://graphql.anilist.co';

const ANILIST_MEDIA_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      episodes
      season
      seasonYear
      format
      title {
        romaji
        english
      }
      relations {
        edges {
          relationType
          node {
            id
            episodes
          }
        }
      }
    }
  }
`;

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;

const memoryCache = new Map();
const pendingRequests = new Map();

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  return response.json();
}

async function getCached(key) {
  const memoryEntry = memoryCache.get(key);

  if (memoryEntry && Date.now() < memoryEntry.expiresAt) {
    return memoryEntry.value;
  }

  memoryCache.delete(key);

  try {
    const cached = await redisGet(`anime:${key}`);

    if (cached) {
      const value = JSON.parse(cached);

      memoryCache.set(key, {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS
      });

      return value;
    }
  } catch (_) {
    // Cache failure: continue without Redis.
  }

  return null;
}

function setCached(key, value) {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  redisSet(
    `anime:${key}`,
    JSON.stringify(value),
    CACHE_TTL_SECONDS
  ).catch(() => {});
}

function extractJimakuSearchTitle(filename) {
  if (!filename) return '';

  let title = String(filename).split(/[\\/]/).pop();

  title = title.replace(/\.(mkv|mp4|avi|webm|mov)$/i, '');
  title = title.replace(/^\[[^\]]+\]/, '');

  // Normalize release separators before extracting the title.
  title = title.replace(/[._]+/g, ' ').trim();

  // Remove explicit episode markers and everything after them.
  title = title.replace(/\bS\d{1,2}E\d{1,3}\b.*$/i, '');
  title = title.replace(/第\d{1,4}話.*$/, '');

  // Remove release-style episode numbers, including ranges.
  title = title.replace(/\s[-–—]\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?.*$/, '');

  // Remove remaining release metadata.
  title = title.replace(/\[[^\]]*\]/g, '');
  title = title.replace(/\([^)]*\)/g, '');

  return title
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–—]+$/, '')
    .trim();
}

function getAbsoluteEpisodeFromFilename(filename) {
  const value = String(filename || '').replace(/_/g, ' ');

  // Prefer an explicit Japanese episode marker.
  const japaneseMatch = value.match(/第\s*0*(\d{1,4})\s*話/);
  if (japaneseMatch) {
    const episode = Number(japaneseMatch[1]);
    return Number.isInteger(episode) && episode > 0 ? episode : null;
  }

  // Release-style numbering, including multi-episode files such as " - 165-166".
  const releaseMatch = value.match(
    /\s[-–—]\s*0*(\d{1,4})(?:\s*[-–—]\s*0*(\d{1,4}))?/
  );

  if (!releaseMatch) return null;

  // For a multi-episode release, use its final episode.
  const episode = Number(releaseMatch[2] || releaseMatch[1]);
  return Number.isInteger(episode) && episode > 0 ? episode : null;
}

async function searchJimakuByTitle(title, token) {
  if (!title) return [];

  const entries = await fetchJson(
    `${JIMAKU_API}/entries/search?query=${encodeURIComponent(title)}`,
    {
      headers: {
        Authorization: token,
        Accept: 'application/json'
      }
    }
  );

  if (!Array.isArray(entries)) return [];

  // The title fallback is intended for TV anime, not related movies.
  return entries.filter(entry =>
    entry &&
    entry.id != null &&
    entry.anilist_id &&
    entry.flags &&
    entry.flags.movie === false &&
    entry.flags.anime === true
  );
}

async function resolveJimakuEntries(imdbId, filename) {
  const token = process.env.JIMAKU_API_TOKEN;

  if (!token) return [];

  let anilistIds = [];

  // Prefer the existing IMDb -> AniList mapping.
  try {
    const mapping = await fetchJson(
      `${ANIMAP_API}/map/imdb/${encodeURIComponent(imdbId)}`
    );

    anilistIds = [
      ...new Set(
        (Array.isArray(mapping.anilist_id) ? mapping.anilist_id : [])
          .filter(id => Number.isInteger(id) && id > 0)
      )
    ];
  } catch (_) {
    // AniMap may not have an IMDb mapping. Try the title fallback below.
  }

  if (anilistIds.length > 0) {
    const results = await Promise.all(
      anilistIds.map(async anilistId => {
        try {
          const entries = await fetchJson(
            `${JIMAKU_API}/entries/search?anilist_id=${anilistId}`,
            {
              headers: {
                Authorization: token,
                Accept: 'application/json'
              }
            }
          );

          return Array.isArray(entries) ? entries : [];
        } catch (_) {
          return [];
        }
      })
    );

    const uniqueEntries = new Map();

    for (const entries of results) {
      for (const entry of entries) {
        if (entry && entry.id != null) {
          uniqueEntries.set(String(entry.id), entry);
        }
      }
    }

    if (uniqueEntries.size > 0) {
      return [...uniqueEntries.values()];
    }
  }

  // Fallback: search Jimaku using the release filename.
  const title = extractJimakuSearchTitle(filename);
  if (!title) return [];

  try {
    return await searchJimakuByTitle(title, token);
  } catch (_) {
    return [];
  }
}
async function getAniListMedia(anilistId) {
  const cacheKey = `anilist:media:v2:${anilistId}`;
  const cached = await getCached(cacheKey);

  if (cached !== null) return cached;

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  const request = fetchJson(ANILIST_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      query: ANILIST_MEDIA_QUERY,
      variables: { id: anilistId }
    })
  })
    .then(response => {
      if (response.errors?.length) {
        throw new Error('AniList GraphQL query failed');
      }

      const media = response.data?.Media;
      if (!media) return null;

      setCached(cacheKey, media);
      return media;
    })
    .finally(() => pendingRequests.delete(cacheKey));

  pendingRequests.set(cacheKey, request);
  return request;
}

async function getAbsoluteEpisodeNumber(anilistId, episodeNumber) {
  const id = Number(anilistId);
  const episode = Number(episodeNumber);

  if (
    !Number.isInteger(id) || id <= 0 ||
    !Number.isInteger(episode) || episode <= 0
  ) {
    return null;
  }

  let currentId = id;
  let offset = 0;
  const visited = new Set();

  while (true) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);

    const media = await getAniListMedia(currentId);
    if (!media) return null;

    if (
      currentId === id &&
      Number.isInteger(media.episodes) &&
      episode > media.episodes
    ) {
      return null;
    }

    const prequels = (media.relations?.edges || [])
      .filter(edge => edge.relationType === 'PREQUEL')
      .map(edge => edge.node)
      .filter(Boolean);

    if (prequels.length === 0) {
      return offset + episode;
    }

    // Multiple prequels make the episode sequence ambiguous.
    if (prequels.length !== 1) return null;

    const prequel = prequels[0];

    if (
      !Number.isInteger(prequel.id) ||
      !Number.isInteger(prequel.episodes) ||
      prequel.episodes <= 0
    ) {
      return null;
    }

    offset += prequel.episodes;
    currentId = prequel.id;
  }
}

async function getJimakuFiles(entryId) {
  const id = Number(entryId);

  if (!Number.isInteger(id) || id <= 0) return [];

  const token = process.env.JIMAKU_API_TOKEN;
  if (!token) return [];

  const cacheKey = `jimaku:files:${id}`;
  const cached = await getCached(cacheKey);

  if (cached !== null) return cached;

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  const request = fetchJson(
    `${JIMAKU_API}/entries/${id}/files`,
    {
      headers: {
        Authorization: token,
        Accept: 'application/json'
      }
    }
  )
    .then(files => {
      const result = Array.isArray(files) ? files : [];
      setCached(cacheKey, result);
      return result;
    })
    .finally(() => pendingRequests.delete(cacheKey));

  pendingRequests.set(cacheKey, request);
  return request;
}

async function getJimakuEntries(imdbId, filename) {
  const normalizedId = String(imdbId || '').replace(/^tt/i, '');

  if (!/^\d+$/.test(normalizedId)) {
    return [];
  }

  const title = extractJimakuSearchTitle(filename);
  const cacheKey =
    `jimaku:v2:${normalizedId}:${title.toLowerCase() || 'mapping'}`;

  const cached = await getCached(cacheKey);
  if (cached !== null) return cached;

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  const request = resolveJimakuEntries(`tt${normalizedId}`, filename)
    .then(entries => {
      setCached(cacheKey, entries);
      return entries;
    })
    .finally(() => pendingRequests.delete(cacheKey));

  pendingRequests.set(cacheKey, request);
  return request;
}

function getEpisodeNumbers(filename) {
  const name = String(filename || '');
  const episodes = new Set();

  // Explicit Japanese episode notation, e.g. 第163話.
  const japaneseEpisode = name.match(/第\s*0*(\d{1,4})\s*話/);
  if (japaneseEpisode) {
    episodes.add(Number(japaneseEpisode[1]));
  }

  // Explicit season/episode notation, e.g. S02E01.
  for (const match of name.matchAll(/\bS\d{1,2}E(\d{1,3})\b/gi)) {
    episodes.add(Number(match[1]));
  }

  // Episode ranges, e.g. 01-04 or 29-32.
  const ranges = [];

  for (const match of name.matchAll(
    /(?:^|[\s._-])(\d{1,3})\s*[-~–]\s*(\d{1,3})(?=$|[\s._[(])/g
  )) {
    const start = Number(match[1]);
    const end = Number(match[2]);

    if (end >= start && end - start <= 100) {
      ranges.push({
        start,
        end,
        index: match.index,
        length: match[0].length
      });

      for (let episode = start; episode <= end; episode++) {
        episodes.add(episode);
      }
    }
  }

  // Standalone episode numbers. Ignore numbers already consumed by ranges.
  for (const match of name.matchAll(
    /(?:^|[\s._-])(\d{1,3})(?=$|[\s._[(])/g
  )) {
    const numberIndex = match.index + match[0].lastIndexOf(match[1]);

    const belongsToRange = ranges.some(range =>
      numberIndex >= range.index &&
      numberIndex < range.index + range.length
    );

    if (!belongsToRange) {
      episodes.add(Number(match[1]));
    }
  }

  return [...episodes];
}

function getJimakuFileScore(file) {
  const name = String(file.name || '');
  const lowerName = name.toLowerCase();
  const extension = lowerName.match(/\.(srt|ass|ssa)$/)?.[1];

  if (!extension) return null;

  // Exclude explicitly bilingual or multilingual files.
  if (
    /bilingual|multilingual|dual[._ -]?subs?|multi[._ -]?subs?/.test(lowerName) ||
    /(?:^|[._-])(?:ja|jpn)[._-](?:en|eng)(?:[._-]|$)/.test(lowerName) ||
    /(?:^|[._-])(?:en|eng)[._-](?:ja|jpn)(?:[._-]|$)/.test(lowerName)
  ) {
    return null;
  }

  // Exclude files explicitly labelled as another language.
  if (
    /\[(?:eng|english|en|por|pt|spa|es|fre|fra|fr)\]/i.test(name) ||
    /(?:^|[._-])(?:en|eng|english)(?:[._-]|$)/i.test(name)
  ) {
    return null;
  }

  const japaneseLabel =
    /\[(?:jpn|japanese|ja)\]/i.test(name) ||
    /(?:^|[._-])(?:jpn|ja)(?:[._-]|$)/i.test(name);

  return {
    extension,
    japaneseLabel,
    score: (japaneseLabel ? 100 : 0) +
      (extension === 'srt' ? 20 : 0)
  };
}

function selectJimakuFile(files, episodeNumbers) {
  const targets = [
    ...new Set(
      (Array.isArray(episodeNumbers) ? episodeNumbers : [episodeNumbers])
        .map(Number)
        .filter(number => Number.isInteger(number) && number > 0)
    )
  ];

  if (targets.length === 0 || !Array.isArray(files)) {
    return null;
  }

  const candidates = [];

  for (const file of files) {
    const fileScore = getJimakuFileScore(file);
    if (!fileScore) continue;

    const fileEpisodes = getEpisodeNumbers(file.name);

    const matchedIndex = targets.findIndex(episode =>
      fileEpisodes.includes(episode)
    );

    if (matchedIndex === -1) continue;

    candidates.push({
      ...file,
      matchedEpisode: targets[matchedIndex],
      format: fileScore.extension,
      japaneseLabel: fileScore.japaneseLabel,
      score: fileScore.score,
      episodePriority: matchedIndex
    });
  }

  candidates.sort((a, b) =>
    a.episodePriority - b.episodePriority ||
    b.score - a.score
  );

  return candidates[0] || null;
}

async function getAniListSeasonPosition(anilistId) {
  const id = Number(anilistId);

  if (!Number.isInteger(id) || id <= 0) return null;

  let currentId = id;
  let position = 1;
  const visited = new Set();

  while (true) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);

    const media = await getAniListMedia(currentId);
    if (!media) return null;

    const prequels = (media.relations?.edges || [])
      .filter(edge => edge.relationType === 'PREQUEL')
      .map(edge => edge.node)
      .filter(Boolean);

    if (prequels.length === 0) {
      return position;
    }

    if (prequels.length !== 1) {
      return null;
    }

    const prequelId = Number(prequels[0].id);

    if (!Number.isInteger(prequelId) || prequelId <= 0) {
      return null;
    }

    position++;
    currentId = prequelId;
  }
}

async function getJimakuEntriesForSeason(imdbId, seasonNumber, filename) {
  const season = Number(seasonNumber);

  if (!Number.isInteger(season) || season < 1) {
    return [];
  }

  const entries = await getJimakuEntries(imdbId, filename);

  const results = await Promise.all(
    entries.map(async entry => {
      if (!entry.anilist_id) return null;

      const position = await getAniListSeasonPosition(
        entry.anilist_id
      );

      if (position !== season) return null;

      return {
        ...entry,
        seasonPosition: position
      };
    })
  );

  return results.filter(Boolean);
}

async function getJimakuSubtitle(imdbId, season, episode, filename) {
  const seasonNumber = Number(season);
  const episodeNumber = Number(episode);

  if (
    !Number.isInteger(seasonNumber) || seasonNumber < 1 ||
    !Number.isInteger(episodeNumber) || episodeNumber < 1
  ) return null;

  const entries = await getJimakuEntriesForSeason(
    imdbId,
    seasonNumber,
    filename
  );


  const candidates = await Promise.all(
    entries.map(async entry => {
      const absoluteEpisode = await getAbsoluteEpisodeNumber(
        entry.anilist_id,
        episodeNumber
      );

      const targetEpisodes = absoluteEpisode
        ? [...new Set([absoluteEpisode, episodeNumber])]
        : [episodeNumber];

      const files = await getJimakuFiles(entry.id);
      const selectedFile = selectJimakuFile(files, targetEpisodes);

      if (!selectedFile) return null;

      return {
        ...selectedFile,
        absoluteEpisode,
        entry
      };
    })
  );

  const validCandidates = candidates.filter(Boolean);

  validCandidates.sort((a, b) =>
    a.episodePriority - b.episodePriority ||
    b.score - a.score
  );

  if (validCandidates.length > 0) {
    return validCandidates[0];
  }

  // Fallback for single-series anime where Stremio's season numbering
  // does not correspond to AniList seasons (e.g. Naruto Shippuden).
  const absoluteEpisode = getAbsoluteEpisodeFromFilename(filename);
  if (!absoluteEpisode) return null;

  const allEntries = await getJimakuEntries(imdbId, filename);

  const seriesEntries = allEntries.filter(entry =>
    entry &&
    entry.flags &&
    entry.flags.movie === false &&
    entry.flags.anime === true
  );

  const absoluteCandidates = await Promise.all(
    seriesEntries.map(async entry => {
      const files = await getJimakuFiles(entry.id);
      const selectedFile = selectJimakuFile(files, [absoluteEpisode]);

      if (!selectedFile) return null;

      return {
        ...selectedFile,
        absoluteEpisode,
        entry
      };
    })
  );

  const matchingCandidates = absoluteCandidates.filter(Boolean);

  matchingCandidates.sort((a, b) => b.score - a.score);

  return matchingCandidates[0] || null;
}

module.exports = {
  getJimakuEntries,
  getAniListMedia,
  getAbsoluteEpisodeNumber,
  getAniListSeasonPosition,
  getJimakuEntriesForSeason,
  getJimakuFiles,
  selectJimakuFile,
  getJimakuSubtitle
};