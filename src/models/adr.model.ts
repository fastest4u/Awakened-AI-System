export interface ADRInput {
  title: string;
  status: "proposed" | "accepted" | "superseded";
  decisionDate: string;
  confidence: "high" | "medium" | "low" | "guess";
  context: string;
  decision: string;
  consequences: string[];
  supersedes: string[];
  tags: string[];
}
