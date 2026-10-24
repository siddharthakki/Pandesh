import { ToolDefinition } from './ToolTypes';

const freshnessProperties = {
  expectedHash: {
    type: 'string',
    description: 'SHA-256 returned by read_file/read_file_range. The edit is rejected if the source changed.',
  },
  allowUnverifiedOverwrite: {
    type: 'boolean',
    description: 'Explicitly allow an overwrite without a previously observed source hash.',
  },
};

export const TOOL_SCHEMAS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file and return content plus a SHA-256 freshness token for safe edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute path to the file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file_range',
      description: 'Read specific lines and return the full-file SHA-256 freshness token.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          startLine: { type: 'number', description: 'First line to read (1-based)' },
          endLine: { type: 'number', description: 'Last line to read (1-based, inclusive)' },
        },
        required: ['path', 'startLine', 'endLine'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Safely edit one or more files. Supports validated patch, exact replacement, whole-file, JSON AST, and preview strategies. Read existing files first and pass expectedHash when possible.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target path for single-file strategies' },
          strategy: {
            type: 'string',
            enum: ['structured_patch', 'search_replace', 'whole_file', 'json_ast', 'proposed_diff'],
            description: 'Optional strategy. Omit to let the engine select safely.',
          },
          content: { type: 'string', description: 'Complete content for whole_file/proposed_diff' },
          patch: { type: 'string', description: 'Unified diff with exact context' },
          search: { type: 'string', description: 'Exact source block for search_replace' },
          replace: { type: 'string', description: 'Replacement block for search_replace' },
          replaceAll: { type: 'boolean', description: 'Replace every exact occurrence; false rejects ambiguous matches' },
          expectedHash: freshnessProperties.expectedHash,
          expectedHashes: {
            type: 'object',
            description: 'Map of patch path to previously observed SHA-256 for multi-file patches.',
            additionalProperties: { type: 'string' },
          },
          jsonOperations: {
            type: 'array',
            description: 'JSON AST operations: set, delete, or merge at a slash/dot path.',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['set', 'delete', 'merge'] },
                path: { type: 'string' },
                value: {},
              },
              required: ['op', 'path'],
            },
          },
          preview: { type: 'boolean', description: 'Validate and return proposed content without writing' },
          allowUnverifiedOverwrite: freshnessProperties.allowUnverifiedOverwrite,
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Atomically write complete content. Existing files are freshness-checked and syntax-validated.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'Full content to write' },
          ...freshnessProperties,
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_file_change',
      description: 'Validate a whole-file proposal and open a VS Code diff without writing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'Proposed new content' },
          expectedHash: freshnessProperties.expectedHash,
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Replace an exact source block. Ambiguous matches are rejected unless replaceAll=true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          search: { type: 'string', description: 'Exact source block' },
          replace: { type: 'string', description: 'Replacement block' },
          replaceAll: { type: 'boolean', description: 'Replace all exact matches' },
          ...freshnessProperties,
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Atomically apply a validated multi-file unified diff. Stale context and overlapping hunks are rejected before writing.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Unified diff text' },
          expectedHash: freshnessProperties.expectedHash,
          expectedHashes: {
            type: 'object',
            description: 'Map of patch path to SHA-256 returned by read_file.',
            additionalProperties: { type: 'string' },
          },
          preview: { type: 'boolean', description: 'Validate without writing' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders in a directory using configured ignore rules.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
          depth: { type: 'number', description: 'Max depth to traverse (default 2)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory and parents in the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path to create' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files by name pattern.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Glob pattern or partial filename' },
          includeGlob: { type: 'string', description: 'Glob pattern to include' },
          excludeGlob: { type: 'string', description: 'Glob pattern to exclude' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents using a regular expression.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression pattern' },
          includeGlob: { type: 'string', description: 'Glob to limit search' },
          excludeGlob: { type: 'string', description: 'Glob to exclude' },
        },
        required: ['pattern'],
      },
    },
  },
  { type: 'function', function: { name: 'find_relevant', description: 'Ranked files and symbols (path:line) for a topic, e.g. "where are tasks persisted". Use when you do not know a symbol name.', parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } } },
  { type: 'function', function: { name: 'find_references', description: 'Where a symbol is defined and every place it is used or called (path:line).', parameters: { type: 'object', properties: { symbol: { type: 'string' }, path: { type: 'string', description: 'defining file, optional' } }, required: ['symbol'] } } },
  { type: 'function', function: { name: 'impact_analysis', description: 'What may break if a file or symbol changes: dependents and tests to run.', parameters: { type: 'object', properties: { target: { type: 'string', description: 'file path or symbol' } }, required: ['target'] } } },
  { type: 'function', function: { name: 'repo_map', description: 'Compact map of the repo: key files and their symbols. Call once to orient.', parameters: { type: 'object', properties: { focus: { type: 'string', description: 'optional words' } } } } },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace. Requires policy approval when risky.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          cwd: { type: 'string', description: 'Working directory inside workspace' },
        },
        required: ['command'],
      },
    },
  },
  { type: 'function', function: { name: 'git_status', description: 'Show workspace Git status.', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show Git diff for a file or workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Optional file path' } } },
    },
  },
  { type: 'function', function: { name: 'git_branch', description: 'List branches and current branch.', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show recent Git commits.',
      parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Maximum commits' } } },
    },
  },
  // M38: Core-backed governed external-service tools. Definitions only —
  // execution, risk classification, approval, and evidence are entirely
  // owned by Core (core/domain/capabilityDispatch.ts); see
  // ToolExecutor.executeCoreBackedCapability. Never registered with
  // GovernedToolRegistry (ToolRegistry.ts) — there is deliberately no local
  // authorization entry for these tool names to consult.
  {
    type: 'function',
    function: {
      name: 'governed_research',
      description: 'Search the web and return bounded, cited evidence excerpts for a research question. Requires approval.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The research question or search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_read_issue',
      description: 'Read an issue (title, body, state, comments) from the governed repository. Read-only.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'number', description: 'Issue number.' } },
        required: ['number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_comment_on_issue',
      description: 'Post a comment on an issue in the governed repository. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number.' },
          body: { type: 'string', description: 'Comment body (Markdown).' },
        },
        required: ['number', 'body'],
      },
    },
  },
  // M39 governed memory capability. Same boundary as the M38 tools above:
  // dispatched through ToolExecutor.executeCoreBackedCapability into Core's
  // single governed capability path — never a local memory store, never a
  // second approval authority. Bounded enums and maxLength on every field.
  {
    type: 'function',
    function: {
      name: 'memory_remember',
      description: 'Durably remember one explicitly authorized fact or decision with source evidence, scope, and sensitivity. Requires approval. Never call this for ordinary conversation.',
      parameters: {
        type: 'object',
        properties: {
          memoryType: { type: 'string', enum: ['user', 'project', 'task', 'episodic', 'semantic', 'procedural'] },
          scopeType: { type: 'string', enum: ['user', 'project', 'task', 'repository', 'global'] },
          scopeId: { type: 'string', maxLength: 200 },
          subject: { type: 'string', maxLength: 200 },
          predicate: { type: 'string', maxLength: 120 },
          value: { type: 'string', maxLength: 2000 },
          sensitivity: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] },
          sourceConversationId: { type: 'string', maxLength: 100 },
          sourceMessageId: { type: 'string', maxLength: 100 },
          expiresAt: { type: 'string', maxLength: 40 },
          affectedEntities: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['user', 'project', 'task', 'decision', 'repository_file', 'github_issue', 'product_record'] },
                canonicalKey: { type: 'string', maxLength: 300 },
                label: { type: 'string', maxLength: 200 },
                relationship: { type: 'string', enum: ['affects', 'depends_on', 'supersedes', 'implemented_by', 'contradicts', 'scoped_to'] },
              },
              required: ['type', 'canonicalKey'],
            },
          },
        },
        required: ['memoryType', 'scopeType', 'scopeId', 'subject', 'predicate', 'value', 'sensitivity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Retrieve durable remembered facts for a scope, with evidence and unresolved contradictions. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          scopeType: { type: 'string', enum: ['user', 'project', 'task', 'repository', 'global'] },
          scopeId: { type: 'string', maxLength: 200 },
          subject: { type: 'string', maxLength: 200 },
          predicate: { type: 'string', maxLength: 120 },
          includeHistorical: { type: 'boolean' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_resolve_contradiction',
      description: 'Resolve a detected contradiction between two remembered facts using an explicit policy. Requires approval. Both facts are preserved.',
      parameters: {
        type: 'object',
        properties: {
          contradictionId: { type: 'string', maxLength: 100 },
          policy: { type: 'string', enum: ['prefer_earlier', 'prefer_later', 'keep_both', 'scope_split'] },
        },
        required: ['contradictionId', 'policy'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_impact',
      description: 'Identify the repository files, GitHub issues, and product records a remembered decision affects, with relationship paths and evidence. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          memoryId: { type: 'string', maxLength: 100 },
          entityId: { type: 'string', maxLength: 100 },
          maxDepth: { type: 'number' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_export',
      description: 'Export an auditable JSON representation of remembered facts, evidence chain, contradictions, entities, and relationships. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          memoryId: { type: 'string', maxLength: 100 },
          scopeType: { type: 'string', enum: ['user', 'project', 'task', 'repository', 'global'] },
          scopeId: { type: 'string', maxLength: 200 },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
      description: 'Forget (tombstone) one remembered fact so it is no longer recalled as active. Requires approval.',
      parameters: {
        type: 'object',
        properties: { memoryId: { type: 'string', maxLength: 100 } },
        required: ['memoryId'],
      },
    },
  },
];
