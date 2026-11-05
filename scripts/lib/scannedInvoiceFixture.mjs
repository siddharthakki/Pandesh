/**
 * A generated scanned invoice: a real PDF with NO text layer, produced
 * locally from a rendered image, so OCR can be tested against ground truth
 * that did not come from a person's private folder.
 *
 * The fixture is built with the tools Pandesh itself drives (Poppler renders
 * the page image; the PDF is assembled byte by byte), so it is reproducible on
 * any machine that has Poppler, and it is a genuine scan: a picture of a
 * document, with no extractable text layer.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A minimal, valid PDF that embeds one full-page JPEG image and no text. */
export function scannedPdfFromImage(imagePath, outPath, width, height) {
  const jpeg = fs.readFileSync(imagePath);
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`);
  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objects.push(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n${jpeg.toString('latin1')}\nendstream`);
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(outPath, body, 'latin1');
  return outPath;
}

/**
 * Renders an invoice as a picture with Poppler's `pdftoppm` from a text PDF
 * built here, then re-embeds that picture as a scan. The result has the same
 * visible content as a text PDF but no text layer at all.
 */
export function buildScannedInvoice(options) {
  const { dir, invoiceNumber, total, vendor, pdftoppm } = options;
  fs.mkdirSync(dir, { recursive: true });
  const textPdf = path.join(dir, 'invoice-text.pdf');
  const lines = [
    vendor,
    `Invoice number: ${invoiceNumber}`,
    'Description: Garden services, April 2026',
    `Total due: EUR ${total}`,
    'Payment terms: 14 days',
  ];
  const stream = `BT /F1 16 Tf 60 760 Td 26 TL ${lines.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(textPdf, body, 'latin1');

  const prefix = path.join(dir, 'invoice-page');
  execFileSync(pdftoppm, ['-r', '150', '-jpeg', '-jpegopt', 'quality=92', '-f', '1', '-l', '1', textPdf, prefix], { stdio: 'ignore' });
  const rendered = fs.readdirSync(dir).find((name) => name.startsWith('invoice-page') && name.endsWith('.jpg'));
  if (!rendered) throw new Error('the invoice page could not be rendered');
  const pageImage = path.join(dir, rendered);
  const pdfPath = path.join(dir, 'invoice-scanned.pdf');
  scannedPdfFromImage(pageImage, pdfPath, 1240, 1754);
  return { pdfPath, pageImage, truth: { invoiceNumber, total } };
}
