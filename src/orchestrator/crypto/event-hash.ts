import { createHash } from "node:crypto";
import { canonicalJson } from "../serialization/canonical-json.js";

function hashDomain(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalJson(value)}`, "utf8").digest("hex");
}

export const payloadHash = (value: unknown): string => hashDomain("project-memory/payload/v1", value);
export const commandHash = (value: unknown): string => hashDomain("project-memory/command/v1", value);
export const responseHash = (value: unknown): string => hashDomain("project-memory/response/v1", value);
export const eventHash = (value: unknown): string => hashDomain("project-memory/event/v1", value);
export const outboxHash = (value: unknown): string => hashDomain("project-memory/outbox/v1", value);
