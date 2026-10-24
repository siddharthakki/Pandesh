import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { ToolResult, ToolContext } from './ToolTypes';
import { FileService } from '../services/FileService';
import { WorkspaceSecurity } from '../services/WorkspaceSecurity';
import { Config } from '../config/Config';

/**
 * Checks if a file is a document based on its extension
 */
function isDocumentFile(filePath: string): boolean {
  const documentExtensions = ['.pdf', '.doc', '.docx', '.txt', '.md'];
  const lowerPath = filePath.toLowerCase();
  return documentExtensions.some(ext => lowerPath.endsWith(ext));
}

/**
 * Extract text from a document file
 */
export async function extractDocumentText(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const documentPath = String(args['path'] ?? '');
  if (!documentPath) {
    return { ok: false, error: 'path is required' };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await WorkspaceSecurity.resolveInsideWorkspace(documentPath, ctx.workspaceRoot, Config.getAllowOutsideWorkspace());
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  // Check if file exists and is a document
  const exists = await FileService.exists(resolvedPath);
  if (!exists) {
    return { ok: false, error: `Document file not found: ${resolvedPath}` };
  }

  if (!isDocumentFile(resolvedPath)) {
    return { ok: false, error: `File is not a document: ${resolvedPath}` };
  }

  // For now, simulate document text extraction
  // In a real implementation, this would call appropriate document parsing libraries
  try {
    const content = await FileService.readText(resolvedPath);
    return {
      ok: true,
      data: {
        path: resolvedPath,
        extractedText: content,
        type: 'document'
      },
      summary: `Extracted text from document: ${resolvedPath}`
    };
  } catch (e) {
    return { ok: false, error: `Failed to extract document text: ${String(e)}` };
  }
}

/**
 * Summarize document content
 */
export async function summarizeDocument(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const documentPath = String(args['path'] ?? '');
  if (!documentPath) {
    return { ok: false, error: 'path is required' };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await WorkspaceSecurity.resolveInsideWorkspace(documentPath, ctx.workspaceRoot, Config.getAllowOutsideWorkspace());
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  // Check if file exists and is a document
  const exists = await FileService.exists(resolvedPath);
  if (!exists) {
    return { ok: false, error: `Document file not found: ${resolvedPath}` };
  }

  if (!isDocumentFile(resolvedPath)) {
    return { ok: false, error: `File is not a document: ${resolvedPath}` };
  }

  // For now, simulate document summarization
  // In a real implementation, this would call an LLM or summarization service
  try {
    const content = await FileService.readText(resolvedPath);
    const summary = `Summary of document at ${resolvedPath}: This is a simulated summary of the document content with ${content.length} characters.`;
    
    return {
      ok: true,
      data: {
        path: resolvedPath,
        summary: summary,
        originalLength: content.length
      },
      summary: `Summarized document: ${resolvedPath}`
    };
  } catch (e) {
    return { ok: false, error: `Failed to summarize document: ${String(e)}` };
  }
}

/**
 * Get document metadata
 */
export async function getDocumentMetadata(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const documentPath = String(args['path'] ?? '');
  if (!documentPath) {
    return { ok: false, error: 'path is required' };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await WorkspaceSecurity.resolveInsideWorkspace(documentPath, ctx.workspaceRoot, Config.getAllowOutsideWorkspace());
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  // Check if file exists and is a document
  const exists = await FileService.exists(resolvedPath);
  if (!exists) {
    return { ok: false, error: `Document file not found: ${resolvedPath}` };
  }

  if (!isDocumentFile(resolvedPath)) {
    return { ok: false, error: `File is not a document: ${resolvedPath}` };
  }

  // For now, return basic metadata
  try {
    const stats = await fs.stat(resolvedPath);
    return {
      ok: true,
      data: {
        path: resolvedPath,
        size: stats.size,
        modified: stats.mtime,
        type: 'document',
        extension: resolvedPath.split('.').pop()?.toLowerCase() || ''
      },
      summary: `Retrieved metadata for document: ${resolvedPath}`
    };
  } catch (e) {
    return { ok: false, error: `Failed to get document metadata: ${String(e)}` };
  }
}

/**
 * Search within a document
 */
export async function searchDocument(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const documentPath = String(args['path'] ?? '');
  const searchTerm = String(args['term'] ?? '');
  
  if (!documentPath) {
    return { ok: false, error: 'path is required' };
  }
  
  if (!searchTerm) {
    return { ok: false, error: 'term is required' };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await WorkspaceSecurity.resolveInsideWorkspace(documentPath, ctx.workspaceRoot, Config.getAllowOutsideWorkspace());
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  // Check if file exists and is a document
  const exists = await FileService.exists(resolvedPath);
  if (!exists) {
    return { ok: false, error: `Document file not found: ${resolvedPath}` };
  }

  if (!isDocumentFile(resolvedPath)) {
    return { ok: false, error: `File is not a document: ${resolvedPath}` };
  }

  // For now, simulate search within document
  try {
    const content = await FileService.readText(resolvedPath);
    const lowerContent = content.toLowerCase();
    const lowerTerm = searchTerm.toLowerCase();
    
    const occurrences = [];
    let index = 0;
    while ((index = lowerContent.indexOf(lowerTerm, index)) !== -1) {
      occurrences.push({
        position: index,
        context: content.substring(Math.max(0, index - 20), Math.min(content.length, index + searchTerm.length + 20))
      });
      index += searchTerm.length;
    }
    
    return {
      ok: true,
      data: {
        path: resolvedPath,
        term: searchTerm,
        occurrences: occurrences,
        total: occurrences.length
      },
      summary: `Searched document ${resolvedPath} for "${searchTerm}" - found ${occurrences.length} occurrences`
    };
  } catch (e) {
    return { ok: false, error: `Failed to search document: ${String(e)}` };
  }
}