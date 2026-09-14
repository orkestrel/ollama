# Ollama

> A typed local-LLM provider for the `@orkestrel` line: a `ProviderInterface` over a
> local Ollama daemon's `POST /api/chat`, with non-streaming `generate`, NDJSON
> `stream`, tool calls, thinking, and usage accounting, built on web-standard `fetch`
> and `ReadableStream` with no Ollama SDK dependency.

This provider lets an Agent run against a real model on `localhost` — one small local model, no cloud dependency, and no API key. The design is deliberately spare — an external boundary kept honest. Every `unknown` wire value is narrowed through the `@orkestrel/contract` guards (`isRecord`, `isString`, `isNumber`) rather than a type assertion, and a missing or malformed field degrades to a sensible default (empty content, no usage, `{}` arguments) rather than a throw.

Every call is bounded by the caller's `AbortSignal` (a cancel, a deadline, or a budget, folded through `AbortSignal.any`) together with the provider's own armed `Timeout`; a `stream` cancelled mid-flight throws a `ProviderAbortError` (from `@orkestrel/agent`) carrying the partial. The provider publishes no events: each call is a pure function of its arguments. The wire `think` flag is configurable through `OllamaOptions.think` (default `false`) and overrideable per call through `ProviderStreamOptions.think`, then backstopped with a per-call `ThinkSplitter`, because a daemon may ignore the flag for a thinking model. With `think: true` the daemon returns reasoning on the separate `message.thinking` channel, streamed live as `thinking` deltas; either way every content delta is split, only clean content is yielded and assembled, and the separated reasoning — plus any daemon-side `message.thinking` deltas — surfaces as `ProviderResult.thinking`, never in the conversation. A per-call `ProviderStreamOptions.schema` (a JSON schema object, from `@orkestrel/agent`) forwards verbatim as the wire's structured-output `format` field, and is omitted from the request when no schema is supplied. Token usage reuses the `TokenUsage` shape rather than minting its own.

The dependency is strictly one-way: this surface imports the abstract provider contract and its error from `@orkestrel/agent`, tool-call shapes from `@orkestrel/tool`, the `NDJSONParser`, the `Timeout`, and the guards from `@orkestrel/contract` — those packages never import from here. It is tested live against `qwen3.5:2b-q4_K_M` in a dedicated `service` test project that requires the daemon and warms the model first, with no `skipIf`, while the `src:core` project stays hermetic on recording-proxy wire-shape assertions that pass with the daemon down. Source: [`src/core`](../src/core). Surfaced through the `@orkestrel/ollama` barrel, aliased `@src/core` inside this repo.

## Surface

The 80% case: create a provider once, then `generate` a turn against a conversation, bounding the call with an `AbortSignal` (from `@orkestrel/abort`). Messages are the abstract `Message` shape from `@orkestrel/agent` (`{ id, role, content }`), so the same conversation drives any provider.

```ts
import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Reply with exactly: ok' }] as const

const result = await provider.generate(messages, abort.signal)
result.content // the assistant's answer text
result.usage // { prompt, completion, total } when the wire reported counts — folds into a token budget
```

`generate` resolves the assembled `ProviderResult` (content + any tool calls + any usage). For live output, `stream` is the same call streamed: it yields `ProviderDelta`s (`content` for answer text, `thinking` for live reasoning) and returns the assembled result when the stream completes. Drive the generator and read its terminal `value`:

```ts
import { createAbort } from '@orkestrel/abort'
import { isProviderAbortError } from '@orkestrel/agent'
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Say hello.' }] as const

try {
	const generator = provider.stream(messages, abort.signal)
	let step = await generator.next()
	while (!step.done) {
		if (step.value.channel === 'content') process.stdout.write(step.value.text)
		if (step.value.channel === 'thinking') process.stderr.write(step.value.text)
		step = await generator.next()
	}
	const result = step.value // the assembled ProviderResult
} catch (error) {
	if (isProviderAbortError(error))
		keep(error.partial.content) // recover what streamed
	else throw error
}
```

