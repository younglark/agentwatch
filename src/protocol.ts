import { MethodKind, proto3 } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AgentwatchError } from "./errors.js";
import { expiredError, isExpired, loadAccessToken, type AccessToken, type LoadTokenOptions } from "./auth/token.js";

/** 与 grokbot-control 冻结 schema 0.79.4 中的字段号一致的最小子集。未知字段在解码时被忽略。 */
const ListGrokBotAgentsRequest = proto3.makeMessageType("aiserver.v1.ListGrokBotAgentsRequest", () => []);

const GrokBotAgent = proto3.makeMessageType("aiserver.v1.GrokBotAgent", () => [
  { no: 1, name: "id", kind: "scalar", T: 9 },
  { no: 3, name: "name", kind: "scalar", T: 9 },
  { no: 5, name: "title", kind: "scalar", T: 9 },
  { no: 12, name: "agentId", kind: "scalar", T: 9 },
]);

const ListGrokBotAgentsResponse = proto3.makeMessageType("aiserver.v1.ListGrokBotAgentsResponse", () => [
  { no: 1, name: "agents", kind: "message", T: GrokBotAgent, repeated: true },
  { no: 3, name: "truncated", kind: "scalar", T: 8 },
]);

const SendGrokBotUserMessageRequest = proto3.makeMessageType(
  "aiserver.v1.SendGrokBotUserMessageRequest",
  () => [
    { no: 1, name: "agentId", kind: "scalar", T: 9 },
    { no: 2, name: "messageId", kind: "scalar", T: 9 },
    { no: 3, name: "text", kind: "scalar", T: 9 },
    { no: 4, name: "sentAtMs", kind: "scalar", T: 3 }, // int64
    { no: 15, name: "sessionId", kind: "scalar", T: 9 },
  ],
);

const GrokBotHarnessRefusal = proto3.makeMessageType("aiserver.v1.GrokBotHarnessRefusal", () => [
  { no: 1, name: "failureCode", kind: "scalar", T: 9 },
  { no: 2, name: "message", kind: "scalar", T: 9 },
]);

const SendGrokBotUserMessageResponse = proto3.makeMessageType(
  "aiserver.v1.SendGrokBotUserMessageResponse",
  () => [
    { no: 1, name: "dispatched", kind: "scalar", T: 8 },
    { no: 2, name: "mode", kind: "scalar", T: 5 }, // int32 enum
    { no: 3, name: "workflowId", kind: "scalar", T: 9, opt: true },
    { no: 4, name: "delivery", kind: "scalar", T: 5 },
    { no: 5, name: "refusal", kind: "message", T: GrokBotHarnessRefusal, opt: true },
  ],
);

const GrokBotService = {
  typeName: "aiserver.v1.GrokBotService",
  methods: {
    listGrokBotAgents: {
      name: "ListGrokBotAgents",
      I: ListGrokBotAgentsRequest,
      O: ListGrokBotAgentsResponse,
      kind: MethodKind.Unary,
    },
    sendGrokBotUserMessage: {
      name: "SendGrokBotUserMessage",
      I: SendGrokBotUserMessageRequest,
      O: SendGrokBotUserMessageResponse,
      kind: MethodKind.Unary,
    },
  },
} as const;

/** aiserver.v1.GrokBotUserMessageDelivery.REFUSED */
export const DELIVERY_REFUSED = 4;

export type BotHit = {
  agentId: string;
  id: string;
  name: string;
  title: string;
};

export type ListBotsResult = {
  bots: BotHit[];
  truncated: boolean;
};

export type SendResult = {
  messageId: string;
  dispatched: boolean;
  delivery: number;
  workflowId?: string;
  refusal?: { failureCode: string; message: string };
};

export type Protocol = {
  listBots(): Promise<ListBotsResult>;
  sendMessage(input: { agentId: string; text: string; messageId?: string; sessionId?: string }): Promise<SendResult>;
};

export type TokenHolder = {
  current(): AccessToken | Promise<AccessToken>;
  reread(): AccessToken | Promise<AccessToken>;
};

