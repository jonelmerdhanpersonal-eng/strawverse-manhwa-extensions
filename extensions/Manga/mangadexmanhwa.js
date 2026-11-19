/**
 * StrawVerse community extension: MangaDex Korean-origin Manhwa
 *
 * Uses MangaDex's public API. It does not host, mirror, or package media.
 * MangaDex attribution and scanlation-group attribution are included in the
 * chapter labels returned to StrawVerse.
 *
 * MangaDex API acceptable-use requirements apply. In particular, applications
 * using chapter content must credit MangaDex and scanlation groups, honor
 * scanlation-group removal requests, and must not monetize MangaDex API access
 * with ads or paid services. See README.md for details.
 */

const name = "mangadexmanhwa";
const version = "1.0.0";
const baseUrl = "https://api.mangadex.org";
const pageSize = 20;
const chapterPageSize = 500;
const allowedContentRatings = ["safe", "suggestive"];
const allowedTranslatedLanguages = ["en"];

// Add MangaDex scanlation-group UUIDs here if the group requests content removal.
const REMOVED_SCANLATION_GROUP_IDS = new Set([]);

// A short in-memory cache prevents repeated metadata requests during browsing.
const CACHE_TTL_MS = 5 * 60 * 1000;
const infoCache = new Map();
const chapterCache = new Map();
let tagCache = null;

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(cache, key, value) {
  cache.set(key, { createdAt: Date.now(), value });
  return value;
}

function getAxios() {
  if (!global.axios || typeof global.axios.get !== "function") {
    throw new Error("StrawVerse HTTP client (global.axios) is unavailable.");
  }
  return global.axios;
}

async function getJson(path, params) {
  const query = params ? params.toString() : "";
  const url = `${baseUrl}${path}${query ? `?${query}` : ""}`;
  const response = await getAxios().get(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "StrawVerse/11.1.1 (+https://github.com/TheYogMehta/StrawVerse)",
    },
  });
  return response?.data;
}

function addRepeated(params, key, values) {
  for (const value of values) params.append(key, String(value));
}