Pass `tools` (a non-empty `ToolDefinition[]` from `@orkestrel/tool`) to advertise callable tools for the turn; when the model calls one, `result.tools` is a `ToolCall[]` from that same package (each with a guaranteed `id`, the tool `name`, and parsed `arguments`). Aborting a `stream` mid-flight throws a `ProviderAbortError` whose `partial` holds whatever streamed before the cancel.

### Surface

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. A function row's `Shape` cell holds its signature, and a guard row's the type it narrows to. A class row's `Shape` cell holds the interface it implements, or its constructor signature where it implements none. A `Shape` cell holds the constant's declared type.

| API                        | Kind      | Shape                                                                                                               | Summary                                                                                                                                                                     |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createOllama`             | function  | `(options: OllamaOptions) => ProviderInterface`                                                                     | Creates a local Ollama inference provider — a `ProviderInterface` over the daemon's `POST /api/chat`, supporting non-streaming `generate` and streaming `stream`.           |
| `OllamaProvider`           | class     | `ProviderInterface`                                                                                                 | Implements the local Ollama inference boundary — a `ProviderInterface` over Ollama's `POST /api/chat`, both non-streaming (`generate`) and streaming NDJSON (`stream`).     |
| `OllamaResponse`           | interface | `{ response, timeout, combined }`                                                                                   | Represents an open `POST /api/chat` response together with the deadline and the combined signal that bound the request.                                                     |
| `OllamaOptions`            | interface | `{ model, url?, keepAlive?, timeout?, options?, think?, fetch?, headers?, format? }`                                | Represents the configuration `createOllama` accepts for the local Ollama backend.                                                                                           |
| `DEFAULT_OLLAMA_URL`       | const     | `string`                                                                                                            | Names the local Ollama daemon base URL, `'http://localhost:11434'`, assumed when `OllamaOptions.url` is omitted.                                                            |
| `DEFAULT_KEEP_ALIVE`       | const     | `string`                                                                                                            | Names how long the model stays resident after a call — `'5m'` when `OllamaOptions.keepAlive` is omitted, Ollama's own `keep_alive` default, expressed as a duration string. |
| `DEFAULT_PROVIDER_TIMEOUT` | const     | `number`                                                                                                            | Names the per-call deadline in milliseconds, `120_000`, when `OllamaOptions.timeout` is omitted — generous enough that a cold model load does not trip it.                  |
| `WireChatRequest`          | interface | `{ model, messages, stream, keep_alive, think, options?, tools?, format? }`                                         | Represents the exact `POST /api/chat` request body `OllamaProvider` sends — the internal typed wire contract.                                                               |
| `OllamaHTTPError`          | class     | `new (message: string, status: number, options?: OllamaHTTPErrorOptions) => OllamaHTTPError`                        | Represents an error thrown when the Ollama `/api/chat` HTTP transport fails.                                                                                                |
| `isOllamaHTTPError`        | function  | `OllamaHTTPError`                                                                                                   | Checks whether a value is an `OllamaHTTPError`.                                                                                                                             |
| `OllamaHTTPErrorOptions`   | interface | `{ cause? }`                                                                                                        | Represents the options a thrown `OllamaHTTPError` accepts beside its message and status — the standard error `cause` link, named so a consumer can reference the shape.     |
| `MAX_ERROR_BODY_LENGTH`    | const     | `number`                                                                                                            | Names the character cap, `2048`, on how much of a non-OK response body is incorporated into a thrown `OllamaHTTPError`'s message.                                           |
| `mapMessages`              | function  | `(messages: readonly Message[]) => WireChatRequest['messages']`                                                     | Maps conversation turns onto the `/api/chat` wire's minimal message shape.                                                                                                  |
| `buildResult`              | function  | `(content: string, thinking: string, tools: readonly ToolCall[], usage: TokenUsage \| undefined) => ProviderResult` | Builds a `ProviderResult` from a turn's content, reasoning, tool calls, and usage.                                                                                          |
| `parseBody`                | function  | `(response: Response) => Promise<Readonly<Record<string, unknown>> \| undefined>`                                   | Parses a non-stream `/api/chat` response body into a wire record.                                                                                                           |
| `extractContent`           | function  | `(record: Readonly<Record<string, unknown>>) => string`                                                             | Extracts the assistant text of one wire record.                                                                                                                             |
| `extractThinking`          | function  | `(record: Readonly<Record<string, unknown>>) => string`                                                             | Extracts the daemon-side reasoning of one wire record.                                                                                                                      |
| `joinThinking`             | function  | `(splitter: ThinkSplitterInterface, wired: string) => string`                                                       | Joins a call's reasoning carriers — the splitter's separated in-content spans and the accumulated wire-side `message.thinking` — into the result's `thinking`.              |
| `extractUsage`             | function  | `(record: Readonly<Record<string, unknown>>) => TokenUsage \| undefined`                                            | Extracts the token usage of one wire record.                                                                                                                                |
| `extractTools`             | function  | `(record: Readonly<Record<string, unknown>>) => readonly ToolCall[]`                                                | Extracts the tool calls of one wire record's `message.tool_calls`.                                                                                                          |
| `extractArguments`         | function  | `(value: unknown) => Readonly<Record<string, unknown>>`                                                             | Extracts a wire `arguments` value as a record.                                                                                                                              |

The wire leaves — `mapMessages` / `buildResult` / `parseBody` and the `extract*` / `joinThinking` narrowing set — are the pure request projections and response extractions `OllamaProvider` composes. They are exported and unit-tested on their own so the package's highest-risk code, the boundary narrowing of every wire `unknown` through the `@orkestrel/contract` guards, is provable without a daemon; the class keeps the stateful work (`#fetch`, `#requestHeaders`, `#body`, and the `#deltas` streaming spine).

