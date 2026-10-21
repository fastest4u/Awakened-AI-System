import { LifecycleError } from "../errors.js";

export class SecretString {
  #value: string | null;

  static from(value: string): SecretString {
    if (value.length === 0) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    return new SecretString(value);
  }

  private constructor(value: string) {
    this.#value = value;
  }

  withValue<T>(operation: (value: string) => T): T {
    if (this.#value === null) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    return operation(this.#value);
  }

  destroy(): void {
    this.#value = null;
  }

  toString(): "[REDACTED]" {
    return "[REDACTED]";
  }

  toJSON(): undefined {
    if (process.env.NODE_ENV !== "production") throw new Error("SECRET_SERIALIZATION_BLOCKED");
    return undefined;
  }
}
