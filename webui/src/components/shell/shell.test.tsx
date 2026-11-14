import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/render-app';

describe('App Shell', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders five Thai nav items', async () => {
    renderApp({ initialUrl: '/overview' });

    await waitFor(() => {
      expect(screen.getAllByText('ภาพรวม & กราฟ').length).toBeGreaterThan(0);
      expect(screen.getAllByText('จัดการความจำ').length).toBeGreaterThan(0);
      expect(screen.getAllByText('กราฟเชื่อมโยง').length).toBeGreaterThan(0);
      expect(screen.getAllByText('ผู้ช่วย AI ดูแลความจำ').length).toBeGreaterThan(0);
      expect(screen.getAllByText('เครื่องมือนักพัฒนา').length).toBeGreaterThan(0);
    });
  });

  it('nav keeps project param', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ initialUrl: '/overview?project=C%3A%5Cp' });

    await waitFor(() => {
      expect(screen.getAllByText('กราฟเชื่อมโยง').length).toBeGreaterThan(0);
    });

    const graphNavBtn = screen.getAllByRole('link', { name: /กราฟเชื่อมโยง/ })[0]
      ?? screen.getAllByText('กราฟเชื่อมโยง')[0].closest('a')!;

    await user.click(graphNavBtn);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/graph');
      expect(router.state.location.search).toEqual({ project: 'C:\\p' });
    });
  });

  it('theme toggle persists', async () => {
    const user = userEvent.setup();
    renderApp({ initialUrl: '/overview' });

    // Initial default theme is dark
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    const themeButton = await screen.findByRole('button', { name: /โหมดสว่าง \(Light\)/i });
    await user.click(themeButton);

    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(localStorage.getItem('pm-v2-theme')).toBe('light');
  });

  it('slash jumps to kanban search, IME ignored', async () => {
    const { router } = renderApp({ initialUrl: '/overview' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/overview');
    });

    // keydown '/' with isComposing: true -> stays at /overview
    fireEvent.keyDown(document.body, { key: '/', keyCode: 229, isComposing: true });
    expect(router.state.location.pathname).toBe('/overview');

    // keydown '/' without composition -> jumps to /kanban and focuses #kanban-search-input
    fireEvent.keyDown(document.body, { key: '/', code: 'Slash' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/kanban');
    });

    const searchInput = document.getElementById('kanban-search-input');
    expect(searchInput).not.toBeNull();
    expect(document.activeElement).toBe(searchInput);
  });

  it('Ctrl+K opens command palette', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ initialUrl: '/overview' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/overview');
    });

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const searchInput = await screen.findByPlaceholderText('ค้นหาเมนู ความจำ หรือคำสั่ง...');
    expect(searchInput).toBeInTheDocument();

    const kanbanItem = await screen.findByRole('option', { name: /จัดการความจำ/ });
    await user.click(kanbanItem);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/kanban');
    });
  });

  it('project switcher lists projects', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({
      initialUrl: '/overview',
      projects: [
        { projectRoot: 'C:\\alpha', name: 'alpha', mode: 'active', initialized: true, productionReady: true },
        { projectRoot: 'C:\\beta', name: 'beta', mode: 'prepared', initialized: true, productionReady: false },
      ],
    });

    const select = (await screen.findByRole('combobox', { name: /โปรเจกต์/ })) as HTMLSelectElement
      ?? document.getElementById('project-switcher-select') as HTMLSelectElement;

    expect(select).not.toBeNull();
    expect(screen.getByText('alpha (active)')).toBeInTheDocument();
    expect(screen.getByText('beta (prepared)')).toBeInTheDocument();

    await user.selectOptions(select, 'C:\\beta');

    await waitFor(() => {
      expect(router.state.location.search).toEqual(expect.objectContaining({ project: 'C:\\beta' }));
    });
  });
});