`OllamaProvider`'s `id` / `name` are `readonly` data members (the abstract `ProviderInterface`'s — `name` is `'ollama'`); `format` is its `readonly` context-framing default (also a data member, satisfying the optional `ProviderInterface.format` — see [Context framing](#context-framing)); its call-signature methods are documented under [Methods](#methods). `ProviderResult` / `ProviderDelta` / `ProviderStreamOptions` / `ProviderInterface` / `ProviderAbortError` / `isProviderAbortError` / `Message` / `ContextFormat` and the `ThinkSplitter` (`createThinkSplitter`) the provider routes content deltas through are owned by `@orkestrel/agent`; `ToolDefinition` / `ToolCall` are owned by `@orkestrel/tool`; the `TokenUsage` shape is owned by `@orkestrel/budget`. All are reused here, never redefined.

## Methods

The public methods of `OllamaProvider` — exactly the abstract `ProviderInterface`'s call-signature members (its `readonly` data members `id` / `name` stay Surface rows). `OllamaProvider` implements that interface exactly, so this doubles as its instance-method surface; the interface itself is documented in `@orkestrel/agent`.

#### `OllamaProvider`

`generate` produces one complete turn; `stream` yields `ProviderDelta`s and returns the assembled result. Each takes the conversation, a bounding `AbortSignal`, optional `tools`, and optional per-call `ProviderStreamOptions`.

| Method     | Returns                                         | Summary                                                                                                                                                      |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `generate` | `Promise<ProviderResult>`                       | Generates one complete turn and resolves the assembled result — the clean content, any separated reasoning, any tool calls, and any usage the wire reported. |
| `stream`   | `AsyncGenerator<ProviderDelta, ProviderResult>` | Streams one turn, yielding a channel-tagged delta per non-empty content or reasoning span and returning the assembled result when the stream completes.      |

## Contract

These invariants hold across `src/core` ↔ `ollama.md` (the `ProviderInterface` / `ProviderResult` / `ProviderAbortError` contract itself is in `@orkestrel/agent`):

1. **Doc ↔ source bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` table is a real export of the `src/core` surface, and every export appears as a Surface row — exhaustive, both directions.
2. **Imports each boundary from its owner, no cycle.** `OllamaProvider` implements `ProviderInterface` and throws `ProviderAbortError`; those symbols, `Message`, and the provider result/delta/options shapes come from `@orkestrel/agent`. `ToolCall` / `ToolDefinition` come from `@orkestrel/tool`, `TokenUsage` from `@orkestrel/budget`, the `NDJSONParser` from `@orkestrel/ndjson`, the `Timeout` from `@orkestrel/timeout`, and the `@orkestrel/contract` guards (`isRecord` / `isString` / `isNumber`) from `@orkestrel/contract`. Each dependency is one-way and never imports from `@src/core`.
3. **The `/api/chat` wire protocol.** `OllamaProvider` POSTs `{ model, messages, stream, keep_alive, think }` to `${url}/api/chat` (the `think` flag is the per-call `ProviderStreamOptions.think` override when present, else `OllamaOptions.think`, default `false`), adding `options` only when configured and `tools` only when a non-empty `ToolDefinition[]` is passed. Each tool maps to `{ type: 'function', function: { name } }`, with `description` and `parameters` added only when the corresponding `ToolDefinition` fields are supplied. Messages map to the wire's minimal `{ role, content }` turn, with `tool_calls` added only on an assistant turn that replays them. A non-OK HTTP status throws `OllamaHTTPError('Ollama API error: <status> - <body>', status)`, its message bounded to a `2048`-char body excerpt (a body-read failure itself throws `OllamaHTTPError` with `'(error body unavailable)'` and a `cause`); a `stream` whose response arrives with a `null` body throws `OllamaHTTPError('Ollama API error: no response body', 0)`. Every throw carries `code: 'HTTP'`, so a caller branches on `error.code` and reads `error.status` for the HTTP number (`0` for the null-body case); `isOllamaHTTPError` narrows a caught value without parsing the message.
4. **Configurable `think` on the wire; the splitter keeps the assembled content clean.** For a thinking-capable model (for example `qwen3`) the per-request `think` flag is the only wire-level reasoning control (its native renderer honours neither the qwen3 `/no_think` token nor a Modelfile `PARAMETER think false`). It is configurable through `OllamaOptions.think` (default `false` — so the general-purpose provider stays immediate for non-thinking models and tests fast) and overrideable per call through `ProviderStreamOptions.think`. Set `think: true` when the caller displays reasoning separately from the answer. With `think: true` the daemon separates reasoning natively, returning it on the distinct `message.thinking` channel (yielded live as `ProviderDelta` `{ channel: 'thinking', text }` and accumulated onto `ProviderResult.thinking`) rather than inline in `message.content`. Either way the per-call `ThinkSplitter` (`createThinkSplitter` — fresh per stream) is the defensive fallback: a daemon may still ignore `think: false` for a thinking model and render reasoning inline as `<think>…</think>` content, so each call routes every content delta through the splitter — the assembled `content` is its authoritative clean accumulation (a tag split across NDJSON chunks is held until disambiguated, an unclosed span at stream end is treated as reasoning, and the qwen3 template's implicit pre-seeded open — a bare `</think>` with no open on the wire — reclassifies the surfaced prefix into thinking), and the separated spans — joined with any daemon-side `message.thinking` deltas — surface as `ProviderResult.thinking`, present only when non-empty. The reasoning never re-enters the conversation.
5. **Non-stream vs. NDJSON stream.** `generate` sends `stream: false` and parses one JSON body. `stream` sends `stream: true` and consumes NDJSON — one JSON object per `\n`-terminated line — pairing a `TextDecoder({ stream: true })` (partial multi-byte characters) with the `@orkestrel/ndjson` `NDJSONParser` parser (partial lines) so a record split across byte reads is reassembled. Each delta line may carry `message.content` (split and yielded as a `content` delta when non-empty) and / or `message.thinking` (yielded as a `thinking` delta when non-empty); the final `done: true` line carries the token usage. At stream end the decoder's held multi-byte tail is flushed and fed through the parser (with a trailing `\n` appended when non-empty) so a non-conformant proxy's final unterminated `done` line is still recovered rather than silently dropped; a `generate`'s non-stream body that is empty or fails to parse as a JSON record yields `undefined`, which the call site reads as `{}` (empty content, no usage), never a raw `SyntaxError` escaping to the caller.
6. **`stream` yields deltas + returns the assembled result.** The generator yields each non-empty clean content delta as `{ channel: 'content', text }` and each daemon-side reasoning delta as `{ channel: 'thinking', text }`; its return value is the assembled `ProviderResult` whose `content` is the splitter's authoritative clean accumulation — exactly the concatenation of the yielded content deltas (a held partial tag the stream never completed is yielded as the final content delta, so the equality holds), except across an implicit-open reclassification (the implicit-open case: the reasoning prefix had already streamed before the bare `</think>` revealed it, so the result drops it and the yields cannot be recalled) — plus any tool calls collected across lines, the usage from the `done` line, and the separated `thinking` when the turn produced any.
7. **Usage from the `done` line / body (reuses `TokenUsage`).** `ProviderResult.usage` is present only when both `prompt_eval_count` and `eval_count` are numbers on the parsed record (the non-stream body, or the stream's `done: true` line) — mapped to `{ prompt, completion, total: prompt + completion }`, the `TokenUsage` shape (imported, not redefined). A delta line carries neither count, so it contributes no usage.
8. **Tool-call extraction with id-generation (no `as`).** `result.tools` is the model's `message.tool_calls`, each entry narrowed to `{ id, name, arguments }`: the entry and its `function` must be records and `name` a string (else the entry is dropped); `arguments` is the wire object as-is, a JSON string parsed to a record, or `{}` when neither; `id` is the wire's `id` when a string, else a freshly minted `crypto.randomUUID()`. An empty result `tools` is never surfaced — its absence means "no calls".
9. **Boundary narrowing — all wire `unknown` through guards, never `as`.** Every value read off the wire (the parsed body, each NDJSON record, `message`, `content`, the usage counts, `tool_calls`, `arguments`) arrives as `unknown` and is narrowed through the `@orkestrel/contract` guards (`isRecord` / `isString` / `isNumber`) — never a type assertion. A missing or malformed field degrades to a sensible default (empty content, no usage, `{}` arguments), never a throw — the one external boundary kept honest.
10. **Bounded by an `AbortSignal` + a deadline.** Each call arms a `Timeout` for `OllamaOptions.timeout` (default `120_000`ms) and passes `AbortSignal.any([timeout.signal, callerSignal])` to `fetch`, so the caller's signal and the deadline both cancel the request; the timeout is always cleared — when the request fails or aborts, and otherwise after the response is consumed (never left armed). An already-aborted signal rejects the call before any content streams.
11. **Abort → `ProviderAbortError` with the partial.** A `stream` cancelled mid-flight (the caller's signal or the deadline) throws a `ProviderAbortError` whose `partial` is the `ProviderResult` assembled from whatever streamed so far — including the splitter's held partial tag, flushed into the partial's `content` before it is thrown, exactly as at normal stream end; `isProviderAbortError` (from `@orkestrel/agent`) narrows a caught value so the loop can recover the partial content. A non-abort error propagates unchanged. The reader is `cancel()`ed (not merely released, freeing the underlying HTTP connection; tolerated as a no-op on an already-done/errored reader) and the parser cleared, both in a `finally`.
12. **Transport seam (custom `fetch` + dynamic `headers`).** `OllamaOptions.fetch` swaps the transport (default `globalThis.fetch`, bound to its `globalThis` receiver — `globalThis.fetch.bind(globalThis)` — because invoking a bare reference through a field loses the `window` receiver and browsers throw `Illegal invocation`; node's fetch is receiver-agnostic) and `OllamaOptions.headers` is a per-request, possibly-async injector whose returned `Readonly<Record<string, string>>` is merged on top of the base `Content-Type` (the hook adds headers; it overrides `Content-Type` only by explicitly returning one). Both are optional — omitted ⇒ the bound global `fetch` and only `Content-Type: application/json`. This lets a browser-side runtime route through the developer's own server with an obfuscated/generated bearer token the server validates: **your app never handles a real API key** — the real key lives only on that server; the `headers` hook supplies whatever short-lived token it expects. The hook is awaited inside the request path's `try`, so a hook rejection clears the armed deadline like any other failure (merged through `Object.entries`, no `as`).
13. **Context-framing `format` (provider-default cascade level, expose-only).** `OllamaOptions.format` is an optional `ContextFormat` (from `@orkestrel/agent`) — the provider's context-framing default, exposed as `provider.format` to satisfy the optional `ProviderInterface.format`. It is the provider-default level of `AgentContext`'s build cascade (beats the managers' built-in framing, beaten by a manager-options or per-item override; see `@orkestrel/agent`), read by the Agent when it assembles the prompt. Omitted ⇒ `undefined` (framing-agnostic; core's built-in framing applies unchanged). It is **never sent on the `/api/chat` wire**: it is consumed by core, absent from the request `body`, and is unrelated to Ollama's structured-output `/api/chat` `format` parameter — that one is sent in the request `body`, but only when a per-call `ProviderStreamOptions.schema` is supplied (omitted otherwise) — the framing default and that wire parameter only share a word.
14. **Event-free.** A pure functional boundary — no Emitter, no events.
15. **Tested live against a real local Ollama (no `skipIf`).** The provider tests run against a real Ollama daemon — no mocks, only genuine third-party calls — model `qwen3.5:2b-q4_K_M`, with `OLLAMA_HOST` / `OLLAMA_MODEL` overridable. Unlike the other surfaces, the dedicated `service` project requires the daemon: `tests/setupService.ts` throws a clear error if it is unreachable and warms the model (a `num_predict: 1` chat) before the suite, so the live tests run unconditionally (no `describe.skipIf`). The project runs serially (`fileParallelism: false`) with a 120s test/hook timeout so a cold load can't flake it; `keep_alive` keeps the model resident across files, and `bash scripts/ollama.sh` brings the daemon and model up before the battery in CI. Assertions are structural — they hold whatever wording a small model produces — and never pin exact output.
16. **Doc ↔ source method bijection.** The `## Methods` table lists exactly `OllamaProvider`'s public methods (`generate` / `stream`), and the class exposes exactly those — no more.

## Patterns

### `createOllama` + `generate`

The dominant single-shot use: one prompt, one assembled result.

```ts
import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M', options: { temperature: 0 } })
const abort = createAbort()
const messages = [
	{ id: '1', role: 'user', content: 'Summarize the release notes for version 2.0.' },
] as const

const result = await provider.generate(messages, abort.signal)
console.log(result.content)
if (result.usage) charge(result.usage) // fold into a token budget
```

### Bounding a call with a budget + timeout

`generate` / `stream` take a plain `AbortSignal`, so fold an abort, a timeout, and a token budget into one bound through `AbortSignal.any` — whichever trips first cancels the call. This caller-side bound stacks on top of the provider's own armed deadline (`OllamaOptions.timeout`, default `120_000`ms): the request dies when either fires, so you get an external cancel/budget and a hard per-call ceiling for free.

```ts
import { createAbort } from '@orkestrel/abort'
import { createTimeout } from '@orkestrel/timeout'
import { createTokenBudget } from '@orkestrel/budget'
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
const abort = createAbort() // external cancel
const timeout = createTimeout({ ms: 30_000 }) // wall-clock deadline
const budget = createTokenBudget({ max: 50_000, scope: 'total' }) // cost ceiling
timeout.start()
budget.start()

const bound = AbortSignal.any([abort.signal, timeout.signal, budget.signal])
const result = await provider.generate(messages, bound)
budget.consume(result.usage ?? { prompt: 0, completion: 0, total: 0 })
```

### Routing through your own server (obfuscated tokens)

In the browser you must not ship the real LLM API key. Instead, deploy a thin server that holds the real key, point the provider's `url` at that server, and use `headers` to attach a generated/obfuscated token your server validates before relaying the request to the real LLM. The custom `fetch` lets you swap the transport (for example a browser fetch, an instrumented wrapper) without touching the wire protocol. The client itself never handles the real API key — it only attaches the header your hook returns. Omitting the transport and the header hook leaves the global `fetch` and only `Content-Type: application/json`.

```ts
import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({
	model: 'qwen3.5:2b-q4_K_M',
	url: 'https://my-app.example.com/llm', // your server, which forwards to the real LLM
	headers: async () => ({ authorization: `Bearer ${await mintToken()}` }), // server validates this
	// fetch: myFetch, // optional: inject a custom transport
})
const abort = createAbort()
const result = await provider.generate(messages, abort.signal)
```

The `headers` hook is called once per request (async, so a token can be refreshed each call); its result merges on top of the base `Content-Type`, so it adds an authorization header without disturbing the JSON body. The real key stays on your server — the client never sees it.

### Context framing

`OllamaOptions.format` is the provider's context-framing default — a `ContextFormat` (from `@orkestrel/agent`) declaring how this provider's models prefer the context sections framed (for example XML group wrappers vs. Markdown headers). It is the **provider-default level** of `AgentContext`'s build cascade (see `@orkestrel/agent`): it beats the managers' built-in framing but is beaten by a manager-options or per-item override. `createOllama` accepts it directly and `OllamaProvider` exposes it as `provider.format`, satisfying the optional `ProviderInterface.format`; the Agent reads it when it assembles the prompt. Omit it and the provider is framing-agnostic — core's built-in section framing applies unchanged.

```ts
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({
	model: 'qwen3.5:2b-q4_K_M',
	format: {
		instructions: {
			open: '<instructions>',
			render: (instruction) => `<instruction>${instruction.content}</instruction>`,
			close: '</instructions>',
		},
	},
})
provider.format // the ContextFormat preceding — read by AgentContext.build()
```

**Not the wire `format`.** This is the prompt-context framing consumed by `AgentContext.build()` — it is **expose-only** and is never sent on the `/api/chat` request. It is unrelated to Ollama's `/api/chat` `format` parameter (structured output / JSON schema): that wire field is driven by a different, per-call source — `ProviderStreamOptions.schema` (from `@orkestrel/agent`) — forwarded verbatim as `format` and omitted from the body when `schema` is undefined. The framing default and the wire parameter share a word and nothing else: the framing default is a hint the daemon never sees, and the wire parameter is a per-call constraint the provider never exposes back.

### Narrowing HTTP errors with `isOllamaHTTPError`

Branch on the HTTP status rather than parsing the thrown message: narrow a caught value with `isOllamaHTTPError` and read `error.status`.

```ts
import { createAbort } from '@orkestrel/abort'
import { createOllama, isOllamaHTTPError } from '@orkestrel/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Reply with exactly: ok' }] as const

try {
	await provider.generate(messages, abort.signal)
} catch (error) {
	if (isOllamaHTTPError(error) && error.status === 404) {
		// the configured model isn't pulled
	} else if (isOllamaHTTPError(error) && error.status === 400) {
		// malformed request (for example an empty model string)
	} else {
		throw error
	}
}
```

### Practices

- **Import the contract from `@orkestrel/agent`, the provider from `@orkestrel/ollama`** — `ProviderInterface` / `ProviderResult` / `isProviderAbortError` live in `@orkestrel/agent`; `createOllama` / `OllamaProvider` / `OllamaOptions` live in `@orkestrel/ollama`.
- **Import tool-call shapes from `@orkestrel/tool`** — `ToolDefinition` / `ToolCall` live with the tool runtime, while the provider contract that consumes them stays in `@orkestrel/agent`.
- **Bound every call** — pass an `AbortSignal` (an abort, or an `AbortSignal.any` over abort + timeout + budget) so a request can be cancelled, deadlined, or capped.
- **Recover the stream's partial** — wrap a driven `stream` in `try`/`catch` and narrow with `isProviderAbortError` to keep the content that arrived before a cancel.
- **Branch on the HTTP status, not the message** — narrow a caught value with `isOllamaHTTPError` and read `error.status` (`404` for an unpulled model) instead of parsing `error.message`.
- **Fold usage into a budget** — `result.usage` is the `TokenUsage` shape; `consume` it per turn to enforce a token ceiling.
- **Give a thinking model headroom** — with `think: true`, a reasoning model (for example `qwen3.5:2b` at `temperature: 0`) can spend 200+ tokens on `message.thinking` before any `content` token arrives; a tight `num_predict` cap or a tight external token budget can exhaust before content starts, yielding empty `result.content` — and `@orkestrel/agent`'s budget enforcement can abort mid-stream with `partial: true` if the cap is hit while thinking is still draining it. Size `num_predict` / the budget with thinking overhead in mind for any model run with `think: true`.
- **Tune through `options`** — pass sampling parameters (`temperature`, `seed`, and `num_predict`) through `OllamaOptions.options`; they forward verbatim to the wire.
- **Observe at the call site** — the provider publishes no events; read `stream`'s deltas and its returned result for everything a turn produced.

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value + type exports), the `OllamaProvider` method bijection, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `createOllama + generate` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/core/OllamaProvider.test.ts`](../tests/src/core/OllamaProvider.test.ts) — hermetic provider request-shape, framing, transport-seam, abort, deadline, and unreachable-upstream coverage, plus the streaming fold — deltas, tool-call accumulation, done-line usage, the unterminated tail flush, and think separation — driven over a canned NDJSON transport. Its recording proxy uses a deliberately unreachable default and asserts only captured requests and local provider behavior.
- [`tests/service/OllamaProvider.test.ts`](../tests/service/OllamaProvider.test.ts) — live provider generation, streaming, thinking, tool-call, usage, seeded, abort, deadline, and daemon-error coverage against the required warmed Ollama service.
- [`tests/service/transport.test.ts`](../tests/service/transport.test.ts) — the browser to own-server to LLM deployment, end-to-end (live, `service` project). A `createRecordingProxy(OLLAMA_CONFIG.host)` — a real `@orkestrel/server` + `@orkestrel/router` HTTP server — records the inbound request, forwards it to the selected Ollama service, and streams the response back.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — the wire leaves in the `src:core` project: the request projections and every response extraction, including each malformed-wire degradation.
- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) — `parseBody` in the `src:core` project: a JSON object body, an empty body, a malformed body, and valid JSON that is not an object.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — hermetic `createOllama` shape, identity, defaults, passthrough, and unreachable-upstream coverage in the `src:core` project.
- [`tests/service/factories.test.ts`](../tests/service/factories.test.ts) — live `createOllama` generation and streaming coverage in the `service` project against the required Ollama service.
- [`tests/src/core/integration.test.ts`](../tests/src/core/integration.test.ts) — the `src/core` integration scope in the `src:core` project: hermetic context framing, recap, reference, cherry-pick, canonical assembly order, scope allow-lists, workspace injection, and conversation selection through the unreachable recording proxy, plus a compile-time drift gate asserting the wire request and response shapes stay compatible with the official `ollama` client's types; that gate's authoritative check is `npm run check` (root tsc), while its run under vitest is an incidental no-op (`expectTypeOf` performs no runtime assertions).
- [`tests/service/compaction.test.ts`](../tests/service/compaction.test.ts) — live recap retention plus manual, automatic, and repeated conversation compaction in the `service` project.
- [`tests/service/conversation.test.ts`](../tests/service/conversation.test.ts) — live non-fatal compaction errors and long-conversation instruction behavior in the `service` project, with proxy calls explicitly forwarding to `OLLAMA_CONFIG.host`.
- [`tests/setup.test.ts`](../tests/setup.test.ts) — the shared test infrastructure itself: every helper, fixture, recorder, and guard `tests/setup.ts` and `tests/setupServer.ts` export, proved in the `setup` project.

## See also

- `@orkestrel/ndjson` — the `NDJSONParser` stream parser the streaming path consumes. Its guide ships with that package.
- `@orkestrel/contract` — the `isRecord` / `isString` / `isNumber` guards that narrow the wire `unknown`. Its guide ships with that package.
- [`AGENTS.md`](../AGENTS.md) — the coding rules this package is written to.
- [`README.md`](README.md) — the guides index.
