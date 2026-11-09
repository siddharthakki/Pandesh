/**
 * Documents and media download, as governed capabilities.
 *
 * Three binaries that were already installed on this PC become real tools:
 *
 *   - Tesseract + Poppler read a SCANNED document (a PDF with no text layer
 *     is a picture of a page, and a picture has to be read by OCR);
 *   - Poppler's `pdftotext` reads the TEXT LAYER of a text PDF;
 *   - yt-dlp fetches a media file from a URL the person named.
 *
 * Everything runs locally. No document byte and no media byte is sent to a
 * model, a cloud service or an API. The download path is deliberately narrow:
 * one http(s) URL, no playlist, a size cap, and a destination inside the one
 * downloads folder Pandesh owns — Pandesh never fetches and runs anything.
 *
 * A direct read names one file and is gated by a per-file approval: that
 * approval IS the person's consent for that file. The household
 * document-reading grants govern unattended scans and routines, where no one
 * is present to approve a file; they are deliberately not a second gate on a
 * read a person already approved.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { nowIso } from '../domain/ids';
import { isCredentialFilePath, redactSecrets } from '../platform/credentialStore';
import { OcrError, ocrFile, resolveOcrTools, runLocalTool, type OcrTools } from './documentOcr';
import { isNonPublicAddress } from './browserHostPolicy';
import { startEgressProxy, vetHost, type EgressProxy } from './browserEgressProxy';
import { EXPORTABLE_SOURCE_EXTENSIONS, PdfExportError, printHtmlToPdf, renderReportHtml } from './documentExport';
import { resolveHostBrowserBin } from './hostBrowserBin';

const MAX_OCR_CHARS = 120_000;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

const PROTECTED_PATH_RE = /(^|[\\/])(\.git|\.karkedikha|\.ssh|\.gnupg|\.aws|\.azure|\.config[\\/]gcloud)([\\/]|$)/i;

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

export function isProtectedDocumentPath(filePath: string): boolean {
  if (isCredentialFilePath(filePath)) return true;
  if (PROTECTED_PATH_RE.test(filePath)) return true;
  try {
    const canonical = fs.realpathSync.native(filePath);
    if (isCredentialFilePath(canonical) || PROTECTED_PATH_RE.test(canonical)) return true;
  } catch {
    /* not on disk or unresolvable */
  }
  return false;
}

/** Only an absolute path to an existing file may be read. */
function resolveDocumentPath(raw: unknown): { path?: string; error?: ToolExecutionResult } {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { error: failure('path is required', 'invalid_arguments') };
  // Audit D10: a relative path used to resolve against the install folder. The chat engine resolves it against the
  // selected workspace before dispatch; anything still relative here has no base to resolve against.
  if (!path.isAbsolute(trimmed)) return { error: failure(`"${trimmed}" is a relative path and no folder is selected to resolve it against; give the full path`, 'invalid_arguments') };
  const resolved = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { error: failure(`"${resolved}" does not exist`, 'document_not_found') };
  }
  if (!stat.isFile()) return { error: failure(`"${resolved}" is not a file`, 'document_not_a_file') };
  // The same invariant the filesystem capability enforces: a credential file
  // or protected application data is never read into the conversation.
  if (isProtectedDocumentPath(resolved)) {
    return { error: failure(`"${path.basename(resolved)}" holds credentials or protected application data. Protected files are never read into the conversation.`, 'document_credential_file_refused') };
  }
  return { path: resolved };
}

/** Downloads stay inside the one folder Pandesh owns; the model may name a
 * subfolder, never an arbitrary directory such as a Windows startup folder. */
