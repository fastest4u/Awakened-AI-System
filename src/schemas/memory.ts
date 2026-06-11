import { z } from "zod";
import { confidenceSchema, noteTypeSchema, roleSchema, scopeSchema, sortSchema } from "./common.js";

const baseListSchema = z.object({
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
});

const contextPackModeSchema = z.enum(["auto", "coding", "debugging", "review", "deploy", "planning", "docs"]);

// Strict calendar date: slashes silently nest folders and ":" is invalid in
// Windows filenames (EINVAL), so anything but YYYY-MM-DD must be rejected.
const isoDateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

// Which indexed fields a query term must occur in (matches MemoryQueryService.SearchScope).
const searchScopeSchema = z.enum(["all", "title", "tags"]);

const confidenceLogEntrySchema = z.object({
  claim: z.string(),
  statedConfidence: confidenceSchema,
  actualResult: z.string(),
  lesson: z.string(),
}).strict();

export const searchInputSchema = z.object({
  query: z.string().min(1),
  tags: z.array(z.string()).default([]),
  folder: z.string().optional(),
  type: noteTypeSchema.optional(),
  limit: z.number().int().positive().max(100).default(10),
  offset: z.number().int().nonnegative().default(0),
  sortBy: sortSchema.default("relevance"),
  scope: searchScopeSchema.default("all").describe("Which fields must match: all (title+tags+aliases+type+body), title, or tags"),
  includeBody: z.boolean().default(false),
  includeSections: z.boolean().default(false).describe("Attach the best-matching heading anchor (section, line, snippet) to each hit"),
}).strict();

export const getInputSchema = z.object({
  path: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  includeBody: z.boolean().default(true),
  includeLinks: z.boolean().default(true),
}).strict().refine((value) => value.path || value.id || value.title, {
  message: "Provide path, id, or title",
});

export const listInputSchema = baseListSchema.extend({
  folder: z.string().optional(),
  type: noteTypeSchema.optional(),
  tag: z.string().optional(),
  sortBy: z.enum(["name", "updated", "created"]).default("updated"),
}).strict();

export const recentInputSchema = z.object({
  limit: z.number().int().positive().max(100).default(20),
  sortBy: z.enum(["updated", "created"]).default("updated"),
  folders: z.array(z.string()).default([]),
  types: z.array(noteTypeSchema).default([]),
}).strict();

export const relatedInputSchema = z.object({
  path: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(20).default(10),
  mode: z.enum(["links", "tags", "text", "hybrid"]).default("hybrid"),
}).strict().refine((value) => value.path || value.query, {
  message: "Provide path or query",
});

export const summarizeContextInputSchema = z.object({
  paths: z.array(z.string()).min(1),
  question: z.string().optional(),
  maxTokens: z.number().int().positive().max(8000).default(1200),
  style: z.enum(["brief", "detailed", "bullet"]).default("brief"),
}).strict();

export const writeSessionLogInputSchema = z.object({
  date: isoDateStringSchema.optional(),
  topic: z.string().min(1),
  agent: z.string().min(1),
  durationMinutes: z.number().int().positive().optional(),
  outcomes: z.array(z.string()).default([]),
  filesTouched: z.array(z.string()).default([]),
  decisionsMade: z.array(z.string()).default([]),
  openFollowUps: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  confidenceLog: z.array(confidenceLogEntrySchema).default([]),
}).strict();

export const writeInsightInputSchema = z.object({
  title: z.string().min(1),
  derivedFrom: z.array(z.string()).default([]),
  confidence: confidenceSchema,
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
}).strict();

export const writeMistakeInputSchema = z.object({
  title: z.string().min(1),
  area: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  occurredDate: isoDateStringSchema,
  agent: z.string().min(1),
  confidence: confidenceSchema,
  problem: z.string().min(1),
  rootCause: z.string().min(1),
  avoidance: z.string().min(1),
  references: z.array(z.string()).default([]),
}).strict();

export const writeAdRInputSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["proposed", "accepted", "superseded"]),
  decisionDate: isoDateStringSchema,
  confidence: confidenceSchema,
  context: z.string().min(1),
  decision: z.string().min(1),
  consequences: z.array(z.string()).default([]),
  supersedes: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
}).strict();

export const createFromTemplateInputSchema = z.object({
  template: z.enum(["session-log", "adr", "mistake", "insight", "runbook", "note"]),
  path: z.string().min(1),
  values: z.record(z.any()).default({}),
}).strict();

export const verifyNoteInputSchema = z.object({
  path: z.string().min(1),
  checkLinks: z.boolean().default(true),
  checkFrontmatter: z.boolean().default(true),
  checkStaleness: z.boolean().default(true),
}).strict();