function getPage(page) {
  const parsed = Number.parseInt(page, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getTitle(attributes) {
  const titles = attributes?.title || {};
  return (
    titles.en ||
    titles["en-us"] ||
    titles["en-gb"] ||
    Object.values(titles)[0] ||
    "Untitled Manhwa"
  );
}

function getDescription(attributes) {
  const descriptions = attributes?.description || {};
  return descriptions.en || Object.values(descriptions)[0] || "";
}

function getCoverUrl(mangaId, relationships, thumbnail = true) {
  const cover = (relationships || []).find((item) => item.type === "cover_art");
  const fileName = cover?.attributes?.fileName;
  if (!fileName) return null;
  const suffix = thumbnail ? ".256.jpg" : "";
  return `https://uploads.mangadex.org/covers/${mangaId}/${encodeURIComponent(fileName)}${suffix}`;
}

function getPeople(relationships) {
  const people = (relationships || [])
    .filter((item) => item.type === "author" || item.type === "artist")
    .map((item) => item.attributes?.name)
    .filter(Boolean);
  return [...new Set(people)].join(", ");
}

function getGenres(attributes) {
  return [...new Set(
    (attributes?.tags || [])
      .map((tag) => tag.attributes?.name?.en)
      .filter(Boolean),
  )];
}

function normaliseStatus(status) {
  const value = String(status || "ongoing").toLowerCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function getTagMap() {
  if (tagCache && Date.now() - tagCache.createdAt < 30 * 60 * 1000) {
    return tagCache.value;
  }

  const data = await getJson("/manga/tag");
  const map = new Map();
  for (const tag of data?.data || []) {
    const id = tag.id;
    const englishName = tag.attributes?.name?.en;
    if (id && englishName) map.set(englishName.toLowerCase(), id);
  }
  tagCache = { createdAt: Date.now(), value: map };
  return map;
}

async function resolveGenreIds(genreFilter) {
  if (!genreFilter) return [];
  const values = Array.isArray(genreFilter)
    ? genreFilter
    : String(genreFilter).split(",");
  const cleaned = values.map((value) => String(value).trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ids = cleaned.filter((value) => uuidPattern.test(value));
  const names = cleaned.filter((value) => !uuidPattern.test(value));

  if (names.length > 0) {
    const tagMap = await getTagMap();
    for (const value of names) {
      const id = tagMap.get(value.toLowerCase());
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

async function buildSearchParams(page, filters = {}, query = "") {
  const safePage = getPage(page);
  const params = new URLSearchParams();
  params.set("limit", String(pageSize));
  params.set("offset", String((safePage - 1) * pageSize));
  params.set("originalLanguage[]", "ko");
  params.set("hasAvailableChapters", "true");
  params.set("availableTranslatedLanguage[]", "en");
  addRepeated(params, "contentRating[]", allowedContentRatings);
  addRepeated(params, "includes[]", ["cover_art", "author", "artist"]);

  if (query) params.set("title", query);

  const status = String(filters?.status || "").trim().toLowerCase();
  if (["ongoing", "completed", "hiatus", "cancelled"].includes(status)) {
    params.append("status[]", status);
  }

  const sort = String(filters?.sort || "").trim().toLowerCase();
  if (sort === "most-followed") {
    params.set("order[followedCount]", "desc");
  } else if (sort === "rating") {
    params.set("order[rating]", "desc");
  } else if (sort === "title-az") {
    params.set("order[title]", "asc");
  } else if (query) {
    params.set("order[relevance]", "desc");
  } else {
    params.set("order[latestUploadedChapter]", "desc");
  }

  const genreIds = await resolveGenreIds(filters?.genre);
  if (genreIds.length > 0) {
    addRepeated(params, "includedTags[]", genreIds);
    params.set("includedTagsMode", "OR");
  }
  return params;
}

function mapMangaResults(data) {
  return (data?.data || []).map((manga) => ({
    id: `mdko-${manga.id}`,
    title: getTitle(manga.attributes),
    image: getCoverUrl(manga.id, manga.relationships, true),
  }));
}

async function fetchMangaPage(query, page = 1, filters = {}) {
  const safeQuery = String(query || "").trim();
  const safePage = getPage(page);
  const cacheKey = JSON.stringify({ q: safeQuery, page: safePage, filters });
  const cached = cacheGet(infoCache, `search:${cacheKey}`);
  if (cached) return cached;

  const params = await buildSearchParams(safePage, filters, safeQuery);
  const data = await getJson("/manga", params);
  const results = mapMangaResults(data);
  const total = Number(data?.total || 0);
  return cacheSet(infoCache, `search:${cacheKey}`, {
    current_page: safePage,
    hasNextPage: (safePage * pageSize) < total,
    results,
  });
}

async function latestManga(page = 1, filters = {}) {
  return fetchMangaPage("", page, filters);
}

async function searchManga(query, page = 1, filters = {}) {
  if (!String(query || "").trim()) return latestManga(page, filters);
  return fetchMangaPage(query, page, filters);
}

function unwrapMangaId(mangaId) {
  return String(mangaId || "").replace(/^mdko-/, "");
}

async function fetchMangaInfo(mangaId) {
  const id = unwrapMangaId(mangaId);
  if (!id) throw new Error("A MangaDex manga ID is required.");

  const cached = cacheGet(infoCache, `detail:${id}`);
  if (cached) return cached;

  const params = new URLSearchParams();
  addRepeated(params, "includes[]", ["cover_art", "author", "artist"]);
  const data = await getJson(`/manga/${encodeURIComponent(id)}`, params);
  const manga = data?.data;
  if (!manga?.id || !manga.attributes) {
    throw new Error("MangaDex did not return manga details for this title.");
  }

  const attributes = manga.attributes;
  const result = {
    id: `mdko-${manga.id}`,
    title: getTitle(attributes),
    image: getCoverUrl(manga.id, manga.relationships, false),
    description: getDescription(attributes),
    genres: getGenres(attributes),
    author: getPeople(manga.relationships),
    type: attributes.originalLanguage === "ko" ? "Manhwa" : "Manga",
    released: attributes.year ? String(attributes.year) : "",
    year: attributes.year ? Number(attributes.year) : null,
    status: normaliseStatus(attributes.status),
  };
  return cacheSet(infoCache, `detail:${id}`, result);
}

function getScanlationGroup(chapter) {
  const group = (chapter?.relationships || []).find(
    (relationship) => relationship.type === "scanlation_group",
  );
  return {
    id: group?.id || "",
    name: group?.attributes?.name || "",
  };
}

async function fetchChapters(mangaId) {
  const id = unwrapMangaId(mangaId);
  if (!id) return { TotalPages: 0, total: 0, Chapters: [] };

  const cached = cacheGet(chapterCache, id);
  if (cached) return cached;

  try {
    const params = new URLSearchParams();
    params.set("limit", String(chapterPageSize));
    params.set("offset", "0");
    params.set("order[chapter]", "desc");
    params.set("includeFuturePublishAt", "0");
    addRepeated(params, "translatedLanguage[]", allowedTranslatedLanguages);
    addRepeated(params, "contentRating[]", allowedContentRatings);
    params.append("includes[]", "scanlation_group");

    const data = await getJson(`/manga/${encodeURIComponent(id)}/feed`, params);
    const chapters = (data?.data || []).reduce((items, chapter) => {
      const group = getScanlationGroup(chapter);
      if (group.id && REMOVED_SCANLATION_GROUP_IDS.has(group.id)) return items;

      const attributes = chapter.attributes || {};
      const chapterNumber = attributes.chapter;
      const number = chapterNumber !== null && chapterNumber !== undefined
        ? (Number.parseFloat(chapterNumber) || 0)
        : 0;
      const chapterTitle = attributes.title || (number ? `Chapter ${number}` : "Chapter");
      const credit = group.name
        ? `Scanlation group: ${group.name}`
        : "Scanlation group: not listed";
      items.push({
        id: `mdko-ch-${chapter.id}`,
        number,
        title: `${chapterTitle} · ${credit}`,
        group: group.name,
      });
      return items;
    }, []);

    const result = {
      TotalPages: 1,
      total: chapters.length,
      Chapters: chapters,
    };
    return cacheSet(chapterCache, id, result);
  } catch (error) {
    // Keep provider failures visible in logs instead of silently disguising them
    // as a title with zero chapters.
    throw error;
  }
}

async function fetchChapterPages(chapterId) {
  const id = String(chapterId || "").replace(/^mdko-ch-/, "");
  if (!id) return [];

  const data = await getJson(`/at-home/server/${encodeURIComponent(id)}`);
  const chapter = data?.chapter;
  const serverBase = String(data?.baseUrl || "").replace(/\/$/, "");
  const hash = chapter?.hash;
  const originalFiles = Array.isArray(chapter?.data) ? chapter.data : [];
  const saverFiles = Array.isArray(chapter?.dataSaver) ? chapter.dataSaver : [];
  const useOriginal = originalFiles.length > 0;
  const files = useOriginal ? originalFiles : saverFiles;
  const qualityPath = useOriginal ? "data" : "data-saver";

  if (!serverBase || !hash || files.length === 0) return [];

  return files.map((file, index) => ({
    page: index + 1,
    img: `${serverBase}/${qualityPath}/${encodeURIComponent(hash)}/${encodeURIComponent(file)}`,
  }));
}

module.exports = {
  name,
  version,
  baseUrl,
  latestManga,
  searchManga,
  fetchMangaInfo,
  fetchChapters,
  fetchChapterPages,
};
