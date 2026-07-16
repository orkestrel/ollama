# @orkestrel/ollama

A typed local-LLM provider for the `@orkestrel` line — a `ProviderInterface`
implementation over a local Ollama daemon's `POST /api/chat`, with NDJSON
streaming, tool calls, thinking, and usage accounting, built on pure
web-standard `fetch` / `ReadableStream` (no Ollama SDK dependency).

## Install

```sh
npm install @orkestrel/ollama
```

## Requirements

- Node.js >= 24
- A running Ollama daemon (default `http://localhost:11434`) with a pulled
  model — required at runtime by any consumer, and by this repo's live-only
  `src:server` test suite
- ESM + CJS (dual-format build)

## Usage

```ts
import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@orkestrel/ollama'

const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Reply with exactly: ok' }] as const

const result = await provider.generate(messages, abort.signal)
result.content // 'ok'
result.usage // { prompt, completion, total }
```

`generate` resolves the assembled `ProviderResult` in one call. For live
output, `stream` is the same call streamed — it yields `ProviderDelta`s
(`content` for answer text, `thinking` for live reasoning) and returns the
assembled result when the stream completes:

```ts
const generator = provider.stream(messages, abort.signal)
let step = await generator.next()
while (!step.done) {
	if (step.value.type === 'content') process.stdout.write(step.value.text)
	step = await generator.next()
}
const streamed = step.value // the assembled ProviderResult
```

## Guide

For the full surface — `createOllama`, `OllamaProvider`, `OllamaOptions`,
tool calls, thinking, and the context-framing default — see
[`guides/src/ollama.md`](guides/src/ollama.md).

## Package

Published as a single server surface per the `exports` field in
`package.json` — one `.` entry backed by a dual ESM + CommonJS build of
`src/server`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