export const verifySourceTruthInputSchema = z.object({
  path: z.string().min(1),
  claimsOnly: z.boolean().default(false),
}).strict();

export const findBrokenLinksInputSchema = z.object({
  folders: z.array(z.string()).default([]),
  limit: z.number().int().positive().max(1000).default(100),
}).strict();

export const findDuplicatesInputSchema = z.object({
  scope: scopeSchema.default("vault"),
  similarityThreshold: z.number().min(0).max(1).default(0.85),
}).strict();

export const checkStalenessInputSchema = z.object({
  folders: z.array(z.string()).default([]),
  olderThanDays: z.number().int().positive().default(90),
}).strict();

export const verifyVaultInputSchema = z.object({
  minScore: z.number().int().min(0).max(100).optional(),
  includeWarnings: z.boolean().default(true),
}).strict();

export const validateFrontmatterInputSchema = z.object({
  paths: z.array(z.string()).default([]),
  format: z.enum(["text", "json", "markdown"]).default("json"),
}).strict();

export const fixFrontmatterInputSchema = z.object({
  paths: z.array(z.string()).default([]),
  dryRun: z.boolean().default(true),
  backup: z.boolean().default(true),
  unsafe: z.boolean().default(false),
  confirm: z.boolean().default(false),
}).strict();

export const migrateFrontmatterInputSchema = z.object({
  paths: z.array(z.string()).default([]),
  dryRun: z.boolean().default(true),
  backup: z.boolean().default(true),
  rollback: z.boolean().default(false),
}).strict();

export const reindexInputSchema = z.object({
  full: z.boolean().default(true),
}).strict();

export const indexNoteInputSchema = z.object({
  path: z.string().min(1),
}).strict();

export const compactVaultInputSchema = z.object({
  fromFolder: z.string().default("05_Agent_Session_Logs"),
  targetFolder: z.string().default("07_Insights"),
  maxSessions: z.number().int().positive().default(30),
  minSessions: z.number().int().positive().default(1),
  dryRun: z.boolean().default(false),
}).strict();

export const exportInputSchema = z.object({
  paths: z.array(z.string()).min(1),
  format: z.enum(["markdown", "zip", "json"]).default("markdown"),
}).strict();

export const importInputSchema = z.object({
  source: z.string().min(1),
  format: z.enum(["markdown", "zip", "json"]).default("markdown"),
  targetFolder: z.string().min(1),
}).strict();

export const diagnoseWorkspaceInputSchema = z.object({}).strict();

export const bootstrapProjectInputSchema = z.object({
  projectName: z.string().min(1).optional(),
  overwrite: z.boolean().default(false),
  ideConfigs: z.boolean().default(true),
}).strict();

export const sessionStartInputSchema = z.object({
  taskArea: z.string().optional(),
  mode: contextPackModeSchema.default("auto"),
  recentLimit: z.number().int().positive().max(10).default(5),
  maxItems: z.number().int().positive().max(30).default(12),
  maxChars: z.number().int().positive().max(20000).default(6000),
}).strict();

export const contextPackInputSchema = z.object({
  query: z.string().optional(),
  taskArea: z.string().optional(),
  mode: contextPackModeSchema.default("auto"),
  maxItems: z.number().int().positive().max(30).default(10),
  maxChars: z.number().int().positive().max(20000).default(5000),
  includeRecentSessions: z.boolean().optional(),
  includeMistakes: z.boolean().optional(),
  includeAdrs: z.boolean().optional(),
  includeRunbooks: z.boolean().optional(),
}).strict();

export const sessionEndInputSchema = z.object({
  topic: z.string().min(1),
  agent: z.string().min(1).default("codex"),
  date: isoDateStringSchema.optional(),
  durationMinutes: z.number().int().positive().optional(),
  outcomes: z.array(z.string()).default([]),
  filesTouched: z.array(z.string()).default([]),
  decisionsMade: z.array(z.string()).default([]),
  openFollowUps: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  verification: z.string().optional(),
  autoCompact: z.boolean().default(true),
  verify: z.boolean().default(true),
  confidenceLog: z.array(confidenceLogEntrySchema).default([]),
}).strict();

export const selfCheckInputSchema = z.object({
  task: z.string().min(1),
  area: z.string().optional(),
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
}).strict();

export const lifecycleStatusInputSchema = z.object({
  includeHistory: z.boolean().default(false),
}).strict();

export const followUpRadarInputSchema = z.object({
  query: z.string().optional(),
  taskArea: z.string().optional(),
  mode: contextPackModeSchema.default("auto"),
  folders: z.array(z.string()).default([]),
  limit: z.number().int().positive().max(100).default(20),
}).strict();

export const awakenInputSchema = z.object({
  focus: z.string().optional(),
}).strict();

export const permissionSchema = roleSchema;
