const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const upload = multer({ dest: path.join(__dirname, "uploads") });

app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// Serve PDF.js from the "public" folder (it should be inside "public/pdfjs")
app.use("/pdfjs", express.static(path.join(__dirname, "public/pdfjs")));

// 10-minute timeout
app.use((req, res, next) => {
  res.setTimeout(600000, () => { // 10-minute timeout
    res.status(408).send('Request Timeout');
  });
  next();
});

// Handle file uploads
app.post("/upload", upload.single("pdf"), (req, res) => {
  const oldPath = req.file.path;
  const newPath = path.join(__dirname, "uploads", req.file.filename + ".pdf");
  fs.renameSync(oldPath, newPath);

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

app.listen(3000, () => console.log("✅ Server running at http://localhost:3000"));