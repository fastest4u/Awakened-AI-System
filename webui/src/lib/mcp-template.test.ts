import { describe, it, expect } from 'vitest';
import {
  defaultValueForSchemaProp,
  buildToolStarterJson,
  insertParamIntoArgs,
  toolSafety,
} from './mcp-template';
import type { McpToolDefinition } from '@/api/types';

describe('mcp-template', () => {
  it('supersede template', () => {
    const tool: McpToolDefinition = {
      name: 'memory_supersede',
      description: 'Supersede a record',
      inputSchema: {
        properties: {
          projectRoot: { type: 'string', description: 'Project root' },
          sessionId: { type: 'string', description: 'Session ID' },
          recordId: { type: 'string', description: 'Target record ID' },
          id: { type: 'string', description: 'Alias for recordId.' },
          supersedingRecordId: {
            type: 'string',
            description: 'New record ID',
          },
          reason: { type: 'string', description: 'Superseding reason' },
        },
        required: ['supersedingRecordId'],
      },
      annotations: {
        destructiveHint: false,
      },
    };

    const starterJson = buildToolStarterJson(tool);
    const parsed = JSON.parse(starterJson);

    expect(Object.keys(parsed)).toEqual([
      'recordId',
      'supersedingRecordId',
      'reason',
    ]);
    expect(parsed.recordId).toBe('');
    expect(parsed.supersedingRecordId).toBe('');
    expect(parsed.reason).toBe('');
  });

  it('defaults', () => {
    expect(defaultValueForSchemaProp('limit', { type: 'number' })).toBe(10);
    expect(defaultValueForSchemaProp('staleAfterDays', { type: 'integer' })).toBe(30);
    expect(defaultValueForSchemaProp('otherNum', { type: 'number' })).toBe(0);
    expect(
      defaultValueForSchemaProp('status', { enum: ['firstOption', 'secondOption'] }),
    ).toBe('firstOption');
    expect(defaultValueForSchemaProp('active', { type: 'boolean' })).toBe(true);
    expect(defaultValueForSchemaProp('tags', { type: 'array' })).toEqual([]);
    expect(defaultValueForSchemaProp('meta', { type: 'object' })).toEqual({});
    expect(defaultValueForSchemaProp('custom', { default: 'customVal' })).toBe(
      'customVal',
    );
    expect(defaultValueForSchemaProp('unknown', null)).toBe('');

    const noPropsTool: McpToolDefinition = {
      name: 'empty_tool',
      description: 'Tool without properties',
      inputSchema: {
        properties: {},
      },
    };
    expect(buildToolStarterJson(noPropsTool)).toBe('{}');
    expect(buildToolStarterJson(null)).toBe('{}');
    expect(buildToolStarterJson(undefined)).toBe('{}');
  });

  it('insertParamIntoArgs keeps edits', () => {
    const initialRaw = '{"query":"x"}';
    const result1 = insertParamIntoArgs(initialRaw, 'limit', { type: 'number' });
    const parsed1 = JSON.parse(result1);
    expect(parsed1).toEqual({ query: 'x', limit: 10 });

    const invalidRaw = 'not json';
    const result2 = insertParamIntoArgs(invalidRaw, 'reason', { type: 'string' });
    const parsed2 = JSON.parse(result2);
    expect(parsed2).toEqual({ reason: '' });

    // Preserves existing key value
    const existingRaw = '{"limit": 42}';
    const result3 = insertParamIntoArgs(existingRaw, 'limit', { type: 'number' });
    const parsed3 = JSON.parse(result3);
    expect(parsed3).toEqual({ limit: 42 });
  });

  it('toolSafety classifies hints correctly', () => {
    expect(
      toolSafety({
        name: 't1',
        description: '',
        inputSchema: { properties: {} },
        annotations: { readOnlyHint: true },
      }),
    ).toBe('read-only');

    expect(
      toolSafety({
        name: 't2',
        description: '',
        inputSchema: { properties: {} },
        annotations: { destructiveHint: true },
      }),
    ).toBe('destructive');

    expect(
      toolSafety({
        name: 't3',
        description: '',
        inputSchema: { properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    ).toBe('mutating');

    expect(toolSafety(null)).toBe('mutating');
  });
});
