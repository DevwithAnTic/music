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
const IS_PROD = Boolean(import.meta.env.PROD);
const LOCAL_SUGGESTION_LIMIT = 8;
const SEARCH_HISTORY_KEY = "streamwave:search-history";
const PLAYER_VOLUME_KEY = "streamwave:player-volume";
const AUTO_SEARCH_DELAY_MS = 420;
const PLAYER_TRANSITION_MS = 240;
const PLAYBACK_QUEUE_KEY = "streamwave:playback-queue";
const AUTOPLAY_KEY = "streamwave:autoplay-enabled";
const LOOP_MODE_KEY = "streamwave:loop-mode";
const RECENT_SONGS_KEY = "streamwave:recent-songs";
const LYRICS_CACHE_KEY = "streamwave:lyrics-cache";
const RECENT_CACHE_LIMIT = 10;
const PREFETCH_BUFFER_TOLERANCE_SEC = 0.35;
const DEFAULT_TRACK_TITLE = "Nothing Playing";
const DEFAULT_TRACK_ARTIST = "No track selected";
const DEFAULT_TRACK_THUMBNAIL = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0f172a"/>
        <stop offset="100%" stop-color="#111827"/>
      </linearGradient>
    </defs>
    <rect width="256" height="256" rx="18" fill="url(#g)"/>
    <circle cx="128" cy="128" r="58" fill="none" stroke="#38bdf8" stroke-width="8" opacity="0.7"/>
    <circle cx="128" cy="128" r="10" fill="#e2e8f0"/>
    <text x="128" y="212" fill="#cbd5e1" font-family="Sora, sans-serif" font-size="18" text-anchor="middle">Nothing Playing</text>
  </svg>`
)}`;

function isHttpsUrl(value) {
  return typeof value === "string" && value.trim().startsWith("https://");
}

if (IS_PROD) {
  const usesSecureBase = isHttpsUrl(API_BASE_URL);
  const usesSecureAudio = isHttpsUrl(AUDIO_API_URL);
  const usesSecureSearch = isHttpsUrl(SEARCH_API_URL);
  if (!usesSecureBase && (!usesSecureAudio || !usesSecureSearch)) {
    throw new Error("Production requires HTTPS API endpoints. Set VITE_API_BASE_URL to an https:// URL.");
  }
}

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
  <main class="app-shell mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-4 px-3 pb-36 pt-4 md:min-h-screen md:gap-6 md:px-8 md:py-8 md:pb-8">
    <header id="appHeader" class="glass reveal rounded-3xl p-4 md:p-6">
      <p class="text-xs uppercase tracking-[0.25em] text-cyan-300/90">StreamWave</p>
      <h1 class="mt-2 text-[1.9rem] font-semibold leading-tight sm:text-4xl">YouTube Audio Streaming</h1>
      <p class="mt-3 text-base text-slate-300 md:text-sm">
        Search with youtubei.js, request audio link from backend, and stream instantly.
      </p>
    </header>

    <section id="searchSection" class="glass reveal rounded-3xl p-2 md:p-3">
      <form id="searchForm" class="flex flex-col gap-2 md:flex-row">
        <div id="homeMenuWrap" class="home-menu-wrap">
          <button
            id="homeMenuBtn"
            type="button"
            class="home-menu-btn hidden"
            aria-label="Menu"
          >
            ☰
          </button>
          <div id="homeMenu" class="home-menu hidden">
            <button id="clearCacheBtn" type="button" class="home-menu-item">Clear Cache</button>
          </div>
        </div>
        <button
          id="searchHomeBtn"
          type="button"
          class="hidden rounded-2xl border border-cyan-300/40 px-3 py-1.5 text-xs font-semibold tracking-[0.16em] text-cyan-300 hover:border-cyan-200 hover:text-cyan-200 md:text-[11px]"
        >
          STREAMWAVE
        </button>
        <input
          id="searchInput"
          type="text"
          placeholder="Search songs, artists, or albums..."
          class="w-full rounded-2xl border border-white/20 bg-slate-900/80 px-3 py-2 text-base outline-none transition focus:border-cyan-400 md:text-sm"
          autocomplete="off"
        />
        <button
          id="searchBtn"
          type="submit"
          class="rounded-2xl bg-cyan-400 px-4 py-2 text-base font-semibold text-slate-900 transition hover:bg-cyan-300 active:scale-[0.99] md:text-sm"
        >
          Search
        </button>
      </form>
      <ul id="suggestions" class="mt-2 grid max-h-64 gap-2 overflow-y-auto"></ul>
    </section>

    <section id="searchOverlayResults" class="hidden fixed z-50 max-h-[52vh] overflow-y-auto rounded-3xl border border-white/15 bg-slate-950/90 p-4 backdrop-blur-xl shadow-2xl"></section>
    <section id="searchOverlaySuggestions" class="hidden fixed max-h-[44vh] overflow-y-auto rounded-3xl border border-white/15 bg-slate-950/92 p-3 backdrop-blur-xl shadow-2xl"></section>

    <section class="grid gap-6">
      <div id="results" class="hidden glass reveal rounded-3xl p-4 md:p-6"></div>

      <aside class="safe-bottom mobile-player glass reveal fixed bottom-2 left-2 right-2 z-40 rounded-2xl p-3 shadow-2xl md:bottom-3 md:left-3 md:right-3 md:p-4 lg:hidden">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-cyan-200">Now Playing</h2>
          <button
            id="togglePlayerSizeBtn"
            type="button"
            class="rounded-lg border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:border-cyan-300/60"
          >
            Open
          </button>
        </div>
        <p id="nowPlaying" class="mt-2 truncate text-xs text-slate-300 md:text-sm">Nothing playing.</p>
        <div id="miniPlayerBar" class="mini-player-bar mt-3">
          <img
            id="miniThumb"
            class="mini-player-thumb"
            src="${DEFAULT_TRACK_THUMBNAIL}"
            alt=""
          />
          <div class="mini-player-meta">
            <p id="miniTitle" class="mini-player-title">${DEFAULT_TRACK_TITLE}</p>
            <p id="miniArtist" class="mini-player-artist">${DEFAULT_TRACK_ARTIST}</p>
          </div>
          <button id="miniPlayPauseBtn" type="button" class="mini-player-control" aria-label="Toggle play">
            ▶
          </button>
          <button id="miniNextBtn" type="button" class="mini-player-control" aria-label="Next track">
            ▶|
          </button>
        </div>
        <div id="playerShell" class="hidden player-shell mt-4 rounded-2xl border border-white/10 bg-slate-900/70 p-3">
          <div class="flex items-center gap-2">
            <button
              id="togglePlayBtn"
              type="button"
              class="rounded-xl bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-cyan-300"
            >
              Play
            </button>
            <p id="playbackTime" class="text-xs text-slate-400">0:00 / 0:00</p>
          </div>
          <input id="seekBar" class="player-range mt-3 w-full" type="range" min="0" max="1000" value="0" />
          <div class="mt-3 flex items-center gap-2">
            <span class="text-xs text-slate-400">Vol</span>
            <input id="volumeControl" class="player-range w-full" type="range" min="0" max="1" step="0.01" value="0.85" />
            <button
              id="muteBtn"
              type="button"
              class="rounded-lg border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:border-cyan-300/60"
            >
              Mute
            </button>
          </div>
        </div>
      <audio id="audioPlayer" class="hidden" preload="none"></audio>
      </aside>
    </section>

    <section id="fullscreenPlayer" class="fullscreen-player hidden">
      <div class="fullscreen-top">
        <button id="fullscreenCloseBtn" type="button" class="fullscreen-icon-btn" aria-label="Close player">⌄</button>
        <button id="fullscreenMenuBtn" type="button" class="fullscreen-icon-btn" aria-label="Player options">⋮</button>
      </div>

      <div class="fullscreen-art-wrap">
        <img id="fullArtwork" class="fullscreen-artwork" src="${DEFAULT_TRACK_THUMBNAIL}" alt="" />
      </div>

      <div class="fullscreen-meta">
        <p id="fullTitle" class="fullscreen-title">${DEFAULT_TRACK_TITLE}</p>
        <p id="fullArtist" class="fullscreen-artist">${DEFAULT_TRACK_ARTIST}</p>
      </div>

      <div class="fullscreen-progress">
        <input id="fullSeekBar" class="player-range w-full" type="range" min="0" max="1000" value="0" />
        <div class="fullscreen-time">
          <span id="fullTimeCurrent">0:00</span>
          <span id="fullTimeTotal">0:00</span>
        </div>
      </div>

      <div class="fullscreen-controls">
        <button id="fullShuffleBtn" type="button" class="fullscreen-control-btn" aria-label="Shuffle">⇄</button>
        <button id="fullPrevBtn" type="button" class="fullscreen-control-btn" aria-label="Previous track">|◀</button>
        <button id="fullPlayPauseBtn" type="button" class="fullscreen-play-btn" aria-label="Play or pause">▶</button>
        <button id="fullNextBtn" type="button" class="fullscreen-control-btn" aria-label="Next track">▶|</button>
        <button id="fullRepeatBtn" type="button" class="fullscreen-control-btn" aria-label="Repeat">↻</button>
        <button id="fullAutoplayBtn" type="button" class="fullscreen-control-btn" aria-label="Autoplay">A</button>
      </div>
      <div class="fullscreen-mobile-lyrics">
        <p id="mobileLyricsStatus" class="desktop-lyrics-status">Play a track to load lyrics.</p>
          <div id="mobileLyricsText" class="desktop-lyrics-text"></div>
      </div>

      <div class="desktop-expanded-shell">
        <div class="desktop-stage">
          <img id="desktopArtwork" class="desktop-artwork" src="${DEFAULT_TRACK_THUMBNAIL}" alt="" />
          <div class="desktop-stage-meta">
            <p id="desktopStageTitle" class="desktop-stage-title">${DEFAULT_TRACK_TITLE}</p>
            <p id="desktopStageArtist" class="desktop-stage-artist">${DEFAULT_TRACK_ARTIST}</p>
          </div>
        </div>
        <aside class="desktop-side">
          <div class="desktop-tabs">
            <button id="desktopTabUpNext" type="button" class="desktop-tab is-active">UP NEXT</button>
            <button id="desktopTabLyrics" type="button" class="desktop-tab">LYRICS</button>
            <button id="desktopTabRelated" type="button" class="desktop-tab">RELATED</button>
          </div>
          <div id="desktopQueueList" class="desktop-queue-list"></div>
          <div id="desktopLyricsPanel" class="desktop-lyrics-panel hidden">
            <p id="desktopLyricsStatus" class="desktop-lyrics-status">Play a track to load lyrics.</p>
            <div id="desktopLyricsText" class="desktop-lyrics-text"></div>
          </div>
          <div id="desktopRelatedPanel" class="desktop-related-panel hidden">
            <p class="desktop-queue-empty">Related view coming soon.</p>
          </div>
        </aside>
      </div>

      <div id="desktopDock" class="desktop-dock">
        <div id="desktopDockProgress" class="desktop-dock-progress">
          <span id="desktopDockProgressFill" class="desktop-dock-progress-fill"></span>
          <span id="desktopDockProgressThumb" class="desktop-dock-progress-thumb"></span>
        </div>
        <span id="desktopDockTime" class="desktop-dock-time">0:00 / 0:00</span>
        <div class="desktop-dock-controls">
          <button id="desktopPrevBtn" type="button" class="desktop-dock-btn" aria-label="Previous track">|◀</button>
          <button id="desktopPlayPauseBtn" type="button" class="desktop-dock-btn is-primary" aria-label="Play or pause">▶</button>
          <button id="desktopNextBtn" type="button" class="desktop-dock-btn" aria-label="Next track">▶|</button>
        </div>
        <div class="desktop-dock-track">
          <img id="desktopDockThumb" class="desktop-dock-thumb" src="${DEFAULT_TRACK_THUMBNAIL}" alt="" />
          <div class="desktop-dock-meta">
            <p id="desktopDockTitle" class="desktop-dock-title">${DEFAULT_TRACK_TITLE}</p>
            <p id="desktopDockArtist" class="desktop-dock-artist">${DEFAULT_TRACK_ARTIST}</p>
          </div>
        </div>
        <div class="desktop-dock-right">
          <button id="desktopShuffleBtn" type="button" class="desktop-dock-btn" aria-label="Shuffle">⇄</button>
          <button id="desktopRepeatBtn" type="button" class="desktop-dock-btn" aria-label="Repeat">↻</button>
          <button id="desktopAutoplayBtn" type="button" class="desktop-dock-btn" aria-label="Autoplay">A</button>
          <div class="dock-menu-wrap">
            <button id="desktopDockMenuBtn" type="button" class="desktop-dock-btn" aria-label="Queue menu">⋮</button>
            <div id="desktopDockMenu" class="dock-menu hidden">
              <button id="clearQueueBtn" type="button" class="dock-menu-item">Clear Queue</button>
            </div>
          </div>
          <input id="desktopVolumeControl" class="player-range desktop-volume" type="range" min="0" max="1" step="0.01" value="0.85" />
        </div>
      </div>
    </section>

    <section id="desktopMiniBar" class="desktop-mini-bar hidden">
      <div id="desktopMiniProgress" class="desktop-mini-progress">
        <span id="desktopMiniProgressFill" class="desktop-mini-progress-fill"></span>
        <span id="desktopMiniProgressThumb" class="desktop-mini-progress-thumb"></span>
      </div>
      <div class="desktop-mini-left">
        <button id="desktopMiniPrevBtn" type="button" class="desktop-mini-btn" aria-label="Previous track">|◀</button>
        <button id="desktopMiniPlayPauseBtn" type="button" class="desktop-mini-btn is-primary" aria-label="Play or pause">▶</button>
        <button id="desktopMiniNextBtn" type="button" class="desktop-mini-btn" aria-label="Next track">▶|</button>
        <span id="desktopMiniTime" class="desktop-mini-time">0:00 / 0:00</span>
      </div>
      <div class="desktop-mini-track">
        <img id="desktopMiniThumb" class="desktop-mini-thumb" src="${DEFAULT_TRACK_THUMBNAIL}" alt="" />
        <div class="desktop-mini-meta">
          <p id="desktopMiniTitle" class="desktop-mini-title">${DEFAULT_TRACK_TITLE}</p>
          <p id="desktopMiniArtist" class="desktop-mini-artist">${DEFAULT_TRACK_ARTIST}</p>
        </div>
      </div>
      <div class="desktop-mini-right">
        <input id="desktopMiniVolume" class="player-range desktop-mini-volume" type="range" min="0" max="1" step="0.01" value="0.85" />
        <button id="desktopMiniRepeatBtn" type="button" class="desktop-mini-btn" aria-label="Repeat">↻</button>
        <button id="desktopMiniShuffleBtn" type="button" class="desktop-mini-btn" aria-label="Shuffle">⇄</button>
        <button id="desktopMiniAutoplayBtn" type="button" class="desktop-mini-btn" aria-label="Autoplay">A</button>
        <button id="desktopMiniExpandBtn" type="button" class="desktop-mini-btn" aria-label="Expand player">▲</button>
      </div>
    </section>
  </main>
