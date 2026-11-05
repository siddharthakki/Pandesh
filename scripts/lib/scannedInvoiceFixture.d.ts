export interface ScannedInvoiceTruth {
  invoiceNumber: string;
  total: string;
}

export interface ScannedInvoiceFixture {
  pdfPath: string;
  pageImage: string;
  truth: ScannedInvoiceTruth;
}

export declare function scannedPdfFromImage(
  imagePath: string,
  outPath: string,
  width: number,
  height: number,
): string;

export declare function buildScannedInvoice(options: {
  dir: string;
  invoiceNumber: string;
  total: string;
  vendor: string;
  pdftoppm: string;
}): ScannedInvoiceFixture;
