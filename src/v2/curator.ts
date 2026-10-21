import type { V2Foundation } from "./composition.js";

export interface CuratorNoteSummary {
  readonly recordId: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly status: string;
  readonly confidence: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly filePaths: readonly string[];
  readonly symbols: readonly string[];
}

export interface CuratorDuplicateGroup {
  readonly contentHash: string;
  readonly recordIds: readonly string[];
  readonly keeperRecordId: string;
  readonly duplicateRecordIds: readonly string[];
  readonly title: string;
}

export interface CuratorRecommendation {
  readonly id: string;
  readonly priority: "high" | "medium" | "low";
  readonly category: "duplicates" | "promotion" | "staleness" | "conflicts" | "healthy";
  readonly title: string;
  readonly description: string;
  readonly actionType: "resolve_duplicates" | "promote_candidates" | "expire_stale" | "none";
  readonly targetRecordIds: readonly string[];
}

export interface CuratorAuditReport {
  readonly ok: true;
  readonly auditedAt: string;
  readonly healthScore: number;
  readonly mode: string;
  readonly counts: {
    readonly totalNotes: number;
    readonly verifiedNotes: number;
    readonly unpromotedCandidates: number;
    readonly duplicateGroups: number;
    readonly staleNotes: number;
    readonly conflictedNotes: number;
  };
  readonly duplicateGroups: readonly CuratorDuplicateGroup[];
  readonly staleNotes: readonly {
    readonly recordId: string;
    readonly status: string;
    readonly summary: string;
    readonly validTo: string | null;
  }[];
  readonly candidateQueue: readonly CuratorNoteSummary[];
  readonly recommendations: readonly CuratorRecommendation[];
}

export interface CuratorExecutionReceipt {
  readonly ok: true;
  readonly sessionId: string;
  readonly executedAt: string;
  readonly beforeHealthScore: number;
  readonly afterHealthScore: number;
  readonly promoted: readonly {
    readonly recordId: string;
    readonly title: string;
    readonly status: string;
  }[];
  readonly superseded: readonly {
    readonly recordId: string;
    readonly supersedingRecordId: string;
    readonly reason: string;
  }[];
  readonly expired: readonly {
    readonly recordId: string;
  }[];
}

export type CuratorChatIntent =
  | "audit"
  | "auto_curate"
  | "awaken"
  | "search"
  | "write_adr"
  | "write_insight"
  | "write_mistake";

export interface CuratorChatResponse {
  readonly ok: true;
  readonly intent: CuratorChatIntent;
  readonly reply: string;
  readonly executedTools: readonly string[];
  readonly data: unknown;
}

function normalizeNoteItem(raw: Record<string, unknown>): CuratorNoteSummary {
  const recordId = String(raw.recordId ?? raw.id ?? "");
  const summary = String(raw.summary ?? raw.text ?? "");
  const colonIdx = summary.indexOf(": ");
  const title =
    typeof raw.title === "string" && raw.title.trim().length > 0
      ? raw.title.trim()
      : colonIdx > 0
        ? summary.slice(0, colonIdx)
        : summary || recordId;
  const kind = String(raw.recordKind ?? raw.kind ?? "insight");
  const filePaths = Array.isArray(raw.filePaths)
    ? raw.filePaths.filter((p): p is string => typeof p === "string")
    : [];
  const symbols = Array.isArray(raw.symbols)
    ? raw.symbols.filter((s): s is string => typeof s === "string")
    : [];
  return Object.freeze({
    recordId,
    kind,
    title,
    summary,
    status: String(raw.status ?? "provisional"),
    confidence: String(raw.confidence ?? "high"),
    validFrom: String(raw.validFrom ?? ""),
    validTo: typeof raw.validTo === "string" ? raw.validTo : null,
    filePaths: Object.freeze(filePaths),
    symbols: Object.freeze(symbols),
  });
}

export class V2MemoryCuratorAgent {
  readonly #foundation: V2Foundation;

  constructor(foundation: V2Foundation) {
    this.#foundation = foundation;
  }