`;

const searchForm = document.querySelector("#searchForm");
const homeMenuWrap = document.querySelector("#homeMenuWrap");
const homeMenuBtn = document.querySelector("#homeMenuBtn");
const homeMenu = document.querySelector("#homeMenu");
const clearCacheBtn = document.querySelector("#clearCacheBtn");
const searchHomeBtn = document.querySelector("#searchHomeBtn");
const searchInput = document.querySelector("#searchInput");
const searchBtn = document.querySelector("#searchBtn");
const appHeader = document.querySelector("#appHeader");
const searchSection = document.querySelector("#searchSection");
const searchOverlayResults = document.querySelector("#searchOverlayResults");
const searchOverlaySuggestions = document.querySelector("#searchOverlaySuggestions");
const suggestionsList = document.querySelector("#suggestions");
const resultsContainer = document.querySelector("#results");
const nowPlaying = document.querySelector("#nowPlaying");
const audioPlayer = document.querySelector("#audioPlayer");
const togglePlayBtn = document.querySelector("#togglePlayBtn");
const seekBar = document.querySelector("#seekBar");
const playbackTime = document.querySelector("#playbackTime");
const volumeControl = document.querySelector("#volumeControl");
const muteBtn = document.querySelector("#muteBtn");
const miniPlayerBar = document.querySelector("#miniPlayerBar");
const mobilePlayer = document.querySelector(".mobile-player");
const miniThumb = document.querySelector("#miniThumb");
const miniTitle = document.querySelector("#miniTitle");
const miniArtist = document.querySelector("#miniArtist");
const miniPlayPauseBtn = document.querySelector("#miniPlayPauseBtn");
const miniNextBtn = document.querySelector("#miniNextBtn");
const togglePlayerSizeBtn = document.querySelector("#togglePlayerSizeBtn");
const playerShell = document.querySelector("#playerShell");
const fullscreenPlayer = document.querySelector("#fullscreenPlayer");
const fullscreenCloseBtn = document.querySelector("#fullscreenCloseBtn");
const fullscreenMenuBtn = document.querySelector("#fullscreenMenuBtn");
const fullArtwork = document.querySelector("#fullArtwork");
const fullTitle = document.querySelector("#fullTitle");
const fullArtist = document.querySelector("#fullArtist");
const fullSeekBar = document.querySelector("#fullSeekBar");
const fullTimeCurrent = document.querySelector("#fullTimeCurrent");
const fullTimeTotal = document.querySelector("#fullTimeTotal");
const fullShuffleBtn = document.querySelector("#fullShuffleBtn");
const fullPrevBtn = document.querySelector("#fullPrevBtn");
const fullPlayPauseBtn = document.querySelector("#fullPlayPauseBtn");
const fullNextBtn = document.querySelector("#fullNextBtn");
const fullRepeatBtn = document.querySelector("#fullRepeatBtn");
const fullAutoplayBtn = document.querySelector("#fullAutoplayBtn");
const mobileLyricsStatus = document.querySelector("#mobileLyricsStatus");
const mobileLyricsText = document.querySelector("#mobileLyricsText");
const desktopTabUpNext = document.querySelector("#desktopTabUpNext");
const desktopTabLyrics = document.querySelector("#desktopTabLyrics");
const desktopTabRelated = document.querySelector("#desktopTabRelated");
const desktopLyricsPanel = document.querySelector("#desktopLyricsPanel");
const desktopLyricsStatus = document.querySelector("#desktopLyricsStatus");
const desktopLyricsText = document.querySelector("#desktopLyricsText");
const desktopRelatedPanel = document.querySelector("#desktopRelatedPanel");
const desktopArtwork = document.querySelector("#desktopArtwork");
const desktopStageTitle = document.querySelector("#desktopStageTitle");
const desktopStageArtist = document.querySelector("#desktopStageArtist");
const desktopQueueList = document.querySelector("#desktopQueueList");
const desktopPrevBtn = document.querySelector("#desktopPrevBtn");
const desktopPlayPauseBtn = document.querySelector("#desktopPlayPauseBtn");
const desktopNextBtn = document.querySelector("#desktopNextBtn");
const desktopDock = document.querySelector("#desktopDock");
const desktopDockTime = document.querySelector("#desktopDockTime");
const desktopDockProgress = document.querySelector("#desktopDockProgress");
const desktopDockProgressFill = document.querySelector("#desktopDockProgressFill");
const desktopDockProgressThumb = document.querySelector("#desktopDockProgressThumb");
const desktopDockThumb = document.querySelector("#desktopDockThumb");
const desktopDockTitle = document.querySelector("#desktopDockTitle");
const desktopDockArtist = document.querySelector("#desktopDockArtist");
const desktopShuffleBtn = document.querySelector("#desktopShuffleBtn");
const desktopRepeatBtn = document.querySelector("#desktopRepeatBtn");
const desktopAutoplayBtn = document.querySelector("#desktopAutoplayBtn");
const desktopDockMenuBtn = document.querySelector("#desktopDockMenuBtn");
const desktopDockMenu = document.querySelector("#desktopDockMenu");
const clearQueueBtn = document.querySelector("#clearQueueBtn");
const desktopVolumeControl = document.querySelector("#desktopVolumeControl");
const desktopMiniBar = document.querySelector("#desktopMiniBar");
const desktopMiniPrevBtn = document.querySelector("#desktopMiniPrevBtn");
const desktopMiniPlayPauseBtn = document.querySelector("#desktopMiniPlayPauseBtn");
const desktopMiniNextBtn = document.querySelector("#desktopMiniNextBtn");
const desktopMiniTime = document.querySelector("#desktopMiniTime");
const desktopMiniProgress = document.querySelector("#desktopMiniProgress");
const desktopMiniProgressFill = document.querySelector("#desktopMiniProgressFill");
const desktopMiniProgressThumb = document.querySelector("#desktopMiniProgressThumb");
const desktopMiniThumb = document.querySelector("#desktopMiniThumb");
const desktopMiniTitle = document.querySelector("#desktopMiniTitle");
const desktopMiniArtist = document.querySelector("#desktopMiniArtist");
const desktopMiniVolume = document.querySelector("#desktopMiniVolume");
const desktopMiniRepeatBtn = document.querySelector("#desktopMiniRepeatBtn");
const desktopMiniShuffleBtn = document.querySelector("#desktopMiniShuffleBtn");
const desktopMiniAutoplayBtn = document.querySelector("#desktopMiniAutoplayBtn");
const desktopMiniExpandBtn = document.querySelector("#desktopMiniExpandBtn");

fullArtwork.addEventListener("error", handleExpandedArtworkError);
desktopArtwork.addEventListener("error", handleExpandedArtworkError);

const isSearchReady = Boolean(SEARCH_API_URL);
let suppressSuggestions = false;
let playbackRequestId = 0;
let searchRequestId = 0;
let suggestRequestId = 0;
let autoSearchTimer;
let lastSearchedQuery = "";
let hasSearched = false;
let searchOverlayHideTimer = null;
let currentVideoId = "";
let currentTrack = {
  title: DEFAULT_TRACK_TITLE,
  author: DEFAULT_TRACK_ARTIST,
  thumbnail: DEFAULT_TRACK_THUMBNAIL,
};
let isPlayerExpanded = false;
let isShuffleEnabled = false;
let isAutoplayEnabled = loadAutoplaySetting();
let loopMode = loadLoopMode();
let isPlayerTransitioning = false;
let activeDesktopTab = "upnext";
let lyricsRequestId = 0;
let lyricsActiveLineIndex = -1;
let isQueueDragInProgress = false;
let isCurrentTrackFullyCached = false;
let currentTrackLoadedFromPrefetch = false;
let prefetchInFlightId = "";
let prefetchAbortController = null;
let autoplayPrefetchInFlight = false;
let artworkRequestId = 0;
const searchHistory = loadSearchHistory();
const suggestionPool = new Map();
let lastVideos = [];
const playbackQueue = loadPlaybackQueue();
const recentSongs = loadRecentSongs();
const lyricsCache = loadLyricsCache();
const prefetchedTracks = new Map();
const lyricsState = {
  lines: [],
  plainText: "",
  synced: false,
  source: "",
  status: "Play a track to load lyrics.",
};

searchHistory.forEach((item) => indexSuggestion(item));

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
  const query = searchInput.value.trim();
  if (!query) {
    clearTimeout(autoSearchTimer);
    renderSuggestions(getDefaultSuggestions());
    updateSuggestionsOverlayVisibility();
    updateSearchResultsOverlayVisibility();
    return;
  }
  renderSuggestions(buildClientSuggestions(query));
  clearTimeout(autoSearchTimer);
  autoSearchTimer = setTimeout(async () => {
    const currentQuery = searchInput.value.trim();
    if (currentQuery.length < 2) return;
    const remoteSuggestions = await fetchRemoteSuggestions(currentQuery);
    if (!remoteSuggestions) return;
    if (suggestionKey(currentQuery) !== suggestionKey(searchInput.value.trim())) return;
    const merged = mergeSuggestions(remoteSuggestions, buildClientSuggestions(currentQuery));
    renderSuggestions(merged);
  }, AUTO_SEARCH_DELAY_MS);
  updateSuggestionsOverlayVisibility();
  updateSearchResultsOverlayVisibility();
});

searchInput.addEventListener("focus", () => {
  if (!searchInput.value.trim()) {
    renderSuggestions(getDefaultSuggestions());
  }
  updateSuggestionsOverlayVisibility();
  updateSearchResultsOverlayVisibility();
});

searchInput.addEventListener("blur", () => {
  clearTimeout(searchOverlayHideTimer);
  searchOverlayHideTimer = setTimeout(() => {
    updateSuggestionsOverlayVisibility();
    updateSearchResultsOverlayVisibility();
  }, 140);
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  suppressSuggestions = true;
  clearTimeout(autoSearchTimer);
  const query = searchInput.value.trim();
  if (!query) return;
  suggestionsList.innerHTML = "";
  searchOverlaySuggestions.innerHTML = "";
  searchOverlaySuggestions.classList.add("hidden");
  updateSuggestionsOverlayVisibility();
  await runSearch(query);
  if (isPlayerExpanded) {
    searchInput.focus({ preventScroll: true });
    updateSearchResultsOverlayVisibility();
  }
});

function renderSuggestions(items) {
  const markup = items
    .map(
      (text) => `
      <li>
        <button
          type="button"
          class="w-full rounded-xl border border-white/10 bg-slate-900/70 px-3 py-3 text-left text-sm hover:border-cyan-300/60 hover:bg-slate-800"
          data-suggestion="${escapeHtml(text)}"
        >${escapeHtml(text)}</button>
      </li>
    `
    )
    .join("");

  if (isPlayerExpanded) {
    suggestionsList.innerHTML = "";
    if (!items.length) {
      searchOverlaySuggestions.innerHTML = "";
      searchOverlaySuggestions.classList.add("hidden");
      return;
    }
    searchOverlaySuggestions.innerHTML = `<ul class="grid gap-2">${markup}</ul>`;
    bindSuggestionButtons(searchOverlaySuggestions);
    updateInlineSuggestionsVisibility();
    updateSuggestionsOverlayVisibility();
    return;
  }

  searchOverlaySuggestions.innerHTML = "";
  searchOverlaySuggestions.classList.add("hidden");
  if (!items.length) {
    suggestionsList.innerHTML = "";
    return;
  }
  suggestionsList.innerHTML = markup;
  bindSuggestionButtons(suggestionsList);
  updateInlineSuggestionsVisibility();
}

function bindSuggestionButtons(container) {
  container.querySelectorAll("button[data-suggestion]").forEach((button) => {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      suppressSuggestions = true;
      const text = button.getAttribute("data-suggestion") || "";
      searchInput.value = text;
      clearTimeout(autoSearchTimer);
      renderSuggestions(buildClientSuggestions(text));
      searchInput.focus();
    });
  });
}

async function fetchRemoteSuggestions(query) {
  if (!SEARCH_API_URL) return [];
  const requestId = ++suggestRequestId;
  try {
    const { payload } = await fetchJsonWithRetry(SEARCH_API_URL, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ mode: "suggest", query }),
    });
    if (requestId !== suggestRequestId) return null;
    const raw = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
    return raw
      .map((item) => normalizeSuggestionValue(item))
      .filter((item) => item.length >= 2)
      .slice(0, LOCAL_SUGGESTION_LIMIT);
  } catch {
    return [];
  }
}

function mergeSuggestions(primary, secondary) {
  const merged = [];
  const seen = new Set();
  [...primary, ...secondary].forEach((text) => {
    const normalized = normalizeSuggestionValue(text);
    const key = suggestionKey(normalized);
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    merged.push(normalized);
  });
  return merged.slice(0, LOCAL_SUGGESTION_LIMIT);
}

async function runSearch(query) {
  if (!SEARCH_API_URL) {
    showError("Missing search API URL in env.");
    return;
  }
  setSearchUrl(query);
  const requestId = ++searchRequestId;
  setLoading(true);
  try {
    const { payload } = await fetchJsonWithRetry(SEARCH_API_URL, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ mode: "search", query }),
    });
    if (requestId !== searchRequestId) return;
    const videos = normalizeVideos(payload?.videos).slice(0, 12);
    lastSearchedQuery = query;
    lastVideos = videos;
    rememberSearchContext(query, videos);
    renderResults(videos);
    renderDesktopQueue();
  } catch (error) {
    if (requestId !== searchRequestId) return;
    showError(`Search failed: ${error.message}`);
  } finally {
    if (requestId === searchRequestId) {
      setLoading(false);
    }
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
  hasSearched = true;
  syncMainResultsVisibility();
  if (!videos.length) {
    const emptyMarkup = `<p class="text-sm text-rose-300">No results found.</p>`;
    resultsContainer.innerHTML = emptyMarkup;
    searchOverlayResults.innerHTML = emptyMarkup;
    updateSearchResultsOverlayVisibility();
    return;
  }

  const markup = `
    <div class="mb-4 flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-cyan-200">Results</h2>
      <p class="text-xs text-slate-400">${videos.length} tracks</p>
    </div>
    <div class="grid gap-3">
      ${videos
        .map(
          (video) => `
            <article class="track-card rounded-2xl border border-white/10 bg-slate-900/60 p-3">
              <div class="flex items-start gap-3">
                <img src="${escapeHtml(video.thumbnail)}" alt="" class="h-14 w-14 shrink-0 rounded-lg object-cover" />
                <div class="min-w-0 flex-1">
                  <p class="result-title text-sm font-medium">${escapeHtml(video.title)}</p>
                  <p class="truncate text-xs text-slate-400">${escapeHtml(video.author)} • ${escapeHtml(video.duration)}</p>
                  <div class="mt-3 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
                    <button
                      type="button"
                      class="w-full rounded-xl bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-cyan-300 sm:w-auto"
                      data-video-id="${escapeHtml(video.id)}"
                      data-video-title="${escapeHtml(video.title)}"
                      data-video-author="${escapeHtml(video.author)}"
                      data-video-thumbnail="${escapeHtml(video.thumbnail)}"
                      data-video-duration="${escapeHtml(video.duration)}"
                    >
                      Play
                    </button>
                    <button
                      type="button"
                      class="w-full rounded-xl border border-white/20 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-cyan-300/60 sm:w-auto"
                      data-queue-video-id="${escapeHtml(video.id)}"
                      data-queue-video-title="${escapeHtml(video.title)}"
                      data-queue-video-author="${escapeHtml(video.author)}"
                      data-queue-video-thumbnail="${escapeHtml(video.thumbnail)}"
                      data-queue-video-duration="${escapeHtml(video.duration)}"
                    >
                      + Queue
                    </button>
                    <button
                      type="button"
                      class="col-span-2 w-full rounded-xl border border-cyan-300/35 px-3 py-2 text-xs font-semibold text-cyan-100 hover:border-cyan-300/70 sm:col-span-1 sm:w-auto"
                      data-next-video-id="${escapeHtml(video.id)}"
                      data-next-video-title="${escapeHtml(video.title)}"
                      data-next-video-author="${escapeHtml(video.author)}"
                      data-next-video-thumbnail="${escapeHtml(video.thumbnail)}"
                      data-next-video-duration="${escapeHtml(video.duration)}"
                    >
                      Play Next
                    </button>
                  </div>
                </div>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
  resultsContainer.innerHTML = markup;
  searchOverlayResults.innerHTML = markup;

  animate(".track-card", {
    opacity: [0, 1],
    translateY: [8, 0],
    delay: stagger(35),
    duration: 400,
    easing: "easeOutQuad",
  });

  bindResultActionButtons(resultsContainer);
  bindResultActionButtons(searchOverlayResults);
  updateSearchResultsOverlayVisibility();
}

function bindResultActionButtons(container) {
  container.querySelectorAll("button[data-video-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const track = readTrackFromDataset(button.dataset, "video");
      enqueueTrack(track);
      await streamVideo(track.id, track.title, track.author, track.thumbnail);
    });
  });

  container.querySelectorAll("button[data-queue-video-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const track = readTrackFromDataset(button.dataset, "queueVideo");
      enqueueTrack(track);
    });
  });

  container.querySelectorAll("button[data-next-video-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const track = readTrackFromDataset(button.dataset, "nextVideo");
      enqueueTrackNext(track);
    });
  });
}

async function streamVideo(videoId, title, author = "Unknown Artist", thumbnail = "") {
  const requestId = ++playbackRequestId;
  if (!videoId) {
    showError("Invalid track selection.");
    return;
  }
  if (!AUDIO_API_URL) {
    showError("Missing audio API URL. Configure VITE_API_BASE_URL in .env.");
    return;
  }
  if (REQUIRE_AUTH && !API_TOKEN) {
    showError("Missing API token. Set VITE_API_TOKEN for secure backend access.");
    return;
  }
  currentVideoId = videoId;
  setWatchUrl(videoId);
  currentTrack = { title, author, thumbnail: thumbnail || currentTrack.thumbnail };
  updateTrackMetaUi();
  addRecentSong({
    id: videoId,
    title,
    author,
    thumbnail: thumbnail || currentTrack.thumbnail,
    duration: playbackQueue.find((item) => item.id === videoId)?.duration || "--:--",
  });
  resetLyricsStateForTrack();
  isCurrentTrackFullyCached = false;
  currentTrackLoadedFromPrefetch = false;
  cancelNextPrefetch();
  prunePrefetchedTracks();
  setLoading(true);
  nowPlaying.textContent = `Loading: ${title}`;
  try {
    const cached = prefetchedTracks.get(videoId);
    let audioSrc = "";
    if (cached?.objectUrl) {
      audioSrc = cached.objectUrl;
      currentTrackLoadedFromPrefetch = true;
    } else {
      const { payload } = await fetchJsonWithRetry(AUDIO_API_URL, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ videoId }),
      });
      if (!payload?.audioUrl) {
        throw new Error("Backend did not return audioUrl.");
      }
      audioSrc = payload.audioUrl;
    }
    if (requestId !== playbackRequestId) {
      return;
    }
    audioPlayer.pause();
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
    audioPlayer.src = audioSrc;
    audioPlayer.currentTime = 0;
    audioPlayer.load();
    await audioPlayer.play();
    if (requestId !== playbackRequestId) {
      return;
    }
    nowPlaying.textContent = `Now Playing: ${title}`;
    updateTrackMetaUi();
    if (currentTrackLoadedFromPrefetch) {
      isCurrentTrackFullyCached = true;
      maybePrefetchNextTrack();
    }
  } catch (error) {
    const message = error?.message || "";
    const interrupted =
      error?.name === "AbortError" ||
      /interrupted by a new load request/i.test(message) ||
      /The play\(\) request was interrupted/i.test(message);
    const autoplayBlocked =
      error?.name === "NotAllowedError" ||
      /play\(\) failed because the user didn't interact/i.test(message) ||
      /user gesture/i.test(message);
    if (interrupted) {
      return;
    }
    if (autoplayBlocked) {
      nowPlaying.textContent = `Ready: ${title} (tap Play)`;
      updateTrackMetaUi();
      return;
    }
    showError(`Playback failed: ${error.message}`);
    nowPlaying.textContent = "Nothing playing.";
  } finally {
    if (requestId === playbackRequestId) {
      setLoading(false);
    }
  }
}

function setLoading(isLoading) {
  searchBtn.disabled = isLoading || !isSearchReady;
  searchBtn.textContent = isLoading ? "Loading..." : "Search";
}

function showError(message) {
  hasSearched = true;
  syncMainResultsVisibility();
  resultsContainer.innerHTML = `<p class="text-sm text-rose-300">${escapeHtml(message)}</p>`;
  searchOverlayResults.innerHTML = resultsContainer.innerHTML;
  updateSearchResultsOverlayVisibility();
}

function syncMainResultsVisibility() {
  resultsContainer.classList.toggle("hidden", !hasSearched || isPlayerExpanded);
  syncTopChromeVisibility();
  updateSuggestionsOverlayVisibility();
}

function syncTopChromeVisibility() {
  const isHomeView = !hasSearched && !isPlayerExpanded;
  appHeader.classList.toggle("hidden", !isHomeView);
  searchHomeBtn.classList.toggle("hidden", isHomeView);
  homeMenuBtn.classList.toggle("hidden", !isHomeView);
  if (!isHomeView) {
    homeMenu.classList.add("hidden");
  }
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

function normalizeSuggestionValue(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestionKey(value) {
  return normalizeSuggestionValue(value).toLowerCase();
}

function indexSuggestion(value) {
  const normalized = normalizeSuggestionValue(value);
  if (normalized.length < 2) return;
  const key = suggestionKey(normalized);
  if (!key) return;
  if (!suggestionPool.has(key)) {
    suggestionPool.set(key, normalized);
  }
}

function loadSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeSuggestionValue(item))
      .filter((item) => item.length >= 2)
      .slice(0, RECENT_CACHE_LIMIT);
  } catch {
    return [];
  }
}

function saveSearchHistory() {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(searchHistory.slice(0, RECENT_CACHE_LIMIT)));
  } catch {
    // Ignore quota/storage errors.
  }
}

function rememberSearchContext(query, videos) {
  const normalizedQuery = normalizeSuggestionValue(query);
  if (normalizedQuery.length >= 2) {
    const deduped = searchHistory.filter((item) => suggestionKey(item) !== suggestionKey(normalizedQuery));
    searchHistory.length = 0;
    searchHistory.push(normalizedQuery, ...deduped.slice(0, RECENT_CACHE_LIMIT - 1));
    saveSearchHistory();
    indexSuggestion(normalizedQuery);
  }

  videos.forEach((video) => {
    indexSuggestion(video.title);
    indexSuggestion(video.author);
  });
}

function buildClientSuggestions(query) {
  const normalizedQuery = suggestionKey(query);
  if (normalizedQuery.length < 2) return [];

  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  lastVideos.forEach((video) => {
    indexSuggestion(video.title);
    indexSuggestion(video.author);
  });

  const scored = [];
  suggestionPool.forEach((text, key) => {
    let score = 0;
    if (key === normalizedQuery) {
      score = 300;
    } else if (key.startsWith(normalizedQuery)) {
      score = 220 - (key.length - normalizedQuery.length);
    } else if (key.includes(` ${normalizedQuery}`)) {
      score = 170 - (key.length - normalizedQuery.length);
    } else if (key.includes(normalizedQuery)) {
      score = 120 - (key.length - normalizedQuery.length);
    }
    if (!score && queryWords.length > 1) {
      const wordHits = queryWords.reduce((acc, word) => (key.includes(word) ? acc + 1 : acc), 0);
      if (wordHits) {
        score = 80 + wordHits * 25 - Math.max(0, key.length - normalizedQuery.length);
      }
    }
    if (score > 0) {
      scored.push({ text, score });
    }
  });

  const ranked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, LOCAL_SUGGESTION_LIMIT)
    .map((item) => item.text);
  if (ranked.length) return ranked;

  return getDefaultSuggestions()
    .filter((item) => suggestionKey(item).includes(normalizedQuery))
    .slice(0, LOCAL_SUGGESTION_LIMIT);
}

function getDefaultSuggestions() {
  return searchHistory.slice(0, LOCAL_SUGGESTION_LIMIT);
}

function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${seconds}`;
}

function getSavedVolume() {
  try {
    const parsed = Number(localStorage.getItem(PLAYER_VOLUME_KEY));
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(1, Math.max(0, parsed));
  } catch {
    return 1;
  }
}

function saveVolume(volume) {
  try {
    localStorage.setItem(PLAYER_VOLUME_KEY, String(volume));
  } catch {
    // Ignore storage errors.
  }
}

function isPhoneUi() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function enforcePhoneVolume() {
  if (!isPhoneUi()) return;
  const needsReset = audioPlayer.muted || audioPlayer.volume < 0.999;
  if (!needsReset) return;
  audioPlayer.muted = false;
  audioPlayer.volume = 1;
  volumeControl.value = "1";
  desktopVolumeControl.value = "1";
  desktopMiniVolume.value = "1";
  saveVolume(1);
}

function updatePlayerUi() {
  enforcePhoneVolume();
  const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0;
  const current = Number.isFinite(audioPlayer.currentTime) ? audioPlayer.currentTime : 0;
  const progress = duration > 0 ? Math.round((current / duration) * 1000) : 0;
  const progressPercent = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
  seekBar.value = String(progress);
  fullSeekBar.value = String(progress);
  playbackTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  fullTimeCurrent.textContent = formatTime(current);
  fullTimeTotal.textContent = formatTime(duration);
  desktopDockTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  desktopMiniTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  togglePlayBtn.textContent = audioPlayer.paused ? "Play" : "Pause";
  muteBtn.textContent = audioPlayer.muted || audioPlayer.volume === 0 ? "Unmute" : "Mute";
  miniPlayPauseBtn.textContent = audioPlayer.paused ? "▶" : "❚❚";
  fullPlayPauseBtn.textContent = audioPlayer.paused ? "▶" : "❚❚";
  desktopPlayPauseBtn.textContent = audioPlayer.paused ? "▶" : "❚❚";
  desktopMiniPlayPauseBtn.textContent = audioPlayer.paused ? "▶" : "❚❚";
  miniNextBtn.disabled = !getNextTrack();
  fullNextBtn.disabled = !getNextTrack();
  desktopNextBtn.disabled = !getNextTrack();
  fullPrevBtn.disabled = !getPreviousTrack();
  desktopPrevBtn.disabled = !getPreviousTrack();
  desktopMiniNextBtn.disabled = !getNextTrack();
  desktopMiniPrevBtn.disabled = !getPreviousTrack();
  fullShuffleBtn.classList.toggle("is-active", isShuffleEnabled);
  fullAutoplayBtn.classList.toggle("is-active", isAutoplayEnabled);
  desktopShuffleBtn.classList.toggle("is-active", isShuffleEnabled);
  desktopAutoplayBtn.classList.toggle("is-active", isAutoplayEnabled);
  desktopMiniShuffleBtn.classList.toggle("is-active", isShuffleEnabled);
  desktopMiniAutoplayBtn.classList.toggle("is-active", isAutoplayEnabled);
  updateRepeatButtonsUi();
  desktopVolumeControl.value = String(audioPlayer.volume);
  desktopMiniVolume.value = String(audioPlayer.volume);
  desktopDockProgressFill.style.width = `${progressPercent}%`;
  desktopMiniProgressFill.style.width = `${progressPercent}%`;
  desktopDockProgressThumb.style.left = `${progressPercent}%`;
  desktopMiniProgressThumb.style.left = `${progressPercent}%`;
  updateSyncedLyrics(current);
}

function updateRepeatButtonsUi() {
  const isActive = loopMode !== "off";
  const isSongMode = loopMode === "song";
  const symbol = isSongMode ? "↻1" : "↻";
  const label = loopMode === "off" ? "Loop off" : loopMode === "queue" ? "Loop queue" : "Loop song";
  [fullRepeatBtn, desktopRepeatBtn, desktopMiniRepeatBtn].forEach((button) => {
    button.classList.toggle("is-active", isActive);
    button.textContent = symbol;
    button.title = label;
    button.setAttribute("aria-label", label);
  });
}

const initialVolume = getSavedVolume();
audioPlayer.volume = initialVolume;
volumeControl.value = String(initialVolume);
desktopVolumeControl.value = String(initialVolume);
desktopMiniVolume.value = String(initialVolume);
updatePlayerUi();
window.addEventListener("resize", updatePlayerUi);

togglePlayBtn.addEventListener("click", togglePlayback);

miniPlayPauseBtn.addEventListener("click", async (event) => {
  event.stopPropagation();
  await togglePlayback();
});

fullPlayPauseBtn.addEventListener("click", togglePlayback);
desktopPlayPauseBtn.addEventListener("click", togglePlayback);
desktopMiniPlayPauseBtn.addEventListener("click", togglePlayback);

miniPlayerBar.addEventListener("click", (event) => {
  if (isInteractiveDockTarget(event.target)) return;
  openFullscreenPlayer();
});

desktopMiniBar.addEventListener("click", (event) => {
  if (isInteractiveDockTarget(event.target)) return;
  openFullscreenPlayer();
});

desktopDock.addEventListener("click", (event) => {
  if (isInteractiveDockTarget(event.target)) return;
  closeFullscreenPlayer();
});

async function togglePlayback() {
  if (!audioPlayer.src) return;
  if (audioPlayer.paused) {
    try {
      await audioPlayer.play();
    } catch {
      // Browser blocked autoplay or play failed.
    }
  } else {
    audioPlayer.pause();
  }
  updatePlayerUi();
}

function isInteractiveDockTarget(target) {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, input, a, .desktop-dock-progress, .desktop-mini-progress"))
  );
}

