const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");
const { isPdfFileSync } = require("./pdf-validate");

const PREVIEW_MAX_CHARS = 320;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const INDEX_CONCURRENCY = 4;

const memoryCache = new Map();
const searchIndexState = {
  entries: [],
  ready: false,
  indexing: false,
  done: 0,
  total: 0,
};

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function parsePaginationOptions(options = {}) {
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(options.pageSize, 10) || DEFAULT_PAGE_SIZE)
  );
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
  return { page, pageSize, query };
}

function getCacheDir(uploadsDir) {
  return path.join(uploadsDir, ".text-cache");
}

function getIndexPath(uploadsDir) {
  return path.join(getCacheDir(uploadsDir), "search-index.json");
}

function getEntryCachePath(uploadsDir, name) {
  return path.join(getCacheDir(uploadsDir), name + ".json");
}

function ensureCacheDir(uploadsDir) {
  const cacheDir = getCacheDir(uploadsDir);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

function getUploadEntries(uploadsDir) {
  if (!fs.existsSync(uploadsDir)) {
    return [];
  }

  const entries = [];

  for (const name of fs.readdirSync(uploadsDir)) {
    if (!name.endsWith(".pdf")) continue;

    const filePath = path.join(uploadsDir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || !isPdfFileSync(filePath)) continue;

    entries.push({
      name,
      filePath,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
    });
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

function readEntryCache(uploadsDir, entry) {
  const cacheKey = entry.name + ":" + entry.mtimeMs;
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey);
  }

  const cachePath = getEntryCachePath(uploadsDir, entry.name);
  if (!fs.existsSync(cachePath)) return null;

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (cached.mtimeMs !== entry.mtimeMs) return null;
    memoryCache.set(cacheKey, cached);
    return cached;
  } catch {
    return null;
  }
}

function writeEntryCache(uploadsDir, entry, overview) {
  ensureCacheDir(uploadsDir);
  const cacheKey = entry.name + ":" + entry.mtimeMs;
  const payload = {
    name: entry.name,
    mtimeMs: entry.mtimeMs,
    pages: overview.pages,
    content: overview.content,
    preview: overview.preview,
  };
  memoryCache.set(cacheKey, payload);
  fs.writeFileSync(getEntryCachePath(uploadsDir, entry.name), JSON.stringify(payload));
  return payload;
}

async function parsePdfOverview(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const result = await pdf(buffer);
    const content = normalizeText(result.text || "");
    return {
      pages: result.numpages || null,
      content,
      preview: content.slice(0, PREVIEW_MAX_CHARS) || "(No extractable text in this PDF)",
    };
  } catch {
    return {
      pages: null,
      content: "",
      preview: "(Could not read PDF content preview)",
    };
  }
}

async function getPdfOverview(uploadsDir, entry) {
  const cached = readEntryCache(uploadsDir, entry);
  if (cached) {
    return {
      pages: cached.pages,
      content: cached.content || "",
      preview: cached.preview,
    };
  }

  const overview = await parsePdfOverview(entry.filePath);
  writeEntryCache(uploadsDir, entry, overview);
  return overview;
}

function buildFileUrls(baseUrl, name) {
  const fileUrl = baseUrl + "/uploads/" + name;
  return {
    viewUrl: baseUrl + "/pdfjs/web/viewer.html?file=" + encodeURIComponent(fileUrl),
    downloadUrl: baseUrl + "/download/" + encodeURIComponent(name),
  };
}

function toFileRecord(entry, overview, baseUrl) {
  return {
    name: entry.name,
    size: entry.size,
    sizeLabel: formatBytes(entry.size),
    modified: entry.modified,
    pages: overview.pages,
    preview: overview.preview,
    ...buildFileUrls(baseUrl, entry.name),
  };
}

function toIndexRecord(entry, overview) {
  return {
    name: entry.name,
    size: entry.size,
    sizeLabel: formatBytes(entry.size),
    modified: entry.modified,
    mtimeMs: entry.mtimeMs,
    pages: overview.pages,
    preview: overview.preview,
    content: overview.content || "",
  };
}

