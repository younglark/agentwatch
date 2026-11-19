export const SERVICE_NAME = "agentwatch";

export type ServiceState = {
  id: string;
  version: string;
  pid: number;
  url: string;
  hostname: string;
  port: number;
  started_at: string;
  started_at_ms: number;
  /** 本地客户端密钥。不得写入 status、日志或帮助输出。 */
  password: string;
};

export type PublicServiceStatus = {
  running: boolean;
  healthy?: boolean;
  id?: string;
  version?: string;
  pid?: number;
  url?: string;
  hostname?: string;
  port?: number;
  started_at?: string;
  reason?: string;
};

export type ServiceBind = {
  hostname: string;
  port: number;
};

export type EnsureReason = "missing" | "version-mismatch" | "bind-change" | "unhealthy";

export type DiscoverOptions = {
  home: string;
  version?: string;
  timing?: Partial<EnsureTiming>;
};

export type EnsureOptions = DiscoverOptions & {
  /** 启动守护进程的命令。默认：[process.execPath, 当前 cli, "service", "run"] */
  command?: string[];
  env?: NodeJS.ProcessEnv;
  onStart?: (reason: EnsureReason, previousVersion?: string) => void;
};

export type StopResult = {
  stopped: boolean;
  reason:
    | "missing-registration"
    | "stale-registration"
    | "stopped"
    | "still-registered"
    | "timeout"
    | "error";
  message?: string;
};

export type EnsureTiming = {
  pollInterval: number;
  requestTimeout: number;
  spawnDelay: number;
  promiseTimeout: number;
  stopPollInterval: number;
  stopPollAttempts: number;
};

export const defaultEnsureTiming: EnsureTiming = {
  pollInterval: 50,
  requestTimeout: 2_000,
  spawnDelay: 100,
  promiseTimeout: 30_000,
  stopPollInterval: 50,
  stopPollAttempts: 100,
};

export function resolveTiming(partial?: Partial<EnsureTiming>): EnsureTiming {
  return { ...defaultEnsureTiming, ...partial };
}

export type ProbeService = {
  state: ServiceState;
  version: string;
  health: "ready" | "waiting" | "failed";
  compatible: boolean;
  rejected: boolean;
};

export function sameState(left: Pick<ServiceState, "id" | "version" | "url" | "pid">, right: typeof left): boolean {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid;
}

export function publicStatus(state: ServiceState, extra: Partial<PublicServiceStatus> = {}): PublicServiceStatus {
  return {
    running: true,
    id: state.id,
    version: state.version,
    pid: state.pid,
    url: state.url,
    hostname: state.hostname,
    port: state.port,
    started_at: state.started_at,
    ...extra,
  };
}
