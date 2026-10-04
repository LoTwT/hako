// 文档代次的共享模型：服务端生成的 UUID v4、初始/恢复两种来源，以及备份引用。
// 该模块只承载类型与严格的序列化/反序列化；表结构由 worker 文档层维护，
// 本机存储由 local-refueling-v2 维护，均引用此处定义。

/** 备份引用固定为 stream + revision + 包哈希；不接受任意对象键或外部 URL。 */
export interface BackupReference {
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
}

/**
 * 代次来源：`initial` 为初次升级时创建的 G0；`restore` 固定保存恢复请求、
 * 前一代次与目标/保护备份引用，且该代次的后续备份沿用同一来源。
 */
export type GenerationOrigin =
  | { kind: "initial" }
  | {
    kind: "restore";
    requestId: string;
    previousGeneration: string;
    targetBackup: BackupReference;
    protectionBackup: BackupReference;
  };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isBackupReference(value: unknown): value is BackupReference {
  if (typeof value !== "object" || value === null) return false;
  const reference = value as Record<string, unknown>;
  return typeof reference.backupStreamId === "string" && UUID_PATTERN.test(reference.backupStreamId)
    && typeof reference.revision === "number" && Number.isSafeInteger(reference.revision) && reference.revision >= 0
    && typeof reference.bundleSha256 === "string" && SHA256_PATTERN.test(reference.bundleSha256);
}

/** 严格解析来源对象；未知字段、缺字段或非法值一律失败（用于 manifest 与持久化读取）。 */
export function parseGenerationOrigin(value: unknown): GenerationOrigin | null {
  if (typeof value !== "object" || value === null) return null;
  const origin = value as Record<string, unknown>;
  if (origin.kind === "initial") {
    return Object.keys(origin).length === 1 ? { kind: "initial" } : null;
  }
  if (origin.kind !== "restore") return null;
  const keys = ["kind", "requestId", "previousGeneration", "targetBackup", "protectionBackup"];
  const present = Object.keys(origin);
  if (present.length !== keys.length || !keys.every((key) => key in origin)) return null;
  if (typeof origin.requestId !== "string" || !UUID_PATTERN.test(origin.requestId)) return null;
  if (typeof origin.previousGeneration !== "string" || !UUID_PATTERN.test(origin.previousGeneration)) return null;
  if (!isBackupReference(origin.targetBackup) || !isBackupReference(origin.protectionBackup)) return null;
  return {
    kind: "restore",
    requestId: origin.requestId,
    previousGeneration: origin.previousGeneration,
    targetBackup: origin.targetBackup,
    protectionBackup: origin.protectionBackup,
  };
}

/** 固定字段顺序的序列化（JSON 文本）；解析侧用 parseGenerationOrigin 严格还原。 */
export function serializeGenerationOrigin(origin: GenerationOrigin): string {
  if (origin.kind === "initial") return JSON.stringify({ kind: "initial" });
  return JSON.stringify({
    kind: "restore",
    requestId: origin.requestId,
    previousGeneration: origin.previousGeneration,
    targetBackup: {
      backupStreamId: origin.targetBackup.backupStreamId,
      revision: origin.targetBackup.revision,
      bundleSha256: origin.targetBackup.bundleSha256,
    },
    protectionBackup: {
      backupStreamId: origin.protectionBackup.backupStreamId,
      revision: origin.protectionBackup.revision,
      bundleSha256: origin.protectionBackup.bundleSha256,
    },
  });
}
