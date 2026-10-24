/**
 * pdfjs-dist ships `legacy/build/pdf.worker.mjs` as a side-effect worker
 * registration with no accompanying types. The main `pdf.mjs` entry has
 * `types/src/pdf.d.ts`; this worker submodule does not. Declaring the module
 * lets Core import it for the bundled fake-worker fallback without changing
 * compiler settings.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
