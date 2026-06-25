require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cookieSession = require("cookie-session");
const { isPdfFileSync } = require("./pdf-validate");
const {
  listUploadFilesPaginated,
  warmSearchIndex,
  queueSearchIndexRefresh,
  getSearchIndexStatus,
  safePdfFilename,
  DEFAULT_PAGE_SIZE,
} = require("./uploads-list");

const UPLOADS_DIR = path.join(__dirname, "uploads");

const app = express();

if (process.env.TRUST_PROXY === "1" || process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || "dev";

if (!process.env.UPLOAD_PASSWORD) {
  console.warn("UPLOAD_PASSWORD not set; using default \"dev\" (set env in production).");
}
if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET not set; using insecure default (set env in production).");
}

app.use(
  cookieSession({
    name: "upload_session",
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  })
);

app.use(express.urlencoded({ extended: true }));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
});

function safeNext(n) {
  if (typeof n !== "string" || !n.startsWith("/") || n.startsWith("//")) return "/";
  return n;
}

function getBaseUrl(req) {
  const fromEnv = process.env.PUBLIC_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  const forwardedProto = req.get("x-forwarded-proto");
  const protocol =
    forwardedProto ||
    (req.secure ? "https" : "http");
  return protocol + "://" + req.get("host");
}

function requireUploadAuth(req, res, next) {
  if (req.session && req.session.uploadAuth === true) return next();
  const nextUrl =
    req.method === "POST" && req.path === "/upload" ? "/" : req.originalUrl.split("?")[0] || "/";
  if (req.accepts("html")) {
    return res.redirect(303, "/login?next=" + encodeURIComponent(safeNext(nextUrl)));
  }
  res.status(401).send("Unauthorized");
}

// 10-minute timeout
app.use((req, res, next) => {
  res.setTimeout(600000, () => {
    res.status(408).send("Request Timeout");
  });
  next();
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  const password = req.body.password;
  const nextRaw = req.body.next;
  if (password === UPLOAD_PASSWORD) {
    req.session.uploadAuth = true;
    return res.redirect(303, safeNext(nextRaw));
  }
  res.redirect(
    303,
    "/login?error=1&next=" + encodeURIComponent(safeNext(nextRaw))
  );
});

app.get("/", requireUploadAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/dashboard", requireUploadAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/api/files/index-status", requireUploadAuth, (req, res) => {
  res.json(getSearchIndexStatus());
});

app.get("/api/files", requireUploadAuth, async (req, res) => {
  try {
    const result = await listUploadFilesPaginated(UPLOADS_DIR, {
      page: req.query.page,
      pageSize: req.query.limit || req.query.pageSize || DEFAULT_PAGE_SIZE,
      query: req.query.q || req.query.query || "",
      baseUrl: getBaseUrl(req),
    });
    res.json(result);
  } catch (err) {
    console.error("Failed to list uploads:", err);
    res.status(500).json({ error: "Failed to list files." });
  }
});

app.get("/download/:filename", (req, res) => {
  const filename = safePdfFilename(req.params.filename);
  if (!filename) {
    return res.status(400).type("text/plain").send("Invalid filename.");
  }

  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath) || !isPdfFileSync(filePath)) {
    return res.status(404).type("text/plain").send("File not found.");
  }

  res.download(filePath, filename);
});

app.use(express.static("public", { index: false }));
app.use("/uploads", express.static("uploads"));

// Serve PDF.js from the "public" folder (it should be inside "public/pdfjs")
app.use("/pdfjs", express.static(path.join(__dirname, "public/pdfjs")));

// Handle file uploads
app.post("/upload", requireUploadAuth, upload.single("pdf"), (req, res) => {
  if (!req.file) {
    return res.status(400).type("text/plain").send("No file uploaded.");
  }

  const oldPath = req.file.path;
  if (!isPdfFileSync(oldPath)) {
    try {
      fs.unlinkSync(oldPath);
    } catch (_) {
      /* ignore */
    }
    return res.status(400).type("text/plain").send("Upload rejected: not a valid PDF file.");
  }

  const newPath = path.join(UPLOADS_DIR, req.file.filename + ".pdf");
  fs.renameSync(oldPath, newPath);
  queueSearchIndexRefresh(UPLOADS_DIR);

  // Direct URL to the uploaded PDF
  const fileUrl = `https://${req.get("host")}/uploads/${req.file.filename}.pdf`;

  // PDF.js viewer URL
  const viewerUrl =
    `https://${req.get("host")}/pdfjs/web/viewer.html?file=${encodeURIComponent(fileUrl)}#toolbar=0&download=false&print=false`;

  // The fullscreen wrapper structure you want teachers to embed in Moodle
  const iframeHtml = `
<div class="iframe-fullscreen-container" style="position: relative; max-width: 100%; height: 600px;">

  <!-- Full screen button -->
  <button type="button"
          class="iframe-fullscreen-btn"
          style="position:absolute; top:10px; right:10px; z-index:9999;
                 padding:6px 12px; background:#007bff; color:#fff;
                 border:none; border-radius:4px; cursor:pointer;">
    Full Screen
  </button>

  <!-- iframe -->
  <iframe
      class="iframe-fullscreen-frame"
      src="${viewerUrl}"
      style="border:0; width:100%; height:100%;"
      allowfullscreen
      allow="fullscreen">
  </iframe>

</div>`.trim();

  // Escape it so it shows as text in HTML
  const escapedIframeHtml = iframeHtml
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Embed code</title>
      </head>
      <body style="font-family: sans-serif; padding: 20px;">
        <h2>✅ Uploaded! Copy this embed code:</h2>

        <p>Paste this inside the Moodle HTML editor:</p>

        <textarea id="embedCode"
                  rows="14"
                  cols="100"
                  readonly
                  style="width:100%; max-width:100%; font-family:monospace; padding:10px;">
${escapedIframeHtml}
        </textarea>

        <br><br>
        <button id="copyBtn"
                style="padding: 8px 16px; cursor:pointer;">
          Copy to clipboard
        </button>

        <script>
          document.getElementById("copyBtn").addEventListener("click", function () {
            var textarea = document.getElementById("embedCode");
            textarea.focus();
            textarea.select();
            document.execCommand("copy");
            alert("Embed code copied to clipboard!");
          });
        </script>
      </body>
    </html>
  `);
});

// Handle the file view using PDF.js
app.get("/view/:filename", (req, res) => {
  const fileUrl = `https://${req.get("host")}/uploads/${req.params.filename}`;

  // Embed PDF.js viewer and pass the file URL as a query parameter
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          html, body { margin:0; height:100%; overflow:hidden; }
          iframe { border:0; width:100%; height:100%; }
        </style>
      </head>
      <body>
        <iframe
          src="/pdfjs/web/viewer.html?file=${encodeURIComponent(fileUrl)}#toolbar=0&download=false&print=false">
        </iframe>
      </body>
    </html>
  `);
});

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).type("text/plain").send("File too large.");
  }
  next(err);
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on http://${HOST}:${PORT}`);
  warmSearchIndex(UPLOADS_DIR).catch((err) => {
    console.error("Failed to build initial PDF search index:", err);
  });
});
