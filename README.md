# @orkestrel/ollama

> A typed local-LLM provider for the `@orkestrel` line: the Ollama daemon's `POST /api/chat`
> wire carried on the shared `AgentProvider` engine from `@orkestrel/agent`, with NDJSON
> streaming, tool calls, thinking, and usage accounting narrowed off the wire through
> `@orkestrel/contract` guards and no Ollama SDK dependency.

Create a provider with the `createOllama` function, hand it a conversation and a
bounding `AbortSignal`, and read the assembled `ProviderResult` the `generate`
method resolves — or drive the `stream` method for live deltas. The engine in
`@orkestrel/agent` holds the deadline, the transport, the header hook, and the
result assembly; this package holds the Ollama wire. Point `url` at your own server
and attach a short-lived token through `headers` where a browser runtime must not
hold the real key, or relay the whole provider through your server so the page never
learns which model answers.

## Install

```sh
npm install @orkestrel/ollama
```

## Requirements

- Node.js >= 22, or any browser with `fetch` and `ReadableStream`
- A reachable Ollama daemon (default `http://localhost:11434`) with a pulled
  model — required at runtime by any consumer, and by this repository's live
  `service` test project; the `src:core` project is hermetic and passes with
  the daemon down
- ESM + CJS (dual-format build)

## Usage

```ts
import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Reply with exactly: ok' }] as const

const result = await provider.generate(messages, abort.signal)
result.content // the assistant's answer text
result.usage // { prompt, completion, total }
```

`generate` resolves the assembled `ProviderResult` in one call. For live
output, `stream` is the same call streamed — it yields `ProviderDelta`s
(`content` for answer text, `thinking` for live reasoning) and returns the
assembled result when the stream completes:

```ts
const answer: string[] = []
const generator = provider.stream(messages, abort.signal)
let step = await generator.next()
while (!step.done) {
	if (step.value.channel === 'content') answer.push(step.value.text)
	step = await generator.next()
}
const streamed = step.value // the assembled ProviderResult
answer.join('') === streamed.content // true
```

## Guide

For the full surface — `createOllama`, `OllamaProvider`, `OllamaOptions`, the
wire seams (`frame` / `body` / `read` / `finish`), tool calls
(`ToolDefinition` / `ToolCall` from `@orkestrel/tool`), thinking, the
context-framing default, and the browser relay — see
[`guides/ollama.md`](guides/ollama.md).

## Package

Published as a single core surface per the `exports` field in
`package.json` — one `.` entry backed by a dual ESM + CommonJS build of
`src/core`, host-independent so the same build serves a server process and a
browser page.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
