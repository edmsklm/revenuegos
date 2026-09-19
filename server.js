// Server: serves the website and answers prompts by scanning the GOs & Circulars PDF
// documents stored in the public Google Drive folder.
//
// New/changed documents are detected incrementally:
//  - per-file extracted-text cache on disk (keyed by file id)
//  - a manifest (JSON) tracks each file's name + last-modified date
//  - Drive is re-listed periodically and on demand; only new/updated files are
//    downloaded and re-extracted; removed files are dropped from the index.
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRIVE_FOLDER_ID =
  process.env.DRIVE_FOLDER_ID || "1uUM85UZc3SdEj-l0efUluhaQdaQOltTS";
const CACHE_DIR = path.join(os.tmpdir(), "go-circulars-cache");
const MANIFEST_PATH = path.join(CACHE_DIR, "manifest.json");
const PORT = process.env.PORT || 3000;
const AUTO_REFRESH_MS = Number(process.env.AUTO_REFRESH_MS) || 5 * 60 * 1000; // re-scan Drive listing interval
const REFRESH_COOLDOWN_MS = 60 * 1000; // don't hammer Drive more than once a minute

const app = express();
app.use(express.json());
// Allow a separately-hosted frontend (e.g. GitHub Pages) to call this API.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------- Drive scan

/** Decode HTML entities used by the Drive listing. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * List files in the public Drive folder via the embeddedfolderview endpoint.
 * Returns [{ id, name, modified (string as shown by Drive) }].
 */
