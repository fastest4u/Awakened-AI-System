import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/render-app';

describe('Overview page', () => {
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;

  beforeAll(() => {
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        width: 500,
        height: 300,
        top: 0,
        left: 0,
        bottom: 300,
        right: 500,
        x: 0,
        y: 0,
        toJSON: () => {},
      };
    };
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 300,
    });
  });

  afterAll(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it('renders KPIs and charts', async () => {
    const mockOverview = {
      ok: true,
      projectRoot: 'C:\\default',
      projectName: 'default',
      status: 'active',
      audit: {
        healthScore: 90,
        counts: {
          verifiedNotes: 4,
          unpromotedCandidates: 2,
          conflictedNotes: 1,
          duplicateGroups: 1,
        },
        recommendations: [
          {
            title: 'ตรวจสอบ Candidate',
            description: 'มี Candidate รอการอนุมัติ 2 รายการ',
            priority: 'high',
          },
        ],
        duplicateGroups: [],
      },
      analytics: {
        byStatus: { verified: 4, candidate: 2, conflicted: 1 },
        byKind: { adr: 2, insight: 2, mistake: 1, 'session-log': 1 },
        activitySeries: [
          { label: 'S-1', notes: 3, verified: 2, sessions: 1 },
          { label: 'Now', notes: 6, verified: 4, sessions: 2 },
        ],
      },
      lifecycle: {
        sessions: [
          {
            sessionId: 's-12345678-abc',
            currentTask: 'Task 1 in progress',
            semanticState: 'active',
            kind: 'root',
            noteCount: 2,
            noteTitles: ['Decision on DB', 'Mistake in Auth'],
            noteIds: ['adr-1', 'mis-1'],
            inProgressItems: ['Subtask 1', 'Subtask 2'],
            filesTouched: ['src/db.ts'],
          },
        ],
        latestCheckpoint: { id: 'cp-1' },
      },
      causalTriads: [
        {
          anchorMistakeId: 'mis-1',
          mistakeTitle: 'Mistake in Auth',
          relatedAdrs: [{ recordId: 'adr-1', title: 'ADR 1 Auth Fix' }],
          relatedInsights: [{ recordId: 'ins-1', title: 'Insight 1 Token Rotation' }],
          sharedContext: ['file:src/auth.ts', 'symbol:verifyToken', 'session:s-12345678'],
        },
      ],
    };

    renderApp({
      initialUrl: '/overview',
      fetchHandler: (url) => {
        if (url.startsWith('/api/overview')) {
          return new Response(JSON.stringify(mockOverview), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    // Check KPI score
    expect(await screen.findByText('90/100')).toBeInTheDocument();

    // Check health tone label
    expect(screen.getByText('สมบูรณ์ดีเยี่ยม (Healthy)')).toBeInTheDocument();

    // Check "รออนุมัติ (Candidates)" card shows 2
    const candidateCardLabel = screen.getByText('รออนุมัติ (Candidates)');
    const candidateCard = candidateCardLabel.closest('[data-slot="card"]') || candidateCardLabel.parentElement;
    expect(candidateCard).toHaveTextContent('2');

    // Check "ความจำซ้ำ / ขัดแย้ง" shows 2 (conflictedNotes: 1 + duplicateGroups: 1)
    const conflictCardLabel = screen.getByText('ความจำซ้ำ / ขัดแย้ง');
    const conflictCard = conflictCardLabel.closest('[data-slot="card"]') || conflictCardLabel.parentElement;
    expect(conflictCard).toHaveTextContent('2');
  });

  it('renders empty vault without NaN', async () => {
    const emptyOverview = {
      ok: true,
      projectRoot: 'C:\\default',
      projectName: 'default',
      status: 'active',
      audit: {
        healthScore: 0,
        counts: {
          verifiedNotes: 0,
          unpromotedCandidates: 0,
          conflictedNotes: 0,
          duplicateGroups: 0,
        },
        recommendations: [],
        duplicateGroups: [],
      },
      analytics: {
        byStatus: {},
        byKind: {},
        activitySeries: [],
      },
      lifecycle: {
        sessions: [],
        latestCheckpoint: null,
      },
      causalTriads: [],
    };

    renderApp({
      initialUrl: '/overview',
      fetchHandler: (url) => {
        if (url.startsWith('/api/overview')) {
          return new Response(JSON.stringify(emptyOverview), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    // Score is 0/100
    expect(await screen.findByText('0/100')).toBeInTheDocument();

    // Must never render "NaN" anywhere
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('triad and session pills open notes', async () => {
    const mockOverview = {
      ok: true,
      projectRoot: 'C:\\default',
      projectName: 'default',
      status: 'active',
      audit: {
        healthScore: 88,
        counts: { verifiedNotes: 2, unpromotedCandidates: 0, conflictedNotes: 0, duplicateGroups: 0 },
        recommendations: [],
        duplicateGroups: [],
      },
      analytics: {
        byStatus: {},
        byKind: {},
        activitySeries: [],
      },
      lifecycle: {
        sessions: [
          {
            sessionId: 'sess-abc-1234',
            currentTask: 'Build feature',
            semanticState: 'ended',
            kind: 'root',
            noteCount: 1,
            noteTitles: ['Linked Session Note'],
            noteIds: ['note-session-1'],
            inProgressItems: [],
            filesTouched: ['src/app.ts'],
          },
        ],
        latestCheckpoint: null,
      },
      causalTriads: [
        {
          anchorMistakeId: 'mis-triad-1',
          mistakeTitle: 'Bug in query invalidation',
          relatedAdrs: [{ recordId: 'adr-triad-1', title: 'ADR Query Cache Fix' }],
          relatedInsights: [{ recordId: 'ins-triad-1', title: 'Insight Invalidation Strategy' }],
          sharedContext: ['file:src/cache.ts'],
        },
      ],
    };

    const { router } = renderApp({
      initialUrl: '/overview',
      fetchHandler: (url) => {
        if (url.startsWith('/api/overview')) {
          return new Response(JSON.stringify(mockOverview), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    // Find and click the session note pill
    const sessionPill = await screen.findByText('Linked Session Note');
    await userEvent.click(sessionPill);

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.note).toBe('note-session-1');
    });

    // Close NoteDetailSheet so background elements are interactive
    fireEvent.keyDown(document.activeElement || document.body, {
      key: 'Escape',
      code: 'Escape',
    });

    await waitFor(() => {
      const search = router.state.location.search as any;
      expect(search.note).toBeUndefined();
    });

    // Find and click "ดูในกราฟ" button on the triad card
    const graphButton = screen.getByRole('button', { name: /ดูในกราฟ/ });
    await userEvent.click(graphButton);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/graph');
      const search = router.state.location.search as any;
      expect(search.node).toBe('mis-triad-1');
    });
  });

  it('sessions table filters', async () => {
    const mockOverview = {
      ok: true,
      projectRoot: 'C:\\default',
      projectName: 'default',
      status: 'active',
      audit: {
        healthScore: 95,
        counts: { verifiedNotes: 3, unpromotedCandidates: 0, conflictedNotes: 0, duplicateGroups: 0 },
        recommendations: [],
        duplicateGroups: [],
      },
      analytics: {
        byStatus: {},
        byKind: {},
        activitySeries: [],
      },
      lifecycle: {
        sessions: [
          {
            sessionId: 'sess-alpha-001',
            currentTask: 'Alpha migration task',
            semanticState: 'ended',
            kind: 'root',
            noteCount: 1,
            noteTitles: [],
            noteIds: [],
            inProgressItems: [],
            filesTouched: [],
          },
          {
            sessionId: 'sess-beta-002',
            currentTask: 'Beta optimization pipeline',
            semanticState: 'active',
            kind: 'child',
            noteCount: 2,
            noteTitles: [],
            noteIds: [],
            inProgressItems: [],
            filesTouched: [],
          },
        ],
        latestCheckpoint: null,
      },
      causalTriads: [],
    };

    renderApp({
      initialUrl: '/overview',
      fetchHandler: (url) => {
        if (url.startsWith('/api/overview')) {
          return new Response(JSON.stringify(mockOverview), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    await screen.findByText('95/100');

    const table = document.querySelector('table');
    expect(table).toBeInTheDocument();
    expect(within(table!).getByText(/Alpha migration task/)).toBeInTheDocument();
    expect(within(table!).getByText(/Beta optimization pipeline/)).toBeInTheDocument();

    const filterInput = document.getElementById('session-table-filter') as HTMLInputElement;
    expect(filterInput).toBeInTheDocument();

    await userEvent.type(filterInput, 'Alpha');

    expect(within(table!).getByText(/Alpha migration task/)).toBeInTheDocument();
    expect(within(table!).queryByText(/Beta optimization pipeline/)).not.toBeInTheDocument();
  });
});
