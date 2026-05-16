export interface CommonFrontmatter {
  title?: string;
  type?: string;
  created?: string;
  updated?: string;
  tags?: string[];
  confidence?: "high" | "medium" | "low" | "guess";
  lastVerified?: string;
  verifiedBy?: string;
  source?: string;
}
