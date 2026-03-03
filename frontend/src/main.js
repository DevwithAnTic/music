import { animate, stagger } from "animejs";
import "./style.css";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
const AUDIO_API_URL =
  import.meta.env.VITE_AUDIO_API_URL ||
  (API_BASE_URL ? `${API_BASE_URL}/getAudio.php` : import.meta.env.VITE_API_URL || "");
const SEARCH_API_URL =
  import.meta.env.VITE_SEARCH_API_URL ||
  (API_BASE_URL ? `${API_BASE_URL}/youtubeSearch.php` : "");
const API_TOKEN = import.meta.env.VITE_API_TOKEN || "";
const REQUIRE_AUTH = String(import.meta.env.VITE_REQUIRE_AUTH || "false").toLowerCase() === "true";

function apiHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (API_TOKEN) {
    headers.Authorization = `Bearer ${API_TOKEN}`;
  }
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, options, maxAttempts = 3) {
  let lastError = new Error("Request failed");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        return { response, payload };
      }
      const retriable = [429, 500, 502, 503, 504].includes(response.status);
      const message = payload?.error || `Request failed with status ${response.status}`;
      if (!retriable || attempt === maxAttempts) {
        if (response.status === 401) {
          throw new Error("Unauthorized. Check VITE_API_TOKEN in frontend env.");
        }
        throw new Error(message);
      }
      const retryAfterHeader = Number(response.headers.get("Retry-After")) || 0;
      const backoffMs = retryAfterHeader > 0 ? retryAfterHeader * 1000 : 350 * attempt + Math.floor(Math.random() * 200);
      await sleep(backoffMs);
      continue;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxAttempts) {
        break;
      }
      await sleep(300 * attempt + Math.floor(Math.random() * 180));
    }
  }
  throw lastError;
}

document.querySelector("#app").innerHTML = `
  <main class="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-8">
    <header class="glass reveal rounded-3xl p-6">
      <p class="text-xs uppercase tracking-[0.25em] text-cyan-300/90">StreamWave</p>
      <h1 class="mt-2 text-3xl font-semibold md:text-4xl">YouTube Audio Streaming</h1>
      <p class="mt-3 text-sm text-slate-300">
        Search with youtubei.js, request audio link from backend, and stream instantly.
      </p>
    </header>

    <section class="glass reveal rounded-3xl p-4 md:p-6">
      <form id="searchForm" class="flex flex-col gap-3 md:flex-row">
        <input
          id="searchInput"
          type="text"
          placeholder="Search songs, artists, or albums..."
          class="w-full rounded-2xl border border-white/20 bg-slate-900/80 px-4 py-3 text-sm outline-none transition focus:border-cyan-400"
          autocomplete="off"
        />
        <button
          id="searchBtn"
          type="submit"
          class="rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-cyan-300"
        >
          Search
        </button>
      </form>
      <ul id="suggestions" class="mt-3 grid gap-2"></ul>
    </section>

    <section class="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div id="results" class="glass reveal rounded-3xl p-4 md:p-6">
        <p class="text-sm text-slate-300">Search for a track to start streaming.</p>
      </div>

      <aside class="glass reveal rounded-3xl p-4 md:p-6">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-cyan-200">Now Playing</h2>
        <p id="nowPlaying" class="mt-3 text-sm text-slate-300">Nothing selected.</p>
        <audio id="audioPlayer" class="mt-4 w-full" controls preload="none"></audio>
      </aside>
    </section>
  </main>
`;

const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#searchInput");
const searchBtn = document.querySelector("#searchBtn");
const suggestionsList = document.querySelector("#suggestions");
const resultsContainer = document.querySelector("#results");
const nowPlaying = document.querySelector("#nowPlaying");
const audioPlayer = document.querySelector("#audioPlayer");

let suggestionTimer;
const isSearchReady = Boolean(SEARCH_API_URL);
let suggestionRequestId = 0;
let suppressSuggestions = false;

animate(".reveal", {
  opacity: [0, 1],
  translateY: [16, 0],
  delay: stagger(90),
  duration: 550,
  easing: "easeOutCubic",
});

searchBtn.disabled = false;
searchBtn.textContent = "Search";

if (REQUIRE_AUTH && !API_TOKEN) {
  searchBtn.disabled = true;
  showError("Missing API token. Set VITE_API_TOKEN for secure backend access.");
}

searchInput.addEventListener("input", () => {
  suppressSuggestions = false;
  clearTimeout(suggestionTimer);
  const query = searchInput.value.trim();
  if (!query) {
    suggestionsList.innerHTML = "";
    return;
  }
  suggestionTimer = setTimeout(() => {
    const requestId = ++suggestionRequestId;
    loadSuggestions(query, requestId);
  }, 250);
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  suppressSuggestions = true;
  clearTimeout(suggestionTimer);
  suggestionRequestId += 1;
  const query = searchInput.value.trim();
  if (!query) return;
  suggestionsList.innerHTML = "";
  await runSearch(query);
});

async function loadSuggestions(query, requestId) {
  if (!SEARCH_API_URL) return;
  let suggestions = [];
  try {
    const { payload } = await fetchJsonWithRetry(SEARCH_API_URL, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ mode: "suggest", query }),
    });
    suggestions = normalizeSuggestions(payload?.suggestions).slice(0, 6);
  } catch {
    suggestions = [];
  }

  const currentQuery = searchInput.value.trim();
  const isStale = requestId !== suggestionRequestId;
  if (suppressSuggestions || isStale || currentQuery !== query) {
    return;
  }
  renderSuggestions(suggestions);
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

