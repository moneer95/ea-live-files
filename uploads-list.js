const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");
const { isPdfFileSync } = require("./pdf-validate");

const PREVIEW_MAX_CHARS = 320;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

const textCache = new Map();

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

async function getPdfOverview(filePath, cacheKey) {
  if (cacheKey && textCache.has(cacheKey)) {
    return textCache.get(cacheKey);
  }

  let overview;
  try {
    const buffer = fs.readFileSync(filePath);
    const result = await pdf(buffer);
    const content = normalizeText(result.text || "");
    overview = {
      pages: result.numpages || null,
      content,
      preview: content.slice(0, PREVIEW_MAX_CHARS) || "(No extractable text in this PDF)",
    };
  } catch {
    overview = {
      pages: null,
      content: "",
      preview: "(Could not read PDF content preview)",
    };
  }

  if (cacheKey) {
    textCache.set(cacheKey, overview);
  }

  return overview;
}

function toFileRecord(entry, overview) {
  return {
    name: entry.name,
    size: entry.size,
    sizeLabel: formatBytes(entry.size),
    modified: entry.modified,
    pages: overview.pages,
    preview: overview.preview,
    viewUrl: "/view/" + encodeURIComponent(entry.name),
    downloadUrl: "/download/" + encodeURIComponent(entry.name),
  };
}

async function buildFileRecord(entry) {
  const cacheKey = entry.name + ":" + entry.mtimeMs;
  const overview = await getPdfOverview(entry.filePath, cacheKey);
  return toFileRecord(entry, overview);
}

function matchesQuery(entry, overview, query) {
  if (!query) return true;
  if (entry.name.toLowerCase().includes(query)) return true;
  return (overview.content || "").toLowerCase().includes(query);
}

async function listUploadFilesPaginated(uploadsDir, options = {}) {
  const { page, pageSize, query } = parsePaginationOptions(options);
  const entries = getUploadEntries(uploadsDir);

  if (!entries.length) {
    return {
      files: [],
      pagination: { page: 1, pageSize, total: 0, totalPages: 0 },
    };
  }

  if (!query) {
    const total = entries.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);
    const files = await Promise.all(slice.map((entry) => buildFileRecord(entry)));

    return {
      files,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  const matches = [];
  for (const entry of entries) {
    const cacheKey = entry.name + ":" + entry.mtimeMs;
    const overview = await getPdfOverview(entry.filePath, cacheKey);
    if (matchesQuery(entry, overview, query)) {
      matches.push(toFileRecord(entry, overview));
    }
  }

  const total = matches.length;
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  const safePage = totalPages ? Math.min(page, totalPages) : 1;
  const start = (safePage - 1) * pageSize;

  return {
    files: matches.slice(start, start + pageSize),
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
    },
  };
}

function safePdfFilename(filename) {
  const base = path.basename(filename);
  if (!base.endsWith(".pdf") || base.includes("..")) return null;
  return base;
}

module.exports = {
  listUploadFilesPaginated,
  safePdfFilename,
  formatBytes,
  DEFAULT_PAGE_SIZE,
};
