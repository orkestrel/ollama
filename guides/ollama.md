# Ollama

> A typed local-LLM provider for the `@orkestrel` line: the Ollama daemon's `POST /api/chat`
> wire carried on the shared `AgentProvider` engine from `@orkestrel/agent`, with NDJSON
> streaming, tool calls, thinking, and usage accounting narrowed off the wire through
> `@orkestrel/contract` guards and no Ollama SDK dependency.

This provider lets an Agent run against a real model on `localhost` — one small local model, no cloud dependency, and no API key. It supplies the Ollama wire and nothing else. `AgentProvider`, the HTTP engine in `@orkestrel/agent`, owns the deadline, the transport, the `headers` hook, the request, the bounded error read, the chunk decoder, the reasoning separation, and the result assembly. `OllamaProvider` extends that engine and fills the wire seams: `frame` returns a fresh NDJSON parser, `body` projects a `ProviderRequest` onto the `/api/chat` request, `read` decodes one record into a `ProviderIncrement`, and `finish` recovers a final line the daemon left unterminated. What a caller drives — `generate`, `stream`, `id`, `format` — is the base's, and [`agent.md`](agent.md) documents it.

The design is deliberately spare — an external boundary kept honest. Every `unknown` wire value is narrowed through the `@orkestrel/contract` guards (`isRecord`, `isString`, `isNumber`) rather than a type assertion, and a missing or malformed field degrades to a sensible default (empty content, no usage, `{}` arguments) rather than a throw. Every call streams: the request always carries `stream: true`, and `generate` drains the same NDJSON path `stream` exposes, so neither call can report content the other would not. The wire `think` flag is configurable through `OllamaOptions.think` (default `false`) and overrideable per call through `ProviderStreamOptions.think`; with `think: true` the daemon returns reasoning on the separate `message.thinking` channel, streamed live as `thinking` deltas. Either way the base's splitter separates any `<think>` span the daemon inlines anyway, so the assembled `content` is clean and the reasoning surfaces as `ProviderResult.thinking`, never in the conversation. A per-call `ProviderStreamOptions.schema` (a JSON schema object, from `@orkestrel/agent`) forwards verbatim as the wire's structured-output `format` field, and is omitted from the request when no schema is supplied. Token usage reuses the `TokenUsage` shape rather than minting its own.

The dependency is strictly one-way: this surface imports the base, the contract types, and the error from `@orkestrel/agent`, the parser factory from `@orkestrel/ndjson`, tool-call shapes from `@orkestrel/tool`, the usage shape from `@orkestrel/budget`, and the guards from `@orkestrel/contract` — those packages never import from here. The published face is core, so `src/core` reaches no `node:*` module and no DOM global and the same build serves a server process and a browser page. It is tested live against `qwen3.5:2b-q4_K_M` in a dedicated `service` test project that requires the daemon and warms the model first, with no `skipIf`, while the `src:core` project stays hermetic on canned-transport and recording-proxy assertions that pass with the daemon down. Source: [`src/core`](../src/core). Surfaced through the `@orkestrel/ollama` barrel, aliased `@src/core` inside this repo.

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
const answer: string[] = []
const reasoning: string[] = []

