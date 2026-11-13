import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/render-app';

describe('NoteDetailSheet', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('opens from ?note= and copies id', async () => {
    const mockNote = {
      id: 'n1',
      recordId: 'n1',
      kind: 'insight',
      recordKind: 'insight',
      title: 'Performance Insight',
      summary: 'Caching queries improves responsiveness',
      body: { format: 'markdown', body: '## Implementation\n\nUse React Query hooks [[note:n2|ดู n2]].' },
      status: 'verified',
      filePaths: ['src/api/queries.ts'],
      symbols: ['noteQuery'],
      wikilinks: ['note:n2'],
      sessionId: 'sess-1',
    };

    renderApp({
      initialUrl: '/kanban?note=n1',
      fetchHandler: (url) => {
        if (url.includes('/api/notes/n1')) {
          return new Response(
            JSON.stringify({
              ok: true,
              projectRoot: 'C:\\default',
              note: mockNote,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    // Heading exists
    expect(
      await screen.findByRole('heading', {
        name: 'รายละเอียดความจำ (Human-Readable Memory View)',
      }),
    ).toBeInTheDocument();

    // Human title & summary rendered
    expect(await screen.findByText('Performance Insight')).toBeInTheDocument();
    expect(
      screen.getByText('Caching queries improves responsiveness'),
    ).toBeInTheDocument();

    // Verify [object Object] is absent from DOM
    expect(document.body.textContent).not.toContain('[object Object]');

    // Click "คัดลอก ID"
    const copyIdBtn = screen.getByRole('button', { name: 'คัดลอก ID' });
    await userEvent.click(copyIdBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('n1');
  });

  it('escape closes and clears param', async () => {
    const mockNote = {
      id: 'n1',
      recordId: 'n1',
      kind: 'adr',
      recordKind: 'adr',
      title: 'Decide on Vite',
      summary: 'Vite chosen for fast builds',
      body: 'Body text here',
      status: 'active',
      filePaths: [],
      symbols: [],
      wikilinks: [],
      sessionId: null,
    };

    const { router } = renderApp({
      initialUrl: '/kanban?note=n1',
      fetchHandler: (url) => {
        if (url.includes('/api/notes/n1')) {
          return new Response(
            JSON.stringify({
              ok: true,
              projectRoot: 'C:\\default',
              note: mockNote,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    await screen.findByRole('heading', {
      name: 'รายละเอียดความจำ (Human-Readable Memory View)',
    });

    // Trigger Escape on document
    fireEvent.keyDown(document.activeElement || document.body, {
      key: 'Escape',
      code: 'Escape',
    });

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.note).toBeUndefined();
      expect(router.state.location.pathname).toBe('/kanban');
    });
  });

  it('404 shows Thai error', async () => {
    renderApp({
      initialUrl: '/kanban?note=missing-id',
      fetchHandler: (url) => {
        if (url.includes('/api/notes/missing-id')) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: 'NOTE_NOT_FOUND',
              message: 'ไม่พบข้อมูลความจำที่ระบุ',
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    // Should display Thai error alert instead of staying in loading state
    expect(
      await screen.findByText(/ไม่พบข้อมูลความจำที่ระบุ/),
    ).toBeInTheDocument();
  });
});
