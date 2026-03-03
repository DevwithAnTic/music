#!/usr/bin/env node
// Usage:
//   node youtubeSearch.js suggest "arijit"
//   node youtubeSearch.js search "arijit songs"
// Prints JSON to stdout.

const youtubeSearchApi = require("youtube-search-api");

function readText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function" && value.toString !== Object.prototype.toString) return value.toString();
  if (Array.isArray(value?.runs)) return value.runs.map((run) => run?.text || "").join("");
  if (typeof value?.text === "string") return value.text;
  return "";
}

function normalizeSuggestions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? item : readText(item)))
      .filter(Boolean);
  }
  if (Array.isArray(raw?.suggestions)) return normalizeSuggestions(raw.suggestions);
  return [];
}

function buildSuggestionsFromSearchApi(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const unique = new Map();
  for (const item of items) {
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    const key = title.toLowerCase();
    if (!unique.has(key)) unique.set(key, title);
  }
  return [...unique.values()];
}

function normalizeVideos(raw) {
  const arrays = [];
  if (Array.isArray(raw?.videos)) arrays.push(raw.videos);
  if (Array.isArray(raw?.results)) arrays.push(raw.results);
  if (Array.isArray(raw?.contents)) arrays.push(raw.contents);
  if (Array.isArray(raw?.items)) arrays.push(raw.items);

  const items = arrays.flat();
  const parsed = items
    .map((item) => {
      const id =
        item?.id ||
        item?.video_id ||
        item?.videoId ||
        item?.endpoint?.payload?.videoId ||
        item?.endpoint?.metadata?.videoId;
      const title = readText(item?.title || item?.headline || item?.name);
      const author = readText(
        item?.author?.name ||
          item?.author ||
          item?.channel?.name ||
          item?.channel ||
          item?.owner?.name ||
          item?.owner ||
          item?.byline_text
      );
      const duration = readText(item?.duration || item?.length_text || item?.lengthText);
      const thumbs =
        item?.thumbnails ||
        item?.thumbnail?.thumbnails ||
        item?.thumbnail ||
        [];
      const thumbnail = Array.isArray(thumbs)
        ? thumbs[thumbs.length - 1]?.url
        : thumbs?.url || "";

      if (!id || !title) return null;
      return {
        id,
        title,
        author: author || "Unknown Artist",
        duration: duration || "--:--",
        thumbnail,
      };
    })
    .filter(Boolean);

  const unique = new Map();
  parsed.forEach((video) => {
    if (!unique.has(video.id)) unique.set(video.id, video);
  });
  return [...unique.values()];
}

async function createClient() {
  const { Innertube } = await import("youtubei.js");
  try {
    return await Innertube.create({ generate_session_locally: true });
  } catch {
    return await Innertube.create();
  }
}

(async () => {
  const mode = (process.argv[2] || "").trim().toLowerCase();
  const query = (process.argv[3] || "").trim();

  if (!mode || !query) {
    console.error("Missing arguments. Expected mode and query.");
    process.exit(1);
  }
  if (mode !== "search" && mode !== "suggest") {
    console.error("Invalid mode. Use search or suggest.");
    process.exit(1);
  }

  try {
    if (mode === "suggest") {
      // youtube-search-api doesn't expose YouTube autocomplete by query,
      // so we derive suggestion candidates from top keyword search titles.
      const raw = await youtubeSearchApi.GetListByKeyword(query, false, 10, [{ type: "video" }]);
      const suggestions = buildSuggestionsFromSearchApi(raw).slice(0, 8);
      process.stdout.write(JSON.stringify({ suggestions }));
      return;
    }

    const yt = await createClient();
    // First try a strict video search, then fallback to generic search if empty.
    const primary = await yt.search(query, { type: "video" });
    let videos = normalizeVideos(primary).slice(0, 15);
    if (videos.length === 0) {
      const fallback = await yt.search(query);
      videos = normalizeVideos(fallback).slice(0, 15);
    }
    process.stdout.write(JSON.stringify({ videos }));
  } catch (error) {
    const message = error?.message || "Unknown error";
    console.error(`youtubeSearch failed: ${message}`);
    process.exit(1);
  }
})();
