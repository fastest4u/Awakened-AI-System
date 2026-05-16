export interface ConfidenceLogEntry {
  claim: string;
  statedConfidence: "high" | "medium" | "low" | "guess";
  actualResult: string;
  lesson: string;
}

export interface SessionLogInput {
  date: string;
  topic: string;
  agent: string;
  durationMinutes?: number;
  outcomes: string[];
  filesTouched: string[];
  decisionsMade: string[];
  openFollowUps: string[];
  references: string[];
  confidenceLog: ConfidenceLogEntry[];
}
