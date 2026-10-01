import test from "node:test";
import assert from "node:assert/strict";
import { pdfText } from "../dist/document-pdf.js";
import { pdfEncoding, pdfGlyphText } from "../dist/pdf-font-encodings.js";

function document(encoding, content = "(AB\\200)", extra = "") {
  const stream = `BT /F1 12 Tf 72 720 Td ${content} Tj ET`;
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj
4 0 obj << /Length ${Buffer.byteLength(stream, "latin1")} >> stream
${stream}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${encoding} >> endobj
${extra}
trailer << /Root 1 0 R >>
%%EOF
`, "latin1");
}

test("simple-font named byte encoding and indirect Differences decode retained text", () => {
  assert.equal(pdfText(document("/WinAnsiEncoding")).pages[0].text, "AB€");
  const read = pdfText(document("<< /BaseEncoding /WinAnsiEncoding /Differences [65 6 0 R /germandbls] >>", undefined, "6 0 obj /eacute endobj"));
  assert.equal(read.pages[0].text, "éß€");
});

test("Differences out-of-byte indices and recursive indirect entries remain bounded and reported", () => {
  const outside = pdfText(document("<< /BaseEncoding /WinAnsiEncoding /Differences [256 /eacute] >>"));
  assert.equal(outside.pages[0].text, "AB€");
  assert.ok(outside.limits.some(line => /outside its byte range/.test(line)));
  const recursive = pdfText(document("<< /BaseEncoding /WinAnsiEncoding /Differences [65 6 0 R] >>", undefined, "6 0 obj 6 0 R endobj"));
  assert.equal(recursive.pages[0].text, "AB€");
  assert.ok(recursive.limits.some(line => /invalid indirect Differences/.test(line)));
});

test("glyph scalar recovery rejects surrogates and values beyond Unicode", () => {
  assert.equal(pdfGlyphText("uniD800"), null);
  assert.equal(pdfGlyphText("u110000"), null);
  assert.equal(pdfGlyphText("u1F600"), "😀");
  assert.equal(pdfGlyphText("eacute.alt"), "é");
  assert.equal(pdfEncoding("UnknownEncoding"), undefined);
  assert.equal(pdfEncoding("WinAnsiEncoding").length, 256);
});

test("indirect named encoding preserves PDF object whitespace and decodes its byte table", () => {
  const indirect = pdfText(document("6 0 R", "(\\200)", "6 0 obj\r\n /WinAnsiEncoding \r\n endobj"));
  assert.equal(indirect.pages[0].text, "\u20ac");
  assert.deepEqual(indirect.limits, pdfText(document("/WinAnsiEncoding", "(\\200)")).limits);
});
