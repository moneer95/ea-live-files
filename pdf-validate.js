const fs = require("fs");

/** Bytes from start of file to search for a PDF header (comment lines may precede %PDF-) */
const HEADER_WINDOW = 1024;

const PDF_MARK = Buffer.from("%PDF-", "latin1");

function isPdfFileSync(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(HEADER_WINDOW);
    const n = fs.readSync(fd, buf, 0, HEADER_WINDOW, 0);
    if (n < 5) return false;
    return buf.subarray(0, n).indexOf(PDF_MARK) !== -1;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * For auditing existing files: pdf, empty, html-like (common XSS upload), or non-pdf.
 */
function classifyUploadSync(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "other";
  if (st.size === 0) return "empty";
  if (isPdfFileSync(filePath)) return "pdf";

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(Math.min(8192, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8").trimStart();
    if (/^<!DOCTYPE\s+html/i.test(text) || /^<html[\s>]/i.test(text)) return "html-like";
    if (/<script[\s>]/i.test(text)) return "html-like";
    return "non-pdf";
  } catch {
    return "non-pdf";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { isPdfFileSync, classifyUploadSync };