async function listDriveFolder() {
  const url = `https://drive.google.com/embeddedfolderview?id=${DRIVE_FOLDER_ID}#list`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Drive folder fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  const files = [];
  // Split into per-entry blocks so title/modified never bleed across entries.
  const blocks = html.split(/<div class="flip-entry" id="entry-/);
  blocks.shift(); // drop preamble before the first entry
  for (const block of blocks) {
    const idMatch = block.match(/^([A-Za-z0-9_-]+)/);
    const titleMatch = block.match(/flip-entry-title">([\s\S]*?)<\/div>/);
    const modMatch = block.match(/flip-entry-last-modified"><div>([\s\S]*?)<\/div>/);
    if (!idMatch || !titleMatch) continue;
    files.push({
      id: idMatch[1],
      name: decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "")),
      modified: modMatch
        ? decodeEntities(modMatch[1].replace(/<[^>]+>/g, ""))
        : null,
    });
  }
  return files;
}

/** Download a Drive file by id, returning a Buffer. */
async function downloadDriveFile(fileId) {
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------- Manifest (change tracking)

// manifest.json shape:
// { files: { "<driveFileId>": { name, modified, textPath, pages, chars, indexedAt } } }
let manifest = { files: {} };

function loadManifest() {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    manifest = { files: {} };
  }
}

function saveManifest() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ------------------------------------------------------------------- Indexing

const state = {
  status: "loading", // loading | ready | error
  error: null,
  syncing: false,
  lastSyncAt: null,
  lastChangeAt: null, // last time the document set actually changed
  files: [], // [{ id, name, modified, pages, chars, indexedAt }]
  pages: [], // [{ file, page, text }]
  events: [], // recent sync events, newest first
};

function logEvent(message) {
  state.events.unshift({ at: new Date().toISOString(), message });
  state.events = state.events.slice(0, 20);
  console.log(`[sync] ${message}`);
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** Split raw PDF text into per-page chunks. pdf-parse concatenates pages with \n\n. */
function splitIntoPages(rawText) {
  const rawPages = rawText.split(/\n{2,}|\f/);
  const pages = [];
  rawPages.forEach((t, i) => {
    const text = normalizeWhitespace(t);
    if (text.length > 0) pages.push({ page: i + 1, text });
  });
  return pages;
}

/** Rebuild the in-memory page index from all per-file text caches + manifest. */
function rebuildPageIndex() {
  const pages = [];
  const files = [];
  for (const [id, meta] of Object.entries(manifest.files)) {
    if (!meta.pages || meta.pages.length === 0) continue;
    meta.pages.forEach((p) =>
      pages.push({
        file: meta.name,
        page: p.page,
        text: p.text,
        // Dot-insensitive variant: "G.O.Ms.No.30" -> "gomsno30" so prompts typed
        // without dots ("GOMs No30") still match.
        textSq: p.text.toLowerCase().replace(/\./g, ""),
      })
    );
    files.push({
      id,
      name: meta.name,
      modified: meta.modified || null,
      pages: meta.pages.length,
      chars: meta.chars || 0,
      indexedAt: meta.indexedAt,
    });
  }
  state.pages = pages;
  state.files = files;
}

/** Extract + cache pages for a single file. Returns manifest meta entry. */
async function indexFile(file, { force = false } = {}) {
  const existing = manifest.files[file.id];
  const unchanged =
    !force &&
    existing &&
    existing.name === file.name &&
    existing.modified === file.modified;
  if (unchanged) return existing;

  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  const textCachePath = path.join(CACHE_DIR, `${file.id}.text.json`);

  let pages;
  if (
    !force &&
    existing &&
    existing.textPath === textCachePath &&
    fs.existsSync(textCachePath) &&
    existing.name === file.name
  ) {
    pages = JSON.parse(fs.readFileSync(textCachePath, "utf8"));
  } else {
    const downloadPath = path.join(CACHE_DIR, `${file.id}.pdf`);
    let pdfBuffer;
    if (fs.existsSync(downloadPath) && fs.statSync(downloadPath).size > 1000) {
      console.log(`[index] Using cached download for ${file.name}`);
      pdfBuffer = fs.readFileSync(downloadPath);
    } else {
      console.log(`[index] Downloading ${file.name} ...`);
      pdfBuffer = await downloadDriveFile(file.id);
      fs.writeFileSync(downloadPath, pdfBuffer);
    }
    const data = await pdfParse(pdfBuffer);
    pages = splitIntoPages(data.text);
    fs.writeFileSync(textCachePath, JSON.stringify(pages));
  }

  const isNew = !existing;
  const meta = {
    name: file.name,
    modified: file.modified,
    textPath: textCachePath,
    pages,
    chars: pages.reduce((n, p) => n + p.text.length, 0),
    indexedAt: new Date().toISOString(),
  };
  manifest.files[file.id] = meta;
  saveManifest();

  logEvent(
    isNew
      ? `New document indexed: "${file.name}" (${pages.length} pages)`
      : `Updated document re-indexed: "${file.name}" (${pages.length} pages)`
  );
  return meta;
}

/** Remove files from the index that no longer exist in Drive. */
function pruneRemoved(driveFiles) {
  const driveIds = new Set(driveFiles.map((f) => f.id));
  for (const id of Object.keys(manifest.files)) {
    if (!driveIds.has(id)) {
      logEvent(`Removed from index (deleted in Drive): "${manifest.files[id].name}"`);
      delete manifest.files[id];
    }
  }
  saveManifest();
}

let syncGeneration = 0;

/**
 * Sync with Drive: list folder, index new/updated files, prune removed ones.
 * Safe to call concurrently — overlapping calls coalesce into the running one.
 */
async function syncDrive() {
  if (state.syncing) return { coalesced: true };
  state.syncing = true;
  const gen = ++syncGeneration;
  try {
    const driveFiles = await listDriveFolder();
    if (gen !== syncGeneration) return { aborted: true }; // superseded
    if (driveFiles.length === 0) throw new Error("No files found in Drive folder");

    pruneRemoved(driveFiles);

    let changes = 0;
    for (const file of driveFiles) {
      const before = manifest.files[file.id];
      await indexFile(file);
      if (manifest.files[file.id] !== before) changes++;
    }

    rebuildPageIndex();
    state.status = "ready";
    state.error = null;
    state.lastSyncAt = new Date().toISOString();
    if (changes > 0) state.lastChangeAt = state.lastSyncAt;
    saveManifest();
    if (changes > 0) logEvent(`Sync complete — ${changes} document(s) added/updated.`);
    else logEvent(`Sync complete — no changes (${driveFiles.length} documents).`);
    return { ok: true, changes };
  } catch (err) {
    // Keep serving from the existing index if we have one.
    if (Object.keys(manifest.files).length > 0) {
      state.status = "ready";
    } else {
      state.status = "error";
    }
    state.error = err.message;
    logEvent(`Sync failed: ${err.message}`);
    return { error: err.message };
  } finally {
    state.syncing = false;
  }
}

// -------------------------------------------------------------------- Search

function tokenize(q) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Count occurrences of needle in haystack. */
function countOccurrences(haystack, needle) {
  let idx = 0;
  let count = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/** Score a page against the query tokens, tolerating missing dots ("GOMs" vs "G.O.Ms"). */
function scorePage(page, tokens) {
  const lower = page.text.toLowerCase();
  const lowerSq = page.textSq; // dots stripped
  let score = 0;
  for (const t of tokens) {
    let count = countOccurrences(lower, t);
    if (count === 0 && t.includes(".")) count = countOccurrences(lowerSq, t.replace(/\./g, ""));
    if (count > 0) score += count * t.length; // weight longer tokens more
  }
  return score;
}

/** Find sentences on a page containing at least one token. */
function extractSentences(text, tokens, maxLen = 600) {
  const sentences = text.split(/(?<=[.;])\s+/);
  const hits = [];
  for (const s of sentences) {
    const lower = s.toLowerCase();
    if (tokens.some((t) => lower.includes(t))) hits.push(s.trim());
  }
  if (hits.length === 0) return text.slice(0, maxLen);
  let out = hits.join(" ");
  if (out.length > maxLen) out = out.slice(0, maxLen) + "…";
  return out;
}

function searchIndex(query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const lowerQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  // Exact-phrase variants: with spaces (normal) and with dots+spaces stripped
  // (so "G.O.Ms.No.260 dated 04-05-2026" ≈ "GOMsNo260dated04052026").
  const phraseSq = lowerQuery.replace(/[.\s]+/g, "");
  // Precise GO reference, e.g. "G.O.Ms.No.30" / "GOMs No30" -> "30".
  const goRef = lowerQuery.replace(/\./g, "").match(/goms?\s*n[oa]?\.?\s*(\d{1,4})/);
  // Per-file squashed names for filename-relevance boosting.
  const fileNameSq = new Map(
    state.files.map((f) => [f.name, f.name.toLowerCase().replace(/[^a-z0-9]/g, "")])
  );
  const scored = [];
  for (const p of state.pages) {
    let score = scorePage(p, tokens);
    if (score === 0) continue;
    // Length normalization: level the field between dense multi-page GO texts
    // and short circulars so common-word repetition doesn't dominate.
    score /= Math.max(0.8, 1 + Math.log10(Math.max(1, p.text.length) / 1000));
    const lowerText = p.text.toLowerCase();
    // Boost pages containing the exact query phrase (e.g. a full GO number + date).
    if (lowerQuery.length >= 8 && lowerText.includes(lowerQuery)) score *= 3;
    else if (phraseSq.length >= 8 && p.textSq.replace(/\s+/g, "").includes(phraseSq)) score *= 3;
    // Strong boost for the exact GO number reference (e.g. "G.O.Ms.No.30").
    if (goRef) {
      const goRe = new RegExp("gomsno\\s*0*" + goRef[1] + "(?![0-9])");
      if (goRe.test(p.textSq)) score *= 2.5;
      else if ((fileNameSq.get(p.file) || "").includes("no" + goRef[1])) score *= 2.5;
    }
    // Boost when most query tokens appear in the document's own file name
    // (e.g. asking about "Circular GOMs No30" ranks that Circular's pages first).
    const nameSq = fileNameSq.get(p.file) || "";
    if (nameSq) {
      const hits = tokens.filter((t) => nameSq.includes(t.replace(/\./g, ""))).length;
      if (tokens.length >= 2 && hits / tokens.length >= 0.6) score *= 2.2;
    }
    scored.push({ score, ...p });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((p) => ({
    file: p.file,
    page: p.page,
    score: p.score,
    snippet: extractSentences(p.text, tokens),
    fullText: p.text,
  }));
}

/** Build a "reply" from top matches, quoting the closest passages exactly. */
function buildReply(query) {
  const matches = searchIndex(query);
  if (matches.length === 0) {
    return {
      found: false,
      reply:
        "No matching content found in the scanned documents. Try terms like a GO number (e.g. G.O.Ms.No.260), a subject (e.g. land alienation, assignment, lease), a village or district name, or a date (e.g. 04-05-2026).",
      matches: [],
    };
  }
  const lines = matches.map(
    (m, i) => `${i + 1}. [${m.file} — page ${m.page}]\n"${m.snippet}"`
  );
  return {
    found: true,
    reply: `Scanned ${state.files.length} document(s) (${state.pages.length} page sections). Closest matches for your prompt:\n\n${lines.join("\n\n")}`,
    matches: matches.map(({ file, page, score, snippet }) => ({ file, page, score, snippet })),
  };
}

// --------------------------------------------------------------------- Routes

app.get("/api/status", (req, res) => {
  res.json({
    status: state.status,
    syncing: state.syncing,
    error: state.error,
    lastSyncAt: state.lastSyncAt,
    lastChangeAt: state.lastChangeAt,
    files: state.files,
    pageChunks: state.pages.length,
    events: state.events,
    autoRefreshMinutes: AUTO_REFRESH_MS / 60000,
    driveFolder: `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`,
  });
});

/**
 * Trigger a Drive re-scan. New/changed files get indexed; removed ones pruned.
 * Non-blocking: returns immediately with { started: true } unless ?wait=1.
 */
app.post("/api/refresh", async (req, res) => {
  const sinceSyncMs = state.lastSyncAt ? Date.now() - new Date(state.lastSyncAt) : Infinity;
  if (sinceSyncMs < REFRESH_COOLDOWN_MS && !req.query.force) {
    return res.json({
      skipped: true,
      message: `Last sync was < ${REFRESH_COOLDOWN_MS / 1000}s ago. Use ?force=1 to override.`,
      lastSyncAt: state.lastSyncAt,
    });
  }
  if (req.query.wait) {
    const result = await syncDrive();
    return res.json(result);
  }
  syncDrive(); // fire and forget
  res.json({ started: true, message: "Drive scan started. Poll /api/status for progress." });
});

app.get("/api/drive-files", async (req, res) => {
  try {
    res.json({ files: await listDriveFolder() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ask", async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Please enter a prompt." });
  if (state.status === "loading" && state.pages.length === 0)
    return res.status(503).json({ error: "Documents are still being scanned. Please wait…" });
  if (state.status === "error" && state.pages.length === 0)
    return res.status(500).json({ error: `Index unavailable: ${state.error}` });

  // Lazy refresh: if Drive hasn't been checked recently, check it in the
  // background so newly added documents become searchable.
  const sinceSyncMs = state.lastSyncAt ? Date.now() - new Date(state.lastSyncAt) : Infinity;
  if (!state.syncing && sinceSyncMs > AUTO_REFRESH_MS) syncDrive(); // fire and forget

  res.json(buildReply(prompt));
});

// ---------------------------------------------------------------------- Boot

loadManifest();
rebuildPageIndex();
if (state.pages.length > 0) {
  // Serve immediately from the persisted cache; refresh from Drive in background.
  state.status = "ready";
  state.lastSyncAt = null;
  console.log(
    `[boot] Restored ${state.files.length} document(s), ${state.pages.length} page sections from cache.`
  );
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  syncDrive(); // initial sync
  setInterval(syncDrive, AUTO_REFRESH_MS); // periodic re-scan for new documents
});
