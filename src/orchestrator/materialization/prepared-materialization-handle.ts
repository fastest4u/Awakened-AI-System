import { isDeepStrictEqual } from "node:util";

import type { StoredEvent } from "../contracts/event.js";
import type {
  PendingLifecycleOutboxV1,
  PreparedMaterializationQueueV1,
} from "../lifecycle/materialization-queue.port.js";

type State = "prepared" | "validating-planned" | "planned" | "validating-committed" | "committed" | "failed";

interface RecordState {
  state: State;
  planned: StoredEvent | null;
}

function immutableEventSnapshot(event: StoredEvent): StoredEvent {
  const snapshot = structuredClone(event);
  const freeze = (value: unknown, seen = new Set<object>()): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) freeze(descriptor.value, seen);
    }
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

/** Owns the branded handle and makes invalid/reentrant transitions terminal. */
export class PreparedMaterializationHandleOwner {
  readonly #states = new WeakMap<object, RecordState>();

  create(pendingOutbox: PendingLifecycleOutboxV1): PreparedMaterializationQueueV1 {
    const handle = Object.freeze({ pendingOutbox }) as PreparedMaterializationQueueV1;
    this.#states.set(handle, { state: "prepared", planned: null });
    return handle;
  }

  capturePlanned(
    handle: PreparedMaterializationQueueV1,
    event: StoredEvent,
    validate: (event: StoredEvent) => void,
  ): void {
    const state = this.#require(handle, "prepared");
    state.state = "validating-planned";
    try {
      validate(event);
      state.planned = immutableEventSnapshot(event);
      state.state = "planned";
    } catch (error) {
      state.state = "failed";
      throw error;
    }
  }

  consumeCommitted(
    handle: PreparedMaterializationQueueV1,
    event: StoredEvent,
    validate: (event: StoredEvent) => void,
  ): void {
    const state = this.#require(handle, "planned");
    state.state = "validating-committed";
    try {
      validate(event);
      if (!isDeepStrictEqual(state.planned, event)) {
        throw new Error("Prepared materialization event mismatch");
      }
      state.state = "committed";
    } catch (error) {
      state.state = "failed";
      throw error;
    }
  }

  #require(handle: PreparedMaterializationQueueV1, expected: State): RecordState {
    const state = this.#states.get(handle);
    if (state === undefined) {
      throw new Error("Prepared materialization handle is not valid for this transition");
    }
    if (state.state !== expected) {
      state.state = "failed";
      throw new Error("Prepared materialization handle is not valid for this transition");
    }
    return state;
  }
}