function renderSuggestions(items) {
  if (!items.length) {
    suggestionsList.innerHTML = "";
    return;
  }
  suggestionsList.innerHTML = items
    .map(
      (text) => `
      <li>
        <button
          type="button"
          class="w-full rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-left text-sm hover:border-cyan-300/60 hover:bg-slate-800"
          data-suggestion="${escapeHtml(text)}"
        >${escapeHtml(text)}</button>
      </li>
    `
    )
    .join("");

  suggestionsList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      suppressSuggestions = true;
      const text = button.getAttribute("data-suggestion") || "";
      searchInput.value = text;
      suggestionsList.innerHTML = "";
      await runSearch(text);
    });
  });
}

async function runSearch(query) {
  if (!SEARCH_API_URL) {
    showError("Missing search API URL in env.");
    return;
  }
  setLoading(true);
  try {
    const { payload } = await fetchJsonWithRetry(SEARCH_API_URL, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ mode: "search", query }),
    });
    const videos = normalizeVideos(payload?.videos).slice(0, 12);
    renderResults(videos);
  } catch (error) {
    showError(`Search failed: ${error.message}`);
  } finally {
    setLoading(false);
  }
}

function normalizeVideos(raw) {
  if (Array.isArray(raw)) return raw;
  const arrays = [];
  if (Array.isArray(raw?.videos)) arrays.push(raw.videos);
  if (Array.isArray(raw?.results)) arrays.push(raw.results);
  if (Array.isArray(raw?.contents)) arrays.push(raw.contents);
  if (Array.isArray(raw?.items)) arrays.push(raw.items);

  const flatItems = arrays.flat();
  const parsed = flatItems
    .map((item) => {
      const id =
        item?.id ||
        item?.video_id ||
        item?.videoId ||
        item?.endpoint?.payload?.videoId ||
        item?.endpoint?.metadata?.videoId;

      const title = readText(item?.title || item?.headline || item?.name);
      const author = readText(item?.author || item?.channel || item?.owner);
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
      return { id, title, author: author || "Unknown Artist", duration: duration || "--:--", thumbnail };
    })
    .filter(Boolean);

  const unique = new Map();
  parsed.forEach((video) => {
    if (!unique.has(video.id)) unique.set(video.id, video);
  });
  return [...unique.values()];
}

function renderResults(videos) {
  if (!videos.length) {
    resultsContainer.innerHTML = `<p class="text-sm text-rose-300">No results found.</p>`;
    return;
  }

  resultsContainer.innerHTML = `
    <div class="mb-4 flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-cyan-200">Results</h2>
      <p class="text-xs text-slate-400">${videos.length} tracks</p>
    </div>
    <div class="grid gap-3">
      ${videos
        .map(
          (video) => `
            <article class="track-card flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-3">
              <img src="${escapeHtml(video.thumbnail)}" alt="" class="h-14 w-14 rounded-lg object-cover" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium">${escapeHtml(video.title)}</p>
                <p class="truncate text-xs text-slate-400">${escapeHtml(video.author)} • ${escapeHtml(video.duration)}</p>
              </div>
              <button
                type="button"
                class="rounded-xl bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-cyan-300"
                data-video-id="${escapeHtml(video.id)}"
                data-video-title="${escapeHtml(video.title)}"
              >
                Play
              </button>
            </article>
          `
        )
        .join("")}
    </div>
  `;

  animate(".track-card", {
    opacity: [0, 1],
    translateY: [8, 0],
    delay: stagger(35),
    duration: 400,
    easing: "easeOutQuad",
  });

  resultsContainer.querySelectorAll("button[data-video-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const videoId = button.getAttribute("data-video-id");
      const title = button.getAttribute("data-video-title") || "Unknown Track";
      await streamVideo(videoId, title);
    });
  });
}

async function streamVideo(videoId, title) {
  if (!AUDIO_API_URL) {
    showError("Missing audio API URL. Configure VITE_API_BASE_URL in .env.");
    return;
  }
  if (REQUIRE_AUTH && !API_TOKEN) {
    showError("Missing API token. Set VITE_API_TOKEN for secure backend access.");
    return;
  }
  setLoading(true);
  nowPlaying.textContent = `Loading: ${title}`;
  try {
    const { payload } = await fetchJsonWithRetry(AUDIO_API_URL, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ videoId }),
    });
    if (!payload?.audioUrl) {
      throw new Error("Backend did not return audioUrl.");
    }
    audioPlayer.src = payload.audioUrl;
    await audioPlayer.play();
    nowPlaying.textContent = `Now Playing: ${title}`;
  } catch (error) {
    showError(`Playback failed: ${error.message}`);
    nowPlaying.textContent = "Nothing selected.";
  } finally {
    setLoading(false);
  }
}

function setLoading(isLoading) {
  searchBtn.disabled = isLoading || !isSearchReady;
  searchBtn.textContent = isLoading ? "Loading..." : "Search";
}

function showError(message) {
  resultsContainer.innerHTML = `<p class="text-sm text-rose-300">${escapeHtml(message)}</p>`;
}

function readText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function" && value.toString !== Object.prototype.toString) return value.toString();
  if (Array.isArray(value?.runs)) return value.runs.map((run) => run?.text || "").join("");
  if (typeof value?.text === "string") return value.text;
  return "";
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
