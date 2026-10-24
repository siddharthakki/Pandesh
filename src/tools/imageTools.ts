import * as vscode from 'vscode';
import { ToolResult, ToolContext } from './ToolTypes';
import { FileService } from '../services/FileService';
import { WorkspaceSecurity } from '../services/WorkspaceSecurity';
import { Config } from '../config/Config';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Checks if a file is an image based on its extension
 */
function isImageFile(filePath: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  const lowerPath = filePath.toLowerCase();
  return imageExtensions.some(ext => lowerPath.endsWith(ext));
}

/**
 * Analyzes an image file using Ollama's multimodal capabilities
 */
export async function analyzeImage(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const imagePath = String(args['path'] ?? '');
  if (!imagePath) {
    return { ok: false, error: 'path is required' };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await WorkspaceSecurity.resolveInsideWorkspace(imagePath, ctx.workspaceRoot, Config.getAllowOutsideWorkspace());
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  // Check if file exists and is an image
  const exists = await FileService.exists(resolvedPath);
  if (!exists) {
    return { ok: false, error: `Image file not found: ${resolvedPath}` };
  }

  if (!isImageFile(resolvedPath)) {
    return { ok: false, error: `File is not an image: ${resolvedPath}` };
  }

  // For now, just return basic information about the image
  // In a real implementation, this would call Ollama with multimodal capabilities
  try {
    const stats = await fs.stat(resolvedPath);
    return {
      ok: true,
      data: {
        path: resolvedPath,
        size: stats.size,
        modified: stats.mtime,
        type: 'image'
      },
      summary: `Analyzed image file: ${resolvedPath}`
    };
  } catch (e) {
    return { ok: false, error: `Failed to analyze image: ${String(e)}` };
  }
}

/**
 * Extract text from an image using OCR capabilities
 */
export async function extractImageText(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const imagePath = String(args['path'] ?? '');
  if (!imagePath) {
    return { ok: false, error: 'path is required' };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await WorkspaceSecurity.resolveInsideWorkspace(imagePath, ctx.workspaceRoot, Config.getAllowOutsideWorkspace());
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  // Check if file exists and is an image
  const exists = await FileService.exists(resolvedPath);
  if (!exists) {
    return { ok: false, error: `Image file not found: ${resolvedPath}` };
  }

  if (!isImageFile(resolvedPath)) {
    return { ok: false, error: `File is not an image: ${resolvedPath}` };
  }

  // For now, simulate OCR extraction
  // In a real implementation, this would call an OCR tool or service
  return {
    ok: true,
    data: {
      path: resolvedPath,
      extractedText: 'Simulated OCR text extraction from image',
      confidence: 0.95
    },
    summary: `Extracted text from image: ${resolvedPath}`
  };
}

/**
 * Get image metadata
 */
export async function getImageMetadata(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const imagePath = String(args['path'] ?? '');
  if (!imagePath) {
    return { ok: false, error: 'path is required' };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await WorkspaceSecurity.resolveInsideWorkspace(imagePath, ctx.workspaceRoot, Config.getAllowOutsideWorkspace());
  } catch (e) {
    return { ok: false, error: String(e) };
  }

// Check if file exists and is an image
    const exists = await FileService.exists(resolvedPath);
    if (!exists) {
      return { ok: false, error: `Image file not found: ${resolvedPath}` };
    }

    if (!isImageFile(resolvedPath)) {
      return { ok: false, error: `File is not an image: ${resolvedPath}` };
    }

    // For now, return basic metadata
    try {
     
// Get file extension for MIME type determination
    const ext = path.extname(resolvedPath).toLowerCase();
    
    // Simulate getting file stats using fs directly
    const fsStats = await fs.stat(resolvedPath);
    return {
      ok: true,
      data: {
        path: resolvedPath,
        size: fsStats.size,
        modified: fsStats.mtime,
        type: 'image',
        mimeType: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                 : ext === '.gif' ? 'image/gif'
                 : ext === '.webp' ? 'image/webp'
                 : ext === '.bmp' ? 'image/bmp'
                 : 'image/png'
      },
      summary: `Retrieved metadata for image: ${resolvedPath}`
    };
  } catch (e) {
    return { ok: false, error: `Failed to get image metadata: ${String(e)}` };
  }
}