function seekToRatio(ratio) {
  if (!Number.isFinite(audioPlayer.duration) || audioPlayer.duration <= 0) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  audioPlayer.currentTime = audioPlayer.duration * clamped;
  updatePlayerUi();
}

function handleProgressPointer(event, container) {
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = (event.clientX - rect.left) / rect.width;
  seekToRatio(ratio);
}

desktopDockProgress.addEventListener("click", (event) => {
  handleProgressPointer(event, desktopDockProgress);
});

desktopMiniProgress.addEventListener("click", (event) => {
  handleProgressPointer(event, desktopMiniProgress);
});

function bindProgressDrag(container) {
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handleProgressPointer(event, container);
    const pointerId = event.pointerId;
    container.setPointerCapture(pointerId);

    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      handleProgressPointer(moveEvent, container);
    };

    const onPointerEnd = (endEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerEnd);
      container.removeEventListener("pointercancel", onPointerEnd);
      if (container.hasPointerCapture(pointerId)) {
        container.releasePointerCapture(pointerId);
      }
    };

    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerEnd);
    container.addEventListener("pointercancel", onPointerEnd);
  };

  container.addEventListener("pointerdown", onPointerDown);
}

bindProgressDrag(desktopDockProgress);
bindProgressDrag(desktopMiniProgress);

