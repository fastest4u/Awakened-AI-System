import { z } from "zod";
import type { ProjectDescriptorV1 } from "./contracts.js";

export const projectDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  vaultId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export function parseProjectDescriptor(value: unknown): ProjectDescriptorV1 {
  return projectDescriptorSchema.parse(value) as ProjectDescriptorV1;
}
