import { describe, it, expect } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/render-app';
import type { CuratorAudit, CuratorChatReply, AutoCurateReceipt } from '@/api/types';

describe('AI Curator page', () => {
  it('chips prefill textarea', async () => {
    const user = userEvent.setup();
    renderApp({
      initialUrl: '/curator',
    });

    const adrChip = await screen.findByRole('button', { name: '+ ADR' });
    const chatInput = (await screen.findByPlaceholderText(
      /พิมพ์คำสั่งหรือคำถาม/,
    )) as HTMLTextAreaElement;

    expect(chatInput).toBeInTheDocument();
    expect(chatInput.id).toBe('curator-chat-input');
    expect(chatInput.value).toBe('');

    await user.click(adrChip);
    expect(chatInput.value).toBe('บันทึก ADR: ');
    expect(document.activeElement).toBe(chatInput);

    // Test + Insight chip
    const insightChip = screen.getByRole('button', { name: '+ Insight' });
    await user.click(insightChip);
    expect(chatInput.value).toBe('บันทึก Insight: ');
    expect(document.activeElement).toBe(chatInput);

    // Test + Mistake chip
    const mistakeChip = screen.getByRole('button', { name: '+ Mistake' });
    await user.click(mistakeChip);
    expect(chatInput.value).toBe('บันทึก Mistake: ');
    expect(document.activeElement).toBe(chatInput);

    // Test Search chip
    const searchChip = screen.getByRole('button', { name: 'ค้นหา' });
    await user.click(searchChip);
    expect(chatInput.value).toBe('ค้นหา ');
    expect(document.activeElement).toBe(chatInput);
  });

  it('Enter sends, Shift+Enter and IME do not', async () => {
    const chatRequests: { url: string; body: any }[] = [];

    renderApp({
      initialUrl: '/curator',
      fetchHandler: (url, options) => {
        if (url.startsWith('/api/curator/chat')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          chatRequests.push({ url, body });
          const reply: CuratorChatReply = {
            projectRoot: 'C:\\default',
            reply: 'บันทึกข้อมูลเรียบร้อยแล้ว',
            intent: 'write_adr',
            executedTools: ['memory_list', 'memory_writeADR'],
          };
          return new Response(JSON.stringify(reply), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    const chatInput = await screen.findByPlaceholderText(/พิมพ์คำสั่งหรือคำถาม/);

    // Set input value
    fireEvent.change(chatInput, { target: { value: 'บันทึก ADR เรื่อง DB' } });

    // 1. Enter while IME is composing (isComposing: true)
    fireEvent.keyDown(chatInput, { key: 'Enter', isComposing: true });
    expect(chatRequests).toHaveLength(0);

    // 2. Enter with keyCode 229 (IME composing code)
    fireEvent.keyDown(chatInput, { key: 'Enter', keyCode: 229 });
    expect(chatRequests).toHaveLength(0);

    // 3. Shift + Enter (newline, should not send)
    fireEvent.keyDown(chatInput, { key: 'Enter', shiftKey: true });
    expect(chatRequests).toHaveLength(0);

    // 4. Plain Enter sends!
    fireEvent.keyDown(chatInput, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(chatRequests).toHaveLength(1);
    });

    expect(chatRequests[0].body).toEqual({
      projectRoot: 'C:\\default',
      message: 'บันทึก ADR เรื่อง DB',
      autoExecute: true,
    });

    // Verify reply text and tool badge rendered
    await screen.findByText('บันทึกข้อมูลเรียบร้อยแล้ว');
    expect(await screen.findByText('memory_list')).toBeInTheDocument();
  });

  it('dry-run sends autoExecute false and skips invalidation', async () => {
    const chatRequests: { url: string; body: any }[] = [];
    let overviewFetches = 0;

    renderApp({
      initialUrl: '/curator',
      fetchHandler: (url, options) => {
        if (url.startsWith('/api/overview')) {
          overviewFetches++;
        }
        if (url.startsWith('/api/curator/chat')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          chatRequests.push({ url, body });
          const reply: CuratorChatReply = {
            projectRoot: 'C:\\default',
            reply: 'จำลองการรันคำสั่งเสร็จสิ้น',
            intent: 'dry_run',
            executedTools: ['memory_list'],
          };
          return new Response(JSON.stringify(reply), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    const dryRunToggle = (await screen.findByRole('checkbox', {
      name: /โหมดจำลองก่อนเขียนจริง \(Dry-Run\)/,
    })) as HTMLInputElement;

    expect(dryRunToggle).toBeInTheDocument();
    expect(dryRunToggle.id).toBe('curator-dry-run-toggle');
    expect(dryRunToggle.checked).toBe(false);

    // Enable dry-run mode
    fireEvent.click(dryRunToggle);
    expect(dryRunToggle.checked).toBe(true);

    const initialOverviewFetches = overviewFetches;

    const chatInput = screen.getByPlaceholderText(/พิมพ์คำสั่งหรือคำถาม/);
    fireEvent.change(chatInput, { target: { value: 'ตรวจเช็คความจำ' } });
    fireEvent.keyDown(chatInput, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(chatRequests).toHaveLength(1);
    });

    expect(chatRequests[0].body.autoExecute).toBe(false);

    // Verify response is rendered
    await screen.findByText('จำลองการรันคำสั่งเสร็จสิ้น');

    // Overview query must NOT have been refetched because autoExecute was false
    expect(overviewFetches).toBe(initialOverviewFetches);
  });

  it('duplicate ids open note', async () => {
    const auditData: CuratorAudit = {
      projectRoot: 'C:\\default',
      healthScore: 88,
      counts: { duplicateGroups: 1 },
      recommendations: [
        { title: 'พบความจำซ้ำ', description: 'กรุณายุบรวมรายการที่ซ้ำ' },
      ],
      duplicateGroups: [
        {
          title: 'กลุ่มความจำซ้ำ: API Auth Cache',
          keeperRecordId: 'keeper-rec-1',
          duplicateRecordIds: ['dup-rec-2', 'dup-rec-3'],
        },
      ],
    };

    const user = userEvent.setup();
    const { router } = renderApp({
      initialUrl: '/curator',
      fetchHandler: (url) => {
        if (url.startsWith('/api/curator/audit')) {
          return new Response(JSON.stringify(auditData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    // Wait for duplicate group to appear
    await screen.findByText('กลุ่มความจำซ้ำ: API Auth Cache');

    // Duplicate button test
    const dupButton = await screen.findByRole('button', { name: /dup-rec-2/ });
    expect(dupButton).toBeInTheDocument();

    await user.click(dupButton);

    await waitFor(() => {
      expect((router.state.location.search as any)?.note).toBe('dup-rec-2');
    });
  });

  it('chat error toasts', async () => {
    renderApp({
      initialUrl: '/curator',
      fetchHandler: (url) => {
        if (url.startsWith('/api/curator/chat')) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: 'INTERNAL_ERROR',
              message: 'Database locked',
            }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
      },
    });

    const chatInput = await screen.findByPlaceholderText(/พิมพ์คำสั่งหรือคำถาม/);
    fireEvent.change(chatInput, { target: { value: 'คำสั่งล้มเหลว' } });
    fireEvent.keyDown(chatInput, { key: 'Enter', shiftKey: false });

    // Toast or message containing "ไม่สำเร็จ" should appear
    const match = await screen.findAllByText(/ไม่สำเร็จ/);
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  it('quick prompts send pre-configured messages', async () => {
    const user = userEvent.setup();
    const chatRequests: string[] = [];

    renderApp({
      initialUrl: '/curator',
      fetchHandler: (url, options) => {
        if (url.startsWith('/api/curator/chat')) {
          const body = options?.body ? JSON.parse(options.body as string) : {};
          chatRequests.push(body.message);
          return new Response(
            JSON.stringify({
              projectRoot: 'C:\\default',
              reply: `ได้รับคำสั่ง: ${body.message}`,
              intent: 'quick_prompt',
              executedTools: ['memory_checkStaleness'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    const quickAuditBtn = await screen.findByRole('button', { name: /ตรวจสุขภาพความจำ/ });
    await user.click(quickAuditBtn);

    await waitFor(() => {
      expect(chatRequests).toContain('ช่วยตรวจสุขภาพความจำและหาความจำซ้ำ');
    });

    await screen.findByText('ได้รับคำสั่ง: ช่วยตรวจสุขภาพความจำและหาความจำซ้ำ');
  });

  it('auto-curate runs and renders receipt banner', async () => {
    const user = userEvent.setup();
    let autoCurateCalled = false;
    const receiptData: AutoCurateReceipt = {
      projectRoot: 'C:\\default',
      beforeHealthScore: 72,
      afterHealthScore: 96,
      promoted: ['cand-1', 'cand-2'],
      superseded: ['dup-1'],
      expired: ['stale-1'],
    };

    renderApp({
      initialUrl: '/curator',
      fetchHandler: (url) => {
        if (url.startsWith('/api/curator/auto-curate')) {
          autoCurateCalled = true;
          return new Response(JSON.stringify(receiptData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    const autoCurateBtn = await screen.findByRole('button', {
      name: /จัดระเบียบอัตโนมัติ/,
    });
    await user.click(autoCurateBtn);

    await waitFor(() => {
      expect(autoCurateCalled).toBe(true);
    });

    // Verify receipt banner rendered
    await screen.findByText(/ผลการจัดระเบียบล่าสุด/);
    const scoreMatches = await screen.findAllByText(/Health Score: 72 → 96\/100/);
    expect(scoreMatches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/อนุมัติ Candidate: 2/)).toBeInTheDocument();
    expect(screen.getByText(/ยุบรวมความจำซ้ำ: 1/)).toBeInTheDocument();
    expect(screen.getByText(/หมดอายุ: 1/)).toBeInTheDocument();
  });

  it('auto-curate error toasts on failure', async () => {
    const user = userEvent.setup();

    renderApp({
      initialUrl: '/curator',
      fetchHandler: (url) => {
        if (url.startsWith('/api/curator/auto-curate')) {
          return new Response(
            JSON.stringify({ ok: false, error: 'AUTO_CURATE_FAILED', message: 'Vault is busy' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }
      },
    });

    const autoCurateBtn = await screen.findByRole('button', {
      name: /จัดระเบียบอัตโนมัติ/,
    });
    await user.click(autoCurateBtn);

    // Toast error containing "ไม่สำเร็จ"
    const match = await screen.findAllByText(/ไม่สำเร็จ/);
    expect(match.length).toBeGreaterThanOrEqual(1);
  });
});