seekBar.addEventListener("input", () => {
  if (!Number.isFinite(audioPlayer.duration) || audioPlayer.duration <= 0) return;
  const ratio = Number(seekBar.value) / 1000;
  audioPlayer.currentTime = audioPlayer.duration * ratio;
  updatePlayerUi();
});

fullSeekBar.addEventListener("input", () => {
  if (!Number.isFinite(audioPlayer.duration) || audioPlayer.duration <= 0) return;
  const ratio = Number(fullSeekBar.value) / 1000;
  audioPlayer.currentTime = audioPlayer.duration * ratio;
  updatePlayerUi();
});

volumeControl.addEventListener("input", () => {
  const volume = Math.min(1, Math.max(0, Number(volumeControl.value)));
  audioPlayer.volume = volume;
  audioPlayer.muted = volume === 0;
  desktopVolumeControl.value = String(volume);
  saveVolume(volume);
  updatePlayerUi();
});

desktopVolumeControl.addEventListener("input", () => {
  const volume = Math.min(1, Math.max(0, Number(desktopVolumeControl.value)));
  audioPlayer.volume = volume;
  audioPlayer.muted = volume === 0;
  volumeControl.value = String(volume);
  desktopMiniVolume.value = String(volume);
  saveVolume(volume);
  updatePlayerUi();
});

