export interface MistakeInput {
  title: string;
  area: string;
  severity: "low" | "medium" | "high" | "critical";
  occurredDate: string;
  agent: string;
  confidence: "high" | "medium" | "low" | "guess";
  problem: string;
  rootCause: string;
  avoidance: string;
  references: string[];
}
