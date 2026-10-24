export interface ModelCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow: number;
  preferredForCode: boolean;
}

const VISION_PREFIXES = [
  'llava', 'bakllava', 'moondream', 'minicpm-v',
  'qwen2-vl', 'qwen2.5vl', 'llama3.2-vision', 'gemma3',
  'mistral-small3.2',
];

const CAPABILITIES: Record<string, ModelCapabilities> = {
  'qwen2.5-coder:32b': { supportsTools: true, supportsVision: false, contextWindow: 8192, preferredForCode: true },
  'qwen2.5-coder:14b': { supportsTools: true, supportsVision: false, contextWindow: 8192, preferredForCode: true },
  'qwen2.5-coder:7b':  { supportsTools: true, supportsVision: false, contextWindow: 8192, preferredForCode: true },
  'llama3.1:8b':       { supportsTools: true, supportsVision: false, contextWindow: 8192, preferredForCode: false },
  'llama3.1:70b':      { supportsTools: true, supportsVision: false, contextWindow: 8192, preferredForCode: false },
  'mistral:7b':        { supportsTools: false, supportsVision: false, contextWindow: 8192, preferredForCode: false },
};

export function getCapabilities(model: string): ModelCapabilities {
  if (CAPABILITIES[model]) { return CAPABILITIES[model]; }
  const base = model.split(':')[0].toLowerCase();
  const isVision = VISION_PREFIXES.some((p) => base.startsWith(p));
  return { supportsTools: true, supportsVision: isVision, contextWindow: 8192, preferredForCode: false };
}

export function modelSupportsVision(model: string): boolean {
  return getCapabilities(model).supportsVision;
}
