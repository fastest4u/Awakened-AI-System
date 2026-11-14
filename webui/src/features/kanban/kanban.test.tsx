import { describe, it, expect } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/render-app';
import type { NoteItem } from '@/api/types';

describe('Kanban page', () => {
  const sampleNotes: NoteItem[] = [
    {
      id: 'n1',
      recordId: 'n1',
      kind: 'insight',
      recordKind: 'insight',
      title: 'Candidate Note 1',
      summary: 'Candidate summary 1',
      body: 'Body 1',
      status: 'provisional',
      filePaths: ['src/candidate.ts'],
      symbols: ['candidateSym'],
      wikilinks: [],
      sessionId: 'sess-1',
    },
    {
      id: 'n2',
      recordId: 'n2',
      kind: 'adr',
      recordKind: 'adr',
      title: 'Verified Note 2',
      summary: 'Verified summary 2',
      body: 'Body 2',
      status: 'active',
      filePaths: ['src/verified.ts'],
      symbols: ['verifiedSym'],
      wikilinks: [],
      sessionId: 'sess-2',
    },
    {
      id: 'n3',
      recordId: 'n3',
      kind: 'mistake',
      recordKind: 'mistake',
      title: 'Archived Note 3',
      summary: 'Archived summary 3',
      body: 'Body 3',
      status: 'superseded',
      filePaths: ['src/archived.ts'],
      symbols: ['archivedSym'],
      wikilinks: [],
      sessionId: 'sess-3',
    },
  ];

  it('debounces search into one request', async () => {
    const user = userEvent.setup();
    const notesRequests: string[] = [];

    const { router } = renderApp({
      initialUrl: '/kanban',
      fetchHandler: (url) => {
        if (url.startsWith('/api/notes')) {
          notesRequests.push(url);
          return new Response(
            JSON.stringify({
              ok: true,
              projectRoot: 'C:\\default',
              items: sampleNotes,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    const searchInput = await screen.findByPlaceholderText(
      /พิมพ์ค้นหาความจำ ชื่อไฟล์ หรือฟังก์ชัน/,
    );
    expect(searchInput).toBeInTheDocument();

    // Initial load request
    await waitFor(() => {
      expect(notesRequests.length).toBeGreaterThanOrEqual(1);
    });
    const initialCount = notesRequests.length;

    // Type quickly: r, e, d, i, s
    await user.type(searchInput, 'redis');

    // Wait for debounce and subsequent request
    await waitFor(
      () => {
        // Exactly one new request with query=redis
        const newRequests = notesRequests.slice(initialCount);
        expect(newRequests.length).toBe(1);
        expect(newRequests[0]).toContain('query=redis');
        expect((router.state.location.search as any)?.q).toBe('redis');
      },
      { timeout: 2000 },
    );
  });

  it('retract requires confirmation', async () => {
    const user = userEvent.setup();
    const governancePosts: any[] = [];

    renderApp({
      initialUrl: '/kanban',
      fetchHandler: async (url, init) => {
        if (url.startsWith('/api/notes')) {
          return new Response(
            JSON.stringify({
              ok: true,
              projectRoot: 'C:\\default',
              items: sampleNotes,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/governance' && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          governancePosts.push(body);
          return new Response(
            JSON.stringify({
              ok: true,
              action: body.action,
              result: { success: true },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    // Wait for candidate note card
    await screen.findByText('Candidate Note 1');

    // Find retract buttons (one per card)
    const retractButtons = screen.getAllByRole('button', { name: 'ถอนคืน' });
    expect(retractButtons.length).toBeGreaterThan(0);

    // Click retract on the first note
    await user.click(retractButtons[0]);

    // No POST before confirmation
    expect(governancePosts.length).toBe(0);

    // Confirm dialog must appear
    const dialogTitle = await screen.findByText(
      'ยืนยันการถอนคืนความจำ (Confirm Retract)',
    );
    expect(dialogTitle).toBeInTheDocument();

    // Type reason
    const reasonInput = document.getElementById(
      'kanban-confirm-reason-input',
    ) as HTMLInputElement;
    expect(reasonInput).toBeInTheDocument();
    await user.type(reasonInput, 'Testing retract reason');

    // Click confirm button
    const confirmButton = screen.getByRole('button', {
      name: 'ยืนยันการดำเนินการ',
    });
    await user.click(confirmButton);

    // Now exactly one POST to /api/governance
    await waitFor(() => {
      expect(governancePosts.length).toBe(1);
      expect(governancePosts[0]).toMatchObject({
        action: 'retract',
        recordId: 'n1',
        reason: 'Testing retract reason',
        projectRoot: 'C:\\default',
      });
    });
  });

  it('promote only on candidates', async () => {
    renderApp({
      initialUrl: '/kanban',
      fetchHandler: (url) => {
        if (url.startsWith('/api/notes')) {
          return new Response(
            JSON.stringify({
              ok: true,
              projectRoot: 'C:\\default',
              items: sampleNotes,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    // Wait for notes to load
    await screen.findByText('Candidate Note 1');
    await screen.findByText('Verified Note 2');

    // Candidate card should have promote button
    const candidateCard = screen.getByText('Candidate Note 1').closest('[data-slot="card"]')!;
    expect(candidateCard).toHaveTextContent('อนุมัติ (Promote)');

    // Verified card should NOT have promote button
    const verifiedCard = screen.getByText('Verified Note 2').closest('[data-slot="card"]')!;
    expect(verifiedCard).not.toHaveTextContent('อนุมัติ (Promote)');
  });

  it('quick entry IME-safe Enter', async () => {
    const user = userEvent.setup();
    const governancePosts: any[] = [];

    renderApp({
      initialUrl: '/kanban',
      fetchHandler: async (url, init) => {
        if (url.startsWith('/api/notes')) {
          return new Response(
            JSON.stringify({
              ok: true,
              projectRoot: 'C:\\default',
              items: sampleNotes,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/governance' && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          governancePosts.push(body);
          return new Response(
            JSON.stringify({
              ok: true,
              action: body.action,
              result: { success: true },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    const titleInput = (await screen.findByPlaceholderText(
      'หัวข้อสั้นๆ เข้าใจง่าย...',
    )) as HTMLInputElement;
    const summaryInput = (await screen.findByPlaceholderText(
      /รายละเอียด \+ ระบุไฟล์/,
    )) as HTMLInputElement;

    await user.type(titleInput, 'New ADR Title');
    await user.type(summaryInput, 'New ADR Summary');

    // Press Enter with IME composing = true -> no POST
    fireEvent.keyDown(titleInput, {
      key: 'Enter',
      keyCode: 13,
      isComposing: true,
    });
    expect(governancePosts.length).toBe(0);

    // Press Enter without composing -> POST
    fireEvent.keyDown(titleInput, {
      key: 'Enter',
      keyCode: 13,
      isComposing: false,
    });

    await waitFor(() => {
      expect(governancePosts.length).toBe(1);
      expect(governancePosts[0]).toMatchObject({
        action: 'writeADR',
        title: 'New ADR Title',
        summary: 'New ADR Summary',
        content: 'New ADR Summary',
        projectRoot: 'C:\\default',
      });
    });
  });

  it('table mode', async () => {
    const user = userEvent.setup();

    renderApp({
      initialUrl: '/kanban',
      fetchHandler: (url) => {
        if (url.startsWith('/api/notes')) {
          return new Response(
            JSON.stringify({
              ok: true,
              projectRoot: 'C:\\default',
              items: sampleNotes,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    await screen.findByText('Candidate Note 1');

    // Click table mode button
    const tableModeButton = screen.getByRole('button', {
      name: /มุมมองตาราง \(Table\)/,
    });
    await user.click(tableModeButton);

    // Table headers should now be present
    expect(await screen.findByText('หมวดหมู่')).toBeInTheDocument();
    expect(screen.getByText('หัวข้อ (Title)')).toBeInTheDocument();
    expect(screen.getByText('สถานะ')).toBeInTheDocument();
    expect(screen.getByText('จัดการ')).toBeInTheDocument();
  });
});
