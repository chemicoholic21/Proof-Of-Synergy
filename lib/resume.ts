/**
 * Resume / document text extraction for the Technical Interview mode.
 *
 * Strategy (best-effort, cheapest first):
 *   1. Digital PDFs  -> pdf-parse (local, instant, free)
 *   2. Word .docx    -> mammoth   (local)
 *   3. Plain text/md -> read directly
 *   4. Scanned / image-only PDFs and image files (PNG/JPG/…) have NO embedded
 *      text layer, so pdf-parse returns little/nothing. When SARVAM_API_KEY is
 *      set we fall back to Sarvam's Document Digitization (Sarvam Vision OCR),
 *      which reads the text off the pixels across 23 languages.
 *
 * Everything runs server-side (Node runtime); heavy parsers are dynamically
 * imported so they stay out of the client bundle.
 */

import { env, sarvamConfigured } from "./env";
import { logger } from "./logger";

const log = logger.child({ module: "resume" });

export const MAX_RESUME_BYTES = 8 * 1024 * 1024; // 8 MB

/** Below this many non-whitespace characters we consider a PDF "empty" (likely scanned). */
const MIN_MEANINGFUL_CHARS = 40;

/** A user-safe parse error — its message is shown directly to the candidate. */
export class ResumeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeParseError";
  }
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".heic", ".heif"];

function hasMeaningfulText(text: string): boolean {
  return text.replace(/\s+/g, "").length >= MIN_MEANINGFUL_CHARS;
}

/** Strip pdf-parse page separators ("-- 1 of 3 --") and collapse excess blank lines. */
function cleanText(text: string): string {
  return text
    .replace(/\n?-- \d+ of \d+ --\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Crude HTML -> text for OCR output delivered as HTML. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Heuristic: does this buffer look like readable UTF-8 text (vs. a binary blob)? */
function looksLikeText(sample: string): boolean {
  if (!sample) return false;
  let printable = 0;
  const len = Math.min(sample.length, 2000);
  for (let i = 0; i < len; i++) {
    const c = sample.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
  }
  return len > 0 && printable / len > 0.85;
}

async function extractPdf(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return cleanText(result.text ?? "");
  } finally {
    try {
      await parser.destroy();
    } catch {
      /* ignore cleanup errors */
    }
  }
}

async function extractDocx(buf: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: buf });
  return cleanText(result.value ?? "");
}

/** Is this buffer a ZIP archive (PK signature)? Sarvam OCR output is delivered as a ZIP. */
function isZip(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
}

/** Pull text out of the ZIP that Sarvam returns (one .md/.html/.json/.txt file per page). */
async function readTextFromZip(buf: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const parts: string[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const raw = await entry.async("string");
    if (name.endsWith(".html") || name.endsWith(".htm")) {
      parts.push(htmlToText(raw));
    } else if (name.endsWith(".json")) {
      try {
        parts.push(harvestJsonText(JSON.parse(raw)));
      } catch {
        /* skip unparseable json */
      }
    } else if (name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".markdown")) {
      parts.push(raw);
    }
  }
  return cleanText(parts.join("\n\n"));
}

/** Recursively collect human text from Sarvam's JSON output (keys like text/content/markdown). */
function harvestJsonText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(harvestJsonText).join("\n");
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const preferred = ["markdown", "text", "content", "value"];
    for (const key of preferred) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    return Object.values(obj).map(harvestJsonText).join("\n");
  }
  return "";
}

/**
 * OCR a scanned PDF or image via Sarvam Document Digitization (Sarvam Vision).
 * Async job: create -> upload -> start -> poll -> download ZIP -> read text.
 */
