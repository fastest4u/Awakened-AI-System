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

  it('renders rich glassmorphic card nodes, column guides, MiniMap, quick-open sheet button, and valid CSS colors without nested hsl(var(--...))', async () => {
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

    const stage = await waitFor(() => {
      const el = document.querySelector('#knowledge-graph-canvas');
      expect(el).not.toBeNull();
      return el!;
    });

    await waitFor(() => {
      expect(document.querySelector('[data-node-id="note:rec-1"]')).not.toBeNull();
      expect(document.querySelector('[data-node-id="file:src/auth.ts"]')).not.toBeNull();
      expect(document.querySelector('[data-node-id="symbol:refreshToken"]')).not.toBeNull();
      expect(document.querySelector('[data-node-id="session:sess-1"]')).not.toBeNull();
    });

    // Flow stage header pills render all 4 narrative columns
    const colGuidesText = stage.querySelector('#flow-column-guides')?.textContent ?? '';
    expect(colGuidesText).toContain('จุดเริ่มต้นของงาน');
    expect(colGuidesText).toContain('การตัดสินใจ & บทเรียน');
    expect(colGuidesText).toContain('ซอร์สโค้ดที่เกี่ยวข้อง');
    expect(colGuidesText).toContain('โมดูลที่ได้รับผลกระทบ');

    // Rich custom card content: full human labels + separated file dir/basename
    const sessionCard = stage.querySelector('[data-node-id="session:sess-1"]')!;
    const noteCard = stage.querySelector('[data-node-id="note:rec-1"]')!;
    const fileCard = stage.querySelector('[data-node-id="file:src/auth.ts"]')!;
    const symbolCard = stage.querySelector('[data-node-id="symbol:refreshToken"]')!;

    expect(sessionCard.textContent).toContain('Auth refactor and token security');
    expect(noteCard.textContent).toContain('Token Refresh Pattern');
    expect(fileCard.textContent).toContain('auth.ts');
    expect(fileCard.textContent).toContain('src/');
    expect(symbolCard.textContent).toContain('refreshToken');

    // MiniMap and zero nested hsl/rgb/oklch(var(--...))
    expect(stage.querySelector('.react-flow__minimap')).not.toBeNull();
    expect(stage.outerHTML).not.toMatch(/(hsl|rgb|oklch)\(var\(--/);

    // Quick-open button [data-action="open-note"] opens NoteDetailSheet directly
    const openBtn = noteCard.querySelector('[data-action="open-note"]') as HTMLButtonElement;
    expect(openBtn).not.toBeNull();
    fireEvent.click(openBtn);
    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.note).toBe('rec-1');
    });
  });

  it('defaults to focused related-only mode hiding unrelated nodes and toggles back with #graph-focus-related-toggle', async () => {
    const multiClusterGraph: GraphResponse = {
      ok: true,
      projectRoot: 'C:\\default',
      nodes: [
        {
          id: 'session:s1',
          label: 'Session Primary',
          kind: 'session',
          sessionId: 's1',
          currentTask: 'Primary Task',
        },
        {
          id: 'note:primary-1',
          label: 'Primary Note',
          kind: 'note',
          recordId: 'primary-1',
          sessionId: 's1',
          subkind: 'adr',
          status: 'verified',
        },
        {
          id: 'file:src/primary.ts',
          label: 'src/primary.ts',
          kind: 'file',
        },
        {
          id: 'symbol:primarySym',
          label: 'primarySym',
          kind: 'symbol',
        },
        {
          id: 'session:s2',
          label: 'Session Unrelated',
          kind: 'session',
          sessionId: 's2',
          currentTask: 'Unrelated Task',
        },
        {
          id: 'note:unrelated-2',
          label: 'Unrelated Note',
          kind: 'note',
          recordId: 'unrelated-2',
          sessionId: 's2',
          subkind: 'insight',
          status: 'verified',
        },
        {
          id: 'file:src/unrelated.ts',
          label: 'src/unrelated.ts',
          kind: 'file',
        },
        {
          id: 'symbol:unrelatedSym',
          label: 'unrelatedSym',
          kind: 'symbol',
        },
      ],
      edges: [
        { source: 'note:primary-1', target: 'session:s1', relation: 'created-in-session' },
        { source: 'note:primary-1', target: 'file:src/primary.ts', relation: 'touches-file' },
        { source: 'note:primary-1', target: 'symbol:primarySym', relation: 'mentions-symbol' },
        { source: 'note:unrelated-2', target: 'session:s2', relation: 'created-in-session' },
        { source: 'note:unrelated-2', target: 'file:src/unrelated.ts', relation: 'touches-file' },
        { source: 'note:unrelated-2', target: 'symbol:unrelatedSym', relation: 'mentions-symbol' },
      ],
      stats: {
        sessionNodes: 2,
        noteNodes: 2,
        fileNodes: 2,
        symbolNodes: 2,
        edgeCount: 6,
      },
    };

    renderApp({
      initialUrl: '/graph?node=note:primary-1',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(multiClusterGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await waitFor(() => {
      expect(document.querySelector('[data-node-id="note:primary-1"]')).toBeTruthy();
    });

    // Focused mode is on by default: unrelated nodes are hidden
    expect(document.querySelector('[data-node-id="file:src/primary.ts"]')).toBeTruthy();
    expect(document.querySelector('[data-node-id="symbol:primarySym"]')).toBeTruthy();
    expect(document.querySelector('[data-node-id="note:unrelated-2"]')).toBeNull();
    expect(document.querySelector('[data-node-id="file:src/unrelated.ts"]')).toBeNull();
    expect(document.querySelector('[data-node-id="symbol:unrelatedSym"]')).toBeNull();

    // Toggle to show all nodes
    const toggleBtn = document.querySelector('#graph-focus-related-toggle') as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn.textContent).toMatch(/แสดงทั้งหมด/);
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(document.querySelector('[data-node-id="note:unrelated-2"]')).toBeTruthy();
      expect(document.querySelector('[data-node-id="file:src/unrelated.ts"]')).toBeTruthy();
      expect(document.querySelector('[data-node-id="symbol:unrelatedSym"]')).toBeTruthy();
      expect(toggleBtn.textContent).toMatch(/เฉพาะที่เกี่ยวข้อง/);
    });
  });

  it('switches focused note cluster via #graph-note-select', async () => {
    const multiNoteGraph: GraphResponse = {
      ok: true,
      projectRoot: 'C:\\default',
      nodes: [
        {
          id: 'note:first',
          label: 'First Topic',
          kind: 'note',
          recordId: 'first',
          sessionId: 's1',
          subkind: 'adr',
        },
        {
          id: 'file:src/first.ts',
          label: 'src/first.ts',
          kind: 'file',
        },
        {
          id: 'note:second',
          label: 'Second Topic',
          kind: 'note',
          recordId: 'second',
          sessionId: 's2',
          subkind: 'mistake',
        },
        {
          id: 'file:src/second.ts',
          label: 'src/second.ts',
          kind: 'file',
        },
      ],
      edges: [
        { source: 'note:first', target: 'file:src/first.ts', relation: 'touches-file' },
        { source: 'note:second', target: 'file:src/second.ts', relation: 'touches-file' },
      ],
      stats: {
        sessionNodes: 0,
        noteNodes: 2,
        fileNodes: 2,
        symbolNodes: 0,
        edgeCount: 2,
      },
    };

    const { router } = renderApp({
      initialUrl: '/graph?node=note:first',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(multiNoteGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await waitFor(() => {
      expect(document.querySelector('[data-node-id="file:src/first.ts"]')).toBeTruthy();
    });

    const noteSelect = document.querySelector('#graph-note-select') as HTMLSelectElement;
    expect(noteSelect).toBeTruthy();
    fireEvent.change(noteSelect, { target: { value: 'note:second' } });

    await waitFor(() => {
      expect(router.state.location.searchStr).toContain('note%3Asecond');
      expect(document.querySelector('[data-node-id="note:second"]')).toBeTruthy();
      expect(document.querySelector('[data-node-id="file:src/second.ts"]')).toBeTruthy();
      expect(document.querySelector('[data-node-id="file:src/first.ts"]')).toBeNull();
    });
  });

  it('renders Orbital galaxy mode cards with full readable labels and non-overlapping ELK positions', async () => {
    const orbitalPoleGraph: GraphResponse = {
      ok: true,
      projectRoot: 'C:\\default',
      nodes: [
        { id: 'note:center', label: 'Center Note', kind: 'note', recordId: 'center', sessionId: 's1' },
        { id: 'symbol:sym1', label: 'sym1', kind: 'symbol' },
        { id: 'symbol:sym2', label: 'sym2', kind: 'symbol' },
        { id: 'symbol:sym3', label: 'sym3', kind: 'symbol' },
        { id: 'symbol:sym4', label: 'sym4', kind: 'symbol' },
        { id: 'symbol:sym5', label: 'sym5', kind: 'symbol' },
        { id: 'symbol:sym6', label: 'sym6', kind: 'symbol' },
        { id: 'symbol:sym7', label: 'sym7', kind: 'symbol' },
      ],
      edges: [
        { source: 'note:center', target: 'symbol:sym1', relation: 'mentions-symbol' },
        { source: 'note:center', target: 'symbol:sym2', relation: 'mentions-symbol' },
        { source: 'note:center', target: 'symbol:sym3', relation: 'mentions-symbol' },
        { source: 'note:center', target: 'symbol:sym4', relation: 'mentions-symbol' },
        { source: 'note:center', target: 'symbol:sym5', relation: 'mentions-symbol' },
        { source: 'note:center', target: 'symbol:sym6', relation: 'mentions-symbol' },
        { source: 'note:center', target: 'symbol:sym7', relation: 'mentions-symbol' },
      ],
      stats: {
        sessionNodes: 0,
        noteNodes: 1,
        fileNodes: 0,
        symbolNodes: 7,
        edgeCount: 7,
      },
    };

    renderApp({
      initialUrl: '/graph?node=note:center',
      fetchHandler: (url) => {
        if (url.startsWith('/api/graph')) {
          return new Response(JSON.stringify(orbitalPoleGraph), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const orbitalBtn = await waitFor(() =>
      screen.getByRole('button', { name: /มุมมองเครือข่ายวงโคจร/i }),
    );
    fireEvent.click(orbitalBtn);

    await waitFor(() => {
      const stage = document.querySelector('#knowledge-graph-canvas')!;
      const cards = stage.querySelectorAll('[data-node-id]');
      expect(cards.length).toBe(8);
      for (let i = 1; i <= 7; i++) {
        const card = stage.querySelector(`[data-node-id="symbol:sym${i}"]`);
        expect(card).not.toBeNull();
        expect(card?.textContent).toContain(`sym${i}`);
      }
      expect(stage.textContent).toContain('ELK Galaxy');
    });
  });
});
