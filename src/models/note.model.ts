export interface VaultNote {
  path: string;
  title: string;
  type: string;
  tags: string[];
  created?: string;
  updated?: string;
  content?: string;
}
