import { Config } from '../config/Config';
import { OllamaMessage } from '../tools/ToolTypes';

const CODING_KEYWORDS = [
  // Actions
  'write', 'implement', 'create', 'build', 'fix', 'debug', 'refactor',
  'edit', 'update', 'modify', 'change', 'add', 'remove', 'delete',
  'generate', 'complete', 'finish', 'optimize', 'review', 'test',
  // Artifacts
  'function', 'class', 'method', 'variable', 'const', 'interface',
  'component', 'module', 'file', 'script', 'program', 'algorithm',
  'api', 'endpoint', 'route', 'schema', 'migration', 'query',
  'import', 'export', 'dependency', 'package', 'library',
  // Languages & frameworks
  'python', 'javascript', 'typescript', 'java', 'kotlin', 'swift',
  'rust', 'go', 'c#', 'c++', 'html', 'css', 'sql', 'bash',
  'react', 'vue', 'angular', 'node', 'express', 'django', 'fastapi',
  'gradle', 'maven', 'webpack', 'vite', 'docker', 'kubernetes',
  // Code signals
  'bug', 'error', 'exception', 'crash', 'compile', 'syntax',
  'code', 'coding', 'codebase', 'repo', 'repository', 'pr',
  'git', 'commit', 'branch', 'merge', 'diff', 'patch',
];

const CODE_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.kt', '.swift',
  '.rs', '.go', '.cs', '.cpp', '.c', '.h', '.rb', '.php',
  '.html', '.css', '.scss', '.sql', '.sh', '.ps1', '.json',
  '.yaml', '.yml', '.toml', '.xml', '.gradle',
]);

function lastUserContent(messages: OllamaMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { return messages[i].content.toLowerCase(); }
  }
  return '';
}

function hasCodeFileAttachment(content: string): boolean {
  // Detect inlined code file headers added by AgentPanel: [Attached file: foo.ts]
  return /\[attached file: [^\]]+\.(ts|tsx|js|jsx|py|java|kt|rs|go|cs|cpp|c|rb|php|sql|sh)\]/i.test(content);
}

function hasDocumentAttachment(content: string): boolean {
  // Detect document headers added by AgentPanel: [Attached document: report.pdf]
  return /\[attached document:/i.test(content);
}

function isCodingTask(content: string): boolean {
  if (hasCodeFileAttachment(content)) { return true; }
  const words = content.split(/\s+/);
  const matchCount = words.filter((w) => CODING_KEYWORDS.includes(w.replace(/[^a-z#.+]/g, ''))).length;
  // Two or more keyword hits = coding task
  return matchCount >= 2;
}

export class ModelRouter {
  static selectModel(messages: OllamaMessage[], hasImages: boolean, hasDocuments = false): string {
    if (hasImages || hasDocuments) {
      return Config.getVisionModel();
    }

    const content = lastUserContent(messages);
    if (hasDocumentAttachment(content)) {
      return Config.getVisionModel();
    }
    if (isCodingTask(content)) {
      return Config.getCodingModel();
    }

    return Config.getChatModel();
  }

  // Used by audit logging / toolbar badge
  static describeSelection(messages: OllamaMessage[], hasImages: boolean, hasDocuments = false): string {
    if (hasImages) { return `vision (image) → ${Config.getVisionModel()}`; }
    if (hasDocuments) { return `vision (document) → ${Config.getVisionModel()}`; }
    const content = lastUserContent(messages);
    if (hasDocumentAttachment(content)) { return `vision (document) → ${Config.getVisionModel()}`; }
    if (isCodingTask(content)) { return `coding → ${Config.getCodingModel()}`; }
    return `chat → ${Config.getChatModel()}`;
  }
}
