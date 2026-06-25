const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");
const { isPdfFileSync } = require("./pdf-validate");

const PREVIEW_MAX_CHARS = 320;

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

async function getPdfOverview(filePath) {
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

async function listUploadFiles(uploadsDir) {
  if (!fs.existsSync(uploadsDir)) {
    return [];
  }

  const names = fs
    .readdirSync(uploadsDir)
    .filter((name) => name.endsWith(".pdf"))
    .sort((a, b) => {
      const aStat = fs.statSync(path.join(uploadsDir, a));
      const bStat = fs.statSync(path.join(uploadsDir, b));
      return bStat.mtimeMs - aStat.mtimeMs;
    });

  const files = [];

  for (const name of names) {
    const filePath = path.join(uploadsDir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || !isPdfFileSync(filePath)) continue;

    const overview = await getPdfOverview(filePath);
    files.push({
      name,
      size: stat.size,
      sizeLabel: formatBytes(stat.size),
      modified: stat.mtime.toISOString(),
      pages: overview.pages,
      content: overview.content,
      preview: overview.preview,
      viewUrl: "/view/" + encodeURIComponent(name),
      downloadUrl: "/download/" + encodeURIComponent(name),
    });
  }

  return files;
}

function safePdfFilename(filename) {
  const base = path.basename(filename);
  if (!base.endsWith(".pdf") || base.includes("..")) return null;
  return base;
}

module.exports = { listUploadFiles, safePdfFilename, formatBytes };
