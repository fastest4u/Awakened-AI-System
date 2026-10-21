import { randomUUID } from "node:crypto";
import type { MessagePort } from "node:worker_threads";
import {
  HistoricalEvidenceKeyUnavailableError,
  type HistoricalEvidenceIntegrityProviderPort,
} from "../integrity/integrity.types.js";
import {
  MAX_INTEGRITY_PROVIDER_INPUT_BYTES,
  decodeIntegrityProviderRequestWire,
  decodeIntegrityProviderResponseWire,
  type IntegrityProviderRequestWire,
} from "./worker-protocol.js";

type ProviderStatus = "available" | "revoked" | "unavailable";
type ProviderOperation = "status" | "fingerprint";

interface PendingProviderOperation {
  readonly providerRequestId: string;
  readonly operation: ProviderOperation;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
}

class IntegrityProviderClientError extends Error {
  constructor(readonly code: "INTEGRITY_FAILURE" | "WORKER_PROTOCOL_ERROR") {
    super(code);
    this.name = "IntegrityProviderClientError";
  }
}

function protocolError(): IntegrityProviderClientError {
  return new IntegrityProviderClientError("WORKER_PROTOCOL_ERROR");
}

const INTRINSIC_UINT8_ARRAY_FILL = Uint8Array.prototype.fill;

function scrubOwnedBytes(bytes: Uint8Array | undefined): void {
  if (bytes === undefined) return;
  try {
    INTRINSIC_UINT8_ARRAY_FILL.call(bytes, 0);
  } catch {
    // A successful transfer detaches the canonical copy.
  }
}

export class WorkerIntegrityProviderClient implements HistoricalEvidenceIntegrityProviderPort {
  readonly #port: Pick<MessagePort, "postMessage">;
  readonly #integrityRequestId: string;
  readonly #mode: "quick" | "full";
  #pending: PendingProviderOperation | undefined;
  #disposed: Error | undefined;

  constructor(
    port: Pick<MessagePort, "postMessage">,
    integrityRequestId: string,
    mode: "quick" | "full",
  ) {
    this.#port = port;
    this.#integrityRequestId = integrityRequestId;
    this.#mode = mode;
  }

  accept(value: unknown): void {
    let response;
    try {
      response = decodeIntegrityProviderResponseWire(value);
    } catch {
      throw this.poison(protocolError());
    }
    const pending = this.#pending;
    if (
      this.#disposed !== undefined
      || pending === undefined
      || response.integrityRequestId !== this.#integrityRequestId
      || response.providerRequestId !== pending.providerRequestId
      || response.operation !== pending.operation
    ) {
      throw this.poison(protocolError());
    }
    this.#pending = undefined;
    if (!response.ok) {
      pending.reject(response.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
        ? new HistoricalEvidenceKeyUnavailableError()
        : new IntegrityProviderClientError(response.code));
      return;
    }
    pending.resolve(response.operation === "status" ? response.status : response.fingerprint);
  }

  dispose(error: Error = protocolError()): void {
    if (this.#disposed !== undefined) return;
    this.#disposed = error;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
  }

  status(keyId: string): Promise<ProviderStatus> {
    return this.start("status", keyId).then((value) => value as ProviderStatus);
  }

  fingerprint(keyId: string, bytes: Uint8Array): Promise<string> {
    if (
      this.#mode !== "full"
      || !(bytes instanceof Uint8Array)
      || bytes.byteLength < 1
      || bytes.byteLength > MAX_INTEGRITY_PROVIDER_INPUT_BYTES
    ) {
      return Promise.reject(protocolError());
    }
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    return this.start("fingerprint", keyId, owned);
  }

  private start(
    operation: "status",
    keyId: string,
  ): Promise<ProviderStatus>;
  private start(
    operation: "fingerprint",
    keyId: string,
    bytes: Uint8Array,
  ): Promise<string>;
  private start(
    operation: ProviderOperation,
    keyId: string,
    bytes?: Uint8Array,
  ): Promise<string> {
    if (this.#disposed !== undefined) {
      scrubOwnedBytes(bytes);
      return Promise.reject(this.#disposed);
    }
    if (this.#pending !== undefined) {
      scrubOwnedBytes(bytes);
      return Promise.reject(protocolError());
    }
    const providerRequestId = randomUUID();
    let request: IntegrityProviderRequestWire;
    try {
      request = decodeIntegrityProviderRequestWire(operation === "status"
        ? {
            type: "integrity-provider-request",
            integrityRequestId: this.#integrityRequestId,
            providerRequestId,
            operation,
            keyId,
          }
        : {
            type: "integrity-provider-request",
            integrityRequestId: this.#integrityRequestId,
            providerRequestId,
            operation,
            keyId,
            bytes,
          });
    } catch {
      scrubOwnedBytes(bytes);
      return Promise.reject(protocolError());
    }
    return new Promise<string>((resolve, reject) => {
      this.#pending = { providerRequestId, operation, resolve, reject };
      try {
        if (request.operation === "fingerprint") {
          const transferable = request.bytes.buffer;
          if (!(transferable instanceof ArrayBuffer)) throw protocolError();
          this.#port.postMessage(request, [transferable]);
          scrubOwnedBytes(request.bytes);
        } else {
          this.#port.postMessage(request);
        }
      } catch {
        if (request.operation === "fingerprint") scrubOwnedBytes(request.bytes);
        this.poison(protocolError());
      }
    });
  }

  private poison(error: Error): Error {
    this.dispose(error);
    return error;
  }
}
