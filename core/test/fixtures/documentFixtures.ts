/** Minimal, hand-built PDF/DOCX fixtures for M36 pass-2 document-extraction
 * tests — no external test-fixture files, no network fetch, deterministic. */
import JSZip from 'jszip';

/** A minimal, byte-exact single-page PDF containing the literal text
 * "Hello World" in a Helvetica content stream. xref offsets are computed
 * exactly rather than relying on pdfjs-dist's xref-recovery fallback, so
 * this exercises the ordinary (non-recovery) parse path. */
export function buildMinimalPdf(text = 'Hello World'): Buffer {
  const escaped = text.replace(/([()\\])/g, '\\$1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // 10pt, not 24pt: pdfjs-dist's text-content extraction clips a run once
  // its cumulative advance would run past the page's visible MediaBox width
  // (confirmed empirically — unrelated to any transform/matrix bug) — at
  // 24pt, anything longer than ~30-45 characters starting at x=100 on a
  // standard 612pt-wide Letter page silently truncates with no error. 10pt
  // comfortably fits realistic fixture sentences on a standard page width.
  const stream = `BT /F1 10 Tf 100 700 Td (${escaped}) Tj ET`;
  const streamObj = `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`;

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((content, index) => {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  offsets.push(Buffer.byteLength(body, 'ascii'));
  body += `5 0 obj\n${streamObj}\nendobj\n`;

  const xrefOffset = Buffer.byteLength(body, 'ascii');
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  body += xref + trailer;
  return Buffer.from(body, 'ascii');
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(paragraphs: string[]): string {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;
}

/** A minimal, valid DOCX (OOXML zip) containing the given paragraphs — built
 * with the same jszip library mammoth itself depends on, so this fixture is
 * exercised through a real, complete OOXML package rather than a synthetic
 * shortcut. */
export async function buildMinimalDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', RELS_XML);
  zip.file('word/document.xml', documentXml(paragraphs));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A minimal valid (silent) WAV file — enough for MIME sniffing/kind
 * detection tests; not intended to carry meaningful audio content. */
export function buildMinimalWav(): Buffer {
  const dataSize = 4;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(8000, 24); // sample rate
  buffer.writeUInt32LE(8000, 28); // byte rate
  buffer.writeUInt16LE(1, 32); // block align
  buffer.writeUInt16LE(8, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