export function createProtocol(opts: {
  baseUrl: string;
  tokenOpts?: LoadTokenOptions;
  /** 测试注入。 */
  access?: TokenHolder;
}): Protocol {
  const holder = opts.access ?? fileAccess(opts.tokenOpts ?? {});
  const interceptor = createRereadInterceptor(holder);
  const transport = createConnectTransport({
    baseUrl: opts.baseUrl.replace(/\/$/, ""),
    httpVersion: "1.1",
    interceptors: [interceptor],
  });
  // Generated-style service typings are incomplete for this hand-written subset.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = createClient(GrokBotService as any, transport);

  return {
    async listBots() {
      try {
        const res = await client.listGrokBotAgents({});
        const bots: BotHit[] = (res.agents ?? []).map((a: { agentId?: string; id?: string; name?: string; title?: string }) => ({
          agentId: a.agentId || a.id || "",
          id: a.id || "",
          name: a.name || "",
          title: a.title || "",
        }));
        return { bots, truncated: Boolean(res.truncated) };
      } catch (e) {
        throw mapRpcError(e, { write: false });
      }
    },
    async sendMessage(input) {
      const messageId = input.messageId || crypto.randomUUID();
      try {
        const res = await client.sendGrokBotUserMessage({
          agentId: input.agentId,
          sessionId: input.sessionId ?? "",
          messageId,
          text: input.text,
          sentAtMs: BigInt(Date.now()),
        });
        const refusal = res.refusal
          ? { failureCode: String(res.refusal.failureCode ?? ""), message: String(res.refusal.message ?? "") }
          : undefined;
        return {
          messageId,
          dispatched: Boolean(res.dispatched),
          delivery: Number(res.delivery ?? 0),
          workflowId: res.workflowId || undefined,
          refusal,
        };
      } catch (e) {
        throw mapRpcError(e, { write: true });
      }
    },
  };
}

function fileAccess(tokenOpts: LoadTokenOptions) {
  return {
    current(): AccessToken {
      return loadAccessToken(tokenOpts);
    },
    reread(): AccessToken {
      return loadAccessToken(tokenOpts);
    },
  };
}

/**
 * Bearer 只读拦截器：401 时再读一次 sand-secrets.json（不调用 refresh 接口），
 * 若 token 已变化则重试这一次 RPC（含发送）。不把 token 写进任何日志。
 */
function createRereadInterceptor(access: TokenHolder): Interceptor {
  return (next) => async (req) => {
    let tok = await readUsableToken(() => access.current());
    req.header.set("authorization", `Bearer ${tok.token}`);
    try {
      return await next(req);
    } catch (err) {
      if (!isUnauthenticated(err)) throw err;
      const again = await access.reread();
      if (isExpired(again) || !again.token || again.token === tok.token) {
        throw expiredError(again);
      }
      req.header.set("authorization", `Bearer ${again.token}`);
      return await next(req);
    }
  };
}

async function readUsableToken(load: () => AccessToken | Promise<AccessToken>): Promise<AccessToken> {
  const first = await load();
  if (!isExpired(first)) return first;
  const second = await load();
  if (!isExpired(second) && second.token !== first.token) return second;
  throw expiredError(second);
}

function isUnauthenticated(err: unknown): boolean {
  if (err instanceof ConnectError) return err.code === Code.Unauthenticated;
  const anyErr = err as { code?: string | number };
  const c = String(anyErr.code ?? "");
  return c === "unauthenticated" || c === "16" || c === String(Code.Unauthenticated);
}

function mapRpcError(err: unknown, opts: { write: boolean }): AgentwatchError {
  if (err instanceof AgentwatchError) return err;
  if (err instanceof ConnectError) {
    if (err.code === Code.Unauthenticated) {
      return new AgentwatchError("auth", "服务器返回未认证（401）。", {
        hint: "请打开并登录官方 Grok Bot 桌面应用，确认磁盘上的 token 已被刷新。",
      });
    }
    if (err.code === Code.NotFound) {
      return new AgentwatchError("not_found", err.rawMessage || err.message);
    }
    if (
      err.code === Code.Unavailable ||
      err.code === Code.ResourceExhausted ||
      err.code === Code.DeadlineExceeded
    ) {
      return new AgentwatchError("retryable", `可重试的 RPC 错误：${err.rawMessage || err.message}`, {
        retryable: true,
      });
    }
    if (opts.write && (err.code === Code.Unknown || err.code === Code.Internal || err.code === Code.Canceled)) {
      return new AgentwatchError("notify_failed", `发送结果未知：${err.rawMessage || err.message}`, {
        hint: "不要盲目重发。先确认 bot 会话里是否已出现通知。",
      });
    }
    return new AgentwatchError("failure", err.rawMessage || err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNRESET|ENOTFOUND|socket hang up|network/i.test(msg)) {
    return new AgentwatchError("retryable", `网络错误：${msg}`, { retryable: true });
  }
  return new AgentwatchError("failure", msg);
}

export function findBot(list: ListBotsResult, botId: string): { bot: BotHit } | { error: AgentwatchError } {
  const bot = list.bots.find((b) => b.agentId === botId || b.id === botId);
  if (bot) return { bot };
  if (list.truncated) {
    return {
      error: new AgentwatchError(
        "lookup_incomplete",
        `ListGrokBotAgents 被截断，列表中没有 ${botId}，无法确认它是否存在。`,
        {
          hint: "没有 Get RPC。列表不完整时不会运行命令，以免通知发到未知目标。",
        },
      ),
    };
  }
  return {
    error: new AgentwatchError("not_found", `完整的 ListGrokBotAgents 结果中找不到 bot ${botId}。`, {
      hint: "没有 GetGrokBotAgent RPC；校验方式是 list + 按 --bot 过滤。请确认 agent-id。",
    }),
  };
}
