import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import {
  AppProviders,
  getOrCreateQueryClient,
  resetGlobalQueryClient,
  createDefaultQueryClient,
} from './app-providers';
import { ApiError } from '@/api/client';

describe('AppProviders & getOrCreateQueryClient retry logic', () => {
  beforeEach(() => {
    resetGlobalQueryClient();
  });

  it('default retry function skips retrying on 404, 403, and 409 ApiError but retries once on 500', () => {
    const qc = getOrCreateQueryClient();
    const retryFn = qc.getDefaultOptions().queries?.retry;
    expect(typeof retryFn).toBe('function');

    if (typeof retryFn === 'function') {
      // 404 should not retry
      expect(retryFn(0, new ApiError(404, 'NOTE_NOT_FOUND'))).toBe(false);
      // 403 should not retry
      expect(retryFn(0, new ApiError(403, 'CSRF_ORIGIN_DENIED'))).toBe(false);
      // 409 should not retry
      expect(retryFn(0, new ApiError(409, 'FRESH_START_RELEASE_MISMATCH'))).toBe(false);
      // 500 should retry once on failureCount 0
      expect(retryFn(0, new ApiError(500, 'INTERNAL_SERVER_ERROR'))).toBe(true);
      // 500 should stop retrying on failureCount 1
      expect(retryFn(1, new ApiError(500, 'INTERNAL_SERVER_ERROR'))).toBe(false);
      // Non-ApiError should retry once on failureCount 0
      expect(retryFn(0, new Error('Network failure'))).toBe(true);
      expect(retryFn(1, new Error('Network failure'))).toBe(false);
    }
  });

  it('does not retry 404 ApiError in useQuery (1 fetch total)', async () => {
    const qc = createDefaultQueryClient();
    qc.setDefaultOptions({
      queries: {
        ...qc.getDefaultOptions().queries,
        retryDelay: 0,
      },
    });

    const queryFn = vi
      .fn()
      .mockRejectedValue(new ApiError(404, 'NOTE_NOT_FOUND', 'Not found'));

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ['test-note-404'],
          queryFn,
        }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <AppProviders queryClient={qc}>{children}</AppProviders>
        ),
      },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(404);
  });

  it('does not retry 403 ApiError in useQuery (1 fetch total)', async () => {
    const qc = createDefaultQueryClient();
    qc.setDefaultOptions({
      queries: {
        ...qc.getDefaultOptions().queries,
        retryDelay: 0,
      },
    });

    const queryFn = vi
      .fn()
      .mockRejectedValue(
        new ApiError(403, 'CSRF_ORIGIN_DENIED', 'Forbidden'),
      );

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ['test-note-403'],
          queryFn,
        }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <AppProviders queryClient={qc}>{children}</AppProviders>
        ),
      },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(403);
  });

  it('retries once on transient 500 ApiError and recovers', async () => {
    const qc = createDefaultQueryClient();
    qc.setDefaultOptions({
      queries: {
        ...qc.getDefaultOptions().queries,
        retryDelay: 0,
      },
    });

    let calls = 0;
    const queryFn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        throw new ApiError(500, 'INTERNAL_SERVER_ERROR', 'Server error');
      }
      return { ok: true, data: 'recovered' };
    });

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ['test-retry-500'],
          queryFn,
        }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <AppProviders queryClient={qc}>{children}</AppProviders>
        ),
      },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual({ ok: true, data: 'recovered' });
  });
});
