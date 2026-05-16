import { z } from "zod";

export const roleSchema = z.enum(["viewer", "editor", "maintainer", "admin"]);
export const noteTypeSchema = z.enum([
  "note",
  "index",
  "moc",
  "dashboard",
  "reference",
  "rules",
  "glossary",
  "identity",
  "goals",
  "adr",
  "session-log",
  "component",
  "source",
  "insight",
  "mistake",
  "runbook",
]);

export const confidenceSchema = z.enum(["high", "medium", "low", "guess"]);
export const sortSchema = z.enum(["relevance", "recent", "updated", "created", "name"]);
export const scopeSchema = z.enum(["vault", "folder", "index"]);

export const commonOutputMetaSchema = z.object({
  tool: z.string(),
  elapsedMs: z.number().int().nonnegative(),
});

export type Role = z.infer<typeof roleSchema>;
export type NoteType = z.infer<typeof noteTypeSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type SortBy = z.infer<typeof sortSchema>;
export type Scope = z.infer<typeof scopeSchema>;
