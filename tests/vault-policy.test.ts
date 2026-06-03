import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  DEFAULT_MARKDOWN_IGNORE,
  DEFAULT_SEMANTIC_EXEMPT_PATHS,
  isSemanticFrontmatterExempt,
  matchesVaultPattern,
} from "../src/config/vault-policy.js";

describe("vault policy", () => {
  it("matches vault-local glob policies against normalized paths", () => {
    assert.equal(matchesVaultPattern(".memory-mcp/backups/latest/note.md", ".memory-mcp/**"), true);
    assert.equal(matchesVaultPattern("99_Templates/Template-Daily-Note.md", "99_Templates/**"), true);
    assert.equal(matchesVaultPattern("07_Insights/note.md", "99_Templates/**"), false);
  });

  it("centralizes markdown scan ignore patterns", () => {
    assert.ok(DEFAULT_MARKDOWN_IGNORE.includes(".memory-mcp/**"));
    assert.ok(DEFAULT_MARKDOWN_IGNORE.includes(".obsidian/**"));
  });

  it("centralizes semantic frontmatter exemptions and allows overrides", () => {
    assert.deepEqual(DEFAULT_SEMANTIC_EXEMPT_PATHS, ["99_Templates/**"]);
    assert.equal(isSemanticFrontmatterExempt("99_Templates/Template-Daily-Note.md"), true);
    assert.equal(isSemanticFrontmatterExempt("00_Index/Retrieval-Protocol.md"), false);
    assert.equal(isSemanticFrontmatterExempt("00_Index/Retrieval-Protocol.md", ["00_Index/**"]), true);
  });
});
