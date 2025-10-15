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

  // Construct the URL for the uploaded PDF
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}.pdf`;

  // Embed link with your specified iframe format
  const embedLink = `
        https://pdf.ea-dental.com/pdfjs/web/viewer.html?file=${encodeURIComponent(fileUrl)}#zoom=page-fit>
  `;


  res.send(`<p>✅ Uploaded! Embed link:</p>
  <code>&lt;iframe src="https://${req.get("host")}/pdfjs/web/viewer.html?file=${embedLink}" width="100%" height="600"&gt;&lt;/iframe&gt;</code>`);
});

// Handle the file view using PDF.js
app.get("/view/:filename", (req, res) => {
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.params.filename}`;

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
          src="/pdfjs/web/viewer.html?file=${encodeURIComponent(fileUrl)}#toolbar=0&download=false&print=false"
        ></iframe>
      </body>
    </html>
  `);
});

app.listen(3000, () => console.log("✅ Server running at http://localhost:3000"));
