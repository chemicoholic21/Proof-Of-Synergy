import { describe, it, expect } from "vitest";
import { extractTextFromUpload, ResumeParseError } from "./resume";

// Minimal fixtures (base64) exercised end-to-end through the real parsers.
// SARVAM_API_KEY is unset in the test env, so OCR is NOT configured — the scanned
// PDF / image branches must surface the OCR-aware ResumeParseError instead of
// silently returning garbage.
const DIGITAL_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxMjQgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKEpvaG4gRG9lIC0gU2VuaW9yIEJhY2tlbmQgRW5naW5lZXIpIFRqIDAgLTI0IFRkIChCdWlsdCBhIHBheW1lbnRzIHBsYXRmb3JtIGluIEdvIGFuZCBQb3N0Z3JlcykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDA0MTYgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0ODYKJSVFT0Y=";
const SCANNED_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAwID4+CnN0cmVhbQoKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyMDIgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA1IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgoyNTEKJSVFT0Y=";
const DOCX_B64 =
  "UEsDBBQAAAAIAGNO/VzJTxqw6wAAAK4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QvU7DMBDeeQrLK4odGBBCSTrwMwJDeYCTfUks7LPlc0v79jht6YAK4933q69b7YIXW8zsIvXyRrVSIJloHU29/Fi/NPdScAGy4CNhL/fIcjVcdet9QhZVTNzLuZT0oDWbGQOwigmpImPMAUo986QTmE+YUN+27Z02kQpSacriIYfuCUfY+CKed/V9LJLRsxSPR+KS1UtIyTsDpeJ6S/ZXSnNKUFV54PDsEl9XgtQXExbk74CT7q0uk51F8Q65vEKoLP0Vs9U2mk2oSvW/zYWecRydwbN+cUs5GmSukwevzkgARz/99WHu4RtQSwMEFAAAAAgAY079XLmBRHGwAAAAKgEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4J1TRN5pWgaEUJMuCKkrKgeIEjeNaB5KwqO3JwMDIAZG278/y233sDO5YUzGOwZNVQNBJ70yTjM4D8f1DkjKwikxe4cMFkzQ8VV7wlnkspMmExIpiEsMppzDntIkJ7QiVT6gK5PRRytyKaOmQciL0Eg3db2l8d0A/mGSXjGIvWqADEvAf2w/jkbiwcurRZd/nPhKFFlEjZnB3UdF1atdFRYob+nHi/wJUEsDBBQAAAAIAGNO/VxcJpPt1AAAADYBAAARAAAAd29yZC9kb2N1bWVudC54bWxtj0tqxDAMQPc9hfB+4rQMpYQkA4XOYpb9HMBjq4khlo2lNM3taxdKoXTzhJD0JPWnz7DAB2b2kQZ127QKkGx0nqZBvb2eDw8KWAw5s0TCQe3I6jTe9Fvnol0DkkAxEHfboGaR1GnNdsZguIkJqdTeYw5GSponvcXsUo4WmcuCsOi7tr3XwXhSY1Feo9trTBW5QsaLIYSX4GWGA5xzJEFy8ESTJ8Tc69pTmb+Z/o4/rn4RMPCMxgo4ZD8R8M6CAVZGB9cdji0ImsDNPzb9c5X+/Xj8AlBLAQIUAxQAAAAIAGNO/VzJTxqw6wAAAK4BAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAY079XLmBRHGwAAAAKgEAAAsAAAAAAAAAAAAAAIABHAEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAY079XFwmk+3UAAAANgEAABEAAAAAAAAAAAAAAIAB9QEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAPgCAAAAAA==";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";

function fileFrom(b64: string, name: string, type: string): File {
  return new File([Buffer.from(b64, "base64")], name, { type });
}

describe("extractTextFromUpload", () => {
  it("reads a digital (text-layer) PDF via pdf-parse", async () => {
    const text = await extractTextFromUpload(fileFrom(DIGITAL_PDF_B64, "resume.pdf", "application/pdf"));
    expect(text).toMatch(/payments platform in Go/);
    expect(text).not.toMatch(/-- 1 of 1 --/); // page markers stripped
  });

  it("reads a .docx via mammoth", async () => {
    const type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const text = await extractTextFromUpload(fileFrom(DOCX_B64, "resume.docx", type));
    expect(text).toMatch(/React design system/);
  });

  it("reads plain text directly", async () => {
    const body = "Alex Kumar\nML Engineer with 6 years building recommendation systems.";
    const text = await extractTextFromUpload(new File([body], "resume.txt", { type: "text/plain" }));
    expect(text).toMatch(/recommendation systems/);
  });

  it("rejects a scanned/image-only PDF with an OCR-aware message when OCR is unconfigured", async () => {
    await expect(
      extractTextFromUpload(fileFrom(SCANNED_PDF_B64, "scan.pdf", "application/pdf"))
    ).rejects.toMatchObject({ name: "ResumeParseError", message: expect.stringMatching(/scanned\/image-only|OCR/i) });
  });

  it("rejects an image resume with an OCR-aware message when OCR is unconfigured", async () => {
    await expect(
      extractTextFromUpload(fileFrom(PNG_B64, "resume.png", "image/png"))
    ).rejects.toMatchObject({ name: "ResumeParseError", message: expect.stringMatching(/OCR/i) });
  });

  it("rejects an empty file", async () => {
    await expect(extractTextFromUpload(new File([], "empty.pdf", { type: "application/pdf" }))).rejects.toBeInstanceOf(
      ResumeParseError
    );
  });
});