async function extractWithSarvamOcr(file: File): Promise<string> {
  const { SarvamAIClient } = await import("sarvamai");
  const client = new SarvamAIClient({ apiSubscriptionKey: env.SARVAM_API_KEY || "" });

  // Bound polling so a stuck job can't exceed the route's time budget: ~45s worst case.
  const job = await client.documentIntelligence.createJob({
    language: "en-IN",
    outputFormat: "md",
    pollingIntervalMs: 1500,
    maxPollingAttempts: 30,
  });

  await job.uploadFile(file);
  await job.start();
  const status = await job.waitUntilComplete();

  if (status.job_state === "Failed") {
    throw new Error(`Sarvam OCR job failed: ${status.error_message ?? "unknown error"}`);
  }

  const links = await job.getDownloadLinks();
  const urls = Object.values(links.download_urls ?? {}).map((d) => d.file_url);
  if (urls.length === 0) throw new Error("Sarvam OCR returned no output files");

  const collected: string[] = [];
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download OCR output (${res.status})`);
    const out = Buffer.from(await res.arrayBuffer());
    collected.push(isZip(out) ? await readTextFromZip(out) : cleanText(out.toString("utf8")));
  }
  const text = cleanText(collected.join("\n\n"));
  log.info("sarvam ocr extracted", { chars: text.length, state: status.job_state });
  return text;
}

/**
 * Extract plain text from an uploaded resume / job-description file. Falls back
 * to Sarvam OCR for scanned PDFs and images when SARVAM_API_KEY is configured.
 * Throws {@link ResumeParseError} with a candidate-facing message on failure.
 */
export async function extractTextFromUpload(file: File): Promise<string> {
  if (file.size === 0) throw new ResumeParseError("The uploaded file is empty.");
  if (file.size > MAX_RESUME_BYTES) {
    throw new ResumeParseError("That file is too large. Please upload a file under 8 MB.");
  }

  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  const isImage = IMAGE_EXTS.some((e) => name.endsWith(e)) || type.startsWith("image/");
  const isPdf = name.endsWith(".pdf") || type === "application/pdf";
  const isDocx =
    name.endsWith(".docx") ||
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const isText = name.endsWith(".txt") || name.endsWith(".md") || type.startsWith("text/");

  // --- Word (.docx): always has a text layer ---
  if (isDocx) {
    try {
      return await extractDocx(buf);
    } catch {
      throw new ResumeParseError("We couldn't read that Word file. Try exporting to PDF, or paste your resume text.");
    }
  }

  // --- Plain text / markdown ---
  if (isText) {
    return cleanText(buf.toString("utf8"));
  }

  // --- Images: no text layer, OCR is the only option ---
  if (isImage) {
    if (!sarvamConfigured()) {
      throw new ResumeParseError(
        "Image resumes need OCR, which isn't configured. Please upload a PDF or Word file, or paste your resume text."
      );
    }
    try {
      const text = await extractWithSarvamOcr(file);
      if (hasMeaningfulText(text)) return text;
      throw new ResumeParseError("We couldn't read any text from that image. Try a clearer scan, or paste your resume text.");
    } catch (e) {
      if (e instanceof ResumeParseError) throw e;
      log.warn("sarvam ocr (image) failed", { error: (e as Error).message });
      throw new ResumeParseError("OCR couldn't read that image. Please try a clearer file, or paste your resume text.");
    }
  }

  // --- PDF: try the local (digital) text layer first, OCR only if it's empty/scanned ---
  if (isPdf) {
    let local = "";
    try {
      local = await extractPdf(buf);
    } catch (e) {
      log.warn("pdf-parse failed, will consider OCR", { error: (e as Error).message });
    }
    if (hasMeaningfulText(local)) return local;

    if (sarvamConfigured()) {
      try {
        const text = await extractWithSarvamOcr(file);
        if (hasMeaningfulText(text)) return text;
      } catch (e) {
        log.warn("sarvam ocr (pdf) failed", { error: (e as Error).message });
      }
    }
    if (hasMeaningfulText(local)) return local;
    throw new ResumeParseError(
      sarvamConfigured()
        ? "We couldn't read text from this PDF, even with OCR. Try a clearer export, or paste your resume text."
        : "This PDF looks scanned/image-only and OCR isn't configured. Upload a text-based PDF or Word file, or paste your resume text."
    );
  }

  // --- Legacy .doc ---
  if (name.endsWith(".doc") || type === "application/msword") {
    throw new ResumeParseError(
      "Legacy .doc files aren't supported. Please upload a PDF or .docx, or paste your resume text."
    );
  }

  // --- Unknown type: accept if it's actually readable text ---
  const asText = buf.toString("utf8");
  if (looksLikeText(asText)) return cleanText(asText);

  throw new ResumeParseError(
    "Unsupported file type. Please upload a PDF, Word (.docx), image, or plain-text file — or paste your resume text."
  );
}
