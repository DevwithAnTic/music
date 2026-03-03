#!/usr/bin/env node
// Usage: node getAudio.js "https://www.youtube.com/watch?v=VIDEO_ID"
// Prints only the best audio-only direct stream URL to stdout.

const youtubedl = require("youtube-dl-exec");

const videoUrl = process.argv[2];

if (!videoUrl) {
  console.error("Missing required argument: video URL");
  process.exit(1);
}

function isAudioOnlyFormat(format) {
  return (
    format &&
    typeof format.url === "string" &&
    format.url.length > 0 &&
    format.acodec &&
    format.acodec !== "none" &&
    (format.vcodec === "none" || !format.vcodec)
  );
}

function scoreAudioFormat(format) {
  const abr = Number(format.abr) || 0;
  const asr = Number(format.asr) || 0;
  const tbr = Number(format.tbr) || 0;
  const preference = Number(format.preference) || 0;
  const extBonus = format.ext === "m4a" ? 20 : format.ext === "webm" ? 10 : 0;
  const protocolBonus = /^https?$/i.test(String(format.protocol || "")) ? 5 : 0;
  return preference * 1_000_000_000 + abr * 1_000_000 + asr * 1_000 + tbr + extBonus + protocolBonus;
}

function isDirectAudioUrl(format) {
  const protocol = String(format.protocol || "");
  const url = String(format.url || "");
  return !/m3u8|dash|http_dash_segments/i.test(protocol) && !/\.m3u8(\?|$)/i.test(url);
}

(async () => {
  try {
    const raw = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      preferFreeFormats: true,
      noWarnings: true,
      noPlaylist: true,
      referer: "youtube.com",
      userAgent: "googlebot",
      addHeader: ["referer: youtube.com", "user-agent: googlebot"],
    });

    const info = typeof raw === "string" ? JSON.parse(raw) : raw;
    const formats = Array.isArray(info?.formats) ? info.formats : [];

    const audioOnlyFormats = formats.filter(isAudioOnlyFormat);
    if (audioOnlyFormats.length === 0) {
      throw new Error("No audio-only formats available.");
    }

    const directAudioFormats = audioOnlyFormats.filter(isDirectAudioUrl);
    const candidates = directAudioFormats.length > 0 ? directAudioFormats : audioOnlyFormats;
    candidates.sort((a, b) => scoreAudioFormat(b) - scoreAudioFormat(a));

    const best = candidates[0];
    if (!best || !best.url) {
      throw new Error("Could not determine best audio stream URL.");
    }

    process.stdout.write(best.url.trim());
  } catch (err) {
    const message = err?.stderr || err?.message || "Unknown error";
    console.error(`Failed to extract audio URL: ${message}`);
    process.exit(1);
  }
})();
