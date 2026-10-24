/**
 * Pure, side-effect-free validation of tool-call arguments against the tool's declared
 * `ModelToolDefinition.parameters` JSON schema — the single schema the model is shown.
 * Supports the subset those definitions use: type (object/array/string/integer/number/boolean),
 * required, properties, items, enum. Unknown properties are allowed (schemas do not close objects).
 * Nothing is executed, read from disk, or mutated.
 */
import type { ModelToolDefinition } from './modelBackend';

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  enum?: unknown[];
}

export interface ToolArgumentValidationOptions {
  /** Return true to accept a value the declared type would reject (documented dispatch coercions). */
  accepts?: (path: string, value: unknown, schema: { type?: string }) => boolean;
  /**
   * Check only that required arguments are present (recursively), not their declared types or enums. Used for
   * native provider tool calls, whose values the dispatch layer has always coerced leniently (e.g. numeric strings
   * for line ranges); a missing required argument is never coercible and is always refused.
   */
  presenceOnly?: boolean;
}

const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

function describe(type: string): string {
  return type === 'integer' ? 'an integer' : type === 'object' ? 'an object' : `a${'aeiou'.includes(type[0]) ? 'n' : ''} ${type}`;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

function check(schema: SchemaNode | undefined, value: unknown, path: string, options: ToolArgumentValidationOptions): string | null {
  if (!schema) return null;
  if (!options.presenceOnly && schema.type && !typeMatches(schema.type, value) && !options.accepts?.(path, value, schema)) {
    return `argument "${path}" must be ${describe(schema.type)}`;
  }
  if (!options.presenceOnly && schema.enum && !schema.enum.includes(value)) {
    return `argument "${path}" must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`;
  }
  if (schema.type === 'object' && typeMatches('object', value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!has(obj, key) || obj[key] === undefined || obj[key] === null) return `missing required argument "${path ? `${path}.` : ''}${key}"`;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!has(obj, key)) continue;
      const problem = check(child, obj[key], path ? `${path}.${key}` : key, options);
      if (problem) return problem;
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const problem = check(schema.items, value[i], `${path}[${i}]`, options);
      if (problem) return problem;
    }
  }
  return null;
}

/** First schema violation as a precise sentence prefixed with the tool name, or null when valid. */
export function validateToolArguments(
  tool: Pick<ModelToolDefinition, 'name' | 'parameters'>,
  args: Record<string, unknown>,
  options: ToolArgumentValidationOptions = {},
): string | null {
  const problem = check(tool.parameters as SchemaNode, args, '', options);
  return problem ? `${tool.name}: ${problem}` : null;
}