function resolveDownloadDirectory(raw: unknown, root: string): { directory?: string; error?: ToolExecutionResult } {
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.existsSync(root) ? fs.realpathSync.native(root) : path.resolve(root);
  } catch {
    canonicalRoot = path.resolve(root);
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const resolved = trimmed ? (path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(canonicalRoot, trimmed)) : canonicalRoot;

  let canonicalTarget = resolved;
  try {
    if (fs.existsSync(resolved)) {
      canonicalTarget = fs.realpathSync.native(resolved);
    } else {
      let cur = path.dirname(resolved);
      while (cur && cur !== path.dirname(cur)) {
        if (fs.existsSync(cur)) {
          const c = fs.realpathSync.native(cur);
          const r = path.relative(canonicalRoot, c);
          if (r !== '' && (r.startsWith('..') || path.isAbsolute(r))) {
            return { error: failure(`Pandesh only writes downloads inside its downloads folder (${root}); "${resolved}" escapes via symlink to "${c}".`, 'media_download_outside_downloads') };
          }
          break;
        }
        cur = path.dirname(cur);
      }
    }
  } catch {
    /* ignore */
  }

  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    return { error: failure(`Pandesh only writes downloads inside its downloads folder (${root}); "${resolved}" is outside it.`, 'media_download_outside_downloads') };
  }
  return { directory: resolved };
}

/** A media URL is only ever an http(s) URL pointing to a public site. */
function resolveMediaUrl(raw: unknown): { url?: string; parsed?: URL; error?: ToolExecutionResult } {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { error: failure('url is required', 'invalid_arguments') };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: failure('the URL could not be parsed', 'invalid_arguments') };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: failure(`only http(s) URLs are allowed; "${parsed.protocol}" is not`, 'media_url_refused') };
  }
  if (parsed.username || parsed.password) {
    return { error: failure('URLs with embedded credentials are not allowed', 'media_url_refused') };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.') ||
    (isIpLiteral && isNonPublicAddress(host))
  ) {
    return { error: failure(`host '${host}' is a local or private-network address; media downloads only fetch from public sites`, 'media_url_refused') };
  }
  return { url: parsed.toString(), parsed };
}

export interface DocumentToolsOptions {
  /** Where a governed download may be written. */
  downloadsDir?: string;
  /** Test seam: the binaries to use. */
  tools?: OcrTools;
  /** Test seam: the yt-dlp binary. */
  ytdlp?: string | null;
  /** Test seam: the headless browser that prints PDFs. */
  browserBin?: string | null;
}

export interface DocumentReadResult {
  engine: string;
  pageCount: number | null;
  sections: Array<{ page: number | null; text: string }>;
  notes: string[];
  truncated: boolean;
}

/**
 * Reads a document the honest way: the text layer first (fast and exact),
 * and OCR only when the text layer has nothing to say. A scan therefore
 * produces text instead of an empty result, and the engine that produced
 * every section is reported.
 */
export async function readDocument(filePath: string, options: { tools?: OcrTools; signal?: AbortSignal; maxChars?: number } = {}): Promise<DocumentReadResult> {
  const tools = options.tools ?? resolveOcrTools();
  const maxChars = options.maxChars ?? MAX_OCR_CHARS;
  const extension = path.extname(filePath).toLowerCase();
  const isPdf = extension === '.pdf';

  if (!isPdf) {
    const result = await ocrFile(filePath, { tools, maxChars, signal: options.signal });
    return { engine: result.engine, pageCount: result.pageCount, sections: result.sections.map((s) => ({ page: s.page, text: s.text })), notes: result.notes, truncated: result.truncated };
  }

  // The text layer first.
  let textLayer = '';
  if (tools.pdftotext) {
    const run = await runLocalTool(tools.pdftotext, ['-layout', '-enc', 'UTF-8', filePath, '-'], { timeoutMs: 60_000, signal: options.signal }).catch(() => null);
    if (run && run.code === 0) textLayer = run.stdout;
  }
  const textChars = textLayer.replace(/\s+/g, '').length;
  if (textChars > 20) {
    const trimmed = textLayer.trim();
    return {
      engine: 'pdftotext',
      pageCount: null,
      sections: [{ page: null, text: trimmed.slice(0, maxChars) }],
      notes: [],
      truncated: trimmed.length > maxChars,
    };
  }

  // Nothing in the text layer: this is a scan. OCR it.
  const notes: string[] = [];
  if (!tools.tesseract) {
    notes.push('the PDF has no text layer and Tesseract OCR is not installed, so there is nothing to read');
    return { engine: 'none', pageCount: null, sections: [], notes, truncated: false };
  }
  const ocr = await ocrFile(filePath, { tools, maxChars, signal: options.signal });
  notes.push('the PDF has no text layer; the text below was read by OCR from the page images');
  for (const note of ocr.notes) notes.push(note);
  return { engine: ocr.engine, pageCount: ocr.pageCount, sections: ocr.sections.map((s) => ({ page: s.page, text: s.text })), notes, truncated: ocr.truncated };
}