desktopMiniVolume.addEventListener("input", () => {
  const volume = Math.min(1, Math.max(0, Number(desktopMiniVolume.value)));
  audioPlayer.volume = volume;
  audioPlayer.muted = volume === 0;
  volumeControl.value = String(volume);
  desktopVolumeControl.value = String(volume);
  saveVolume(volume);
  updatePlayerUi();
});

muteBtn.addEventListener("click", () => {
  audioPlayer.muted = !audioPlayer.muted;
  updatePlayerUi();
});

miniNextBtn.addEventListener("click", async () => {
  await playNextTrack();
});

togglePlayerSizeBtn.addEventListener("click", () => {
  if (isPlayerExpanded) {
    closeFullscreenPlayer();
  } else {
    openFullscreenPlayer();
  }
});

fullscreenCloseBtn.addEventListener("click", closeFullscreenPlayer);
searchHomeBtn.addEventListener("click", () => {
  navigateHome();
  closeFullscreenPlayer();
});
homeMenuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  homeMenu.classList.toggle("hidden");
});
clearCacheBtn.addEventListener("click", async () => {
  await clearClientCaches();
  homeMenu.classList.add("hidden");
  window.location.reload();
});
fullscreenMenuBtn.addEventListener("click", () => {
  // Reserved for future actions menu.
});

fullNextBtn.addEventListener("click", playNextTrack);
desktopNextBtn.addEventListener("click", playNextTrack);
desktopPrevBtn.addEventListener("click", playPreviousTrack);
desktopMiniNextBtn.addEventListener("click", playNextTrack);
desktopMiniPrevBtn.addEventListener("click", playPreviousTrack);
fullPrevBtn.addEventListener("click", playPreviousTrack);
fullShuffleBtn.addEventListener("click", () => {
  isShuffleEnabled = !isShuffleEnabled;
  updatePlayerUi();
});
fullRepeatBtn.addEventListener("click", () => {
  cycleLoopMode();
});
fullAutoplayBtn.addEventListener("click", () => {
  isAutoplayEnabled = !isAutoplayEnabled;
  saveAutoplaySetting(isAutoplayEnabled);
  updatePlayerUi();
});
desktopShuffleBtn.addEventListener("click", () => {
  isShuffleEnabled = !isShuffleEnabled;
  updatePlayerUi();
});
desktopRepeatBtn.addEventListener("click", () => {
  cycleLoopMode();
});
desktopAutoplayBtn.addEventListener("click", () => {
  isAutoplayEnabled = !isAutoplayEnabled;
  saveAutoplaySetting(isAutoplayEnabled);
  updatePlayerUi();
});
desktopMiniShuffleBtn.addEventListener("click", () => {
  isShuffleEnabled = !isShuffleEnabled;
  updatePlayerUi();
});
desktopMiniRepeatBtn.addEventListener("click", () => {
  cycleLoopMode();
});
desktopMiniAutoplayBtn.addEventListener("click", () => {
  isAutoplayEnabled = !isAutoplayEnabled;
  saveAutoplaySetting(isAutoplayEnabled);
  updatePlayerUi();
});
desktopMiniExpandBtn.addEventListener("click", openFullscreenPlayer);
desktopDockMenuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  desktopDockMenu.classList.toggle("hidden");
});
clearQueueBtn.addEventListener("click", () => {
  clearPlaybackQueue();
  desktopDockMenu.classList.add("hidden");
});

desktopTabUpNext.addEventListener("click", () => setDesktopTab("upnext"));
desktopTabLyrics.addEventListener("click", () => setDesktopTab("lyrics"));
desktopTabRelated.addEventListener("click", () => setDesktopTab("related"));

audioPlayer.addEventListener("play", updatePlayerUi);
audioPlayer.addEventListener("pause", updatePlayerUi);
audioPlayer.addEventListener("timeupdate", updatePlayerUi);
audioPlayer.addEventListener("durationchange", updatePlayerUi);
audioPlayer.addEventListener("progress", maybeMarkCurrentTrackCachedAndPrefetch);
audioPlayer.addEventListener("canplaythrough", maybeMarkCurrentTrackCachedAndPrefetch);
audioPlayer.addEventListener("loadeddata", maybeMarkCurrentTrackCachedAndPrefetch);
audioPlayer.addEventListener("ended", updatePlayerUi);
audioPlayer.addEventListener("ended", async () => {
  if (loopMode === "song" && currentVideoId) {
    await streamVideo(currentVideoId, currentTrack.title, currentTrack.author, currentTrack.thumbnail);
    return;
  }
  const next = getNextTrack();
  if (next) {
    await streamVideo(next.id, next.title, next.author, next.thumbnail);
    return;
  }
  if (!isAutoplayEnabled) return;
  const generated = await appendAutoplayTrackAtQueueEnd();
  if (!generated) return;
  await streamVideo(generated.id, generated.title, generated.author, generated.thumbnail);
});

function updateTrackMetaUi() {
  miniTitle.textContent = currentTrack.title || DEFAULT_TRACK_TITLE;
  miniArtist.textContent = currentTrack.author || DEFAULT_TRACK_ARTIST;
  miniThumb.src = currentTrack.thumbnail || DEFAULT_TRACK_THUMBNAIL;
  fullTitle.textContent = currentTrack.title || DEFAULT_TRACK_TITLE;
  fullArtist.textContent = currentTrack.author || DEFAULT_TRACK_ARTIST;
  setExpandedArtwork(currentVideoId, currentTrack.thumbnail || DEFAULT_TRACK_THUMBNAIL);
  desktopStageTitle.textContent = currentTrack.title || DEFAULT_TRACK_TITLE;
  desktopStageArtist.textContent = currentTrack.author || DEFAULT_TRACK_ARTIST;
  desktopDockThumb.src = currentTrack.thumbnail || DEFAULT_TRACK_THUMBNAIL;
  desktopDockTitle.textContent = currentTrack.title || DEFAULT_TRACK_TITLE;
  desktopDockArtist.textContent = currentTrack.author || DEFAULT_TRACK_ARTIST;
  desktopMiniThumb.src = currentTrack.thumbnail || DEFAULT_TRACK_THUMBNAIL;
  desktopMiniTitle.textContent = currentTrack.title || DEFAULT_TRACK_TITLE;
  desktopMiniArtist.textContent = currentTrack.author || DEFAULT_TRACK_ARTIST;
  renderDesktopQueue();
}

function getExpandedArtworkCandidates(videoId, fallbackUrl) {
  const fallback = fallbackUrl || DEFAULT_TRACK_THUMBNAIL;
  if (!videoId) return [fallback];
  const id = encodeURIComponent(videoId);
  const candidates = [
    `https://i.ytimg.com/vi_webp/${id}/maxresdefault.webp`,
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi_webp/${id}/sddefault.webp`,
    `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
    `https://i.ytimg.com/vi_webp/${id}/hqdefault.webp`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    fallback,
  ];
  return [...new Set(candidates.filter(Boolean))];
}

function probeImage(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const done = (ok, width = 0, height = 0) => {
      if (settled) return;
      settled = true;
      resolve({ ok, width, height, url });
    };
    const timer = window.setTimeout(() => done(false), timeoutMs);
    image.onload = () => {
      window.clearTimeout(timer);
      done(true, image.naturalWidth || 0, image.naturalHeight || 0);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      done(false);
    };
    image.src = url;
  });
}

async function resolveBestExpandedArtwork(candidates, fallback) {
  for (const url of candidates) {
    const probed = await probeImage(url);
    if (!probed.ok) continue;
    const tinyPlaceholder = probed.width <= 200 || probed.height <= 120;
    if (tinyPlaceholder && url !== fallback) continue;
    return url;
  }
  return fallback;
}

async function setExpandedArtwork(videoId, fallbackUrl) {
  const requestId = ++artworkRequestId;
  const fallback = fallbackUrl || DEFAULT_TRACK_THUMBNAIL;
  const candidates = getExpandedArtworkCandidates(videoId, fallback);
  const best = await resolveBestExpandedArtwork(candidates, fallback);
  if (requestId !== artworkRequestId) return;
  fullArtwork.dataset.fallbackSrc = fallback;
  desktopArtwork.dataset.fallbackSrc = fallback;
  fullArtwork.src = best;
  desktopArtwork.src = best;
}

function handleExpandedArtworkError(event) {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement)) return;
  const fallback = image.dataset.fallbackSrc || DEFAULT_TRACK_THUMBNAIL;
  if (image.src === fallback) return;
  image.src = fallback;
}

function getNextTrack() {
  if (!playbackQueue.length) return null;
  if (isShuffleEnabled) {
    const candidates = playbackQueue.filter((video) => video.id !== currentVideoId);
    if (!candidates.length) return playbackQueue[0] || null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  if (!currentVideoId) return playbackQueue[0] || null;
  const idx = playbackQueue.findIndex((video) => video.id === currentVideoId);
  if (idx < 0) return playbackQueue[0] || null;
  const next = playbackQueue[idx + 1] || null;
  if (next) return next;
  return loopMode === "queue" ? playbackQueue[0] || null : null;
}

function isAudioElementFullyBuffered(element) {
  if (!Number.isFinite(element.duration) || element.duration <= 0) return false;
  const buffered = element.buffered;
  if (!buffered || buffered.length === 0) return false;
  const end = buffered.end(buffered.length - 1);
  return end >= element.duration - PREFETCH_BUFFER_TOLERANCE_SEC;
}

function maybeMarkCurrentTrackCachedAndPrefetch() {
  if (!currentVideoId || isCurrentTrackFullyCached) return;
  if (currentTrackLoadedFromPrefetch || isAudioElementFullyBuffered(audioPlayer)) {
    isCurrentTrackFullyCached = true;
    maybePrefetchNextTrack();
  }
}

function cancelNextPrefetch() {
  if (prefetchAbortController) {
    prefetchAbortController.abort();
  }
  prefetchAbortController = null;
  prefetchInFlightId = "";
}

function revokePrefetchedTrack(entry) {
  if (entry?.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
  }
}

function prunePrefetchedTracks() {
  const keep = new Set();
  if (currentVideoId) keep.add(currentVideoId);
  const next = getNextTrack();
  if (next?.id) keep.add(next.id);
  [...prefetchedTracks.keys()].forEach((id) => {
    if (keep.has(id)) return;
    revokePrefetchedTrack(prefetchedTracks.get(id));
    prefetchedTracks.delete(id);
  });
}

async function maybePrefetchNextTrack() {
  if (!isCurrentTrackFullyCached || !AUDIO_API_URL) return;
  let next = getNextTrack();
  if (!next && isAutoplayEnabled && !autoplayPrefetchInFlight) {
    autoplayPrefetchInFlight = true;
    try {
      const generated = await appendAutoplayTrackAtQueueEnd();
      if (generated) {
        next = getNextTrack();
      }
    } finally {
      autoplayPrefetchInFlight = false;
    }
  }
  if (!next?.id || next.id === currentVideoId) return;
  if (prefetchedTracks.has(next.id) || prefetchInFlightId === next.id) return;

  cancelNextPrefetch();
  prefetchAbortController = new AbortController();
  prefetchInFlightId = next.id;

  try {
    const { payload } = await fetchJsonWithRetry(AUDIO_API_URL, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ videoId: next.id }),
      signal: prefetchAbortController.signal,
    });
    const audioUrl = payload?.audioUrl || "";
    if (!audioUrl) {
      throw new Error("Missing prefetch audio URL");
    }
    const response = await fetch(audioUrl, { signal: prefetchAbortController.signal });
    if (!response.ok) {
      throw new Error(`Prefetch download failed (${response.status})`);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const old = prefetchedTracks.get(next.id);
    if (old) {
      revokePrefetchedTrack(old);
    }
    prefetchedTracks.set(next.id, { id: next.id, objectUrl });
    prunePrefetchedTracks();
  } catch (error) {
    if (error?.name !== "AbortError") {
      // Silent fallback: playback will use normal streaming path.
    }
  } finally {
    if (prefetchInFlightId === next.id) {
      prefetchInFlightId = "";
      prefetchAbortController = null;
    }
  }
}