function withFileUrls(record, baseUrl) {
  const { content, mtimeMs, ...file } = record;
  return {
    ...file,
    ...buildFileUrls(baseUrl, record.name),
  };
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

function loadSearchIndexFromDisk(uploadsDir) {
  const indexPath = getIndexPath(uploadsDir);
  if (!fs.existsSync(indexPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (!Array.isArray(parsed.entries)) return null;
    return parsed.entries;
  } catch {
    return null;
  }
}

function saveSearchIndexToDisk(uploadsDir, entries) {
  ensureCacheDir(uploadsDir);
  fs.writeFileSync(
    getIndexPath(uploadsDir),
    JSON.stringify({ updatedAt: new Date().toISOString(), entries })
  );
}

function isIndexFresh(entries, indexedEntries) {
  if (entries.length !== indexedEntries.length) return false;
  const indexedByName = new Map(indexedEntries.map((entry) => [entry.name, entry.mtimeMs]));
  return entries.every((entry) => indexedByName.get(entry.name) === entry.mtimeMs);
}

async function buildSearchIndex(uploadsDir) {
  const entries = getUploadEntries(uploadsDir);
  searchIndexState.total = entries.length;
  searchIndexState.done = 0;

  if (!entries.length) {
    searchIndexState.entries = [];
    searchIndexState.ready = true;
    saveSearchIndexToDisk(uploadsDir, []);
    return;
  }

  const indexed = await mapPool(entries, INDEX_CONCURRENCY, async (entry) => {
    const overview = await getPdfOverview(uploadsDir, entry);
    searchIndexState.done += 1;
    return toIndexRecord(entry, overview);
  });

  searchIndexState.entries = indexed;
  searchIndexState.ready = true;
  saveSearchIndexToDisk(uploadsDir, indexed);
}

async function warmSearchIndex(uploadsDir) {
  if (searchIndexState.indexing) return;

  searchIndexState.indexing = true;
  searchIndexState.ready = false;

  try {
    const entries = getUploadEntries(uploadsDir);
    searchIndexState.total = entries.length;
    searchIndexState.done = 0;

    const diskIndex = loadSearchIndexFromDisk(uploadsDir);
    if (diskIndex && isIndexFresh(entries, diskIndex)) {
      searchIndexState.entries = diskIndex;
      searchIndexState.done = entries.length;
      searchIndexState.ready = true;
      return;
    }

    await buildSearchIndex(uploadsDir);
  } catch (err) {
    console.error("Failed to warm PDF search index:", err);
  } finally {
    searchIndexState.indexing = false;
  }
}

function queueSearchIndexRefresh(uploadsDir) {
  setImmediate(() => {
    warmSearchIndex(uploadsDir).catch((err) => {
      console.error("Failed to refresh PDF search index:", err);
    });
  });
}

function getSearchIndexStatus() {
  return {
    ready: searchIndexState.ready,
    indexing: searchIndexState.indexing,
    done: searchIndexState.done,
    total: searchIndexState.total,
  };
}

function paginateRecords(records, page, pageSize, baseUrl) {
  const total = records.length;
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  const safePage = totalPages ? Math.min(page, totalPages) : 1;
  const start = (safePage - 1) * pageSize;

  return {
    files: records.slice(start, start + pageSize).map((record) => withFileUrls(record, baseUrl)),
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
    },
  };
}

function matchesFilename(entry, query) {
  return entry.name.toLowerCase().includes(query);
}

function matchesIndexedRecord(record, query) {
  if (record.name.toLowerCase().includes(query)) return true;
  return (record.content || "").toLowerCase().includes(query);
}

async function listUploadFilesPaginated(uploadsDir, options = {}) {
  const { page, pageSize, query } = parsePaginationOptions(options);
  const baseUrl = options.baseUrl || "";
  const entries = getUploadEntries(uploadsDir);

  if (!entries.length) {
    return {
      files: [],
      pagination: { page: 1, pageSize, total: 0, totalPages: 0 },
      indexing: false,
    };
  }

  if (!query) {
    const total = entries.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);
    const files = await Promise.all(
      slice.map(async (entry) =>
        toFileRecord(entry, await getPdfOverview(uploadsDir, entry), baseUrl)
      )
    );

    return {
      files,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
      },
      indexing: searchIndexState.indexing,
      index: getSearchIndexStatus(),
    };
  }

  const filenameMatches = entries.filter((entry) => matchesFilename(entry, query));

  if (!searchIndexState.ready) {
    const quickMatches = await Promise.all(
      filenameMatches.map(async (entry) =>
        toIndexRecord(entry, await getPdfOverview(uploadsDir, entry))
      )
    );

    return {
      ...paginateRecords(quickMatches, page, pageSize, baseUrl),
      indexing: true,
      index: getSearchIndexStatus(),
      partial: true,
    };
  }

  const indexedMatches = searchIndexState.entries.filter((record) =>
    matchesIndexedRecord(record, query)
  );

  const merged = new Map();
  for (const record of indexedMatches) {
    merged.set(record.name, record);
  }
  for (const entry of filenameMatches) {
    if (!merged.has(entry.name)) {
      merged.set(
        entry.name,
        toIndexRecord(entry, await getPdfOverview(uploadsDir, entry))
      );
    }
  }

  const orderedMatches = entries
    .map((entry) => merged.get(entry.name))
    .filter(Boolean);

  return {
    ...paginateRecords(orderedMatches, page, pageSize, baseUrl),
    indexing: searchIndexState.indexing,
    index: getSearchIndexStatus(),
    partial: false,
  };
}

function safePdfFilename(filename) {
  const base = path.basename(filename);
  if (!base.endsWith(".pdf") || base.includes("..")) return null;
  return base;
}

module.exports = {
  listUploadFilesPaginated,
  warmSearchIndex,
  queueSearchIndexRefresh,
  getSearchIndexStatus,
  safePdfFilename,
  formatBytes,
  buildFileUrls,
  DEFAULT_PAGE_SIZE,
};
