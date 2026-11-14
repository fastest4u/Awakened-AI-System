import type { V2Foundation } from "../composition.js";
import {
  CuratorModel,
  KnowledgeGraphModel,
  MVC_ARCHITECTURE_MANIFEST,
  MemoryNoteModel,
  OverviewModel,
  ProjectModel,
} from "./models.js";

export class WebUiMvcController {
  static getArchitectureManifest() {
    return MVC_ARCHITECTURE_MANIFEST;
  }

  static async listProjects(
    defaultProjectRoot: string,
    extraProjectRoots: readonly string[],
    knownProjects: Set<string>,
    getFoundation: (root: string) => Promise<V2Foundation>,
    isFoundationCached?: (root: string) => boolean,
  ) {
    const projects = await ProjectModel.listDiscoveredProjects(
      defaultProjectRoot,
      extraProjectRoots,
      knownProjects,
      getFoundation,
      isFoundationCached,
    );
    return {
      ok: true,
      defaultProjectRoot,
      projects,
    };
  }

  static async getOverview(projectRoot: string, foundation: V2Foundation) {
    return OverviewModel.getProjectOverview(projectRoot, foundation);
  }

  static async listNotes(
    projectRoot: string,
    foundation: V2Foundation,
    filters: { query?: string; status?: string; kind?: string },
  ) {
    let items = await MemoryNoteModel.listEnrichedNotes(
      foundation,
      filters.query,
      100,
      projectRoot,
    );
    if (filters.status) {
      items = items.filter((i) => i.status === filters.status);
    }
    if (filters.kind) {
      items = items.filter((i) => i.recordKind === filters.kind || i.kind === filters.kind);
    }
    return {
      ok: true,
      projectRoot,
      items,
    };
  }

  static async getNoteDetail(projectRoot: string, foundation: V2Foundation, noteId: string) {
    const note = await MemoryNoteModel.getNoteById(foundation, noteId, projectRoot);
    if (!note) {
      return {
        ok: false,
        error: "NOTE_NOT_FOUND",
        message: "ไม่พบข้อมูลความจำที่ระบุ",
        projectRoot,
        note: null,
      };
    }
    return {
      ok: true,
      projectRoot,
      note,
    };
  }

  static async executeGovernanceAction(
    foundation: V2Foundation,
    body: Record<string, unknown>,
  ): Promise<{ readonly statusCode: number; readonly payload: Record<string, unknown> }> {
    const action = String(body.action ?? "").trim();
    let result: unknown;
    switch (action) {
      case "promote":
        result = await foundation.content.invoke("memory_promote", {
          recordId: body.recordId ?? body.id,
          targetStatus: body.targetStatus ?? "verified",
          verificationMethod: body.verificationMethod ?? "user-confirmed",
          reason: body.reason ?? "Promoted via Project Memory V2 WebUI",
        });
        break;
      case "supersede":
        result = await foundation.content.invoke("memory_supersede", {
          recordId: body.recordId ?? body.id,
          supersedingRecordId: body.supersedingRecordId ?? body.replacementRecordId,
          reason: body.reason ?? "Superseded via Project Memory V2 WebUI",
        });
        break;
      case "retract":
        result = await foundation.content.invoke("memory_retract", {
          recordId: body.recordId ?? body.id,
          reason: body.reason ?? "Retracted via Project Memory V2 WebUI",
        });
        break;
      case "expire":
        result = await foundation.content.invoke("memory_expire", {
          recordId: body.recordId ?? body.id,
          reason: body.reason ?? "Expired via Project Memory V2 WebUI",
        });
        break;
      case "writeADR":
      case "write_adr":
        result = await foundation.content.invoke("memory_writeADR", {
          title: body.title,
          summary: body.summary,
          content: body.content,
        });
        break;
      case "writeInsight":
      case "write_insight":
        result = await foundation.content.invoke("memory_writeInsight", {
          title: body.title,
          summary: body.summary,
          content: body.content,
        });
        break;
      case "writeMistake":
      case "write_mistake":
        result = await foundation.content.invoke("memory_writeMistake", {
          title: body.title,
          summary: body.summary,
          content: body.content,
        });
        break;
      default:
        return {
          statusCode: 400,
          payload: { ok: false, error: "UNSUPPORTED_GOVERNANCE_ACTION" },
        };
    }
    return {
      statusCode: 200,
      payload: { ok: true, action, result },
    };
  }

  static async getKnowledgeGraph(projectRoot: string, foundation: V2Foundation) {
    return KnowledgeGraphModel.getProjectGraph(projectRoot, foundation);
  }

  static async getCuratorAudit(projectRoot: string, foundation: V2Foundation) {
    const curator = CuratorModel.createAgent(foundation);
    const audit = await curator.auditVault();
    return {
      ...audit,
      projectRoot,
    };
  }

  static async runCuratorAutoCurate(
    projectRoot: string,
    foundation: V2Foundation,
    body: Record<string, unknown>,
  ) {
    const curator = CuratorModel.createAgent(foundation);
    const receipt = await curator.autoCurate({
      promoteCandidates: body.promoteCandidates !== false,
      resolveDuplicates: body.resolveDuplicates !== false,
      expireStale: body.expireStale !== false,
    });
    return {
      ...receipt,
      projectRoot,
    };
  }

  static async runCuratorChat(
    projectRoot: string,
    foundation: V2Foundation,
    message: string,
    autoExecute: boolean,
  ) {
    const curator = CuratorModel.createAgent(foundation);
    const reply = await curator.chat({
      message,
      autoExecute,
    });
    return {
      ...reply,
      projectRoot,
    };
  }
}