try {
	const generator = provider.stream(messages, abort.signal)
	let step = await generator.next()
	while (!step.done) {
		if (step.value.channel === 'content') answer.push(step.value.text)
		if (step.value.channel === 'thinking') reasoning.push(step.value.text)
		step = await generator.next()
	}
	const result = step.value // the assembled ProviderResult
	answer.join('') === result.content // true — the content deltas concatenate to the result
} catch (error) {
	if (isProviderAbortError(error))
		answer.push(error.partial.content) // recover what streamed
	else throw error
}
```

Pass `tools` (a non-empty `ToolDefinition[]` from `@orkestrel/tool`) to advertise callable tools for the turn; when the model calls one, `result.tools` is a `ToolCall[]` from that same package (each with a guaranteed `id`, the tool `name`, and parsed `arguments`). Aborting a `stream` mid-flight throws a `ProviderAbortError` whose `partial` holds whatever streamed before the cancel.

### Surface

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. An extended interface's name comes before `plus`, with the members it adds after. A function row's `Shape` cell holds its signature, and a guard row's the type it narrows to. A class row's `Shape` cell holds the interface it implements, or its constructor signature where it implements none. A `Shape` cell holds the constant's declared type.

| API                  | Kind      | Shape                                                                       | Summary                                                                                                                                                                     |
| -------------------- | --------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createOllama`       | function  | `(options: OllamaOptions) => ProviderInterface`                             | Creates a local Ollama inference provider — a `ProviderInterface` over the daemon's `POST /api/chat`, assembling `generate` from the same NDJSON engine as `stream`.        |
| `OllamaProvider`     | class     | `AgentProviderInterface`                                                    | Implements the Ollama `/api/chat` wire over the shared `AgentProvider` engine.                                                                                              |
| `OllamaOptions`      | interface | `ProviderOptions plus { model, url?, keepAlive?, options?, think? }`        | Represents the configuration `createOllama` accepts for the local Ollama backend.                                                                                           |
| `WireChatRequest`    | interface | `{ model, messages, stream, keep_alive, think, options?, tools?, format? }` | Represents the exact `POST /api/chat` request body `OllamaProvider` sends — the internal typed wire contract.                                                               |
| `DEFAULT_OLLAMA_URL` | const     | `string`                                                                    | Names the local Ollama daemon base URL, `'http://localhost:11434'`, assumed when `OllamaOptions.url` is omitted.                                                            |
| `DEFAULT_KEEP_ALIVE` | const     | `string`                                                                    | Names how long the model stays resident after a call — `'5m'` when `OllamaOptions.keepAlive` is omitted, Ollama's own `keep_alive` default, expressed as a duration string. |
| `OLLAMA_CHAT_PATH`   | const     | `string`                                                                    | Names the Ollama chat endpoint appended to the configured base URL.                                                                                                         |
| `mapMessages`        | function  | `(messages: readonly Message[]) => WireChatRequest['messages']`             | Maps conversation turns onto the `/api/chat` wire's minimal message shape.                                                                                                  |
| `extractContent`     | function  | `(record: Readonly<Record<string, unknown>>) => string`                     | Extracts the assistant text of one wire record.                                                                                                                             |
| `extractThinking`    | function  | `(record: Readonly<Record<string, unknown>>) => string`                     | Extracts the daemon-side reasoning of one wire record.                                                                                                                      |
| `extractUsage`       | function  | `(record: Readonly<Record<string, unknown>>) => TokenUsage \| undefined`    | Extracts the token usage of one wire record.                                                                                                                                |
| `extractTools`       | function  | `(record: Readonly<Record<string, unknown>>) => readonly ToolCall[]`        | Extracts the tool calls of one wire record's `message.tool_calls`.                                                                                                          |
| `extractArguments`   | function  | `(value: unknown) => Readonly<Record<string, unknown>>`                     | Extracts a wire `arguments` value as a record.                                                                                                                              |

The wire leaves — `mapMessages` and the `extract*` narrowing set — are the pure request projection and response extractions `OllamaProvider` composes. They are exported and unit-tested on their own so the package's highest-risk code, the boundary narrowing of every wire `unknown` through the `@orkestrel/contract` guards, is provable without a daemon. Everything they do not do lives in `@orkestrel/agent`: the deadline, the transport seam, the streaming spine, the splitter, and the assembly of a `ProviderResult`.

