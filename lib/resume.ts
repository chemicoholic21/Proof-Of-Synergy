/**
 * Resume / document text extraction for the Technical Interview mode.
 *
 * Accepts an uploaded file (PDF, Word .docx, or plain text/markdown) and returns
 * the plain text so the interviewer model can read the candidate's real experience
 * and projects. Extraction runs server-side (Node runtime) — pdf-parse and mammoth
 * are dynamically imported so they stay out of the client bundle.
 */

export const MAX_RESUME_BYTES = 8 * 1024 * 1024; // 8 MB

/** A user-safe parse error — its message is shown directly to the candidate. */
export class ResumeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeParseError";
  }
}

/** Strip pdf-parse page separators ("-- 1 of 3 --") and collapse excess blank lines. */
function cleanPdfText(text: string): string {
  return text
    .replace(/\n?-- \d+ of \d+ --\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Heuristic: does this buffer look like readable UTF-8 text (vs. a binary blob)? */
function looksLikeText(sample: string): boolean {
  if (!sample) return false;
  let printable = 0;
  const len = Math.min(sample.length, 2000);
  for (let i = 0; i < len; i++) {
    const c = sample.charCodeAt(i);
    // printable ASCII, common whitespace, or extended/unicode
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
  }
  return len > 0 && printable / len > 0.85;
}

async function extractPdf(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return cleanPdfText(result.text ?? "");
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
  return (result.value ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Extract plain text from an uploaded resume / job-description file.
 * Throws {@link ResumeParseError} with a candidate-facing message on unsupported
 * or unreadable input.
 */
export async function extractTextFromUpload(file: File): Promise<string> {
  if (file.size === 0) throw new ResumeParseError("The uploaded file is empty.");
  if (file.size > MAX_RESUME_BYTES) {
    throw new ResumeParseError("That file is too large. Please upload a file under 8 MB.");
  }

  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    if (name.endsWith(".pdf") || type === "application/pdf") {
      return await extractPdf(buf);
    }
    if (
      name.endsWith(".docx") ||
      type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      return await extractDocx(buf);
    }
    if (name.endsWith(".txt") || name.endsWith(".md") || type.startsWith("text/")) {
      return buf.toString("utf8").replace(/\n{3,}/g, "\n\n").trim();
    }
    if (name.endsWith(".doc") || type === "application/msword") {
      throw new ResumeParseError(
        "Legacy .doc files aren't supported. Please upload a PDF or .docx, or paste your resume text."
      );
    }
    // Unknown extension — accept it only if the bytes are actually readable text.
    const asText = buf.toString("utf8");
    if (looksLikeText(asText)) return asText.replace(/\n{3,}/g, "\n\n").trim();
    throw new ResumeParseError(
      "Unsupported file type. Please upload a PDF, Word (.docx), or plain-text file — or paste your resume text."
    );
  } catch (e) {
    if (e instanceof ResumeParseError) throw e;
    throw new ResumeParseError(
      "We couldn't read that file. It may be scanned/image-only or corrupted — try a different export, or paste your resume text."
    );
  }
}
