// Planner is reserved for multi-step planning mode.
// In MVP it emits a simple plan structure; a future iteration can use a separate
// model call to produce an explicit step list before execution.

import { OllamaClient } from '../models/OllamaClient';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ContextManager } from './ContextManager';
import { Config } from '../config/Config';
import { ToolContext } from '../tools/ToolTypes';

export interface Plan {
  steps: PlanStep[];
}

export interface PlanStep {
  id: number;
  task: string;
  tool: string;
  args: Record<string, unknown>;
  completed: boolean;
}

export class Planner {
  private client = new OllamaClient();
  private steps: PlanStep[] = [];

  setSteps(steps: Omit<PlanStep, 'id' | 'completed'>[]): void {
    this.steps = steps.map((s, i) => ({ ...s, id: i, completed: false }));
  }

  markCompleted(id: number): void {
    const step = this.steps.find((s) => s.id === id);
    if (step) { step.completed = true; }
  }

  getSteps(): PlanStep[] {
    return [...this.steps];
  }

  hasSteps(): boolean {
    return this.steps.length > 0;
  }

  allCompleted(): boolean {
    return this.steps.every((s) => s.completed);
  }

  clear(): void {
    this.steps = [];
  }

  // Create a plan using LLM
  async createPlan(
    contextManager: ContextManager,
    userRequest: string,
    signal?: AbortSignal,
  ): Promise<Plan | null> {
    const tools = ToolRegistry.allSchemas();

    // Create a prompt that asks the LLM to create a plan
    const prompt = `
You are an expert planner. Given a user request, you must break it down into steps and identify the tools needed to execute those steps.

User request: "${userRequest}"

Available tools:
${JSON.stringify(tools, null, 2)}

Please respond with a JSON object containing an array of steps. Each step should include:
- task: A brief description of what needs to be done
- tool: The name of the tool to use (must be from the available tools list)
- args: Arguments for the tool (must match the tool's schema)

Example response format:
{
  "steps": [
    {
      "task": "Read a file",
      "tool": "read_file",
      "args": {
        "path": "/path/to/file"
      }
    },
    {
      "task": "Process content",
      "tool": "run_command",
      "args": {
        "command": "echo 'hello'"
      }
    }
  ]
}

If the user request cannot be accomplished with the available tools, respond with an empty steps array.
`;

    try {
      const response = await this.client.chat(
        [
          { role: 'system', content: prompt },
          { role: 'user', content: userRequest }
        ],
        tools,
        signal
      );

      if (signal?.aborted) {
        return null;
      }

      const assistantMsg = response.message;
      const content = assistantMsg.content || '';

      // Extract JSON from the response, handling potential markdown code blocks
      let jsonStr = content.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.substring(7, jsonStr.length - 3);
      }

      const plan: Plan = JSON.parse(jsonStr);
      return plan;
    } catch (error) {
      console.error('Error creating plan:', error);
      return null;
    }
  }

  // Execute a plan with multi-step tool calls
  async executePlan(
    plan: Plan,
    contextManager: ContextManager,
    events: { onToolStart?: (toolName: string, args: Record<string, unknown>) => void; onToolResult?: (toolName: string, result: any) => void },
    signal?: AbortSignal,
  ): Promise<void> {
    for (const step of plan.steps) {
      if (signal?.aborted) {
        break;
      }

      events.onToolStart?.(step.tool, step.args);
      
      // Here we would implement the actual execution of each step
      // For now, this is a placeholder that demonstrates how it could work
      console.log(`Executing step: ${step.task} using tool ${step.tool}`);
    }
  }

  // Multi-step planning capability
  async createDetailedPlan(task: string, contextManager: ContextManager): Promise<string[]> {
    const messages = contextManager.getMessages();
    
    // Add a system message to request detailed planning
    const planPrompt = `
      Analyze the following task and provide a detailed step-by-step plan:
      Task: ${task}
      
      Consider the conversation history when creating the plan.
      Provide a clear, actionable plan with specific steps that can be executed.
      The plan should be structured as a list of items.
    `;
    
    // This would normally call the LLM to generate a detailed plan
    // For now we'll return a basic structure
    const detailedPlan = [
      `1. Analyze task requirements: "${task}"`,
      `2. Identify necessary tools and resources`,
      `3. Break down into executable subtasks`,
      `4. Execute first subtask`,
      `5. Evaluate results and adjust plan if needed`
    ];
    
    return detailedPlan;
  }
}
