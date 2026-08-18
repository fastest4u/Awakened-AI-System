import type { Migration } from "../migration.js";
import { eventCoreMigration } from "./0001-event-core.js";
import { sessionLifecycleMigration } from "./0002-session-lifecycle.js";
import { qualifiedCheckpointCoverageMigration } from "./0003-qualified-checkpoint-coverage.js";
import { sessionEndEffectiveStateMigration } from "./0004-session-end-effective-state.js";
import {
  sessionEndFinalCheckpointTransitionMigration,
} from "./0005-session-end-final-checkpoint-transition.js";

export const PROJECT_STORE_MIGRATIONS: readonly Migration[] = Object.freeze([
  eventCoreMigration,
  sessionLifecycleMigration,
  qualifiedCheckpointCoverageMigration,
  sessionEndEffectiveStateMigration,
  sessionEndFinalCheckpointTransitionMigration,
] as const);

export const CURRENT_PROJECT_STORE_SCHEMA_VERSION = 5;
