/** CLI 退出码。写入 --help 后含义不得更改。 */
export const EXIT = {
  OK: 0,
  /** 被包装的子进程以非零码退出（通知仍可能已发出）。 */
  CHILD: 1,
  USAGE: 2,
  /** 子进程超时被杀死（通知仍可能已发出）。 */
  TIMEOUT: 3,
  AUTH: 4,
  NOT_FOUND: 5,
  /** 发送被服务器拒绝，或通知失败且不是可重试网络错误。 */
  NOTIFY: 7,
  RETRYABLE: 8,
  FAILURE: 9,
  /** 例如 ListGrokBotAgents 被截断，bot 是否存在未知。 */
  UNKNOWN: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
