import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderApp } from '@/test/render-app';
import { pmKeys } from '@/api/queries';
import type { McpToolDefinition } from '@/api/types';

describe('MCP Console page', () => {
  const sampleTools: McpToolDefinition[] = [
    {
      name: 'memory_v2Status',
      description: 'Check v2 vault status',
      inputSchema: {
        properties: {},
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'memory_search',
      description: 'Search memory notes',
      inputSchema: {
        properties: {
          query: { type: 'string', description: 'Query string' },
          limit: { type: 'number', description: 'Max results' },
        },
        required: ['query'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'memory_forgetEvidence',
      description: 'Forget evidence permanently',
      inputSchema: {
        properties: {
          reason: { type: 'string', description: 'Reason for forgetting' },
        },
        required: ['reason'],
      },
      annotations: {
        destructiveHint: true,
      },
    },
  ];

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      writable: true,
      configurable: true,
    });
  });

  it('read-only run keeps cache', async () => {
    const user = userEvent.setup();
    const mcpCalls: any[] = [];
    const defaultProjectRoot = 'C:\\default';

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 60_000 },
      },
    });

    qc.setQueryData(pmKeys.overview(defaultProjectRoot), {
      ok: true,
      projectRoot: defaultProjectRoot,
      projectName: 'default',
      status: 'active',
      audit: { healthScore: 100 },
    });

    const stateBefore = qc.getQueryState(pmKeys.overview(defaultProjectRoot));
    const dataUpdatedAtBefore = stateBefore?.dataUpdatedAt;
    expect(dataUpdatedAtBefore).toBeDefined();

    renderApp({
      initialUrl: '/mcp',
      defaultProjectRoot,
      queryClient: qc,
      fetchHandler: (url, options) => {
        if (url === '/api/mcp/tools') {
          return new Response(
            JSON.stringify({ ok: true, tools: sampleTools }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/mcp/call') {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          mcpCalls.push(body);
          return new Response(
            JSON.stringify({
              ok: true,
              tool: body.tool,
              result: { status: 'healthy', tool: body.tool },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    // Verify badge Read-Only (อ่านอย่างเดียว)
    expect(
      await screen.findByText('Read-Only (อ่านอย่างเดียว)'),
    ).toBeInTheDocument();

    const executeBtn = screen.getByRole('button', {
      name: /รันคำสั่ง \(Execute\)/,
    });
    await user.click(executeBtn);

    await waitFor(() => {
      expect(mcpCalls.length).toBe(1);
    });

    expect(mcpCalls[0]).toEqual({
      tool: 'memory_v2Status',
      args: {},
      projectRoot: defaultProjectRoot,
    });

    // Check pre-seeded overview query dataUpdatedAt unchanged
    const stateAfter = qc.getQueryState(pmKeys.overview(defaultProjectRoot));
    expect(stateAfter?.dataUpdatedAt).toBe(dataUpdatedAtBefore);

    // Verify output <pre> shows result JSON
    const preEl = await screen.findByRole('region', { name: /response-output/i }).catch(() => null);
    const preOutput = preEl ?? document.querySelector('pre');
    expect(preOutput).not.toBeNull();
    expect(preOutput?.textContent).toContain('"status": "healthy"');
  });

  it('selecting a tool seeds template and pills insert params', async () => {
    const user = userEvent.setup();

    renderApp({
      initialUrl: '/mcp',
      fetchHandler: (url) => {
        if (url === '/api/mcp/tools') {
          return new Response(
            JSON.stringify({ ok: true, tools: sampleTools }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    // Wait for tool select to populate
    const select = (await screen.findByDisplayValue(
      /memory_v2Status/,
    )) as HTMLSelectElement;
    expect(select.id).toBe('mcp-tool-select');

    // Select memory_search
    await user.selectOptions(select, 'memory_search');

    const argsTextarea = document.getElementById(
      'mcp-tool-args',
    ) as HTMLTextAreaElement;
    expect(argsTextarea).not.toBeNull();
    expect(argsTextarea.value).toContain('"query"');

    // Clear / set args to {}
    fireEvent.change(argsTextarea, { target: { value: '{}' } });
    expect(argsTextarea.value).toBe('{}');

    // Click pill limit
    const limitPill = await screen.findByRole('button', { name: /limit/ });
    await user.click(limitPill);

    expect(argsTextarea.value).toContain('"limit": 10');
  });

  it('destructive tool needs confirmation', async () => {
    const user = userEvent.setup();
    const mcpCalls: any[] = [];

    renderApp({
      initialUrl: '/mcp',
      fetchHandler: (url, options) => {
        if (url === '/api/mcp/tools') {
          return new Response(
            JSON.stringify({ ok: true, tools: sampleTools }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/mcp/call') {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          mcpCalls.push(body);
          return new Response(
            JSON.stringify({
              ok: true,
              tool: body.tool,
              result: { status: 'forgotten' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    const select = (await screen.findByDisplayValue(
      /memory_v2Status/,
    )) as HTMLSelectElement;
    await user.selectOptions(select, 'memory_forgetEvidence');

    expect(
      await screen.findByText('Destructive (ลบ/ถอนคืนข้อมูล)'),
    ).toBeInTheDocument();

    const executeBtn = screen.getByRole('button', {
      name: /รันคำสั่ง \(Execute\)/,
    });
    await user.click(executeBtn);

    // No POST yet
    expect(mcpCalls.length).toBe(0);

    // Confirm dialog is shown with button ยืนยันรันคำสั่ง
    const confirmBtn = await screen.findByRole('button', {
      name: 'ยืนยันรันคำสั่ง',
    });
    expect(confirmBtn).toBeInTheDocument();

    await user.click(confirmBtn);

    await waitFor(() => {
      expect(mcpCalls.length).toBe(1);
    });

    expect(mcpCalls[0].tool).toBe('memory_forgetEvidence');
  });

  it('invalid JSON warns', async () => {
    const user = userEvent.setup();
    const mcpCalls: any[] = [];

    renderApp({
      initialUrl: '/mcp',
      fetchHandler: (url, options) => {
        if (url === '/api/mcp/tools') {
          return new Response(
            JSON.stringify({ ok: true, tools: sampleTools }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/mcp/call') {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          mcpCalls.push(body);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    await screen.findByDisplayValue(/memory_v2Status/);
    const argsTextarea = document.getElementById(
      'mcp-tool-args',
    ) as HTMLTextAreaElement;

    fireEvent.change(argsTextarea, { target: { value: '{' } });

    const executeBtn = screen.getByRole('button', {
      name: /รันคำสั่ง \(Execute\)/,
    });
    await user.click(executeBtn);

    // Verify warning toast
    const toasts = await screen.findAllByText('JSON Arguments ไม่ถูกต้อง');
    expect(toasts.length).toBeGreaterThanOrEqual(1);

    // Verify no POST
    expect(mcpCalls.length).toBe(0);
  });

  it('copy output', async () => {
    renderApp({
      initialUrl: '/mcp',
      fetchHandler: (url) => {
        if (url === '/api/mcp/tools') {
          return new Response(
            JSON.stringify({ ok: true, tools: sampleTools }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/mcp/call') {
          return new Response(
            JSON.stringify({
              ok: true,
              tool: 'memory_v2Status',
              result: { hello: 'world' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    await screen.findByDisplayValue(/memory_v2Status/);
    const executeBtn = screen.getByRole('button', {
      name: /รันคำสั่ง \(Execute\)/,
    });
    await userEvent.click(executeBtn);

    await screen.findByText(/"hello": "world"/);

    const copyBtn = screen.getByRole('button', { name: /คัดลอก JSON/ });
    await userEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('"hello": "world"'),
    );
  });
});
