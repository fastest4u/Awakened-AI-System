function invalid(): never {
  throw new TypeError("CANONICAL_JSON_INVALID");
}

function isDataProperty(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && "value" in descriptor;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) invalid();
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      return invalid();
  }

  if (ancestors.has(value)) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) invalid();

      const names = Object.getOwnPropertyNames(descriptors);
      if (names.length !== length + 1 || !names.includes("length")) invalid();

      const items: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!isDataProperty(descriptor) || descriptor.enumerable !== true) invalid();
        items.push(serialize(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();

    const entries: string[] = [];
    const keys = Object.getOwnPropertyNames(descriptors).sort();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!isDataProperty(descriptor) || descriptor.enumerable !== true) invalid();
      entries.push(`${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}
