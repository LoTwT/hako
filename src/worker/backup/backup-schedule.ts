// 独立备份的调度节奏。生产固定值只在本文件维护；测试子类通过注入不同节奏
// 加速验证，持久语义（责任、退避计数、alarm 计算）完全一致。

/** 首次未覆盖变化起的固定捕获窗口；后续编辑不顺延。 */
export const BACKUP_WINDOW_MS = 30_000;

/** 可重试失败的退避间隔：1、5、15、60 分钟，之后每小时。 */
export const BACKUP_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000, 3_600_000];

/** 退避序列结束后的固定重试间隔。 */
export const BACKUP_HOURLY_RETRY_MS = 3_600_000;

/** 最近保留的完成且验证的独立备份数量。 */
export const BACKUP_RETENTION_COUNT = 30;

export interface BackupSchedulePolicy {
  readonly windowMs: number;
  readonly retryDelaysMs: readonly number[];
  readonly hourlyRetryMs: number;
  readonly retentionCount: number;
}

export const PRODUCTION_BACKUP_SCHEDULE: BackupSchedulePolicy = {
  windowMs: BACKUP_WINDOW_MS,
  retryDelaysMs: BACKUP_RETRY_DELAYS_MS,
  hourlyRetryMs: BACKUP_HOURLY_RETRY_MS,
  retentionCount: BACKUP_RETENTION_COUNT,
};

/** 第 attemptCount 次尝试失败后的安全重试间隔；尝试序号从 1 开始。 */
export function backupRetryDelayMs(schedule: BackupSchedulePolicy, attemptCount: number): number {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error("invalid_backup_attempt_count");
  }
  const index = attemptCount - 1;
  if (index < schedule.retryDelaysMs.length) return schedule.retryDelaysMs[index];
  return schedule.hourlyRetryMs;
}
