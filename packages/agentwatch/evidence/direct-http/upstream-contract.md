# Direct transport contract: reference only

2026-11-20, Asia/Shanghai. Parent scope: t185. Baseline c378e8f.
Reference: younglark/grokbot-control tag npm-v0.7.0,
commit 097ed4fd107d1d7a92ef10f37b44b104edea1d70. Read using git show from an
already-present reference checkout; no install, execute, credential read or live request.
No SDK/generated source was copied into the runtime.

## Pinned primary reference files

- [Connect client](https://github.com/younglark/grokbot-control/blob/097ed4fd107d1d7a92ef10f37b44b104edea1d70/dist/connect/client.js):
  Bearer interceptor; read-only RPC allowlist includes ListGrokBotAgents and
  GetGrokBotSendStatus; writes are not replayed. Structured auth code whitelist
  is distinct from transient refresh network/timeout/cooldown errors.
- [Bot operations](https://github.com/younglark/grokbot-control/blob/097ed4fd107d1d7a92ef10f37b44b104edea1d70/dist/ops/bot.js):
  get = listGrokBotAgents({}) + local filter. Agentwatch intentionally only accepts
  exact agentId, not the reference's alternative numeric server id. Missing from
  a truncated list is inconclusive, not authorization proof.
- [Message operations](https://github.com/younglark/grokbot-control/blob/097ed4fd107d1d7a92ef10f37b44b104edea1d70/dist/ops/message.js):
  sendGrokBotUserMessage({agentId,sessionId:"",messageId,text,sentAtMs:BigInt(now)});
  getGrokBotSendStatus({agentId,sessionId:"",messageId}). No guessed team id.
  The CLI adds agent_id/message_id to its own envelope; the RPC responses do NOT
  echo those identifiers. Agentwatch receipt IDs are local request correlation,
  not proof of server echo, idempotency or durable delivery.
- [Service descriptor](https://github.com/younglark/grokbot-control/blob/097ed4fd107d1d7a92ef10f37b44b104edea1d70/vendor/proto-gen/svc_aiserver.v1.GrokBotService_connect.js):
  service aiserver.v1.GrokBotService; all three named methods are unary.
- [Message schema](https://github.com/younglark/grokbot-control/blob/097ed4fd107d1d7a92ef10f37b44b104edea1d70/vendor/proto-gen/aiserver.v1_pb.js):
  List response agents (GrokBotAgent.agent_id)/truncated;
  send response dispatched/mode/workflow_id/delivery/refusal;
  status response status/echo_entry_id/rejection_code/accepted_at_ms.
  Delivery values 1 ACCEPTED_BOX, 2 ACCEPTED_TEMPORAL, 3 DUPLICATE, 4 REFUSED;
  status 1 NOT_FOUND, 2 ACCEPTED, 3 REJECTED, 4 PENDING, 5 UNKNOWN_DURABILITY.
- [Auth provider](https://github.com/younglark/grokbot-control/blob/097ed4fd107d1d7a92ef10f37b44b104edea1d70/dist/auth/provider.js):
  public client_id is not embedded or guessed from JWT; config or persisted binding
  only, mismatch refused. Agentwatch implements its OWN independent private file
  and explicit AGENTWATCH_CLIENT_ID policy, not this provider/store or ~/.gbc.

## Minimal HTTP encoding

[Connect protocol specification](https://connectrpc.com/docs/protocol/) opened via
public search this turn: unary POST /package.Service/Method; application/json;
Connect-Protocol-Version:1; bare protobuf JSON body, no gRPC binary framing and no
CLI result envelope. Success HTTP 200, errors non-200 JSON {code,message?,details?}.
Protobuf JSON uses lowerCamelCase field names and decimal strings for int64;
enums accept their fully-qualified protobuf enum constant spelling or numeric code.
Tests pin actual named constants and numeric alternatives from the schema above.

Current agentwatch emits JSON, while the reference Connect transport can also use
protobuf binary. The actual backend accepting these JSON calls is NOT live tested.
Client uses only explicit Bearer + Connect/content-type headers, not forged App headers.
Backend origin is bound in the private file; HTTPS except numeric loopback mock HTTP;
no redirects, no separately overridable token destination, no inferred team/client id.

## Local semantics versus remote claims

- All six exact structured auth codes map to AUTH_NOT_CONFIGURED/4; permission/
  missing targets to BOT_FORBIDDEN/5; truncated absence UNKNOWN/10; other read
  failures transport/8. Missing/unsafe/expired private credentials never request HTTP.
- Once fetch is invoked, all failures are potentially dispatched: no network write
  retry, even if a response claims retryable or rpc_dispatched:false. This is a
  deliberate safer adaptation: the old CLI could attest a LOCAL auth interceptor
  failure; a remote JSON field cannot attest local non-dispatch.
- Common worker preserves the injected local-proof safe retry contract, max three
  total attempts with persisted 250/500ms backoff; tests at public engine/store seam.
  Production direct adapter currently has no refresh/pre-dispatch transient retry
  source. Local credential loss retains pending/NOT_CONFIGURED, not a lost outbox.
- Maximum response 1MiB while streaming/decompressing, absolute 3s deadline through
  body reads, cancellation via AbortSignal.any and reader finally release. Private
  file max16KiB while reading, not merely a pre-read stat size check.
- Receipt is a sanitized field whitelist, not a full HTTP capture. Unknown side
  effects are never auto-replayed. Durability is always unverified; accepted and
  duplicate do not prove server dedup, persisted inbox, read status or business success.

No real backend, real bot, real credentials, browser login, OAuth refresh,
team binding, notifications or four-vendor CLI E2E was exercised. Browser login/
refresh provisioning commands are explicitly deferred, not simulated as implemented.
