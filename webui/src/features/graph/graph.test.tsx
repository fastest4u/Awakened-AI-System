import { describe, it, expect } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/render-app';
import type { GraphResponse } from '@/api/types';

describe('Knowledge Graph page', () => {
  const sampleGraph: GraphResponse = {
    ok: true,
    projectRoot: 'C:\\default',
    nodes: [
      {
        id: 'session:sess-1',
        label: 'Session 1',
        kind: 'session',
        sessionId: 'sess-1',
        currentTask: 'Auth refactor and token security',
      },
      {
        id: 'note:rec-1',
        label: 'Token Refresh Pattern',
        kind: 'note',
        subkind: 'adr',
        recordId: 'rec-1',
        sessionId: 'sess-1',
        status: 'verified',
        summary: 'Implements sliding window refresh for JWT tokens',
      },
      {
        id: 'file:src/auth.ts',
        label: 'src/auth.ts',
        kind: 'file',
      },
      {
        id: 'symbol:refreshToken',
        label: 'refreshToken',
        kind: 'symbol',
      },
    ],
    edges: [
      {
        source: 'session:sess-1',
        target: 'note:rec-1',
        relation: 'created-in-session',
      },
      {
        source: 'note:rec-1',
        target: 'file:src/auth.ts',
        relation: 'touches-file',
      },
      {
        source: 'file:src/auth.ts',
        target: 'symbol:refreshToken',
        relation: 'defines-symbol',
      },
    ],
    stats: {
      sessionNodes: 1,
      noteNodes: 1,
      fileNodes: 1,
      symbolNodes: 1,
      edgeCount: 3,
    },
  };

  it('selecting a node updates URL and inspector', async () => {
    const { router } = renderApp({
      initialUrl: '/graph',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(sampleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText('แผนผังความเชื่อมโยงเข้าใจง่าย: เซสชัน AI ➔ ความจำ ➔ ไฟล์ ➔ โค้ด'),
      ).toBeInTheDocument();
    });

    // Node is rendered in canvas
    const fileNodeEl = await waitFor(() => {
      const el = document.querySelector('[data-node-id="file:src/auth.ts"]');
      expect(el).not.toBeNull();
      return el!;
    });

    // Click the node
    fireEvent.click(fileNodeEl);

    // Inspector shows plain-language summary box
    await waitFor(() => {
      expect(
        screen.getByText('สรุปใจความสำคัญ (อ่านเข้าใจง่าย)'),
      ).toBeInTheDocument();
      expect(screen.getByText(/ไฟล์ 'src\/auth.ts'/)).toBeInTheDocument();
    });

    // URL search param updated to node=file:src/auth.ts
    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.node).toBe('file:src/auth.ts');
    });
  });

  it('double-click note opens note sheet', async () => {
    const { router } = renderApp({
      initialUrl: '/graph',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(sampleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    const noteNodeEl = await waitFor(() => {
      const el = document.querySelector('[data-node-id="note:rec-1"]');
      expect(el).not.toBeNull();
      return el!;
    });

    // Double click the note node (simulating two clicks within 400ms or doubleClick)
    fireEvent.click(noteNodeEl);
    fireEvent.click(noteNodeEl);

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.note).toBe('rec-1');
    });
  });

  it('mode switch keeps svg mounted', async () => {
    renderApp({
      initialUrl: '/graph',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(sampleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    await waitFor(() => {
      expect(document.querySelector('#knowledge-graph-canvas')).not.toBeNull();
    });

    const svgBefore = document.querySelector('#knowledge-graph-canvas');

    // Switch to orbital layout
    const orbitalBtn = screen.getByRole('button', {
      name: /มุมมองเครือข่ายวงโคจร/i,
    });
    fireEvent.click(orbitalBtn);

    // Verify same SVG instance is still mounted
    const svgAfter = document.querySelector('#knowledge-graph-canvas');
    expect(svgAfter).toBe(svgBefore);

    // Switch back to flow layout
    const flowBtn = screen.getByRole('button', {
      name: /มุมมองลำดับเรื่องราว/i,
    });
    fireEvent.click(flowBtn);
    expect(document.querySelector('#knowledge-graph-canvas')).toBe(svgBefore);
  });

  it('filters by kind and session, and provides zoom HUD', async () => {
    const { router } = renderApp({
      initialUrl: '/graph',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(sampleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    await waitFor(() => {
      expect(document.querySelector('#graph-zoom-hud')).not.toBeNull();
    });

    // Check HUD buttons
    const hud = document.querySelector('#graph-zoom-hud')!;
    const zoomInBtn = hud.querySelector('button[title="ซูมเข้า"]') as HTMLButtonElement;
    const zoomOutBtn = hud.querySelector('button[title="ซูมออก"]') as HTMLButtonElement;
    const resetZoomBtn = hud.querySelector('button[title="รีเซ็ตมุมมอง 100%"]') as HTMLButtonElement;
    const focusBtn = hud.querySelector('button[title="ซูมโฟกัสจุดที่เลือก"]') as HTMLButtonElement;

    expect(zoomInBtn).not.toBeNull();
    expect(zoomOutBtn).not.toBeNull();
    expect(resetZoomBtn).not.toBeNull();
    expect(focusBtn).not.toBeNull();

    // Click zoom in
    fireEvent.click(zoomInBtn);
    expect(resetZoomBtn.textContent).toBe('125%');

    // Click zoom out
    fireEvent.click(zoomOutBtn);
    expect(resetZoomBtn.textContent).toBe('100%');

    // Focus selected
    fireEvent.click(focusBtn);
    expect(resetZoomBtn.textContent).toBe('175%');

    // Reset zoom
    fireEvent.click(resetZoomBtn);
    expect(resetZoomBtn.textContent).toBe('100%');

    // Click Kind filter for Note
    const noteFilterBtn = screen.getByRole('button', { name: /ความจำ/i });
    fireEvent.click(noteFilterBtn);

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.kind).toBe('note');
    });

    // Click Session filter
    const sessionSelect = document.getElementById(
      'graph-session-filter',
    ) as HTMLSelectElement;
    expect(sessionSelect).not.toBeNull();
    fireEvent.change(sessionSelect, { target: { value: 'sess-1' } });

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.session).toBe('sess-1');
    });
  });

  it('resolves raw recordId from deep-link search.node without note: prefix', async () => {
    renderApp({
      initialUrl: '/graph?node=rec-1',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(sampleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    await waitFor(() => {
      expect(
        screen.getAllByText('Token Refresh Pattern').length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getByText('สรุปใจความสำคัญ (อ่านเข้าใจง่าย)'),
      ).toBeInTheDocument();
    });

    // The note is selected and its related session is shown in inspector
    expect(screen.getByText(/เซสชัน AI ที่เกี่ยวข้อง/)).toBeInTheDocument();
  });

  it('syncs external URL search param updates without stomping', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({
      initialUrl: '/graph',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(sampleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    const searchInput = (await screen.findByPlaceholderText(
      'ค้นหาชื่อเรื่อง, ชื่อไฟล์ หรือฟังก์ชันในกราฟ...',
    )) as HTMLInputElement;

    // Simulate external deep-link navigation / back-forward
    await act(async () => {
      await router.navigate({
        to: '/graph',
        search: (prev: any) => ({ ...prev, q: 'auth' }),
        replace: true,
      });
    });

    await waitFor(() => {
      expect(searchInput.value).toBe('auth');
    });

    // Now type locally
    await user.clear(searchInput);
    await user.type(searchInput, 'token');

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.q).toBe('token');
    });
  });

  it('clicking related items in inspector refocused the node', async () => {
    const { router } = renderApp({
      initialUrl: '/graph?node=note:rec-1',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(sampleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/ไฟล์ซอร์สโค้ดที่เกี่ยวข้อง/)).toBeInTheDocument();
    });

    // Click related file badge in inspector
    const fileBadge = screen.getByText('src/auth.ts');
    fireEvent.click(fileBadge);

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.node).toBe('file:src/auth.ts');
    });
  });

  it('supports keyboard navigation (Enter and Space) on related elements in inspector', async () => {
    const { router } = renderApp({
      initialUrl: '/graph?node=note:rec-1',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(sampleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/ไฟล์ซอร์สโค้ดที่เกี่ยวข้อง/)).toBeInTheDocument();
    });

    // 1. Related file badge responds to Enter
    const fileBadge = screen.getByRole('button', { name: /src\/auth\.ts/ });
    fireEvent.keyDown(fileBadge, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.node).toBe('file:src/auth.ts');
    });

    // Now on file:src/auth.ts, inspector shows related note and related symbol
    await waitFor(() => {
      expect(screen.getByText(/ความจำ & บทเรียนที่เชื่อมโยง/)).toBeInTheDocument();
      expect(screen.getByText(/ฟังก์ชัน \/ คลาสที่เกี่ยวข้อง/)).toBeInTheDocument();
    });

    // 2. Related symbol responds to Enter
    const symbolBadge = screen.getByRole('button', { name: /refreshToken/ });
    fireEvent.keyDown(symbolBadge, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.node).toBe('symbol:refreshToken');
    });

    // Go back to file:src/auth.ts to test Space on related note
    await act(async () => {
      await router.navigate({
        to: '/graph',
        search: (prev: any) => ({ ...prev, node: 'file:src/auth.ts' }),
      });
    });

    const noteItem = await waitFor(() => {
      const el = screen.getByRole('button', { name: /Token Refresh Pattern/ });
      expect(el).toBeInTheDocument();
      return el;
    });

    // 3. Related note responds to Space
    fireEvent.keyDown(noteItem, { key: ' ', code: 'Space' });

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.node).toBe('note:rec-1');
    });
  });
});