`OllamaProvider` declares `name` (`'ollama'`) and inherits the rest of its data members from the base: `id` is the stable per-instance trace label, and `format` is the context-framing default `OllamaOptions.format` supplies (see [Context framing](#context-framing)). Its wire seams are documented under [Methods](#methods), and the `generate` / `stream` boundary it inherits under `AgentProviderInterface` in [`agent.md`](agent.md). `AgentProvider` / `AgentProviderInterface` / `ProviderInterface` / `ProviderOptions` / `ProviderRequest` / `ProviderIncrement` / `ProviderParserInterface` / `ProviderResult` / `ProviderDelta` / `ProviderStreamOptions` / `ProviderError` / `isProviderError` / `ProviderAbortError` / `isProviderAbortError` / `Message` / `ContextFormat` are owned by `@orkestrel/agent`; `ToolDefinition` / `ToolCall` by `@orkestrel/tool`; the `TokenUsage` shape by `@orkestrel/budget`; `createNDJSONParser` by `@orkestrel/ndjson`. All are reused here, never redefined.

## Methods

The wire seams `OllamaProvider` declares — exactly the members of `AgentProviderInterface` that the base leaves open. The runtime never calls them directly: a caller drives `generate` or `stream`, and the engine calls these to frame, project, decode, and drain the Ollama wire. Those inherited calls, the `id` / `name` / `format` data members, and the `ProviderParserInterface` the seam returns are documented in [`agent.md`](agent.md).

#### `OllamaProvider`

`frame` opens the call's framing state and `finish` drains it; `body` writes the request and `read` reads one record back.

| Method   | Returns                                            | Summary                                                                        |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `frame`  | `ProviderParserInterface`                          | Creates fresh NDJSON framing state for a call.                                 |
| `body`   | `WireChatRequest`                                  | Projects conversation turns and per-call options onto the Ollama request body. |
| `read`   | `ProviderIncrement`                                | Extracts a record's content, reasoning, tools, and completed usage report.     |
| `finish` | `ReadonlyArray<Readonly<Record<string, unknown>>>` | Recovers a final NDJSON record that arrived without its line terminator.       |

## Contract

These invariants hold across `src/core` ↔ `ollama.md`. The engine contract itself — `ProviderInterface`, `AgentProvider`, `ProviderResult`, `ProviderError`, `ProviderAbortError` — is in `@orkestrel/agent`, and [`agent.md`](agent.md) states it.

1. **Doc ↔ source bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` table is a real export of the `src/core` surface, and every export appears as a Surface row — exhaustive, both directions.
2. **Imports each boundary from its owner, no cycle.** `OllamaProvider` extends `AgentProvider` and implements `AgentProviderInterface`; that base, `ProviderRequest`, `ProviderIncrement`, `ProviderParserInterface`, `ProviderInterface`, `ProviderOptions`, `Message`, and the provider errors come from `@orkestrel/agent`. `createNDJSONParser` comes from `@orkestrel/ndjson`, `ToolCall` / `ToolDefinition` from `@orkestrel/tool`, `TokenUsage` from `@orkestrel/budget`, and the guards (`isRecord` / `isString` / `isNumber` / `parseJSONAs`) from `@orkestrel/contract`. Each dependency is one-way and never imports from `@src/core`. No module under `src/` imports `@orkestrel/timeout` any more — the base arms the deadline — though the manifest still declares it a runtime dependency.
3. **The `/api/chat` wire body.** `OllamaProvider` POSTs to `${url}${OLLAMA_CHAT_PATH}`, defaulting `url` to `DEFAULT_OLLAMA_URL` and `keep_alive` to `DEFAULT_KEEP_ALIVE`. The body carries `model`, the mapped `messages`, `stream: true` on every call, `keep_alive`, and `think` (the per-call `ProviderStreamOptions.think` override when present, else `OllamaOptions.think`, default `false`), adding `options` only when configured, `format` only when the call supplies a `ProviderStreamOptions.schema`, and `tools` only when a non-empty `ToolDefinition[]` is passed. Each tool maps to `{ type: 'function', function: { name } }`, with `description` and `parameters` added only when the corresponding `ToolDefinition` fields are supplied. Messages map to the wire's minimal `{ role, content }` turn, with `tool_calls` added only on an assistant turn that replays them and `images` only on a multimodal turn. A non-OK status is the base's failure, not this package's: it throws `ProviderError` with code `'HTTP'`, the response `status`, and a message bounded to an excerpt of the response body.
4. **Configurable `think` on the wire; the base's splitter keeps the assembled content clean.** For a thinking-capable model (for example `qwen3`) the per-request `think` flag is the only wire-level reasoning control (its native renderer honours neither the qwen3 `/no_think` token nor a Modelfile `PARAMETER think false`). It is configurable through `OllamaOptions.think` (default `false` — so the general-purpose provider stays immediate for non-thinking models and tests fast) and overrideable per call through `ProviderStreamOptions.think`. Set `think: true` when the caller displays reasoning separately from the answer: the daemon then separates reasoning natively, returning it on the distinct `message.thinking` channel, which `read` reports and the engine yields as `ProviderDelta` `{ channel: 'thinking', text }` and accumulates onto `ProviderResult.thinking`. Either way the base's `split` behaviour stays armed, because a daemon may ignore `think: false` for a thinking model and render reasoning inline as `<think>…</think>` content; `OllamaProvider` passes no `split` to `super`, so the default separation applies and the assembled `content` is the splitter's clean accumulation. The reasoning never re-enters the conversation.
5. **One NDJSON path.** Every call consumes NDJSON — one JSON object per `\n`-terminated line. `frame()` returns `createNDJSONParser()`, fresh per call, so no call inherits another's half-read record, and the base pairs it with a streaming `TextDecoder` so a record split across byte reads is reassembled. At end of input the base calls `finish(parser)`, which feeds a trailing `\n` through the parser: a non-conformant proxy's final unterminated line is recovered rather than silently dropped. `OllamaProvider` passes no `strict` to `super`, so a stream that ends without a settled record still assembles its result from the deltas it carried.
6. **`stream` yields deltas and returns the assembled result.** The engine yields each non-empty clean content delta as `{ channel: 'content', text }` and each daemon-side reasoning delta as `{ channel: 'thinking', text }`; its return value is the assembled `ProviderResult` whose `content` is the splitter's authoritative clean accumulation — the concatenation of the yielded content deltas, except across an implicit-open reclassification, where the reasoning prefix had already streamed before a bare `</think>` revealed it and the yields cannot be recalled — plus any tool calls collected across lines, the usage from the `done` line, and the separated `thinking` when the turn produced any.
7. **Usage from the `done` line (reuses `TokenUsage`).** `read` reports `usage` only for a record whose `done` is `true` and whose `prompt_eval_count` and `eval_count` are both numbers — mapped to `{ prompt, completion, total: prompt + completion }`, the `TokenUsage` shape, imported rather than redefined. A delta line carries no counts and a `done: false` line's counts are ignored, so neither contributes usage, and `ProviderResult.usage` is absent when the turn reported none.
8. **Tool-call extraction with id-generation (no `as`).** `result.tools` is the model's `message.tool_calls`, each entry narrowed to `{ id, name, arguments }`: the entry and its `function` must be records and `name` a string (else the entry is dropped); `arguments` is the wire object as-is, a JSON string parsed to a record, or `{}` when neither; `id` is the wire's `id` when a string, else a freshly minted `crypto.randomUUID()`. An empty result `tools` is never surfaced — its absence means "no calls".
9. **Boundary narrowing — all wire `unknown` through guards, never `as`.** Every value read off the wire (each NDJSON record, `message`, `content`, `thinking`, the usage counts, `tool_calls`, `arguments`) arrives as `unknown` and is narrowed through the `@orkestrel/contract` guards — never a type assertion. A missing or malformed field degrades to a sensible default (empty content, no usage, `{}` arguments), never a throw — the one external boundary kept honest.
10. **The base owns everything that is not the wire.** The per-call deadline (`OllamaOptions.timeout`, `120_000`ms when omitted, folded with the caller's signal so either cancels the request and the timer is always cleared), the cancellation rule (a `stream` cancelled mid-flight throws `ProviderAbortError` carrying the partial, and the reader and parser are released in a `finally`), the transport seam (`OllamaOptions.fetch` and the per-request `OllamaOptions.headers` hook, awaited inside the deadline and raced against the combined signal), and the bounded error read all live in `AgentProvider`. `OllamaOptions` extends `ProviderOptions`, so those keys are the base's and behave identically for every provider built on it; [`agent.md`](agent.md) states each rule once.
11. **Context-framing `format` (provider-default cascade level, expose-only).** `OllamaOptions.format` is an optional `ContextFormat` (from `@orkestrel/agent`) — the provider's context-framing default, passed to `super` and exposed as `provider.format`. It is the provider-default level of `AgentContext`'s build cascade (beats the managers' built-in framing, beaten by a manager-options or per-item override; see [`agent.md`](agent.md)), read by the Agent when it assembles the prompt. Omitted ⇒ `undefined` (framing-agnostic; core's built-in framing applies unchanged). It is **never sent on the `/api/chat` wire**: it is consumed by core, absent from the request `body`, and unrelated to Ollama's structured-output `format` parameter — that one is sent in the request `body`, but only when a per-call `ProviderStreamOptions.schema` is supplied — the framing default and that wire parameter only share a word.
12. **Event-free.** A pure functional boundary — no Emitter, no events. Each call is a function of its arguments.
13. **A core face that runs in a browser.** The package publishes one entry, built from `src/core`, which imports no `node:*` module and no DOM global; the scoped core typecheck compiles it with the `ESNext` and `WebWorker` libraries and no ambient `@types`, so neither Node's globals nor the DOM's are in scope, and the base binds `globalThis.fetch` to its own receiver so a browser does not throw `Illegal invocation` on a bare transport reference. The campaign's Chromium receipt drove the built `@orkestrel/agent` closure this provider extends in Chrome 148 (2026-09-14): the core modules load as ES modules with no console error, a browser-side `RelayProvider` round-trips and cancels with its partial, and a refused token arrives as `ProviderError` with code `'HTTP'` and status `401`. The daemon is the remaining limit — a page reaches `/api/chat` directly only where the daemon, or a proxy in front of it, answers the page's origin; otherwise relay the call through your own server ([Relaying through your own server](#relaying-through-your-own-server)).
14. **Tested live against a real local Ollama (no `skipIf`).** The live tests run against a real Ollama daemon — no mocks, only genuine third-party calls — model `qwen3.5:2b-q4_K_M`, with `OLLAMA_HOST` / `OLLAMA_MODEL` overridable. Unlike the other surfaces, the dedicated `service` project requires the daemon: `tests/setupService.ts` throws a clear error if it is unreachable and warms the model (a `num_predict: 1` chat) before the suite, so the live tests run unconditionally (no `describe.skipIf`). The project runs serially (`fileParallelism: false`) with a 120s test/hook timeout so a cold load cannot flake it; `keep_alive` keeps the model resident across files, and `bash scripts/ollama.sh` brings the daemon and model up before the battery in CI. Assertions are structural — they hold whatever wording a small model produces — and never pin exact output. The hermetic half sits in `tests/src/core/`, and the relay round trip is proved hermetically in [`tests/src/core/integration.test.ts`](../tests/src/core/integration.test.ts) and live in [`tests/service/relay.test.ts`](../tests/service/relay.test.ts).
15. **Doc ↔ source method bijection.** The `## Methods` table lists exactly the members `OllamaProvider` declares — `frame`, `body`, `read`, and `finish` — and the class declares exactly those. `generate` and `stream` reach a caller through the same class but are declared once, in `AgentProvider`, and documented in [`agent.md`](agent.md).

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

`generate` / `stream` take a plain `AbortSignal`, so fold an abort, a timeout, and a token budget into one bound through `AbortSignal.any` — whichever trips first cancels the call. This caller-side bound stacks on top of the base's own armed deadline (`OllamaOptions.timeout`, `120_000`ms when omitted): the request dies when either fires, so you get an external cancel or budget and a hard per-call ceiling together.

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

### Projecting the wire without a daemon

The seam members are ordinary methods, so a test or a debugging session can read the exact request this provider would send and the exact contribution one daemon record makes — with no socket, no daemon, and no model. Construct `OllamaProvider` directly: `createOllama` returns the narrower `ProviderInterface`, which exposes the call boundary alone.

```ts
import { OllamaProvider } from '@orkestrel/ollama'

const provider = new OllamaProvider({ model: 'qwen3.5:2b-q4_K_M', keepAlive: '9m' })
const request = provider.body({
	messages: [{ id: '1', role: 'user', content: 'Say hello.' }],
	options: { think: true },
})
request.stream // true — every call streams
request.think // true — the per-call override beats the constructed default
request.keep_alive // '9m'
request.messages // [{ role: 'user', content: 'Say hello.' }] — ids stay local

const parser = provider.frame()
parser.parse('{"message":{"content":"Hel"}}\n') // [{ message: { content: 'Hel' } }]
provider.read({ message: { content: 'lo' }, done: true, prompt_eval_count: 3, eval_count: 4 })
// { content: 'lo', thinking: '', tools: [], usage: { prompt: 3, completion: 4, total: 7 } }
provider.finish(parser) // [] — the parser held nothing back
```

### Running in the browser

The published face is core, so the same `createOllama` call runs unchanged in a browser module. Point `url` at whatever the page can actually reach: the daemon's own origin where it answers that origin, or your own server standing in front of it. A page that reaches a daemon directly is a development arrangement — it puts the model endpoint on the network the page runs on — so prefer one of the server patterns that follow for anything a user runs.

```ts
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({
	model: 'qwen3.5:2b-q4_K_M',
	url: 'https://llm.example.com', // the daemon's origin, or your proxy in front of it
})
provider.name // 'ollama'
```

### Relaying through your own server

The agent-level relay keeps the whole provider on your server and gives the browser a `ProviderInterface` over your own route. The browser sends identified messages, tools, and per-call options; the server answers with NDJSON frames carrying the deltas and the settled result, so `thinking`, `tools`, and `usage` survive the hop and a server-side cancel arrives as a `ProviderAbortError` with its partial. Nothing about the model, the vendor, or the daemon's address reaches the page — which is what separates this from the transparent wire proxy that follows.

On the server, mount `createRelay` over a real `OllamaProvider` on any fetch-standard router; this composition uses an `@orkestrel/router` dispatcher. `authorize` is mandatory, and minting and validating the session credential stays your application's job.

```ts
import { createRelay } from '@orkestrel/agent'
import { createOllama } from '@orkestrel/ollama'
import { createDispatcher } from '@orkestrel/router'

const handler = createRelay({
	provider: createOllama({ model: 'qwen3.5:2b-q4_K_M' }),
	authorize: (request) => request.headers.get('authorization') === 'Bearer session-token',
})
const dispatcher = createDispatcher({
	routes: [{ method: 'POST', path: '/inference', handler }],
})
```

In the browser, `createRelayProvider` drives that route like a local provider. `@orkestrel/agent` declares no parser dependency, so the browser application supplies one — `createNDJSONParser` from `@orkestrel/ndjson` here.

```ts
import { createRelayProvider } from '@orkestrel/agent'
import { createNDJSONParser } from '@orkestrel/ndjson'

const browser = createRelayProvider({
	url: 'https://app.example.com/inference',
	parser: createNDJSONParser,
	headers: () => ({ authorization: 'Bearer session-token' }),
})
const relayed = await browser.generate(messages, abort.signal)
relayed.content // the daemon's answer, reassembled from the relay's frames
```

A refusal never becomes a frame: a wrong credential reaches the browser as a `ProviderError` with code `'HTTP'` and status `401`, and the provider on the server is never entered. [`agent.md`](agent.md) states the frame vocabulary, the byte limit, and the rest of the refusal statuses.

### Routing through your own server (obfuscated tokens)

A transparent wire proxy is the lighter shape: leave the provider in the browser, point `url` at a thin server of your own that forwards `/api/chat` to the daemon, and use `headers` to attach a generated token that server validates. The client never handles the real key — the key lives only on that server, and the `headers` hook supplies whatever short-lived token it expects. The custom `fetch` swaps the transport (a browser fetch, an instrumented wrapper) without touching the wire protocol. Omitting the transport and the header hook leaves the bound global `fetch` and only `Content-Type: application/json`.

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

The `headers` hook is called once per request (async, so a token can be refreshed each call); its result merges on top of the base `Content-Type`, so it adds an authorization header without disturbing the JSON body. What this shape cannot do is hide the vendor: the page still speaks Ollama's `/api/chat`, still names the model, and still needs a proxy that speaks that same wire, so switching vendors means shipping a different provider to the browser. Relay instead when the page must stay ignorant of what answers it.

### Context framing

`OllamaOptions.format` is the provider's context-framing default — a `ContextFormat` (from `@orkestrel/agent`) declaring how this provider's models prefer the context sections framed (for example XML group wrappers vs. Markdown headers). It is the **provider-default level** of `AgentContext`'s build cascade (see [`agent.md`](agent.md)): it beats the managers' built-in framing but is beaten by a manager-options or per-item override. `createOllama` accepts it directly and `OllamaProvider` hands it to the base, which exposes it as `provider.format`; the Agent reads it when it assembles the prompt. Omit it and the provider is framing-agnostic — core's built-in section framing applies unchanged.

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

### Narrowing a failed call with `isProviderError`

Branch on the machine-readable `code` and the HTTP `status` rather than parsing the thrown message. The engine throws one error class for every provider built on it, so the same `catch` serves a local daemon, a proxy, and a relay.

```ts
import { createAbort } from '@orkestrel/abort'
import { isProviderError } from '@orkestrel/agent'
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Reply with exactly: ok' }] as const

try {
	await provider.generate(messages, abort.signal)
} catch (error) {
	if (isProviderError(error) && error.code === 'HTTP' && error.status === 404) {
		// the configured model isn't pulled
	} else if (isProviderError(error) && error.code === 'HTTP' && error.status === 400) {
		// malformed request (for example an empty model string)
	} else {
		throw error
	}
}
```

A cancel is outside that taxonomy: the caller's signal and the deadline both throw `ProviderAbortError`, which `isProviderAbortError` narrows, and its `partial` carries what had streamed.

### Practices

- **Import the engine from `@orkestrel/agent`, the wire from `@orkestrel/ollama`** — `ProviderInterface` / `ProviderResult` / `ProviderError` / `isProviderError` / `isProviderAbortError` live in `@orkestrel/agent`; `createOllama` / `OllamaProvider` / `OllamaOptions` live in `@orkestrel/ollama`.
- **Import tool-call shapes from `@orkestrel/tool`** — `ToolDefinition` / `ToolCall` live with the tool runtime, while the provider contract that consumes them stays in `@orkestrel/agent`.
- **Bound every call** — pass an `AbortSignal` (an abort, or an `AbortSignal.any` over abort + timeout + budget) so a request can be cancelled, deadlined, or capped.
- **Recover the stream's partial** — wrap a driven `stream` in `try`/`catch` and narrow with `isProviderAbortError` to keep the content that arrived before a cancel.
- **Branch on the code and the status, not the message** — narrow a caught value with `isProviderError` and read `error.code` and `error.status` (`404` for an unpulled model) instead of parsing `error.message`.
- **Fold usage into a budget** — `result.usage` is the `TokenUsage` shape; `consume` it per turn to enforce a token ceiling.
- **Give a thinking model headroom** — with `think: true`, a reasoning model (for example `qwen3.5:2b` at `temperature: 0`) can spend 200+ tokens on `message.thinking` before any `content` token arrives; a tight `num_predict` cap or a tight external token budget can exhaust before content starts, yielding empty `result.content` — and `@orkestrel/agent`'s budget enforcement can abort mid-stream with `partial: true` if the cap is hit while thinking is still draining it. Size `num_predict` and the budget with thinking overhead in mind for any model run with `think: true`.
- **Tune through `options`** — pass sampling parameters (`temperature`, `seed`, and `num_predict`) through `OllamaOptions.options`; they forward verbatim to the wire.
- **Observe at the call site** — the provider publishes no events; read `stream`'s deltas and its returned result for everything a turn produced.

## Tests

The hermetic projects — `src:core`, `setup`, `guides`, `conformance`, `policy`, and `config` — run with no daemon and no network. The `service` project requires a warm local Ollama, and `distribution` packs and installs the artifact.

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value + type exports), the `OllamaProvider` method bijection, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `createOllama + generate` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/core/OllamaProvider.test.ts`](../tests/src/core/OllamaProvider.test.ts) — hermetic provider request-shape, framing, transport-seam, abort, deadline, and unreachable-upstream coverage, plus the streaming fold — deltas, tool-call accumulation, done-line usage, the unterminated tail flush, and think separation — driven over a canned NDJSON transport. Its recording proxy uses a deliberately unreachable default and asserts only captured requests and local provider behavior.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — the wire leaves: the request projection and every response extraction, including each malformed-wire degradation.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — hermetic `createOllama` shape, identity, defaults, passthrough, and unreachable-upstream coverage.
- [`tests/src/core/integration.test.ts`](../tests/src/core/integration.test.ts) — the `src/core` integration scope. A real `@orkestrel/server` + `@orkestrel/router` relay in front of this provider carries ordered content and thinking deltas, tools, and usage while keeping the browser and daemon credentials apart, refuses a wrong bearer with an empty `401` before the daemon transport is entered, crosses a browser cancel and a server deadline as an abort frame with its partial, reduces a daemon stream failure to the fixed public error frame, and replays a returned tool call. Beside those, hermetic context framing, recap, reference, cherry-pick, canonical assembly order, scope allow-lists, workspace injection, and conversation selection run through the unreachable recording proxy, with a compile-time drift gate asserting the wire request and response shapes stay compatible with the official `ollama` client's types; that gate's authoritative check is `npm run check` (root tsc), while its run under vitest is an incidental no-op (`expectTypeOf` performs no runtime assertions).
- [`tests/setup.test.ts`](../tests/setup.test.ts) — the shared host-independent test infrastructure: every helper, fixture, recorder, and guard `tests/setup.ts` exports, plus the narrowing guards and tool fixtures from `tests/setupServer.ts`.
- [`tests/setupServer.test.ts`](../tests/setupServer.test.ts) — the Node-resource half of `tests/setupServer.ts` against real loopback sockets: the recording proxy and relay server, the captured and open transports, the capture wait, and the provider-stream driver.
- [`tests/setupService.test.ts`](../tests/setupService.test.ts) — the hermetic half of the `service` project's setup: the environment readers, the sampling tables, and the readiness contract.
- [`tests/conformance.test.ts`](../tests/conformance.test.ts) — where this package's wire types drift from the official `ollama` client they are written against.
- [`tests/distribution.test.ts`](../tests/distribution.test.ts) — the packed package installed into a throwaway consumer: the exports map, the shipped declarations, and the module objects a real runtime hands that consumer.
- [`tests/policy.test.ts`](../tests/policy.test.ts) and [`tests/config.test.ts`](../tests/config.test.ts) — the vendored cross-cutting proofs: the path- and text-shaped repository laws, and that the root configuration resolves its aliases, projects, and outputs.
- [`tests/service/OllamaProvider.test.ts`](../tests/service/OllamaProvider.test.ts) — live provider generation, streaming, thinking, tool-call, usage, seeded, abort, deadline, and daemon-error coverage against the required warmed Ollama service.
- [`tests/service/factories.test.ts`](../tests/service/factories.test.ts) — live `createOllama` generation and streaming coverage.
- [`tests/service/relay.test.ts`](../tests/service/relay.test.ts) — the browser-to-server relay against the live daemon: a generated answer through the authenticated route, streamed deltas joining to the settled content, and a cancel after a live delta returning the relay's partial.
- [`tests/service/transport.test.ts`](../tests/service/transport.test.ts) — the transparent wire proxy, end-to-end. A `createRecordingProxy(OLLAMA_CONFIG.host)` — a real `@orkestrel/server` + `@orkestrel/router` HTTP server — records the inbound request, forwards it to the selected Ollama service, and streams the response back.
- [`tests/service/tools.test.ts`](../tests/service/tools.test.ts) and [`tests/service/authority.test.ts`](../tests/service/authority.test.ts) — live tool dispatch through the agent loop, and the authority gate's approval and denial paths.
- [`tests/service/budget.test.ts`](../tests/service/budget.test.ts) and [`tests/service/lifecycle.test.ts`](../tests/service/lifecycle.test.ts) — live token-budget enforcement mid-stream, and the agent's status, event, and abort lifecycle.
- [`tests/service/schema.test.ts`](../tests/service/schema.test.ts) and [`tests/service/scopes.test.ts`](../tests/service/scopes.test.ts) — a live structured-output `schema` constraining the answer, and a live scope filtering what reaches the wire.
- [`tests/service/compaction.test.ts`](../tests/service/compaction.test.ts) and [`tests/service/conversation.test.ts`](../tests/service/conversation.test.ts) — live recap retention with manual, automatic, and repeated compaction, and live non-fatal compaction errors and long-conversation instruction behavior, with proxy calls explicitly forwarding to `OLLAMA_CONFIG.host`.

## See also

- `@orkestrel/agent` — the `AgentProvider` engine this package extends, the `ProviderInterface` contract, the errors, and the relay. Its guide is mirrored here as [`agent.md`](agent.md) and ships with that package.
- `@orkestrel/ndjson` — the parser `frame()` returns for each call. Its guide ships with that package.
- `@orkestrel/contract` — the `isRecord` / `isString` / `isNumber` / `parseJSONAs` helpers that narrow the wire `unknown`. Its guide ships with that package.
- [`AGENTS.md`](../AGENTS.md) — the coding rules this package is written to.
- [`README.md`](README.md) — the guides index.
