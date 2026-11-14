export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

const DEFAULT_RETRY_BASE_DELAY_MS = 120;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

let bootstrapCache: { csrfToken: string; defaultProjectRoot: string } | null = null;
let retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS;

export function setApiRetryBaseDelayMs(ms: number): void {
  retryBaseDelayMs = Math.max(0, ms);
}

export function resetBootstrap(): void {
  bootstrapCache = null;
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
    );
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithExponentialBackoff(
  url: string,
  init?: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (init?.signal?.aborted) {
      throw (
        init.signal.reason ??
        new DOMException('The operation was aborted.', 'AbortError')
      );
    }
    try {
      const res = await fetch(url, init);
      if (!RETRYABLE_HTTP_STATUSES.has(res.status) || attempt === maxRetries) {
        return res;
      }
    } catch (err) {
      lastError = err;
      if (
        init?.signal?.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        throw err;
      }
      if (attempt === maxRetries) {
        throw err;
      }
    }
    const delayMs = retryBaseDelayMs * 2 ** attempt;
    await sleepWithSignal(delayMs, init?.signal ?? undefined);
  }
  throw lastError instanceof Error ? lastError : new Error('Request failed');
}

export async function getBootstrap(
  forceFetch = false,
): Promise<{ csrfToken: string; defaultProjectRoot: string }> {
  if (!forceFetch && bootstrapCache) {
    return bootstrapCache;
  }

  if (!forceFetch) {
    const metaToken = document
      .querySelector('meta[name="pm-csrf-token"]')
      ?.getAttribute('content');
    const metaProj = document
      .querySelector('meta[name="pm-default-project"]')
      ?.getAttribute('content');
    if (metaToken && metaProj) {
      bootstrapCache = { csrfToken: metaToken, defaultProjectRoot: metaProj };
      return bootstrapCache;
    }
  }

  const res = await fetchWithExponentialBackoff('/api/bootstrap', undefined, 3);
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok || (data && data.ok === false)) {
    throw new ApiError(
      res.status,
      data?.error || 'BOOTSTRAP_FAILED',
      data?.message || `Failed to bootstrap: ${res.status}`,
    );
  }

  bootstrapCache = {
    csrfToken: data.csrfToken,
    defaultProjectRoot: data.defaultProjectRoot,
  };

  const metaTokenEl = document.querySelector('meta[name="pm-csrf-token"]');
  if (metaTokenEl) {
    metaTokenEl.setAttribute('content', data.csrfToken);
  }

  return bootstrapCache;
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  let url = path;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== '') {
        searchParams.set(key, val);
      }
    }
    const qs = searchParams.toString();
    if (qs) {
      url += (url.includes('?') ? '&' : '?') + qs;
    }
  }

  const res = await fetchWithExponentialBackoff(
    url,
    { method: 'GET', signal },
    3,
  );
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok || (json && json.ok === false)) {
    throw new ApiError(
      res.status,
      json?.error || String(res.status),
      json?.message || json?.error,
    );
  }

  return json as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const boot = await getBootstrap();

  const doFetch = async (token: string) => {
    return fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-PM-CSRF-Token': token,
      },
      body: JSON.stringify(body),
    });
  };

  let res = await doFetch(boot.csrfToken);

  if (res.status === 403) {
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // ignore
    }

    if (json?.error === 'CSRF_TOKEN_INVALID') {
      resetBootstrap();
      const freshBoot = await getBootstrap(true);
      res = await doFetch(freshBoot.csrfToken);
      let retryJson: any = null;
      try {
        retryJson = await res.json();
      } catch {
        // ignore
      }

      if (!res.ok || (retryJson && retryJson.ok === false)) {
        throw new ApiError(
          res.status,
          retryJson?.error || String(res.status),
          retryJson?.message || retryJson?.error,
        );
      }

      return retryJson as T;
    }

    throw new ApiError(
      res.status,
      json?.error || String(res.status),
      json?.message || json?.error,
    );
  }

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok || (json && json.ok === false)) {
    throw new ApiError(
      res.status,
      json?.error || String(res.status),
      json?.message || json?.error,
    );
  }

  return json as T;
}
