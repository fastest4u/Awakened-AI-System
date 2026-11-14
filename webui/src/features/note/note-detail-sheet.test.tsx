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

  it('clicking a file or symbol badge navigates to /graph?q= and clears note param', async () => {
    const mockNote = {
      id: 'n1',
      recordId: 'n1',
      kind: 'insight',
      recordKind: 'insight',
      title: 'Performance Insight',
      summary: 'Caching queries improves responsiveness',
      body: 'Body text',
      status: 'verified',
      filePaths: ['src/api/queries.ts'],
      symbols: ['noteQuery'],
      wikilinks: [],
      sessionId: 'sess-1',
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

    const fileBadge = await screen.findByText('src/api/queries.ts');
    await userEvent.click(fileBadge);

    await waitFor(() => {
      const location = router.state.location;
      expect(location.pathname).toBe('/graph');
      const search = location.search as any;
      expect(search.q).toBe('src/api/queries.ts');
      expect(search.note).toBeUndefined();
    });
  });

  it('clicking a non-note wikilink navigates to /kanban?q= and clears note param', async () => {
    const mockNote = {
      id: 'n1',
      recordId: 'n1',
      kind: 'insight',
      recordKind: 'insight',
      title: 'Performance Insight',
      summary: 'Check related [[kanban-topic|Kanban Topic]]',
      body: 'Body text',
      status: 'verified',
      filePaths: [],
      symbols: [],
      wikilinks: ['kanban-topic'],
      sessionId: 'sess-1',
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

    const wikilinkBtn = await screen.findByRole('button', {
      name: 'Kanban Topic',
    });
    await userEvent.click(wikilinkBtn);

    await waitFor(() => {
      const location = router.state.location;
      expect(location.pathname).toBe('/kanban');
      const search = location.search as any;
      expect(search.q).toBe('kanban-topic');
      expect(search.note).toBeUndefined();
    });
  });

  it('clicking Focus in Graph navigates to /graph in a single atomic transition and clears note param', async () => {
    const mockNote = {
      id: 'n1',
      recordId: 'n1',
      kind: 'insight',
      recordKind: 'insight',
      title: 'Performance Insight',
      summary: 'Summary text',
      body: 'Body text',
      status: 'verified',
      filePaths: [],
      symbols: [],
      wikilinks: [],
      sessionId: 'sess-1',
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

    const navigateSpy = vi.spyOn(router, 'navigate');

    const focusBtn = await screen.findByRole('button', {
      name: /ดูความเชื่อมโยงในกราฟ/,
    });
    await userEvent.click(focusBtn);

    await waitFor(() => {
      const location = router.state.location;
      expect(location.pathname).toBe('/graph');
      const search = location.search as any;
      expect(search.node).toBe('n1');
      expect(search.note).toBeUndefined();
    });

    // Verify atomic single navigation call
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/graph',
      }),
    );
  });
});
