import type { Migration } from "../migration.js";
import { eventCoreMigration } from "./0001-event-core.js";
import { sessionLifecycleMigration } from "./0002-session-lifecycle.js";
import { qualifiedCheckpointCoverageMigration } from "./0003-qualified-checkpoint-coverage.js";
import { sessionEndEffectiveStateMigration } from "./0004-session-end-effective-state.js";
import {
  sessionEndFinalCheckpointTransitionMigration,
} from "./0005-session-end-final-checkpoint-transition.js";
import { v2RolloutControlPlaneMigration } from "./0006-v2-rollout-control-plane.js";
import { v2ShadowMigration } from "./0007-v2-shadow-migration.js";
import { v2FreshStartMigration } from "./0008-v2-fresh-start.js";
import { retainedEvidenceMigration } from "./0009-retained-evidence.js";

export const PROJECT_STORE_MIGRATIONS: readonly Migration[] = Object.freeze([
  eventCoreMigration,
  sessionLifecycleMigration,
  qualifiedCheckpointCoverageMigration,
  sessionEndEffectiveStateMigration,
  sessionEndFinalCheckpointTransitionMigration,
  v2RolloutControlPlaneMigration,
  v2ShadowMigration,
  v2FreshStartMigration,
  retainedEvidenceMigration,
] as const);

export const CURRENT_PROJECT_STORE_SCHEMA_VERSION = 9;
