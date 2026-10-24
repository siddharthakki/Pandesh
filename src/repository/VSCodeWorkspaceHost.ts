/**
 * VS Code adapter for the portable WorkspaceHost.
 *
 * Listing, reading, hashing, git state and text search come from the local filesystem host (they work identically in any
 * Node environment). What VS Code uniquely adds — language-server symbols, definitions, references, diagnostics and the
 * editor's open/recent files — is layered on top. Every VS Code call is bounded and failure-tolerant: a missing language
 * server just means that accelerator returns nothing, never an error to the caller.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import {
  LocalFilesystemWorkspaceHost,
  toPosix,
  type HostDiagnostic,
  type HostLocation,
  type SymbolHit,
} from '../../core/platform/repo/workspaceHost';

const LSP_DEADLINE_MS = 2_000;

function withDeadline<T>(work: PromiseLike<T>, fallback: T, ms = LSP_DEADLINE_MS): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(work).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

const SYMBOL_KIND_NAMES: Record<number, string> = { 4: 'class', 5: 'class', 6: 'method', 8: 'property', 9: 'function', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'variable', 22: 'enum', 23: 'struct' };

/** Remembers recently focused files (workspace-relative, most recent first). */
export class RecentFilesTracker implements vscode.Disposable {
  private readonly files: string[] = [];
  private readonly subscription?: vscode.Disposable;

  constructor(private readonly root: string, private readonly limit = 40) {
    this.subscription = vscode.window?.onDidChangeActiveTextEditor?.(editor => {
      const fsPath = editor?.document?.uri?.fsPath;
      if (fsPath) this.note(fsPath);
    });
  }

  note(fsPath: string): void {
    const rel = toPosix(path.relative(this.root, fsPath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const at = this.files.indexOf(rel);
    if (at >= 0) this.files.splice(at, 1);
    this.files.unshift(rel);
    if (this.files.length > this.limit) this.files.length = this.limit;
  }

  list(): string[] { return [...this.files]; }
  dispose(): void { this.subscription?.dispose(); }
}

export class VSCodeWorkspaceHost extends LocalFilesystemWorkspaceHost {
  readonly kind: string = 'vscode';

  constructor(root: string, private readonly recent: RecentFilesTracker = new RecentFilesTracker(root)) {
    super(root);
  }

  private relative(uri: vscode.Uri): string | undefined {
    const rel = toPosix(path.relative(this.root, uri.fsPath));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : undefined;
  }

  async symbols(query: string, max = 50): Promise<SymbolHit[]> {
    if (!query.trim()) return [];
    const found = await withDeadline(
      vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query),
      [] as vscode.SymbolInformation[] | undefined,
    );
    const hits: SymbolHit[] = [];
    for (const symbol of found ?? []) {
      const rel = symbol.location?.uri ? this.relative(symbol.location.uri) : undefined;
      if (!rel) continue;
      hits.push({ name: symbol.name, kind: SYMBOL_KIND_NAMES[Number(symbol.kind)] ?? 'symbol', path: rel, line: (symbol.location.range?.start?.line ?? 0) + 1, ...(symbol.containerName ? { container: symbol.containerName } : {}) });
      if (hits.length >= max) break;
    }
    return hits;
  }

  private async locations(command: string, relPath: string, line: number, column: number): Promise<HostLocation[]> {
    let found: Array<vscode.Location | vscode.LocationLink> | undefined;
    try {
      const uri = vscode.Uri.file(path.join(this.root, relPath));
      const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column));
      found = await withDeadline(
        vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(command, uri, position),
        [] as Array<vscode.Location | vscode.LocationLink> | undefined,
      );
    } catch {
      return []; // no language server / Position API: this accelerator simply yields nothing
    }
    const out: HostLocation[] = [];
    for (const item of found ?? []) {
      const target = 'targetUri' in item ? item.targetUri : item.uri;
      const range = 'targetRange' in item ? item.targetRange : item.range;
      const rel = target ? this.relative(target) : undefined;
      if (rel) out.push({ path: rel, line: (range?.start?.line ?? 0) + 1, column: range?.start?.character });
    }
    return out;
  }

  definitions(relPath: string, line: number, column: number): Promise<HostLocation[]> {
    return this.locations('vscode.executeDefinitionProvider', relPath, line, column);
  }

  references(relPath: string, line: number, column: number): Promise<HostLocation[]> {
    return this.locations('vscode.executeReferenceProvider', relPath, line, column);
  }

  async diagnostics(relPaths?: readonly string[]): Promise<HostDiagnostic[]> {
    const all = vscode.languages?.getDiagnostics?.() ?? [];
    const wanted = relPaths ? new Set(relPaths.map(toPosix)) : undefined;
    const out: HostDiagnostic[] = [];
    for (const [uri, diagnostics] of all) {
      const rel = this.relative(uri);
      if (!rel || (wanted && !wanted.has(rel))) continue;
      for (const d of diagnostics) {
        const severity = d.severity === 0 ? 'error' : d.severity === 1 ? 'warning' : 'info';
        out.push({ path: rel, line: d.range.start.line + 1, severity, message: d.message.slice(0, 300) });
        if (out.length >= 500) return out;
      }
    }
    return out;
  }

  async openFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const group of vscode.window?.tabGroups?.all ?? []) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        const rel = input?.uri && input.uri.scheme === 'file' ? this.relative(input.uri) : undefined;
        if (rel && !out.includes(rel)) out.push(rel);
      }
    }
    return out;
  }

  async recentFiles(): Promise<string[]> { return this.recent.list(); }
}