function getPreviousTrack() {
  if (!currentVideoId || !playbackQueue.length) return null;
  const idx = playbackQueue.findIndex((video) => video.id === currentVideoId);
  if (idx <= 0) return null;
  return playbackQueue[idx - 1];
}

async function playNextTrack() {
  const next = getNextTrack();
  if (!next) return;
  await streamVideo(next.id, next.title, next.author, next.thumbnail);
}

async function appendAutoplayTrackAtQueueEnd() {
  const context = buildAutoplayContext();
  if (!SEARCH_API_URL) return null;
  const query = buildAutoplayQuery(context);
  if (!query) return null;
  try {
    const { payload } = await fetchJsonWithRetry(SEARCH_API_URL, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ mode: "search", query }),
    });
    const candidates = normalizeVideos(payload?.videos).slice(0, 16);
    const remoteCandidate = pickAutoplayCandidate(candidates, context);
    if (!remoteCandidate) return null;
    enqueueTrack(remoteCandidate);
    return remoteCandidate;
  } catch {
    return null;
  }
}

function pickAutoplayCandidate(candidates, context) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const inQueue = new Set(playbackQueue.map((track) => track.id));
  const titleInQueue = new Set(
    playbackQueue
      .map((track) => normalizedSongName(track?.title))
      .filter(Boolean)
  );
  const currentTitle = normalizedSongName(currentTrack.title || "");
  if (currentTitle) titleInQueue.add(currentTitle);
  const filtered = candidates
    .map((track) => normalizeTrack(track))
    .filter((track) => {
      if (!track.id || track.id === currentVideoId || inQueue.has(track.id)) return false;
      const normalizedTitle = normalizedSongName(track.title || "");
      if (!normalizedTitle) return false;
      if (titleInQueue.has(normalizedTitle)) return false;
      return true;
    });
  if (!filtered.length) return null;
  return filtered
    .map((track) => ({ track, score: scoreTrackAgainstContext(track, context) }))
    .sort((a, b) => b.score - a.score)[0]?.track || null;
}

function buildAutoplayContext() {
  const currentIndex = playbackQueue.findIndex((track) => track.id === currentVideoId);
  const recentQueueSlice =
    currentIndex >= 0
      ? playbackQueue.slice(Math.max(0, currentIndex - 3), currentIndex + 1)
      : playbackQueue.slice(-4);
  const source = recentQueueSlice.length ? recentQueueSlice : [currentTrack];
  const terms = new Set();
  const artists = [];
  source.forEach((track) => {
    const artist = cleanArtistName(track?.author || "");
    const title = cleanTrackTitle(track?.title || "");
    if (artist) {
      artists.push(artist);
      terms.add(artist.toLowerCase());
    }
    title
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .slice(0, 4)
      .forEach((word) => terms.add(word));
  });
  return {
    artists,
    terms: [...terms],
  };
}

function buildAutoplayQuery(context) {
  const title = cleanTrackTitle(currentTrack.title || "");
  const artist = cleanArtistName(currentTrack.author || "");
  const preferredArtist = context?.artists?.[0] || "";
  const contextTerms = Array.isArray(context?.terms) ? context.terms.slice(0, 3).join(" ") : "";
  if (preferredArtist && title) return `${preferredArtist} ${title} similar songs`;
  if (title && artist) return `${artist} ${title}`;
  if (preferredArtist && contextTerms) return `${preferredArtist} ${contextTerms}`;
  if (contextTerms) return contextTerms;
  if (title) return title;
  if (artist) return artist;
  return lastSearchedQuery || "";
}

function scoreTrackAgainstContext(track, context) {
  const title = cleanTrackTitle(track?.title || "").toLowerCase();
  const artist = cleanArtistName(track?.author || "").toLowerCase();
  const terms = Array.isArray(context?.terms) ? context.terms : [];
  const artists = Array.isArray(context?.artists) ? context.artists.map((item) => item.toLowerCase()) : [];
  let score = 0;
  if (artists.includes(artist)) score += 90;
  for (const term of terms) {
    if (!term) continue;
    if (title.includes(term)) score += 16;
    if (artist.includes(term)) score += 24;
  }
  const titleWordCount = title.split(/\s+/).filter(Boolean).length;
  score -= Math.max(0, titleWordCount - 12);
  return score;
}

function normalizedSongName(value) {
  return cleanTrackTitle(value || "")
    .toLowerCase()
    .replace(/\b(official|video|lyrics?|audio|hq|hd|remix|version|live)\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function playPreviousTrack() {
  const prev = getPreviousTrack();
  if (!prev) return;
  await streamVideo(prev.id, prev.title, prev.author, prev.thumbnail);
}

function renderDesktopQueue() {
  if (!playbackQueue.length) {
    desktopQueueList.innerHTML = `<p class="desktop-queue-empty">Search tracks to build queue.</p>`;
    return;
  }
  desktopQueueList.innerHTML = playbackQueue
    .map((video, index) => {
      const isActive = video.id === currentVideoId;
      return `
        <article
          class="desktop-queue-row ${isActive ? "is-active" : ""}"
          draggable="true"
          data-queue-index="${index}"
        >
          <span class="desktop-queue-grip" aria-hidden="true">⋮⋮</span>
          <button
            type="button"
            class="desktop-queue-item"
            data-queue-video-id="${escapeHtml(video.id)}"
            data-queue-video-title="${escapeHtml(video.title)}"
            data-queue-video-author="${escapeHtml(video.author)}"
            data-queue-video-thumbnail="${escapeHtml(video.thumbnail)}"
          >
            <img src="${escapeHtml(video.thumbnail)}" alt="" class="desktop-queue-thumb" />
            <span class="desktop-queue-meta">
              <span class="desktop-queue-title">${escapeHtml(video.title)}</span>
              <span class="desktop-queue-artist">${escapeHtml(video.author)}</span>
            </span>
          </button>
          <div class="desktop-queue-tail">
            <span class="desktop-queue-duration">${escapeHtml(video.duration)}</span>
            <button
              type="button"
              class="desktop-queue-remove"
              data-remove-queue-index="${index}"
              aria-label="Remove from queue"
              title="Remove from queue"
            >
              ✕
            </button>
          </div>
        </article>
      `;
    })
    .join("");

  desktopQueueList.querySelectorAll("button[data-queue-video-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (isQueueDragInProgress) return;
      const videoId = button.getAttribute("data-queue-video-id");
      const title = button.getAttribute("data-queue-video-title") || "Unknown Track";
      const author = button.getAttribute("data-queue-video-author") || "Unknown Artist";
      const thumbnail = button.getAttribute("data-queue-video-thumbnail") || "";
      await streamVideo(videoId, title, author, thumbnail);
    });
  });

  desktopQueueList.querySelectorAll("button[data-remove-queue-index]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const index = Number(button.getAttribute("data-remove-queue-index"));
      removeQueueItem(index);
    });
  });

  desktopQueueList.querySelectorAll("article[data-queue-index]").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      const fromIndex = Number(row.getAttribute("data-queue-index"));
      if (!Number.isInteger(fromIndex)) return;
      isQueueDragInProgress = true;
      row.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.setData("text/plain", String(fromIndex));
        event.dataTransfer.effectAllowed = "move";
      }
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      row.classList.add("is-drop-target");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("is-drop-target");
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      row.classList.remove("is-drop-target");
      const toIndex = Number(row.getAttribute("data-queue-index"));
      const fromRaw = event.dataTransfer?.getData("text/plain") || "";
      const fromIndex = Number(fromRaw);
      moveQueueItem(fromIndex, toIndex);
    });
    row.addEventListener("dragend", () => {
      isQueueDragInProgress = false;
      row.classList.remove("is-dragging");
      desktopQueueList.querySelectorAll(".desktop-queue-row.is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
    });
  });
}

function openFullscreenPlayer() {
  if (isPlayerExpanded || isPlayerTransitioning) return;
  isPlayerTransitioning = true;
  updateFullscreenTopOffset();
  const sourceBar = !desktopMiniBar.classList.contains("hidden") ? desktopMiniBar : miniPlayerBar;
  const openOverlay = () => {
    isPlayerExpanded = true;
    updatePlayerLayout();
    fullscreenPlayer.style.opacity = "0";
    fullscreenPlayer.style.transform = "translateY(16px) scale(0.985)";
    animate(fullscreenPlayer, {
      opacity: [0, 1],
      translateY: [16, 0],
      scale: [0.985, 1],
      duration: PLAYER_TRANSITION_MS,
      easing: "easeOutCubic",
    });
    animate("#fullscreenPlayer .fullscreen-top, #fullscreenPlayer .fullscreen-art-wrap, #fullscreenPlayer .fullscreen-meta, #fullscreenPlayer .fullscreen-progress, #fullscreenPlayer .fullscreen-controls, #fullscreenPlayer .desktop-expanded-shell, #fullscreenPlayer .desktop-dock", {
      opacity: [0, 1],
      translateY: [10, 0],
      delay: stagger(55, { start: 60 }),
      duration: PLAYER_TRANSITION_MS,
      easing: "easeOutQuad",
    });
    setTimeout(() => {
      fullscreenPlayer.style.opacity = "";
      fullscreenPlayer.style.transform = "";
      isPlayerTransitioning = false;
    }, PLAYER_TRANSITION_MS + 40);
  };

  if (sourceBar && !sourceBar.classList.contains("hidden")) {
    animate(sourceBar, {
      opacity: [1, 0],
      translateY: [0, 12],
      duration: 170,
      easing: "easeOutQuad",
    });
    setTimeout(openOverlay, 145);
    return;
  }

  openOverlay();
}

function closeFullscreenPlayer() {
  if (!isPlayerExpanded || isPlayerTransitioning) return;
  isPlayerTransitioning = true;
  animate(fullscreenPlayer, {
    opacity: [1, 0],
    translateY: [0, 10],
    scale: [1, 0.992],
    duration: 190,
    easing: "easeInQuad",
  });

  setTimeout(() => {
    isPlayerExpanded = false;
    updatePlayerLayout();
    const targetBar = !desktopMiniBar.classList.contains("hidden") ? desktopMiniBar : miniPlayerBar;
    if (targetBar && !targetBar.classList.contains("hidden")) {
      targetBar.style.opacity = "0";
      targetBar.style.transform = "translateY(12px)";
      animate(targetBar, {
        opacity: [0, 1],
        translateY: [12, 0],
        duration: PLAYER_TRANSITION_MS,
        easing: "easeOutCubic",
      });
      setTimeout(() => {
        targetBar.style.opacity = "";
        targetBar.style.transform = "";
      }, PLAYER_TRANSITION_MS + 30);
    }
    isPlayerTransitioning = false;
  }, 195);
}

function updatePlayerLayout() {
  miniPlayerBar.classList.add("hidden");
  if (mobilePlayer) {
    mobilePlayer.classList.add("hidden");
  }
  togglePlayerSizeBtn.classList.remove("hidden");
  fullscreenPlayer.classList.toggle("hidden", !isPlayerExpanded);
  desktopMiniBar.classList.toggle("hidden", isPlayerExpanded);
  togglePlayerSizeBtn.textContent = isPlayerExpanded ? "Close" : "Open";
  document.body.classList.toggle("player-open", isPlayerExpanded);
  syncMainResultsVisibility();
  updateFullscreenTopOffset();
  updateSuggestionsOverlayVisibility();
  updateSearchResultsOverlayVisibility();
}

