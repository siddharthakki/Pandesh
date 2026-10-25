/**
 * Connector Truth & Verification Accounting
 *
 * Distinguishes tool availability from successful authentication and completed tool execution.
 * Never hardcodes "verified access" merely because connector tools are exposed in the environment.
 */

export interface ConnectorTruthState {
  hasTools: boolean;
  toolNames: string[];
  toolAvailability: 'available' | 'unavailable';
  authenticationStatus: 'verified' | 'unauthenticated' | 'untested';
  executionStatus: 'completed' | 'failed' | 'not_invoked';
  completedExecutions: number;
  failedExecutions: number;
}

export function evaluateConnectorTruth(
  tools: Array<{ name: string }>,
  historyOrExecutions?: {
    toolCalls?: Array<{ tool: string; status: string }>;
    hasAuthToken?: boolean | null;
  }
): ConnectorTruthState {
  const matchingTools = tools.filter(t => t.name.startsWith('gmail_'));
  const hasTools = matchingTools.length > 0;
  const toolNames = matchingTools.map(t => t.name);

  const toolCalls = historyOrExecutions?.toolCalls || [];
  const completedExecutions = toolCalls.filter(c => c.tool.startsWith('gmail_') && c.status === 'completed').length;
  const failedExecutions = toolCalls.filter(c => c.tool.startsWith('gmail_') && c.status === 'failed').length;

  let authenticationStatus: 'verified' | 'unauthenticated' | 'untested' = 'untested';
  if (completedExecutions > 0) {
    authenticationStatus = 'verified';
  } else if (historyOrExecutions?.hasAuthToken === false || (failedExecutions > 0 && completedExecutions === 0)) {
    authenticationStatus = 'unauthenticated';
  } else if (historyOrExecutions?.hasAuthToken === true) {
    authenticationStatus = 'verified';
  }

  let executionStatus: 'completed' | 'failed' | 'not_invoked' = 'not_invoked';
  if (completedExecutions > 0) {
    executionStatus = 'completed';
  } else if (failedExecutions > 0) {
    executionStatus = 'failed';
  }

  return {
    hasTools,
    toolNames,
    toolAvailability: hasTools ? 'available' : 'unavailable',
    authenticationStatus,
    executionStatus,
    completedExecutions,
    failedExecutions,
  };
}

export function formatConnectorTruthPrompt(
  state: ConnectorTruthState,
  options?: { activeTask?: { objective: string; status: string; evidence?: any } }
): string {
  if (!state.hasTools) return '';

  const toolList = state.toolNames.join(', ');
  let authDesc = 'untested (tool availability alone does not establish verified authentication until tools run)';
  if (state.authenticationStatus === 'verified') {
    authDesc = `verified (${state.completedExecutions} completed execution(s))`;
  } else if (state.authenticationStatus === 'unauthenticated') {
    authDesc = 'unauthenticated or failed (authentication credentials required or prior tool call failed)';
  }

  let execDesc = 'not invoked in this turn/session';
  if (state.executionStatus === 'completed') {
    execDesc = `completed (${state.completedExecutions} successful invocation(s))`;
  } else if (state.executionStatus === 'failed') {
    execDesc = `failed (${state.failedExecutions} failed invocation(s))`;
  }

  let prompt = `\n\nCURRENT CONNECTOR STATUS & TOOL AVAILABILITY:
- Gmail Connector:
  * Tool Availability: Available (${toolList})
  * Authentication Status: ${authDesc}
  * Execution Status: ${execDesc}
- Conversation History Note: All historical messages above are preserved verbatim for conversational continuity. If earlier assistant turns claimed that Gmail was not connected or that no Gmail tools were available, note that Gmail tools are currently available in your tool list. Use the available tools to inspect real threads and attachments rather than claiming tools are absent.`;

  if (options?.activeTask) {
    prompt += `\n- Active Task Objective: "${options.activeTask.objective}" (Status: ${options.activeTask.status})`;
    if (options.activeTask.evidence) {
      prompt += `\n- Active Task Verified Evidence: ${typeof options.activeTask.evidence === 'string' ? options.activeTask.evidence : JSON.stringify(options.activeTask.evidence)}`;
    }
  }

  return prompt;
}
