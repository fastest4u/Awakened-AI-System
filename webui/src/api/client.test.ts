import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { apiPost, apiGet, resetBootstrap, ApiError } from './client';

describe('API Client', () => {
  beforeEach(() => {
    resetBootstrap();
    document.head.querySelectorAll('meta[name^="pm-"]').forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads csrf token from meta and sends it on POST', async () => {
    const metaToken = document.createElement('meta');
    metaToken.name = 'pm-csrf-token';
    metaToken.content = 'tok-meta';
    document.head.appendChild(metaToken);

    const metaProj = document.createElement('meta');
    metaProj.name = 'pm-default-project';
    metaProj.content = '/workspace/test';
    document.head.appendChild(metaProj);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, projectRoot: '/workspace/test', reply: 'ok' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiPost<{ ok: boolean; reply: string }>('/api/curator/chat', {
      message: 'hello',
    });

    expect(result).toEqual({ ok: true, projectRoot: '/workspace/test', reply: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/curator/chat');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      'content-type': 'application/json',
      'X-PM-CSRF-Token': 'tok-meta',
    });
    expect(JSON.parse(options.body)).toEqual({ message: 'hello' });
  });

  it('falls back to /api/bootstrap when meta is absent', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/bootstrap') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            csrfToken: 'tok-boot',
            defaultProjectRoot: '/boot/proj',
          }),
        };
      }
      if (url === '/api/curator/chat') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, reply: 'from-boot' }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiPost<{ ok: boolean; reply: string }>('/api/curator/chat', {
      message: 'hi',
    });

    expect(result).toEqual({ ok: true, reply: 'from-boot' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/bootstrap');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/curator/chat');
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      'content-type': 'application/json',
      'X-PM-CSRF-Token': 'tok-boot',
    });
  });

  it('retries once after CSRF_TOKEN_INVALID', async () => {
    let bootstrapCalls = 0;
    let postCalls = 0;
    const postHeaders: Record<string, string>[] = [];

    const fetchMock = vi.fn().mockImplementation(async (url: string, options?: any) => {
      if (url === '/api/bootstrap') {
        bootstrapCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            csrfToken: bootstrapCalls === 1 ? 'tok-old' : 'tok-new',
            defaultProjectRoot: '/proj',
          }),
        };
      }
      if (url === '/api/curator/chat') {
        postCalls++;
        postHeaders.push(options?.headers || {});
        if (postCalls === 1) {
          return {
            ok: false,
            status: 403,
            json: async () => ({
              ok: false,
              error: 'CSRF_TOKEN_INVALID',
              message: 'Invalid token',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, reply: 'success' }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiPost<{ ok: boolean; reply: string }>('/api/curator/chat', {
      action: 'test',
    });

    expect(result).toEqual({ ok: true, reply: 'success' });
    expect(postCalls).toBe(2);
    expect(postHeaders[0]['X-PM-CSRF-Token']).toBe('tok-old');
    expect(postHeaders[1]['X-PM-CSRF-Token']).toBe('tok-new');

    // A second consecutive 403 rejects with ApiError code CSRF_TOKEN_INVALID
    const alwaysFailFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/bootstrap') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, csrfToken: 'tok-bad', defaultProjectRoot: '/proj' }),
        };
      }
      return {
        ok: false,
        status: 403,
        json: async () => ({ ok: false, error: 'CSRF_TOKEN_INVALID', message: 'Still invalid' }),
      };
    });
    vi.stubGlobal('fetch', alwaysFailFetch);
    resetBootstrap();

    await expect(apiPost('/api/curator/chat', {})).rejects.toThrow(ApiError);
    try {
      await apiPost('/api/curator/chat', {});
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('CSRF_TOKEN_INVALID');
      expect(err.status).toBe(403);
    }
  });

  it('maps error JSON to ApiError', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        ok: false,
        error: 'NOTE_NOT_FOUND',
        message: 'ไม่พบข้อมูลความจำที่ระบุ',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    let thrownError: any;
    try {
      await apiGet('/api/notes/missing');
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(ApiError);
    expect(thrownError.status).toBe(404);
    expect(thrownError.code).toBe('NOTE_NOT_FOUND');
    expect(thrownError.message).toBe('ไม่พบข้อมูลความจำที่ระบุ');
  });
});
