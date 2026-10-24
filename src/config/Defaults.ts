export const DEFAULTS = {
  // Empty means "Auto": no named model is hardcoded as the fresh-install
  // default for these task-role settings. ProductionModelCandidates treats an
  // unset role as eligible for every installed model, capability-gated by
  // selectTaskModel, instead of blocking on a historical name that may not be
  // installed. An explicit user-set value always wins over Auto, unchanged.
  model: '',
  // Role-specific model defaults (Phase 2+)
  agentModel: '',
  autocompleteModel: 'qwen2.5-coder:1.5b',
  editModel: '',
  reviewerModel: '',
  // Legacy aliases — kept for backward compat; prefer role-specific getters
  codingModel: '',
  codingFallbackModel: '',
  chatModel: '',
  visionModel: 'qwen2.5vl:7b',
  embeddingModel: 'nomic-embed-text',
  fallbackModel: 'qwen2.5-coder:14b',
  apiBase: 'http://localhost:11434',
  searxngUrl: '',
  providerType: 'ollama' as const,

  // M42 local-first model routing. The default policy is strictly local-only:
  // repository/task context is never sent to a cloud endpoint unless the user
  // explicitly selects 'local-first-cloud-fallback' AND configures a cloud
  // endpoint, model and API key.
  modelRoutingPolicy: 'local-only' as const,
  cloudFallbackApiBase: '',
  cloudFallbackModel: '',
  orcaRouterApiBase: 'https://api.orcarouter.ai/v1',
  cloudSpendMode: 'FREE_ONLY' as const,
  cloudAllowCredits: false,
  repositoryGraphEnabled: true,
  skillsEnabled: true,
  repositoryGraphMaxFiles: 150_000,
  openRouterModel: '',
  contextWindow: 8_192,
  maxOutputTokens: 0,
  temperature: 0.7,
  requestTimeoutMs: 300_000,
  allowOutsideWorkspace: false,
  maxIterations: 20,
  maxToolOutputChars: 20_000,
  maxFileReadChars: 50_000,
  requireApprovalForWrites: true,
  requireApprovalForCommands: true,
  enableAuditLog: true,
  enableCheckpoints: true,
  commandTimeoutMs: 120_000,

  // Trusted autonomy is opt-in. Enabling it is an explicit standing approval
  // for one generated, persisted contract per durable task. Hard denials and
  // out-of-contract actions still stop or request approval.
  trustedAutonomyEnabled: false,
  progressHeartbeatMs: 15_000,

  // Sequential specialist roles are opt-in because they add several local
  // inference calls per task. The single-agent path remains the baseline.
  sequentialRolesEnabled: false,
  maxReviewerRepairPasses: 1,

  // Phase 6 task budgets. These are upper bounds per durable task and survive
  // pause/resume and extension restart through TaskStore.
  maxTaskWallClockMs: 60 * 60 * 1000,
  maxTaskModelCalls: 30,
  maxTaskToolCalls: 100,
  maxTaskRepairAttempts: 3,
  maxTaskOutputBytes: 5 * 1024 * 1024,
  maxTaskNoProgressSteps: 4,

  ignoredDirs: ['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__'],
} as const;