function setWatchUrl(videoId) {
  if (!videoId) return;
  try {
    const url = new URL(window.location.href);
    url.pathname = "/watch";
    url.search = `?v=${encodeURIComponent(videoId)}`;
    window.history.pushState({ videoId }, "", url.pathname + url.search);
  } catch {
    // Ignore URL update failures.
  }
}

function setSearchUrl(query) {
  const normalized = String(query || "").trim();
  if (!normalized) return;
  try {
    const url = new URL(window.location.href);
    url.pathname = "/";
    url.search = `?q=${encodeURIComponent(normalized)}`;
    window.history.pushState({ q: normalized }, "", url.pathname + url.search);
  } catch {
    // Ignore URL update failures.
  }
}

function navigateHome() {
  hasSearched = false;
  resultsContainer.innerHTML = "";
  suggestionsList.innerHTML = "";
  searchOverlayResults.classList.add("hidden");
  syncMainResultsVisibility();
  try {
    const url = new URL(window.location.href);
    url.pathname = "/";
    url.search = "";
    window.history.pushState({}, "", url.pathname);
  } catch {
    // Ignore URL update failures.
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function readTrackFromDataset(dataset, prefix) {
  const titleKey = `${prefix}Title`;
  const authorKey = `${prefix}Author`;
  const thumbKey = `${prefix}Thumbnail`;
  const durationKey = `${prefix}Duration`;
  const idKey = `${prefix}Id`;
  return {
    id: dataset[idKey] || dataset.videoId || "",
    title: dataset[titleKey] || dataset.videoTitle || "Unknown Track",
    author: dataset[authorKey] || dataset.videoAuthor || "Unknown Artist",
    thumbnail: dataset[thumbKey] || dataset.videoThumbnail || "",
    duration: dataset[durationKey] || dataset.videoDuration || "--:--",
  };
}

function normalizeTrack(track) {
  return {
    id: String(track?.id || ""),
    title: String(track?.title || "Unknown Track"),
    author: String(track?.author || "Unknown Artist"),
    thumbnail: String(track?.thumbnail || ""),
    duration: String(track?.duration || "--:--"),
  };
}

function loadPlaybackQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYBACK_QUEUE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => normalizeTrack(item)).filter((item) => item.id);
  } catch {
    return [];
  }
}

function savePlaybackQueue() {
  try {
    localStorage.setItem(PLAYBACK_QUEUE_KEY, JSON.stringify(playbackQueue.slice(0, 200)));
  } catch {
    // Ignore storage errors.
  }
}

function enqueueTrack(track) {
  const normalized = normalizeTrack(track);
  if (!normalized.id) return;
  const existingIndex = playbackQueue.findIndex((item) => item.id === normalized.id);
  if (existingIndex >= 0) {
    playbackQueue.splice(existingIndex, 1);
  }
  playbackQueue.push(normalized);
  savePlaybackQueue();
  renderDesktopQueue();
  prunePrefetchedTracks();
  void maybePrefetchNextTrack();
}

function enqueueTrackNext(track) {
  const normalized = normalizeTrack(track);
  if (!normalized.id) return;
  let currentIndex = playbackQueue.findIndex((item) => item.id === currentVideoId);
  const existingIndex = playbackQueue.findIndex((item) => item.id === normalized.id);
  if (existingIndex >= 0) {
    playbackQueue.splice(existingIndex, 1);
    if (currentIndex > existingIndex) currentIndex -= 1;
  }
  const insertAt = currentIndex >= 0 ? currentIndex + 1 : 0;
  playbackQueue.splice(insertAt, 0, normalized);
  savePlaybackQueue();
  renderDesktopQueue();
  prunePrefetchedTracks();
  void maybePrefetchNextTrack();
}

function moveQueueItem(fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= playbackQueue.length || toIndex >= playbackQueue.length) return;
  if (fromIndex === toIndex) return;
  const [moved] = playbackQueue.splice(fromIndex, 1);
  if (!moved) return;
  playbackQueue.splice(toIndex, 0, moved);
  savePlaybackQueue();
  renderDesktopQueue();
  prunePrefetchedTracks();
  void maybePrefetchNextTrack();
}

function removeQueueItem(index) {
  if (!Number.isInteger(index)) return;
  if (index < 0 || index >= playbackQueue.length) return;
  const [removed] = playbackQueue.splice(index, 1);
  if (!removed) return;
  savePlaybackQueue();
  renderDesktopQueue();
  prunePrefetchedTracks();
  void maybePrefetchNextTrack();
}

function clearPlaybackQueue() {
  playbackQueue.length = 0;
  savePlaybackQueue();
  renderDesktopQueue();
  cancelNextPrefetch();
  prefetchedTracks.forEach((entry) => revokePrefetchedTrack(entry));
  prefetchedTracks.clear();
}

function loadAutoplaySetting() {
  try {
    const saved = localStorage.getItem(AUTOPLAY_KEY);
    if (saved === null) return true;
    return saved === "true";
  } catch {
    return true;
  }
}

function saveAutoplaySetting(value) {
  try {
    localStorage.setItem(AUTOPLAY_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage errors.
  }
}

function loadLoopMode() {
  try {
    const saved = String(localStorage.getItem(LOOP_MODE_KEY) || "off");
    if (saved === "queue" || saved === "song") return saved;
    return "off";
  } catch {
    return "off";
  }
}

function saveLoopMode(mode) {
  try {
    localStorage.setItem(LOOP_MODE_KEY, mode);
  } catch {
    // Ignore storage errors.
  }
}

function cycleLoopMode() {
  if (loopMode === "off") {
    loopMode = "queue";
  } else if (loopMode === "queue") {
    loopMode = "song";
  } else {
    loopMode = "off";
  }
  saveLoopMode(loopMode);
  updatePlayerUi();
}

function loadRecentSongs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_SONGS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => normalizeTrack(item)).filter((item) => item.id);
  } catch {
    return [];
  }
}

function saveRecentSongs() {
  try {
    localStorage.setItem(RECENT_SONGS_KEY, JSON.stringify(recentSongs.slice(0, RECENT_CACHE_LIMIT)));
  } catch {
    // Ignore storage errors.
  }
}

function addRecentSong(track) {
  const normalized = normalizeTrack(track);
  if (!normalized.id) return;
  const deduped = recentSongs.filter((item) => item.id !== normalized.id);
  recentSongs.length = 0;
  recentSongs.push(normalized, ...deduped.slice(0, RECENT_CACHE_LIMIT - 1));
  saveRecentSongs();
}

function loadLyricsCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LYRICS_CACHE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => ({
        key: String(entry?.key || ""),
        status: String(entry?.status || ""),
        synced: Boolean(entry?.synced),
        source: String(entry?.source || ""),
        plainText: String(entry?.plainText || ""),
        lines: Array.isArray(entry?.lines) ? entry.lines.filter((line) => Number.isFinite(line?.time) && typeof line?.text === "string") : [],
      }))
      .filter((entry) => entry.key);
  } catch {
    return [];
  }
}

function saveLyricsCache() {
  try {
    localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(lyricsCache.slice(0, RECENT_CACHE_LIMIT)));
  } catch {
    // Ignore storage errors.
  }
}

function upsertLyricsCache(cacheEntry) {
  const key = String(cacheEntry?.key || "");
  if (!key) return;
  const normalized = {
    key,
    status: String(cacheEntry?.status || ""),
    synced: Boolean(cacheEntry?.synced),
    source: String(cacheEntry?.source || ""),
    plainText: String(cacheEntry?.plainText || ""),
    lines: Array.isArray(cacheEntry?.lines) ? cacheEntry.lines.slice(0, 500) : [],
  };
  const deduped = lyricsCache.filter((entry) => entry.key !== key);
  lyricsCache.length = 0;
  lyricsCache.push(normalized, ...deduped.slice(0, RECENT_CACHE_LIMIT - 1));
  saveLyricsCache();
}

function setDesktopTab(tab) {
  activeDesktopTab = tab;
  desktopTabUpNext.classList.toggle("is-active", tab === "upnext");
  desktopTabLyrics.classList.toggle("is-active", tab === "lyrics");
  desktopTabRelated.classList.toggle("is-active", tab === "related");
  desktopQueueList.classList.toggle("hidden", tab !== "upnext");
  desktopLyricsPanel.classList.toggle("hidden", tab !== "lyrics");
  desktopRelatedPanel.classList.toggle("hidden", tab !== "related");
  if (tab === "lyrics") {
    ensureLyricsLoadedForCurrentTrack();
  }
}

async function loadLyricsForTrack(track) {
  const requestId = ++lyricsRequestId;
  const cacheKey = getLyricsCacheKey(track);
  const cached = lyricsCache.find((entry) => entry.key === cacheKey);
  if (cached) {
    lyricsState.lines = cached.lines;
    lyricsState.plainText = cached.plainText;
    lyricsState.synced = cached.synced;
    lyricsState.source = cached.source;
    lyricsState.status = cached.status || "Lyrics loaded from cache.";
    renderLyricsPanel();
    return;
  }

  lyricsState.lines = [];
  lyricsState.plainText = "";
  lyricsState.synced = false;
  lyricsState.source = "";
  lyricsState.status = "Loading lyrics...";
  renderLyricsPanel();

  const titleCandidates = buildLyricsTitleCandidates(track.title);
  const artistCandidates = buildLyricsArtistCandidates(track.author);
  if (!titleCandidates.length) {
    lyricsState.status = "Lyrics unavailable for this track.";
    renderLyricsPanel();
    return;
  }

  try {
    let payload = null;
    const attempts = [];
    const artists = artistCandidates.length ? artistCandidates : [""];
    titleCandidates.slice(0, 4).forEach((title) => {
      artists.slice(0, 3).forEach((artist) => {
        attempts.push({ title, artist });
      });
    });

    for (const attempt of attempts) {
      if (requestId !== lyricsRequestId) return;
      const trackName = attempt.title;
      const artistName = attempt.artist;
      const artistParam = artistName ? `&artist_name=${encodeURIComponent(artistName)}` : "";
      const directUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(trackName)}${artistParam}`;
      payload = await fetch(directUrl).then((r) => (r.ok ? r.json() : null));
      if (payload) break;

      const searchUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(trackName)}${artistParam}`;
      const searchPayload = await fetch(searchUrl).then((r) => (r.ok ? r.json() : []));
      payload = Array.isArray(searchPayload) && searchPayload.length ? searchPayload[0] : null;
      if (payload) break;
    }

    if (requestId !== lyricsRequestId) return;
    if (!payload) {
      lyricsState.status = "Lyrics unavailable for this track.";
      upsertLyricsCache({
        key: cacheKey,
        status: lyricsState.status,
        synced: false,
        source: "LRCLIB",
        plainText: "",
        lines: [],
      });
      renderLyricsPanel();
      return;
    }

    const syncedRaw = payload?.syncedLyrics || "";
    const plainRaw = payload?.plainLyrics || "";
    const parsedLines = parseSyncedLyrics(syncedRaw);

    if (requestId !== lyricsRequestId) return;
    if (parsedLines.length) {
      lyricsState.lines = parsedLines;
      lyricsState.synced = true;
      lyricsState.source = "LRCLIB synced";
      lyricsState.status = "Synced lyrics loaded.";
      lyricsState.plainText = parsedLines.map((line) => line.text).join("\n");
    } else if (plainRaw.trim()) {
      lyricsState.plainText = plainRaw.trim();
      lyricsState.synced = false;
      lyricsState.source = "LRCLIB plain";
      lyricsState.status = "Plain lyrics loaded.";
    } else {
      lyricsState.status = "Lyrics unavailable for this track.";
    }
    upsertLyricsCache({
      key: cacheKey,
      status: lyricsState.status,
      synced: lyricsState.synced,
      source: lyricsState.source,
      plainText: lyricsState.plainText,
      lines: lyricsState.lines,
    });
  } catch {
    if (requestId !== lyricsRequestId) return;
    lyricsState.status = "Failed to load lyrics.";
    upsertLyricsCache({
      key: cacheKey,
      status: lyricsState.status,
      synced: false,
      source: "LRCLIB",
      plainText: "",
      lines: [],
    });
  }

  if (requestId !== lyricsRequestId) return;
  renderLyricsPanel();
}