  async auditVault(options?: { readonly limit?: number }): Promise<CuratorAuditReport> {
    const limit = options?.limit ?? 200;
    const status = await this.#foundation.status();
    const listRaw = (await this.#foundation.content.invoke("memory_list", {
      limit,
    })) as { items?: Array<Record<string, unknown>> };
    const dupRaw = (await this.#foundation.content.invoke("memory_findDuplicates", {})) as {
      duplicateGroups?: Array<{ contentHash: string; recordIds: string[] }>;
    };
    const staleRaw = (await this.#foundation.content.invoke("memory_checkStaleness", {})) as {
      staleItems?: Array<Record<string, unknown>>;
    };

    const notes = (listRaw.items ?? []).map(normalizeNoteItem);
    const notesById = new Map<string, CuratorNoteSummary>(notes.map((n) => [n.recordId, n]));

    const activeNotes = notes.filter(
      (n) =>
        n.status !== "retracted" &&
        n.status !== "superseded" &&
        n.status !== "expired" &&
        n.status !== "erased-evidence",
    );

    const verifiedNotes = activeNotes.filter(
      (n) => n.status === "verified" || n.status === "active",
    );
    const candidateQueue = activeNotes.filter(
      (n) => n.status === "provisional" || n.status === "candidate",
    );
    const conflictedNotes = activeNotes.filter((n) => n.status === "conflicted");

    // Combine content-hash duplicates with normalized-summary duplicates among active notes
    const seenGroups = new Map<string, string[]>();
    for (const group of dupRaw.duplicateGroups ?? []) {
      const activeIds = group.recordIds.filter((id) => {
        const note = notesById.get(id);
        return (
          !note ||
          (note.status !== "retracted" &&
            note.status !== "superseded" &&
            note.status !== "expired")
        );
      });
      if (activeIds.length > 1) {
        seenGroups.set(group.contentHash, [...new Set(activeIds)]);
      }
    }

    const byNormSummary = new Map<string, string[]>();
    for (const note of activeNotes) {
      const norm = note.summary.trim().toLowerCase().replace(/\s+/gu, " ");
      if (norm.length < 4) continue;
      const list = byNormSummary.get(norm) ?? [];
      list.push(note.recordId);
      byNormSummary.set(norm, list);
    }
    for (const [norm, ids] of byNormSummary.entries()) {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length <= 1) continue;
      const alreadyCovered = [...seenGroups.values()].some(
        (existing) =>
          uniqueIds.every((id) => existing.includes(id)) && existing.length === uniqueIds.length,
      );
      if (!alreadyCovered) {
        seenGroups.set(`summary:${norm.slice(0, 48)}`, uniqueIds);
      }
    }

    const duplicateGroups: CuratorDuplicateGroup[] = [];
    for (const [contentHash, recordIds] of seenGroups.entries()) {
      if (recordIds.length < 2) continue;
      const verifiedInGroup = recordIds.find((id) => {
        const st = notesById.get(id)?.status;
        return st === "verified" || st === "active";
      });
      const keeperRecordId = verifiedInGroup ?? recordIds[0]!;
      const duplicateRecordIds = recordIds.filter((id) => id !== keeperRecordId);
      if (duplicateRecordIds.length === 0) continue;
      const sampleTitle = notesById.get(keeperRecordId)?.title ?? keeperRecordId;
      duplicateGroups.push(
        Object.freeze({
          contentHash,
          recordIds: Object.freeze([...recordIds]),
          keeperRecordId,
          duplicateRecordIds: Object.freeze(duplicateRecordIds),
          title: sampleTitle,
        }),
      );
    }

    const staleNotes = (staleRaw.staleItems ?? [])
      .map((item) => ({
        recordId: String(item.recordId ?? item.id ?? ""),
        status: String(item.status ?? "expired"),
        summary: String(item.summary ?? ""),
        validTo: typeof item.validTo === "string" ? item.validTo : null,
      }))
      .filter(
        (s) =>
          s.recordId.length > 0 &&
          s.status !== "superseded" &&
          s.status !== "retracted",
      );

    let penalty = 0;
    penalty += Math.min(35, duplicateGroups.length * 12);
    penalty += Math.min(25, candidateQueue.length * 4);
    penalty += Math.min(30, conflictedNotes.length * 15);
    penalty += Math.min(10, staleNotes.length * 5);
    const healthScore = activeNotes.length === 0 ? 100 : Math.max(15, 100 - penalty);

    const recommendations: CuratorRecommendation[] = [];
    if (duplicateGroups.length > 0) {
      const dupIds = duplicateGroups.flatMap((g) => g.duplicateRecordIds);
      recommendations.push(
        Object.freeze({
          id: "rec-resolve-duplicates",
          priority: "high",
          category: "duplicates",
          title: `พบความจำซ้ำ ${duplicateGroups.length} กลุ่ม (${dupIds.length} รายการ)`,
          description:
            "แนะนำให้รวมความจำที่ซ้ำกันโดยเก็บรายการหลักไว้และ Supersede รายการที่ซ้ำเพื่อเพิ่มความแม่นยำในการค้นหา",
          actionType: "resolve_duplicates",
          targetRecordIds: Object.freeze(dupIds),
        }),
      );
    }
    if (candidateQueue.length > 0) {
      recommendations.push(
        Object.freeze({
          id: "rec-promote-candidates",
          priority: "medium",
          category: "promotion",
          title: `มี Candidate/Provisional รออนุมัติ ${candidateQueue.length} รายการ`,
          description:
            "ความจำที่บันทึกใหม่มี Evidence รองรับแล้ว สามารถกด Promote เป็น Verified เพื่อให้ AI ใช้งานเป็นกฎหลักได้ทันที",
          actionType: "promote_candidates",
          targetRecordIds: Object.freeze(candidateQueue.map((c) => c.recordId)),
        }),
      );
    }
    if (staleNotes.length > 0) {
      recommendations.push(
        Object.freeze({
          id: "rec-expire-stale",
          priority: "low",
          category: "staleness",
          title: `พบความจำที่หมดอายุหรือล้าสมัย ${staleNotes.length} รายการ`,
          description: "แนะนำให้ปรับสถานะเป็น Expired เพื่อไม่ให้รบกวน Context ปัจจุบัน",
          actionType: "expire_stale",
          targetRecordIds: Object.freeze(staleNotes.map((s) => s.recordId)),
        }),
      );
    }
    if (recommendations.length === 0) {
      recommendations.push(
        Object.freeze({
          id: "rec-vault-healthy",
          priority: "low",
          category: "healthy",
          title: "คลังความจำสะอาดและพร้อมใช้งาน 100%",
          description: "ไม่พบความจำซ้ำหรือรายการค้างอนุมัติ",
          actionType: "none",
          targetRecordIds: Object.freeze([]),
        }),
      );
    }

    return Object.freeze({
      ok: true,
      auditedAt: new Date().toISOString(),
      healthScore,
      mode: status.mode,
      counts: Object.freeze({
        totalNotes: activeNotes.length,
        verifiedNotes: verifiedNotes.length,
        unpromotedCandidates: candidateQueue.length,
        duplicateGroups: duplicateGroups.length,
        staleNotes: staleNotes.length,
        conflictedNotes: conflictedNotes.length,
      }),
      duplicateGroups: Object.freeze(duplicateGroups),
      staleNotes: Object.freeze(staleNotes),
      candidateQueue: Object.freeze(candidateQueue),
      recommendations: Object.freeze(recommendations),
    });
  }

  async autoCurate(options?: {
    readonly promoteCandidates?: boolean;
    readonly resolveDuplicates?: boolean;
    readonly expireStale?: boolean;
  }): Promise<CuratorExecutionReceipt> {
    const promoteCandidates = options?.promoteCandidates !== false;
    const resolveDuplicates = options?.resolveDuplicates !== false;
    const expireStale = options?.expireStale !== false;

    const auditBefore = await this.auditVault();
    const sessionStart = (await this.#foundation.content.invoke("memory_sessionStart", {
      agentName: "v2-ai-memory-curator",
      taskSummary: "Autonomous AI Memory Curator governance pass",
      contextArea: "memory-curation",
      includeContext: false,
    })) as { sessionId: string };
    const sessionId = sessionStart.sessionId;

    const superseded: Array<{
      readonly recordId: string;
      readonly supersedingRecordId: string;
      readonly reason: string;
    }> = [];
    const supersededSet = new Set<string>();

    if (resolveDuplicates) {
      for (const group of auditBefore.duplicateGroups) {
        const keeperId = group.keeperRecordId;
        for (const dupId of group.duplicateRecordIds) {
          if (dupId === keeperId || supersededSet.has(dupId)) continue;
          const reason = `Auto-superseded duplicate of ${keeperId} by AI Memory Curator`;
          await this.#foundation.content.invoke("memory_supersede", {
            sessionId,
            recordId: dupId,
            supersedingRecordId: keeperId,
            reason,
          });
          supersededSet.add(dupId);
          superseded.push(
            Object.freeze({
              recordId: dupId,
              supersedingRecordId: keeperId,
              reason,
            }),
          );
        }
      }
    }

    const promoted: Array<{
      readonly recordId: string;
      readonly title: string;
      readonly status: string;
    }> = [];

    if (promoteCandidates) {
      for (const candidate of auditBefore.candidateQueue) {
        if (supersededSet.has(candidate.recordId)) continue;
        await this.#foundation.content.invoke("memory_promote", {
          sessionId,
          recordId: candidate.recordId,
          targetStatus: "verified",
          verificationMethod: "user-confirmed",
          reason: "Auto-promoted verified candidate by AI Memory Curator",
        });
        promoted.push(
          Object.freeze({
            recordId: candidate.recordId,
            title: candidate.title,
            status: "verified",
          }),
        );
      }
    }

    const expired: Array<{ readonly recordId: string }> = [];
    if (expireStale) {
      for (const stale of auditBefore.staleNotes) {
        if (
          supersededSet.has(stale.recordId) ||
          stale.status === "expired" ||
          stale.status === "superseded" ||
          stale.status === "retracted"
        ) {
          continue;
        }
        await this.#foundation.content.invoke("memory_expire", {
          sessionId,
          recordId: stale.recordId,
          reason: "Auto-expired stale memory record by AI Memory Curator",
        });
        expired.push(Object.freeze({ recordId: stale.recordId }));
      }
    }

    await this.#foundation.content.invoke("memory_sessionEnd", {
      sessionId,
      summary: `AI Memory Curator completed: promoted ${promoted.length}, superseded ${superseded.length}, expired ${expired.length}.`,
    });

    const auditAfter = await this.auditVault();

    return Object.freeze({
      ok: true,
      sessionId,
      executedAt: new Date().toISOString(),
      beforeHealthScore: auditBefore.healthScore,
      afterHealthScore: auditAfter.healthScore,
      promoted: Object.freeze(promoted),
      superseded: Object.freeze(superseded),
      expired: Object.freeze(expired),
    });
  }

  async chat(request: {
    readonly message: string;
    readonly autoExecute?: boolean;
  }): Promise<CuratorChatResponse> {
    const rawMessage = String(request.message ?? "").trim();
    const executedTools: string[] = [];

    // 1. Write ADR intent (Thai & English)
    const adrMatch =
      rawMessage.match(/^(?:บันทึก|สร้าง|เขียน|เพิ่ม)?\s*adr\s*[:：-]\s*(.+)$/iu) ??
      rawMessage.match(/^(?:write|create|record)\s+adr\s*[:：-]\s*(.+)$/iu);
    if (adrMatch) {
      const text = adrMatch[1]!.trim();
      executedTools.push("memory_writeADR");
      const created = (await this.#foundation.content.invoke("memory_writeADR", {
        title: text.slice(0, 90),
        summary: text,
        content: `# ${text.slice(0, 90)}\n\n${text}`,
      })) as { recordId: string; status: string };
      return Object.freeze({
        ok: true,
        intent: "write_adr",
        reply: `บันทึก ADR เรียบร้อยแล้ว (${created.recordId}): "${text}" [สถานะ: ${created.status}]`,
        executedTools: Object.freeze(executedTools),
        data: created,
      });
    }

    // 2. Write Mistake intent (Thai & English)
    const mistakeMatch =
      rawMessage.match(
        /^(?:บันทึก|สร้าง|เขียน|เพิ่ม)?\s*(?:mistake|ข้อผิดพลาด|บั๊ก)\s*[:：-]\s*(.+)$/iu,
      ) ?? rawMessage.match(/^(?:write|create|record)\s+mistake\s*[:：-]\s*(.+)$/iu);
    if (mistakeMatch) {
      const text = mistakeMatch[1]!.trim();
      executedTools.push("memory_writeMistake");
      const created = (await this.#foundation.content.invoke("memory_writeMistake", {
        title: text.slice(0, 90),
        summary: text,
        content: `# ${text.slice(0, 90)}\n\n${text}`,
      })) as { recordId: string; status: string };
      return Object.freeze({
        ok: true,
        intent: "write_mistake",
        reply: `บันทึกข้อผิดพลาด (Mistake) เรียบร้อยแล้ว (${created.recordId}): "${text}"`,
        executedTools: Object.freeze(executedTools),
        data: created,
      });
    }

    // 3. Write Insight intent (Thai & English)
    const insightMatch =
      rawMessage.match(
        /^(?:บันทึก|สร้าง|เขียน|เพิ่ม)?\s*(?:insight|บทเรียน|ความรู้)\s*[:：-]\s*(.+)$/iu,
      ) ?? rawMessage.match(/^(?:write|create|record)\s+insight\s*[:：-]\s*(.+)$/iu);
    if (insightMatch) {
      const text = insightMatch[1]!.trim();
      executedTools.push("memory_writeInsight");
      const created = (await this.#foundation.content.invoke("memory_writeInsight", {
        title: text.slice(0, 90),
        summary: text,
        content: `# ${text.slice(0, 90)}\n\n${text}`,
      })) as { recordId: string; status: string };
      return Object.freeze({
        ok: true,
        intent: "write_insight",
        reply: `บันทึก Insight เรียบร้อยแล้ว (${created.recordId}): "${text}"`,
        executedTools: Object.freeze(executedTools),
        data: created,
      });
    }

    // 4. Auto-curate / Promote candidates / Resolve duplicates intent
    if (
      /(?:อนุมัติ|promote|auto[\s-]?curate|จัดระเบียบ|ทำความสะอาด|รวมความจำซ้ำ|resolve duplicate)/iu.test(
        rawMessage,
      )
    ) {
      executedTools.push(
        "memory_sessionStart",
        "memory_list",
        "memory_findDuplicates",
        "memory_promote",
        "memory_supersede",
        "memory_sessionEnd",
      );
      const receipt = await this.autoCurate({
        promoteCandidates: true,
        resolveDuplicates: true,
        expireStale: true,
      });
      return Object.freeze({
        ok: true,
        intent: "auto_curate",
        reply:
          `AI Curator จัดการความจำเสร็จสมบูรณ์! ` +
          `อนุมัติ (Promoted): ${receipt.promoted.length} รายการ, ` +
          `รวมความจำซ้ำ (Superseded): ${receipt.superseded.length} รายการ, ` +
          `คะแนนสุขภาพความจำ: ${receipt.beforeHealthScore} → ${receipt.afterHealthScore}/100`,
        executedTools: Object.freeze(executedTools),
        data: receipt,
      });
    }

    // 5. Audit / Health / Duplicate check intent
    if (
      /(?:ตรวจสุขภาพ|สุขภาพความจำ|ความจำซ้ำ|duplicate|audit|health|stale|ล้าสมัย)/iu.test(
        rawMessage,
      )
    ) {
      executedTools.push("memory_list", "memory_findDuplicates", "memory_checkStaleness");
      const audit = await this.auditVault();
      return Object.freeze({
        ok: true,
        intent: "audit",
        reply:
          `ผลตรวจสุขภาพคลังความจำ: ${audit.healthScore}/100 ` +
          `(ทั้งหมด ${audit.counts.totalNotes} รายการ, Verified ${audit.counts.verifiedNotes}, ` +
          `รออนุมัติ ${audit.counts.unpromotedCandidates}, ซ้ำ ${audit.counts.duplicateGroups} กลุ่ม)`,
        executedTools: Object.freeze(executedTools),
        data: audit,
      });
    }

    // 6. Awaken / Overview intent
    if (/(?:สรุป|ตื่นรู้|awaken|overview|ภาพรวม|ต้องทำอะไรต่อ)/iu.test(rawMessage)) {
      executedTools.push("memory_awaken");
      const awaken = (await this.#foundation.content.invoke("memory_awaken", {
        area: rawMessage,
      })) as {
        autonomousAgenda?: Array<{ action: string }>;
        governanceAlerts?: { unpromotedCandidateCount?: number };
      };
      const topActions = (awaken.autonomousAgenda ?? [])
        .slice(0, 3)
        .map((a, idx) => `${idx + 1}. ${a.action}`)
        .join(" | ");
      return Object.freeze({
        ok: true,
        intent: "awaken",
        reply: `สรุปสถานะ Awakening: ${topActions || "พร้อมทำงาน"}`,
        executedTools: Object.freeze(executedTools),
        data: awaken,
      });
    }

    // 7. Search intent (explicit or default fallback)
    const searchMatch = rawMessage.match(/^(?:ค้นหา|หา|search|find)\s+(.+)$/iu);
    const query = searchMatch ? searchMatch[1]!.trim() : rawMessage || "governed";
    executedTools.push("memory_search");
    const searchRes = (await this.#foundation.content.invoke("memory_search", {
      query,
      limit: 10,
    })) as { items?: Array<Record<string, unknown>> };
    const items = (searchRes.items ?? []).map(normalizeNoteItem);
    const preview =
      items.length > 0
        ? items
            .slice(0, 3)
            .map((i) => `• [${i.kind.toUpperCase()}] ${i.title} (${i.status})`)
            .join("\n")
        : "ไม่พบความจำที่ตรงกับคำค้นหา";
    return Object.freeze({
      ok: true,
      intent: "search",
      reply: `ผลการค้นหา "${query}" พบ ${items.length} รายการ:\n${preview}`,
      executedTools: Object.freeze(executedTools),
      data: { query, items },
    });
  }
}
