import type { McpToolDefinition } from '@/api/types';

export function defaultValueForSchemaProp(key: string, prop: unknown): unknown {
  if (!prop || typeof prop !== 'object') return '';
  const p = prop as Record<string, any>;
  if (p.default !== undefined) return p.default;
  if (Array.isArray(p.enum) && p.enum.length > 0) return p.enum[0];
  if (p.type === 'number' || p.type === 'integer') {
    return key === 'limit' ? 10 : key === 'staleAfterDays' ? 30 : 0;
  }
  if (p.type === 'boolean') return true;
  if (p.type === 'array') return [];
  if (p.type === 'object') return {};
  return '';
}

export function buildToolStarterJson(
  tool: McpToolDefinition | null | undefined,
): string {
  const schema = tool?.inputSchema;
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return '{}';
  const keys = Object.keys(props);
  if (keys.length === 0) return '{}';

  const requiredSet = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const template: Record<string, unknown> = {};
  let optionalAdded = 0;

  for (const k of keys) {
    const p = props[k] || {};
    const desc = String(p.description || '');
    const isReq = requiredSet.has(k);

    if (!isReq) {
      if (
        k === 'sessionId' ||
        k === 'projectRoot' ||
        k === 'workspaceRoot' ||
        k === 'workflowId'
      ) {
        continue;
      }
      if (/\balias\b/iu.test(desc)) {
        continue;
      }
      if (optionalAdded >= 3) {
        continue;
      }
      optionalAdded += 1;
    }

    template[k] = defaultValueForSchemaProp(k, p);
  }

  return Object.keys(template).length === 0
    ? '{}'
    : JSON.stringify(template, null, 2);
}

export function insertParamIntoArgs(
  rawArgs: string,
  key: string,
  prop: unknown,
): string {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(rawArgs || '{}');
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate)
    ) {
      parsed = { ...candidate };
    }
  } catch {
    parsed = {};
  }

  if (!(key in parsed)) {
    parsed[key] = defaultValueForSchemaProp(key, prop);
  }

  return JSON.stringify(parsed, null, 2);
}

export function toolSafety(
  tool: McpToolDefinition | null | undefined,
): 'read-only' | 'destructive' | 'mutating' {
  if (tool?.annotations?.readOnlyHint === true) {
    return 'read-only';
  }
  if (tool?.annotations?.destructiveHint === true) {
    return 'destructive';
  }
  return 'mutating';
}
