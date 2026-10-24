import { ToolDefinition } from './ToolTypes';

export type ToolArgumentValidation = { ok: true } | { ok: false; error: string };

export function validateToolArguments(
  definition: ToolDefinition,
  args: Record<string, unknown>,
): ToolArgumentValidation {
  for (const name of definition.function.parameters.required ?? []) {
    if (args[name] === undefined) {
      return { ok: false, error: `Missing required field: ${name}` };
    }
  }
  return { ok: true };
}
