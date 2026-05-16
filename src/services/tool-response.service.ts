export interface ToolEnvelope<T> {
  ok: boolean;
  data?: T;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: {
    tool: string;
    elapsedMs: number;
  };
}

export interface ToolTextResult<T> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolEnvelope<T>;
}

export interface ToolErrorResult extends ToolTextResult<never> {
  isError: true;
}

const okEnvelope = <T>(tool: string, startedAt: number, data: T, warnings: string[] = []): ToolEnvelope<T> => ({
  ok: true,
  data,
  warnings,
  meta: { tool, elapsedMs: Date.now() - startedAt },
});

const errorEnvelope = (
  tool: string,
  startedAt: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ToolEnvelope<never> => ({
  ok: false,
  error: { code, message, details },
  meta: { tool, elapsedMs: Date.now() - startedAt },
});

const textResult = <T>(payload: ToolEnvelope<T>): ToolTextResult<T> => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
});

export class ToolResponseService {
  buildOk<T>(tool: string, startedAt: number, data: T, warnings: string[] = []): ToolTextResult<T> {
    return textResult(okEnvelope(tool, startedAt, data, warnings));
  }

  buildError(tool: string, startedAt: number, code: string, message: string, details: Record<string, unknown> = {}): ToolErrorResult {
    return {
      ...textResult(errorEnvelope(tool, startedAt, code, message, details)),
      isError: true,
    };
  }
}