/** The text of a read result, bounded, with the page each part came from. */
export function renderDocumentRead(result: DocumentReadResult): string {
  const lines: string[] = [
    `engine: ${result.engine}${result.pageCount ? ` · ${result.pageCount} page(s)` : ''}${result.truncated ? ' · truncated' : ''}`,
  ];
  for (const note of result.notes) lines.push(`note: ${note}`);
  for (const section of result.sections) {
    if (!section.text) continue;
    lines.push(section.page ? `--- page ${section.page} ---` : '--- text ---', section.text);
  }
  const totalChars = result.sections.reduce((sum, section) => sum + section.text.length, 0);
  lines.push(`(${totalChars} characters read locally)`);
  return lines.join('\n');
}

export function createDocumentToolsAdapter(options: DocumentToolsOptions = {}): GovernedCapabilityAdapter {
  const downloadsDir = options.downloadsDir ?? path.join(os.tmpdir(), 'pandesh-downloads');
  const tools = options.tools;

  function toolsFor(): OcrTools {
    return tools ?? resolveOcrTools();
  }

  async function runOcr(call: ModelToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const resolved = resolveDocumentPath(args.path);
    if (resolved.error) return resolved.error;
    const firstPage = args.firstPage === undefined ? undefined : Number(args.firstPage);
    const lastPage = args.lastPage === undefined ? undefined : Number(args.lastPage);
    try {
      const result = await ocrFile(resolved.path!, {
        tools: toolsFor(),
        language: typeof args.language === 'string' ? args.language : undefined,
        firstPage: Number.isFinite(firstPage) ? firstPage : undefined,
        lastPage: Number.isFinite(lastPage) ? lastPage : undefined,
        maxChars: MAX_OCR_CHARS,
        signal,
      });
      const chars = result.sections.reduce((sum, section) => sum + section.text.length, 0);
      if (chars === 0) {
        return failure(
          `OCR ran but found no text in "${path.basename(resolved.path!)}"${result.notes.length ? ` (${result.notes.join('; ')})` : ''}. The page may be blank, or the text may be in a language no OCR language pack covers.`,
          'document_ocr_no_text',
        );
      }
      return {
        status: 'succeeded', exitCode: 0,
        output: redactSecrets(renderDocumentRead({ engine: result.engine, pageCount: result.pageCount, sections: result.sections.map((s) => ({ page: s.page, text: s.text })), notes: result.notes, truncated: result.truncated })),
        resultCategory: 'document_ocr_completed',
        normalizedArguments: { path: resolved.path },
      };
    } catch (error) {
      if (error instanceof OcrError) {
        return failure(error.message, `document_ocr_${error.reason}`);
      }
      return failure(error instanceof Error ? error.message : String(error), 'document_ocr_failed');
    }
  }

  async function runRead(call: ModelToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const resolved = resolveDocumentPath(args.path);
    if (resolved.error) return resolved.error;
    try {
      const result = await readDocument(resolved.path!, { tools: toolsFor(), signal });
      if (result.sections.every((section) => !section.text.trim())) {
        return failure(
          `"${path.basename(resolved.path!)}" produced no text. ${result.notes.join('; ') || 'The file may be empty or unreadable.'}`,
          'document_no_text',
        );
      }
      return {
        status: 'succeeded', exitCode: 0,
        output: redactSecrets(renderDocumentRead(result)),
        resultCategory: 'document_read_completed',
        normalizedArguments: { path: resolved.path },
      };
    } catch (error) {
      if (error instanceof OcrError) return failure(error.message, `document_read_${error.reason}`);
      return failure(error instanceof Error ? error.message : String(error), 'document_read_failed');
    }
  }

  async function runDownload(call: ModelToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const resolvedUrl = resolveMediaUrl(args.url);
    if (resolvedUrl.error) return resolvedUrl.error;

    // DNS pre-flight verification ensures the hostname resolves exclusively to public IPs
    const vetted = await vetHost(resolvedUrl.parsed!.hostname);
    if (!vetted.ok) {
      return failure(`media download target refused: ${vetted.reason}`, 'media_url_refused');
    }

    const resolvedDir = resolveDownloadDirectory(args.directory, downloadsDir);
    if (resolvedDir.error) return resolvedDir.error;
    const targetDir = resolvedDir.directory!;
    const ytdlp = options.ytdlp ?? resolveDownloadBinary();
    if (!ytdlp) {
      return failure('yt-dlp is not installed on this PC, so Pandesh cannot download media.', 'media_download_unavailable');
    }
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch {
      return failure(`the download folder "${targetDir}" could not be created`, 'media_download_unavailable');
    }
    const snapshot = (): Map<string, string> => new Map(fs.readdirSync(targetDir).map((name) => {
      try {
        const stat = fs.statSync(path.join(targetDir, name));
        return [name, `${stat.size}:${stat.mtimeMs}`];
      } catch {
        return [name, 'missing'];
      }
    }));
    const before = snapshot();

    let proxy: EgressProxy | null = null;
    try {
      proxy = await startEgressProxy();
    } catch (e) {
      return failure(`could not initialize egress security proxy: ${e instanceof Error ? e.message : String(e)}`, 'media_download_unavailable');
    }

    const argv = [
      '--no-playlist',
      '--no-exec',
      '--no-progress',
      '--newline',
      '--max-filesize', String(MAX_DOWNLOAD_BYTES),
      '--socket-timeout', '30',
      '--retries', '2',
      '--proxy', `http://127.0.0.1:${proxy.port}`,
      '-o', path.join(targetDir, '%(title).80s.%(ext)s'),
    ];
    if (typeof args.format === 'string' && args.format.trim()) argv.push('-f', args.format.trim());
    argv.push(resolvedUrl.url!);
    try {
      const run = await runLocalTool(ytdlp, argv, { timeoutMs: 15 * 60_000, signal, cwd: targetDir });
      if (run.code !== 0) {
        return failure(`yt-dlp could not fetch that URL (exit ${run.code ?? 'none'}): ${run.stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`.slice(0, 400), 'media_download_failed');
      }
      // Report only what THIS download wrote; files already in the folder are
      // not evidence of this call.
      const files = [...snapshot()].filter(([name, signature]) => (
        !name.endsWith('.part') && !name.endsWith('.ytdl') && before.get(name) !== signature
      )).map(([name]) => name);
      if (files.length === 0) {
        return failure('yt-dlp reported success but no new file was written.', 'media_download_no_file');
      }
      const written = files.map((name) => {
        const full = path.join(targetDir, name);
        const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
        return { name, bytes: size, path: full };
      });
      return {
        status: 'succeeded', exitCode: 0,
        output: `Downloaded ${written.length} file(s) into ${targetDir}:\n${written.map((f) => `- ${f.name} (${f.bytes} bytes)`).join('\n')}\nThe person is responsible for the rights to the material that was downloaded.`,
        resultCategory: 'media_download_completed',
        normalizedArguments: { url: resolvedUrl.url, directory: targetDir },
      };
    } catch (error) {
      if (error instanceof OcrError) return failure(error.message, `media_download_${error.reason}`);
      return failure(error instanceof Error ? error.message : String(error), 'media_download_failed');
    } finally {
      if (proxy) await proxy.close();
    }
  }

  /** Audit D5: Markdown or a text report becomes a verified PDF, printed locally by the browser Windows ships. */
  async function runExport(call: ModelToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const markdownArg = typeof args.markdown === 'string' ? args.markdown : '';
    const sourceArg = typeof args.source === 'string' ? args.source.trim() : '';
    if (!!markdownArg.trim() === !!sourceArg) {
      return failure('give exactly one of "source" (a .md or .txt file) or "markdown" (the report text)', 'invalid_arguments');
    }
    let content = markdownArg;
    let sourcePath: string | null = null;
    if (sourceArg) {
      const resolved = resolveDocumentPath(sourceArg);
      if (resolved.error) return resolved.error;
      sourcePath = resolved.path!;
      const extension = path.extname(sourcePath).toLowerCase();
      if (!EXPORTABLE_SOURCE_EXTENSIONS.has(extension)) {
        return failure(`only Markdown or plain-text files can be exported to PDF; "${path.basename(sourcePath)}" is ${extension || 'unknown'}`, 'pdf_export_unsupported_source');
      }
      if (fs.statSync(sourcePath).size > 2 * 1024 * 1024) return failure('the source file is larger than 2 MB', 'pdf_export_source_too_large');
      content = fs.readFileSync(sourcePath, 'utf8');
    }
    if (!content.trim()) return failure('there is no text to put in the PDF', 'invalid_arguments');

    const outputArg = typeof args.output === 'string' ? args.output.trim() : '';
    const outputRaw = outputArg || (sourcePath ? sourcePath.replace(/\.[^.\\/]+$/, '.pdf') : '');
    if (!outputRaw) return failure('"output" is required when exporting text: the full path of the .pdf to write', 'invalid_arguments');
    if (!path.isAbsolute(outputRaw)) return failure(`"${outputRaw}" is a relative path and no folder is selected to resolve it against; give the full path`, 'invalid_arguments');
    const outputPath = path.resolve(outputRaw);
    if (path.extname(outputPath).toLowerCase() !== '.pdf') return failure('the output file must end in .pdf', 'invalid_arguments');
    if (isProtectedDocumentPath(outputPath)) return failure('that location holds credentials or protected application data; PDFs are never written there', 'pdf_export_refused');
    if (!fs.existsSync(path.dirname(outputPath))) return failure(`the folder "${path.dirname(outputPath)}" does not exist`, 'pdf_export_no_folder');
    if (fs.existsSync(outputPath) && args.overwrite !== true) {
      return failure(`"${path.basename(outputPath)}" already exists and was left unchanged; pass overwrite=true only if the person asked to replace it`, 'pdf_export_exists');
    }
    const browserBin = options.browserBin === undefined ? resolveHostBrowserBin() : options.browserBin;
    if (!browserBin) return failure('no Edge or Chrome browser was found on this PC, so a PDF cannot be printed', 'pdf_export_unavailable');

    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : path.basename(outputPath, '.pdf');
    const plainText = sourcePath ? path.extname(sourcePath).toLowerCase() === '.txt' : false;
    const ocr = toolsFor();
    try {
      const verified = await printHtmlToPdf(renderReportHtml(content, title, plainText), outputPath, {
        browserBin, pdftotext: ocr.pdftotext, pdfinfo: ocr.pdfinfo, signal,
      });
      const facts = [`${verified.bytes} bytes`, verified.pages !== null ? `${verified.pages} page(s)` : null, verified.textChars !== null ? `${verified.textChars} characters of text verified` : null].filter(Boolean).join(', ');
      return {
        status: 'succeeded', exitCode: 0,
        output: `Saved PDF: ${outputPath} (${facts}). Printed locally${sourcePath ? ` from ${path.basename(sourcePath)}` : ''}; nothing was sent off this PC.`,
        resultCategory: 'pdf_export_completed',
        normalizedArguments: { source: sourcePath, output: outputPath },
      };
    } catch (error) {
      if (error instanceof PdfExportError) return failure(`NOT SAVED: ${error.message}`, `pdf_export_${error.reason}`);
      return failure(`NOT SAVED: ${error instanceof Error ? error.message : String(error)}`, 'pdf_export_failed');
    }
  }

  async function run(call: ModelToolCall, ctx?: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
    const signal = ctx?.signal;
    if (call.name === 'document_ocr') return runOcr(call, signal);
    if (call.name === 'document_read') return runRead(call, signal);
    if (call.name === 'media_download') return runDownload(call, signal);
    if (call.name === 'export_document_pdf') return runExport(call, signal);
    return failure(`unknown tool '${call.name}'`, 'invalid_arguments');
  }

  return {
    id: 'document-tools',
    definitions: () => [
      {
        name: 'document_read',
        description: 'Read a PDF, scan or image on this PC and return its text. Uses the text layer when the document has one and OCR (Tesseract) when it does not — a scanned invoice therefore returns text instead of nothing. Reads only the file you name, locally; no document content is sent anywhere. Consequential: the person approves the exact file first.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the PDF or image.' } }, required: ['path'] },
      },
      {
        name: 'document_ocr',
        description: 'Read the PICTURE of a scanned page with OCR and return the text with the page it came from. Use this for a scan whose text layer is empty, or to OCR an image. Tesseract runs locally on this PC. Consequential: the person approves the exact file first.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the PDF or image.' },
            firstPage: { type: 'number' },
            lastPage: { type: 'number' },
            language: { type: 'string', description: 'OCR language, e.g. "eng" or "deu+eng".' },
          },
          required: ['path'],
        },
      },
      {
        name: 'media_download',
        description: 'Download one media file from an http(s) URL with yt-dlp into Pandesh\'s downloads folder (or a subfolder of it). One URL only, no playlist, size capped, nothing is ever executed. The person approves the exact URL and folder first and stays responsible for the rights to the material. Consequential.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The http(s) URL to download.' },
            directory: { type: 'string', description: 'Optional subfolder inside Pandesh\'s downloads folder.' },
            format: { type: 'string', description: 'Optional yt-dlp format selector.' },
          },
          required: ['url'],
        },
      },
      {
        name: 'export_document_pdf',
        description: 'Turn a report into a real PDF file on this PC. Give either "source" (a .md or .txt file, e.g. one you just wrote with write_file) or "markdown" (the report text, with headings, lists and tables) plus "output" (the .pdf path). Markdown formatting is kept; the PDF is printed locally and verified before success is reported. Use this instead of pandoc, LibreOffice or installing a converter. Consequential: the person approves the output file first.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Path of the .md or .txt file to convert.' },
            markdown: { type: 'string', description: 'The report as Markdown, when there is no source file.' },
            output: { type: 'string', description: 'Path of the .pdf to write. Defaults to the source path with .pdf.' },
            title: { type: 'string', description: 'Optional document title.' },
            overwrite: { type: 'boolean', description: 'Replace an existing PDF; only when the person asked to.' },
          },
        },
      },
    ],
    classify: (toolName) => (toolName === 'document_read' || toolName === 'document_ocr' || toolName === 'media_download' || toolName === 'export_document_pdf' ? 'consequential' : 'read_only'),
    health: () => {
      const resolved = toolsFor();
      const missing = [
        resolved.tesseract ? null : 'Tesseract OCR',
        resolved.pdftoppm ? null : 'Poppler (pdftoppm)',
        resolved.pdftotext ? null : 'Poppler (pdftotext)',
      ].filter(Boolean) as string[];
      const browser = options.browserBin === undefined ? resolveHostBrowserBin() : options.browserBin;
      if (missing.length === 3 && browser) {
        return { state: 'degraded', reason: `no OCR tool is installed (missing ${missing.join(', ')}); PDF export still works`, checkedAt: nowIso() };
      }
      if (missing.length === 3) {
        return { state: 'unavailable', reason: `no document tool is installed (missing ${missing.join(', ')})`, checkedAt: nowIso() };
      }
      if (missing.length > 0) {
        return { state: 'degraded', reason: `missing ${missing.join(', ')}`, checkedAt: nowIso() };
      }
      return { state: 'available', checkedAt: nowIso() };
    },
    redactArguments: (_toolName, args) => ({ ...args, ...(typeof args.markdown === 'string' && args.markdown.length > 400 ? { markdown: `${args.markdown.slice(0, 400)}… (${args.markdown.length} characters)` } : {}) }),
    run,
  };
}

/** The yt-dlp binary, when it is installed. */
export function resolveDownloadBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = ['yt-dlp', 'yt-dlp.exe'];
  for (const candidate of candidates) {
    const found = findOnPath(candidate, env);
    if (found) return found;
  }
  return null;
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* absent */ }
  }
  const local = env.LOCALAPPDATA;
  if (local) {
    const candidate = path.join(local, 'Python', 'Scripts', name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* absent */ }
    const scripts = path.join(local, 'Python', 'bin', name);
    try { if (fs.statSync(scripts).isFile()) return scripts; } catch { /* absent */ }
  }
  return null;
}