function parseSyncedLyrics(lrcText) {
  if (!lrcText) return [];
  const lines = [];
  lrcText.split("\n").forEach((raw) => {
    const row = String(raw || "").trim();
    if (!row) return;

    // Capture all timestamps on a line (e.g. [00:12.10][00:15,20]text).
    const timeMatches = [...row.matchAll(/\[(\d{1,2}):(\d{1,2}(?:[.,]\d{1,3})?)\]/g)];
    if (!timeMatches.length) return;

    // Remove timestamps and metadata-like tags from lyric text.
    const text = row
      .replace(/\[\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?\]/g, "")
      .replace(/\[[a-z]{1,8}:[^\]]*]/gi, "")
      .trim();
    if (!text) return;

    timeMatches.forEach((match) => {
      const minutes = Number(match[1]);
      const seconds = Number(String(match[2]).replace(",", "."));
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return;
      lines.push({ time: minutes * 60 + seconds, text });
    });
  });
  return lines.sort((a, b) => a.time - b.time);
}

function updateSyncedLyrics(currentTime) {
  if (!lyricsState.synced || !lyricsState.lines.length) {
    lyricsActiveLineIndex = -1;
    return;
  }
  let activeIndex = -1;
  for (let i = 0; i < lyricsState.lines.length; i += 1) {
    if (lyricsState.lines[i].time <= currentTime) {
      activeIndex = i;
    } else {
      break;
    }
  }
  if (activeIndex < 0) {
    lyricsActiveLineIndex = -1;
    applyActiveSyncedLyric(desktopLyricsText, -1);
    applyActiveSyncedLyric(mobileLyricsText, -1);
    return;
  }
  if (activeIndex === lyricsActiveLineIndex) return;
  lyricsActiveLineIndex = activeIndex;
  applyActiveSyncedLyric(desktopLyricsText, activeIndex);
  applyActiveSyncedLyric(mobileLyricsText, activeIndex);
}

function applyActiveSyncedLyric(container, activeIndex) {
  const previous = container.querySelector(".lyrics-line.is-active");
  if (previous) previous.classList.remove("is-active");
  if (activeIndex < 0) return;
  const active = container.querySelector(`[data-lyric-index="${activeIndex}"]`);
  if (!active) return;
  active.classList.add("is-active");
  active.scrollIntoView({ block: "center", behavior: "auto" });
}

function handleSyncedLyricsClick(event) {
  if (!lyricsState.synced || !lyricsState.lines.length) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const line = target.closest(".lyrics-line");
  if (!(line instanceof HTMLElement)) return;
  const timestamp = Number(line.dataset.lyricTime);
  if (!Number.isFinite(timestamp)) return;
  audioPlayer.currentTime = Math.max(0, timestamp);
  updatePlayerUi();
}

function renderLyricsPanel() {
  desktopLyricsStatus.textContent = lyricsState.status;
  mobileLyricsStatus.textContent = lyricsState.status;
  lyricsActiveLineIndex = -1;
  if (lyricsState.synced) {
    const syncedMarkup = lyricsState.lines
      .map(
        (line, index) =>
          `<p class="lyrics-line" data-lyric-index="${index}" data-lyric-time="${line.time}">${escapeHtml(line.text)}</p>`
      )
      .join("");
    desktopLyricsText.classList.add("is-synced");
    mobileLyricsText.classList.add("is-synced");
    desktopLyricsText.innerHTML = syncedMarkup;
    mobileLyricsText.innerHTML = syncedMarkup;
    updateSyncedLyrics(Number.isFinite(audioPlayer.currentTime) ? audioPlayer.currentTime : 0);
    return;
  }
  desktopLyricsText.classList.remove("is-synced");
  mobileLyricsText.classList.remove("is-synced");
  const plain = lyricsState.plainText || "";
  desktopLyricsText.textContent = plain;
  mobileLyricsText.textContent = plain;
}

function resetLyricsStateForTrack() {
  lyricsState.lines = [];
  lyricsState.plainText = "";
  lyricsState.synced = false;
  lyricsState.source = "";
  lyricsState.status = "Open Lyrics tab to load lyrics.";
  renderLyricsPanel();
}

function ensureLyricsLoadedForCurrentTrack() {
  if (!currentTrack?.title || currentTrack.title === DEFAULT_TRACK_TITLE) {
    lyricsState.status = "Play a track to load lyrics.";
    renderLyricsPanel();
    return;
  }
  if (lyricsState.synced || lyricsState.plainText) return;
  void loadLyricsForTrack(currentTrack);
}

desktopLyricsText.addEventListener("click", handleSyncedLyricsClick);
mobileLyricsText.addEventListener("click", handleSyncedLyricsClick);

function getLyricsCacheKey(track) {
  return `${cleanTrackTitle(track?.title || "").toLowerCase()}::${cleanArtistName(track?.author || "").toLowerCase()}`;
}

function buildLyricsTitleCandidates(value) {
  const raw = String(value || "");
  const cleaned = cleanTrackTitle(raw);
  const strippedLead = cleaned
    .replace(/^\s*(?:official|lyric|lyrics|audio|video)\s*[:\-]\s*/i, "")
    .trim();
  const splitCandidates = strippedLead
    .split(/\s+(?:[-|:])\s+/)
    .map((part) => cleanTrackTitle(part))
    .filter(Boolean);
  const candidates = [cleaned, strippedLead, ...splitCandidates]
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(candidates)];
}

function buildLyricsArtistCandidates(value) {
  const raw = String(value || "");
  const cleaned = cleanArtistName(raw);
  const primary = cleaned.split(/\s+(?:x|and|&)\s+/i).map((part) => cleanArtistName(part)).filter(Boolean);
  const candidates = [cleaned, ...primary].map((item) => item.trim()).filter(Boolean);
  return [...new Set(candidates)];
}

function cleanTrackTitle(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#@][\w.-]+/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]/g, " ")
    .replace(
      /\b(official|video|audio|visualizer|lyric(?:s)?|mv|hd|4k|8k|remix|edit|version|live|concert|cover|karaoke|slowed|reverb|sped\s*up|nightcore|bass\s*boosted|prod\.?|produced\s+by|from|ost|soundtrack)\b/gi,
      " "
    )
    .replace(/\b(ft|feat|featuring)\b.*$/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\-\s|:]+|[\-\s|:]+$/g, "")
    .trim();
}

function cleanArtistName(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#@][\w.-]+/g, " ")
    .split(/[|]/)[0]
    .replace(/\b(ft|feat|featuring)\b.*$/gi, " ")
    .replace(/\b(official|topic|vevo|records?|music|channel)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function updateFullscreenTopOffset() {
  if (!searchSection) return;
  const rect = searchSection.getBoundingClientRect();
  const minTop = 8;
  const fallbackTop = window.matchMedia("(min-width: 1024px)").matches ? 120 : 92;
  const top = rect.bottom > 0 ? Math.max(minTop, Math.round(rect.bottom + 10)) : fallbackTop;
  fullscreenPlayer.style.top = `${top}px`;
}

function updateSearchResultsOverlayPosition() {
  const rect = searchSection.getBoundingClientRect();
  const top = Math.max(8, Math.round(rect.bottom + 8));
  const width = Math.max(320, Math.round(rect.width));
  searchOverlayResults.style.top = `${top}px`;
  searchOverlayResults.style.left = `${Math.round(rect.left)}px`;
  searchOverlayResults.style.width = `${width}px`;
}

function updateSuggestionsOverlayPosition() {
  const rect = searchSection.getBoundingClientRect();
  const top = Math.max(8, Math.round(rect.bottom + 8));
  const width = Math.max(320, Math.round(rect.width));
  searchOverlaySuggestions.style.top = `${top}px`;
  searchOverlaySuggestions.style.left = `${Math.round(rect.left)}px`;
  searchOverlaySuggestions.style.width = `${width}px`;
}

function updateSuggestionsOverlayVisibility() {
  const focused = document.activeElement === searchInput;
  const hasSuggestions = Boolean(searchOverlaySuggestions.querySelector("button[data-suggestion]"));
  const shouldShow =
    isPlayerExpanded &&
    focused &&
    hasSuggestions &&
    !(isPhoneUi() && hasSearched);
  updateInlineSuggestionsVisibility();
  if (!shouldShow) {
    searchOverlaySuggestions.classList.add("hidden");
    return;
  }
  updateSuggestionsOverlayPosition();
  searchOverlaySuggestions.classList.remove("hidden");
}

function updateInlineSuggestionsVisibility() {
  const focused = document.activeElement === searchInput;
  const hasSuggestions = Boolean(suggestionsList.querySelector("button[data-suggestion]"));
  const shouldShow = !isPlayerExpanded && focused && hasSuggestions && !isPhoneUi();
  suggestionsList.classList.toggle("hidden", !shouldShow);
}

function updateSearchResultsOverlayVisibility() {
  const focused = document.activeElement === searchInput;
  const shouldShow = isPlayerExpanded && focused && hasSearched;
  if (!shouldShow) {
    searchOverlayResults.classList.add("hidden");
    return;
  }
  updateSearchResultsOverlayPosition();
  searchOverlayResults.classList.remove("hidden");
}

window.addEventListener("resize", () => {
  if (isPlayerTransitioning) return;
  updatePlayerLayout();
});
window.addEventListener("scroll", () => {
  if (!isPlayerExpanded) return;
  updateFullscreenTopOffset();
  updateSuggestionsOverlayPosition();
  updateSearchResultsOverlayPosition();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    desktopDockMenu.classList.add("hidden");
  }
  if (event.key === "Escape" && isPlayerExpanded) {
    closeFullscreenPlayer();
  }
});
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest("#homeMenuWrap")) {
    homeMenu.classList.add("hidden");
  }
  if (event.target.closest(".dock-menu-wrap")) return;
  desktopDockMenu.classList.add("hidden");
});
window.addEventListener("beforeunload", () => {
  cancelNextPrefetch();
  prefetchedTracks.forEach((entry) => revokePrefetchedTrack(entry));
  prefetchedTracks.clear();
});

async function clearClientCaches() {
  const keys = [
    SEARCH_HISTORY_KEY,
    PLAYER_VOLUME_KEY,
    PLAYBACK_QUEUE_KEY,
    AUTOPLAY_KEY,
    LOOP_MODE_KEY,
    RECENT_SONGS_KEY,
    LYRICS_CACHE_KEY,
  ];
  keys.forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage errors.
    }
  });
  try {
    sessionStorage.clear();
  } catch {
    // Ignore storage errors.
  }
  searchHistory.length = 0;
  suggestionPool.clear();
  lastVideos = [];
  playbackQueue.length = 0;
  recentSongs.length = 0;
  lyricsCache.length = 0;
  clearPlaybackQueue();
  if ("caches" in window && typeof window.caches.keys === "function") {
    try {
      const names = await window.caches.keys();
      await Promise.all(names.map((name) => window.caches.delete(name)));
    } catch {
      // Ignore cache API errors.
    }
  }
}
updateTrackMetaUi();
setDesktopTab(activeDesktopTab);
renderLyricsPanel();
updatePlayerLayout();
