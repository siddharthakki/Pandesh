export type SpecialistRole = 'supervisor' | 'planner' | 'implementer' | 'reviewer' | 'validator';

export interface SupervisorArtifact {
  schemaVersion: 1;
  role: 'supervisor';
  goal: string;
  taskSummary: string;
  acceptanceCriteria: string[];
  risks: string[];
  allowedPaths: string[];
  recommendedValidation: string[];
  createdAt: string;
  model: string;
  rawResponse?: string;
}

export interface PlanStep {
  id: string;
  objective: string;
  files: string[];
  validation: string[];
}

export interface PlannerArtifact {
  schemaVersion: 1;
  role: 'planner';
  goal: string;
  summary: string;
  steps: PlanStep[];
  assumptions: string[];
  createdAt: string;
  model: string;
  rawResponse?: string;
}

export interface ImplementationArtifact {
  schemaVersion: 1;
  role: 'implementer';
  taskId: string;
  summary: string;
  filesChanged: string[];
  commandsRun: string[];
  checkpointIds: string[];
  validationPassed?: boolean;
  completedAt: string;
}

export interface ReviewFinding {
  severity: 'blocking' | 'warning' | 'info';
  file?: string;
  message: string;
  remediation?: string;
}

export interface ReviewArtifact {
  schemaVersion: 1;
  role: 'reviewer';
  taskId: string;
  summary: string;
  blocking: boolean;
  findings: ReviewFinding[];
  reviewedAt: string;
  model: string;
  rawResponse?: string;
}

export interface ValidationArtifact {
  schemaVersion: 1;
  role: 'validator';
  taskId: string;
  passed: boolean;
  summary: string;
  requiredGatesPassed: boolean;
  reviewerBlocking: boolean;
  commandsRun: string[];
  validatedAt: string;
  model: string;
  rawResponse?: string;
}

export interface RoleWorkflowSummary {
  schemaVersion: 1;
  workflowId: string;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  repairPasses: number;
  baselineMode: 'single-role' | 'sequential-specialists';
  finalStatus: 'running' | 'completed' | 'blocked' | 'failed';
  artifacts: string[];
}
