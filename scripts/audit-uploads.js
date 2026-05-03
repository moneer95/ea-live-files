#!/usr/bin/env node
/**
 * Lists files in uploads/ that are not valid PDFs (e.g. HTML/XSS payloads with a .pdf name).
 * Usage: node scripts/audit-uploads.js [--delete]
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { classifyUploadSync } = require(path.join(__dirname, "..", "pdf-validate"));

const uploadsDir = path.join(__dirname, "..", "uploads");
const deleteBad = process.argv.includes("--delete");

if (!fs.existsSync(uploadsDir)) {
  console.error("No uploads directory:", uploadsDir);
  process.exit(1);
}

const names = fs.readdirSync(uploadsDir);
const suspicious = [];

for (const name of names) {
  const fp = path.join(uploadsDir, name);
  let st;
  try {
    st = fs.statSync(fp);
  } catch {
    continue;
  }
  if (!st.isFile()) continue;

  const kind = classifyUploadSync(fp);
  if (kind !== "pdf") {
    suspicious.push({ name, kind, fp });
    console.log(`${kind}\t${name}`);
  }
}

if (suspicious.length === 0) {
  console.log("OK: all files look like PDFs.");
  process.exit(0);
}

console.error(`\nFound ${suspicious.length} suspicious file(s).`);

if (deleteBad) {
  for (const { fp, name } of suspicious) {
    try {
      fs.unlinkSync(fp);
      console.error("deleted:", name);
    } catch (e) {
      console.error("could not delete:", name, e.message);
    }
  }
} else {
  console.error("Run with --delete to remove them (use only if you trust this list).");
}

process.exit(1);
