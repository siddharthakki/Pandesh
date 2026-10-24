/**
 * TypeScript/JavaScript structure from the real compiler AST, as a stronger extractor for the portable repository graph
 * (provenance `ast`). The portable core ships only a lexical extractor; this one is supplied by the VS Code adapter
 * because it depends on the `typescript` package. Large files fall back to the lexical extractor to keep indexing cheap.
 */
import * as ts from 'typescript';
import type { Extraction, ExtractorFn, ImportRec, SymbolRec } from '../../core/platform/repo/extractors';

const MAX_AST_CHARS = 150_000;
const EXTENSION_KIND: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX,
};

const isExported = (node: ts.Node): boolean => {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return (flags & ts.ModifierFlags.Export) !== 0 || (flags & ts.ModifierFlags.Default) !== 0;
};

const heritage = (node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, kind: ts.SyntaxKind, source: ts.SourceFile): string[] | undefined => {
  const names = (node.heritageClauses ?? []).filter(clause => clause.token === kind).flatMap(clause => clause.types.map(type => type.expression.getText(source)));
  return names.length ? names : undefined;
};

export const tsAstExtractor: ExtractorFn = (relPath, text): Partial<Extraction> | undefined => {
  const dot = relPath.lastIndexOf('.');
  const kind = dot >= 0 ? EXTENSION_KIND[relPath.slice(dot).toLowerCase()] : undefined;
  if (kind === undefined || text.length > MAX_AST_CHARS) return undefined;
  let source: ts.SourceFile;
  try { source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, false, kind); } catch { return undefined; }
  const symbols: SymbolRec[] = [];
  const imports: ImportRec[] = [];
  const exports = new Set<string>();
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const addImport = (spec: string, node: ts.Node, importKind: ImportRec['kind'], names?: string[]): void => {
    imports.push({ spec, line: lineOf(node), kind: importKind, ...(names?.length ? { names } : {}), provenance: 'ast', confidence: 0.95 });
  };
  const addSymbol = (record: SymbolRec): void => {
    if (symbols.length >= 300) return;
    symbols.push(record);
    if (record.exported) exports.add(record.name);
  };

  const visit = (node: ts.Node, container?: string): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name) names.push('default');
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) names.push((element.propertyName ?? element.name).text);
      addImport(node.moduleSpecifier.text, node, 'static', names);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text, node, 'static');
      if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const element of node.exportClause.elements) exports.add(element.name.text);
      return;
    }
    if (ts.isExportAssignment(node)) { exports.add('default'); }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg) && node.arguments.length >= 1) {
        if (ts.isIdentifier(callee) && callee.text === 'require') addImport(arg.text, node, 'require');
        else if (callee.kind === ts.SyntaxKind.ImportKeyword) addImport(arg.text, node, 'dynamic');
      }
    }
    if (ts.isClassDeclaration(node) && node.name) {
      addSymbol({ name: node.name.text, kind: 'class', line: lineOf(node), exported: isExported(node), ...(heritage(node, ts.SyntaxKind.ExtendsKeyword, source) ? { extends: heritage(node, ts.SyntaxKind.ExtendsKeyword, source) } : {}), ...(heritage(node, ts.SyntaxKind.ImplementsKeyword, source) ? { implements: heritage(node, ts.SyntaxKind.ImplementsKeyword, source) } : {}) });
      for (const member of node.members) {
        if ((ts.isMethodDeclaration(member) || ts.isGetAccessor(member)) && member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
          addSymbol({ name: member.name.text, kind: 'method', line: lineOf(member), exported: false, container: node.name.text });
        }
      }
      return;
    }
    if (ts.isInterfaceDeclaration(node)) { addSymbol({ name: node.name.text, kind: 'interface', line: lineOf(node), exported: isExported(node), ...(heritage(node, ts.SyntaxKind.ExtendsKeyword, source) ? { extends: heritage(node, ts.SyntaxKind.ExtendsKeyword, source) } : {}) }); return; }
    if (ts.isTypeAliasDeclaration(node)) { addSymbol({ name: node.name.text, kind: 'type', line: lineOf(node), exported: isExported(node) }); return; }
    if (ts.isEnumDeclaration(node)) { addSymbol({ name: node.name.text, kind: 'enum', line: lineOf(node), exported: isExported(node) }); return; }
    if (ts.isFunctionDeclaration(node) && node.name) { addSymbol({ name: node.name.text, kind: 'function', line: lineOf(node), exported: isExported(node) }); }
    if (ts.isVariableStatement(node) && !container) {
      const exported = isExported(node);
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer;
        const isFunction = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
        if (exported || isFunction || /^[A-Z][A-Z0-9_]+$/.test(declaration.name.text)) addSymbol({ name: declaration.name.text, kind: isFunction ? 'function' : 'variable', line: lineOf(declaration), exported });
        if (initializer) visit(initializer, container);
      }
      return;
    }
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) { addSymbol({ name: node.name.text, kind: 'module', line: lineOf(node), exported: isExported(node) }); }
    ts.forEachChild(node, child => visit(child, container));
  };
  visit(source);
  return { language: kind === ts.ScriptKind.TS || kind === ts.ScriptKind.TSX ? 'typescript' : 'javascript', symbols, imports, exports: [...exports], provenance: 'ast' };
};
