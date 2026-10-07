import { FreshStartError } from "../fresh-start/contracts.js";

function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
function wellFormed(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}
/** Copies only own data descriptors. Charging includes escaped keys/strings and JSON punctuation. */
export function copyBoundedProtocolData(value: unknown, maximumBytes: 8192 | 16384): unknown {
  let bytes = 0, containers = 0;
  const charge = (amount: number) => { bytes += amount; if (bytes > maximumBytes) invalid(); };
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null) { charge(4); return null; }
    if (typeof input === "string") {
      if (!wellFormed(input) || input.length > 2048 || Buffer.byteLength(input, "utf8") > 2048) invalid();
      charge(Buffer.byteLength(JSON.stringify(input), "utf8")); return input;
    }
    if (typeof input === "boolean") { charge(input ? 4 : 5); return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) invalid(); charge(JSON.stringify(input).length); return input; }
    if (typeof input !== "object" || depth > 8 || ++containers > 128) invalid();
    const prototype: unknown = Object.getPrototypeOf(input);
    const array = Array.isArray(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(input);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(input, "length");
      if (!length || !("value" in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 64
        || keys.length !== length.value + 1) invalid();
      const descriptors: PropertyDescriptor[] = [];
      for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
        descriptors.push(descriptor);
      }
      if (keys.some(key => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)))) invalid();
      charge(2 + Math.max(0, descriptors.length - 1));
      const output: unknown[] = [];
      for (const descriptor of descriptors) output.push(copy(descriptor.value, depth + 1));
      return Object.freeze(output);
    }
    if (keys.length > 32) invalid();
    charge(2 + Math.max(0, keys.length - 1));
    const descriptors: [string, PropertyDescriptor][] = [];
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 128) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      if (!wellFormed(key)) invalid();
      charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 1); descriptors.push([key, descriptor]);
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of descriptors) output[key] = copy(descriptor.value, depth + 1);
    return Object.freeze(output);
  };
  try { return copy(value, 0); } catch { return invalid(); }
}
/** Measurement is for already copied data only; it is not validation or authority. */
export function encodedProtocolBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
