import type { ContextFormatInterface, MessageInterface, ToolDefinition } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'
import { isProviderAbortError } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { OllamaProvider } from '@src/server'
import { describe, expect, it, vi } from 'vitest'
import { createRecorder, createUserMessage } from '../../setup.js'
import {
	createLiveOllama,
	drive,
	ndjsonLine,
	OLLAMA_CONFIG,
	startOllamaStub,
} from '../../setupOllama.js'

// OllamaProvider — two complementary tracks (AGENTS §16 — no mocks; only genuine
// third-party calls).
//
//  • LIVE (against a REAL local Ollama): the `src:ollama` project REQUIRES Ollama —
//    `setupOllama.ts` throws if the daemon is unreachable and WARMS the model — so the
//    live tests run UNCONDITIONALLY (no `skipIf`). Assertions are STRUCTURAL — robust
//    to a small quantized model's nondeterminism, never asserting brittle exact text.
//
//  • DETERMINISTIC (against a real local stub HTTP server, `startOllamaStub` in
//    `tests/setupOllama.ts`): a
//    genuine `fetch` + `TextDecoder` + `NDJSONParser` round-trip — NOT a mock of the
//    provider — used to pin the behaviours a small model can't make deterministic: the
//    exact `/api/chat` request shape, a non-OK status's error text, a malformed /
//    empty / absent body, the §14 `arguments` narrowing (JSON-string / id-less /
//    garbage tool calls), and the streaming decoder's multi-byte + partial-line
//    reassembly. These don't burn model time.

// A weather tool the model can call — a tightly-constrained single-arg function so a
// warmed qwen3.5:2b reliably emits ONE tool call when told to use it.
const WEATHER_TOOL: ToolDefinition = {
	name: 'get_weather',
	description: 'Get the current weather for a city.',
	parameters: {
		type: 'object',
		properties: { city: { type: 'string', description: 'The city name' } },
		required: ['city'],
	},
}

describe('OllamaProvider (live)', () => {
	describe('generate', () => {
		it('returns assembled content for a prompt', async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()

			const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)

			expect(result.content.length).toBeGreaterThan(0)
		})

		it("a constrained 'reply ok' prompt yields content containing 'ok'", async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()

			const result = await provider.generate(
				[createUserMessage('Reply with exactly: ok')],
				abort.signal,
			)

			expect(result.content.toLowerCase()).toContain('ok')
		})

		it('carries a multi-message conversation (system + user) to a grounded answer', async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()

			// A system instruction the model must obey, plus a user turn — proving the
			// provider sends the WHOLE conversation, not just the last message.
			const messages: readonly MessageInterface[] = [
				{
					id: crypto.randomUUID(),
					role: 'system',
					content: 'You only ever answer with the single word: blue.',
				},
				{ id: crypto.randomUUID(), role: 'user', content: 'What is your favorite color?' },
			]

			const result = await provider.generate(messages, abort.signal)

			expect(result.content.toLowerCase()).toContain('blue')
		})

		it('reports token usage with prompt + completion summing to total', async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()

			const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)

			expect(result.usage).toBeDefined()
			const usage = result.usage
			if (usage === undefined) throw new Error('usage missing')
			expect(usage.prompt).toBeGreaterThan(0)
			expect(usage.completion).toBeGreaterThan(0)
			expect(usage.total).toBe(usage.prompt + usage.completion)
		})

		it('keeps thinking OFF — a constrained reply has no thinking-token inflation', async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()

			const result = await provider.generate(
				[createUserMessage('Reply with exactly: ok')],
				abort.signal,
			)

			// This provider defaults to `think: false` (built here without the option), so a constrained reply is ~1-2
			// completion tokens. If thinking leaked back on, the hidden reasoning trace
			// inflates completion to ~150+ tokens and drags the call from ~300ms to several
			// seconds — a tight ceiling locks the fast-test guarantee. qwen3.5 honours ONLY
			// the `think` flag (not the `/no_think` token, not a Modelfile PARAMETER), so the
			// per-request flag the provider owns is the sole thinking control.
			expect(result.usage).toBeDefined()
			const usage = result.usage
			if (usage === undefined) throw new Error('usage missing')
			expect(usage.completion).toBeLessThan(20)
		})

		it('keeps thinking OFF — no <think> reasoning trace leaks into content', async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()

			const result = await provider.generate(
				[createUserMessage('Reply with exactly: ok')],
				abort.signal,
			)

			// With `think: false` the answer is the bare content; a leaked reasoning trace
			// would surface qwen's `<think>…</think>` channel tags in the text. Assert none
			// appear — a structural complement to the token-count ceiling above.
			expect(result.content).not.toContain('<think>')
			expect(result.content).not.toContain('</think>')
		})

		it('populates result.tools when the model calls a tool (id/name/arguments)', async () => {
			const provider = createLiveOllama({ numPredict: 64 })
			const abort = createAbort()

			const result = await provider.generate(
				[createUserMessage('What is the weather in Paris? Use the get_weather tool.')],
				abort.signal,
				[WEATHER_TOOL],
			)

			// A warmed qwen3.5:2b with a tool-forcing prompt reliably calls the single tool.
			expect(result.tools).toBeDefined()
			const tools = result.tools ?? []
			expect(tools.length).toBeGreaterThan(0)
			for (const call of tools) {
				// Every field is narrowed off the wire (§14) — assert the shape the provider
				// guarantees: a non-empty id, the tool name, and an object `arguments`.
				expect(call.id.length).toBeGreaterThan(0)
				expect(call.name).toBe('get_weather')
				expect(isRecord(call.arguments)).toBe(true)
			}
		})
	})

	describe('stream', () => {
		it('yields content ProviderDeltas and RETURNS the assembled result', async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()

			const { deltas, result } = await drive(
				provider.stream([createUserMessage('Say hello there.')], abort.signal),
			)

			expect(deltas.length).toBeGreaterThan(0)
			for (const delta of deltas) expect(typeof delta).toBe('string')
			expect(result.content.length).toBeGreaterThan(0)
			// The assembled content is exactly the concatenated deltas.
			expect(result.content).toBe(deltas.join(''))
			expect(result.usage).toBeDefined()
		})

		it('streams a longer answer incrementally — more than one content delta', async () => {
			const provider = createLiveOllama({ numPredict: 64 })
			const abort = createAbort()

			// A longer constrained answer streams across multiple lines; assert the deltas
			// arrive incrementally (>1) rather than as one lump.
			const { deltas, result } = await drive(
				provider.stream(
					[createUserMessage('List the numbers one through ten, one per line.')],
					abort.signal,
				),
			)

			expect(deltas.length).toBeGreaterThan(1)
			expect(result.content).toBe(deltas.join(''))
		})

		it('assembles tool calls from a streamed turn', async () => {
			const provider = createLiveOllama({ numPredict: 64 })
			const abort = createAbort()

			const { result } = await drive(
				provider.stream(
					[createUserMessage('What is the weather in Tokyo? Use the get_weather tool.')],
					abort.signal,
					[WEATHER_TOOL],
				),
			)

			// The stream collects tool_calls across its lines and RETURNS them on the result.
			expect(result.tools).toBeDefined()
			const tools = result.tools ?? []
			expect(tools.length).toBeGreaterThan(0)
			expect(tools.every((call) => call.name === 'get_weather')).toBe(true)
			expect(tools.every((call) => call.id.length > 0)).toBe(true)
		})
	})

	describe('abort', () => {
		it('rejects generate when the signal is already aborted', async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()
			abort.abort()

			await expect(
				provider.generate([createUserMessage('Say hello.')], abort.signal),
			).rejects.toThrow(Error)
		})

		it('rejects stream when the signal is already aborted (before any content)', async () => {
			const provider = createLiveOllama({ numPredict: 24 })
			const abort = createAbort()
			abort.abort()

			// A pre-aborted signal makes `#fetch` reject before headers — surfaced as the raw
			// fetch rejection on the FIRST pull, NOT a ProviderAbortError (that wrapping only
			// happens once a stream is in flight).
			const generator = provider.stream([createUserMessage('Say hello.')], abort.signal)
			await expect(generator.next()).rejects.toThrow(Error)
		})

		it('throws ProviderAbortError with the partial content when aborted mid-stream', async () => {
			// A generous num_predict + a long-output prompt so the stream is still flowing
			// when we cancel after the first delta — the abort lands mid-flight.
			const provider = createLiveOllama({ numPredict: 200 })
			const abort = createAbort()

			const generator = provider.stream(
				[createUserMessage('Count slowly from 1 to 40, one number per line.')],
				abort.signal,
			)
			const first = await generator.next()
			expect(first.done).toBe(false)
			abort.abort()

			let caught: unknown
			try {
				// Drive the generator to completion; the next read rejects under the aborted
				// signal and surfaces a ProviderAbortError carrying what streamed so far.
				for (;;) {
					const step = await generator.next()
					if (step.done) break
				}
			} catch (error) {
				caught = error
			}

			expect(isProviderAbortError(caught)).toBe(true)
			if (!isProviderAbortError(caught)) throw new Error('expected ProviderAbortError')
			expect(caught.partial.content.length).toBeGreaterThan(0)
		})
	})
})

// ── Deterministic (real local stub server — no model needed) ─────────────────────
//
// A genuine HTTP round-trip over the real `fetch` + decoder + parser path; the stub
// captures the request and serves crafted responses, so wire-shape, error-status,
// malformed-body, §14 narrowing, and the streaming decoder are all pinned exactly.

describe('OllamaProvider (request body)', () => {
	// The non-stream body the provider posts — captured by the stub. One generate call
	// with everything set, asserted field-by-field.
	it('posts model/messages/stream/keep_alive and the default think:false; options + tools when set', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({
				model: 'test-model',
				url: stub.url,
				keepAlive: '9m',
				options: { num_predict: 7, temperature: 0.5 },
			})
			await provider.generate([createUserMessage('hello')], createAbort().signal, [WEATHER_TOOL])

			expect(stub.captured.length).toBe(1)
			const request = stub.captured[0]
			if (request === undefined) throw new Error('no captured request')
			expect(request.method).toBe('POST')
			expect(request.path).toBe('/api/chat')
			expect(request.contentType).toBe('application/json')
			const body = request.body
			expect(body.model).toBe('test-model')
			expect(body.stream).toBe(false)
			expect(body.keep_alive).toBe('9m')
			// `think` defaults to false when the option is omitted (backward-compatible).
			expect(body.think).toBe(false)
			expect(body.options).toEqual({ num_predict: 7, temperature: 0.5 })
			// messages map to the wire's minimal { role, content } turn.
			expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
			// tools map to the function-tool wire shape.
			expect(body.tools).toEqual([
				{
					type: 'function',
					function: {
						name: 'get_weather',
						description: 'Get the current weather for a city.',
						parameters: WEATHER_TOOL.parameters,
					},
				},
			])
		} finally {
			await stub.close()
		}
	})

	it('defaults keep_alive to 5m and omits options/tools when unset', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			const body = stub.captured[0]?.body ?? {}
			expect(body.keep_alive).toBe('5m')
			// No sampling options configured and no tools passed → neither key on the wire.
			expect('options' in body).toBe(false)
			expect('tools' in body).toBe(false)
		} finally {
			await stub.close()
		}
	})

	it('carries think:true on the wire when the option is set (the thinking-model wire shape)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			// A thinking model whose reasoning is displayed separately constructs with `think: true`
			// — the daemon then separates reasoning natively on the `message.thinking` channel.
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url, think: true })
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			expect(stub.captured[0]?.body.think).toBe(true)
		} finally {
			await stub.close()
		}
	})

	it('carries the default think:false on the wire when the option is omitted', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			// No `think` option → the backward-compatible default rides the wire.
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			expect(stub.captured[0]?.body.think).toBe(false)
		} finally {
			await stub.close()
		}
	})

	it('per-call think overrides the constructor default', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url, think: true })
			await provider.generate([createUserMessage('hi')], createAbort().signal, undefined, {
				think: false,
			})

			expect(stub.captured[0]?.body.think).toBe(false)
		} finally {
			await stub.close()
		}
	})

	it('per-call think can enable reasoning over a constructor default of false', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			await provider.generate([createUserMessage('hi')], createAbort().signal, undefined, {
				think: true,
			})

			expect(stub.captured[0]?.body.think).toBe(true)
		} finally {
			await stub.close()
		}
	})

	it('omits the tools key when an EMPTY tools array is passed', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			await provider.generate([createUserMessage('hi')], createAbort().signal, [])

			expect('tools' in (stub.captured[0]?.body ?? {})).toBe(false)
		} finally {
			await stub.close()
		}
	})

	it('sets stream:true on the streaming path', async () => {
		const stub = await startOllamaStub({ chunks: [ndjsonLine({ done: true })] })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			await drive(provider.stream([createUserMessage('hi')], createAbort().signal))

			expect(stub.captured[0]?.body.stream).toBe(true)
		} finally {
			await stub.close()
		}
	})

	it('maps every role (system/user/assistant/tool) and replays assistant tool_calls', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const messages: readonly MessageInterface[] = [
				{ id: '1', role: 'system', content: 'sys' },
				{ id: '2', role: 'user', content: 'u' },
				{
					id: '3',
					role: 'assistant',
					content: '',
					calls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Paris' } }],
				},
				{ id: '4', role: 'tool', content: 'sunny' },
			]
			await provider.generate(messages, createAbort().signal)

			expect(stub.captured[0]?.body.messages).toEqual([
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'u' },
				// the assistant turn replays its tool_calls in the minimal wire shape
				{
					role: 'assistant',
					content: '',
					tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
				},
				{ role: 'tool', content: 'sunny' },
			])
		} finally {
			await stub.close()
		}
	})

	it('accepts an empty messages array (sends [])', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			await provider.generate([], createAbort().signal)

			expect(stub.captured[0]?.body.messages).toEqual([])
		} finally {
			await stub.close()
		}
	})

	it('forwards a multimodal turn’s base64 images onto the wire message (only when present)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const messages: readonly MessageInterface[] = [
				{ id: '1', role: 'user', content: 'Describe this.', images: ['aGVsbG8=', 'd29ybGQ='] },
				{ id: '2', role: 'user', content: 'No image here.' },
			]
			await provider.generate(messages, createAbort().signal)

			// The first turn carries `images` verbatim; the second (no images) omits the field
			// entirely (the empty optional is never sent) — proving the forwarding is conditional.
			expect(stub.captured[0]?.body.messages).toEqual([
				{ role: 'user', content: 'Describe this.', images: ['aGVsbG8=', 'd29ybGQ='] },
				{ role: 'user', content: 'No image here.' },
			])
		} finally {
			await stub.close()
		}
	})

	it('omits images for an empty images array (no empty optional on the wire)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const messages: readonly MessageInterface[] = [
				{ id: '1', role: 'user', content: 'hi', images: [] },
			]
			await provider.generate(messages, createAbort().signal)

			const first = stub.captured[0]?.body.messages
			expect(first).toEqual([{ role: 'user', content: 'hi' }])
		} finally {
			await stub.close()
		}
	})
})

// ── Think separation (H4 — the splitter is the guarantee) ────────────────────────
//
// `think: false` rides the wire (pinned above), but a daemon may IGNORE it for a
// thinking model and render the reasoning INLINE as `<think>…</think>` content — or,
// think-enabled daemon-side, carry it on a separate `message.thinking` delta field.
// These stub round-trips pin the provider-level guarantee: the yielded / assembled
// content is CLEAN, the reasoning lands on `result.thinking` (never re-entering the
// conversation), and a tag split across NDJSON chunk boundaries never leaks.

describe('OllamaProvider (think separation)', () => {
	it('stream: an in-content <think> span is split away — clean deltas, thinking on the result', async () => {
		const stub = await startOllamaStub({
			chunks: [
				ndjsonLine({ message: { content: '<think>weigh the ' } }),
				ndjsonLine({ message: { content: 'options</think>' } }),
				ndjsonLine({ message: { content: 'Here is the answer.' } }),
				ndjsonLine({ done: true, prompt_eval_count: 3, eval_count: 4 }),
			],
		})
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const { deltas, result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)
			expect(result.content).toBe('Here is the answer.')
			expect(result.thinking).toBe('weigh the options')
			// The stream contract holds over the SPLIT output: content === the joined yields,
			// and no think tag ever reached a consumer.
			expect(deltas.join('')).toBe(result.content)
			expect(deltas.join('')).not.toContain('<think>')
			expect(result.usage).toEqual({ prompt: 3, completion: 4, total: 7 })
		} finally {
			await stub.close()
		}
	})

	it('stream: a tag split ACROSS chunk boundaries never leaks (the held-partial path)', async () => {
		const stub = await startOllamaStub({
			chunks: [
				ndjsonLine({ message: { content: '<thi' } }),
				ndjsonLine({ message: { content: 'nk>cross-chunk reasoning</thi' } }),
				ndjsonLine({ message: { content: 'nk>clean tail' } }),
				ndjsonLine({ done: true }),
			],
		})
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const { deltas, result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)
			expect(result.content).toBe('clean tail')
			expect(result.thinking).toBe('cross-chunk reasoning')
			expect(deltas.join('')).toBe('clean tail')
		} finally {
			await stub.close()
		}
	})

	it('stream: an UNCLOSED <think> at stream end lands on thinking, never on content', async () => {
		const stub = await startOllamaStub({
			chunks: [
				ndjsonLine({ message: { content: '<think>cut off mid-reas' } }),
				ndjsonLine({ done: true }),
			],
		})
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const { deltas, result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)
			expect(result.content).toBe('')
			expect(deltas).toEqual([])
			expect(result.thinking).toBe('cut off mid-reas')
		} finally {
			await stub.close()
		}
	})

	it('stream: the IMPLICIT leading open (a bare </think> — the qwen3 template pre-seeds the open) stays out of the result', async () => {
		const stub = await startOllamaStub({
			chunks: [
				ndjsonLine({ message: { content: 'the user asks X, so ' } }),
				ndjsonLine({ message: { content: 'answer briefly.</thi' } }),
				ndjsonLine({ message: { content: 'nk>Yes, briefly.' } }),
				ndjsonLine({ done: true }),
			],
		})
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const { deltas, result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)
			// The reasoning prefix streamed live (indistinguishable until the bare close arrived),
			// but the ASSEMBLED result is clean — the splitter reclassified it on the close, and
			// the tag itself never reached a consumer.
			expect(result.content).toBe('Yes, briefly.')
			expect(result.thinking).toBe('the user asks X, so answer briefly.')
			expect(deltas.join('')).not.toContain('</think>')
			expect(result.content).not.toContain('</think>')
		} finally {
			await stub.close()
		}
	})

	it('generate: the implicit leading open is separated in the one-body call too', async () => {
		const stub = await startOllamaStub({
			body: { message: { content: 'reason it out.</think>ok' } },
		})
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)
			expect(result.content).toBe('ok')
			expect(result.thinking).toBe('reason it out.')
		} finally {
			await stub.close()
		}
	})

	it('stream: daemon-side message.thinking deltas (the think:true wire shape) accumulate onto thinking', async () => {
		const stub = await startOllamaStub({
			chunks: [
				ndjsonLine({ message: { content: '', thinking: 'wire-side ' } }),
				ndjsonLine({ message: { content: 'answer', thinking: 'reasoning' } }),
				ndjsonLine({ done: true }),
			],
		})
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const { thoughts, result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)
			expect(result.content).toBe('answer')
			expect(thoughts).toEqual(['wire-side ', 'reasoning'])
			expect(result.thinking).toBe('wire-side reasoning')
		} finally {
			await stub.close()
		}
	})

	it('generate: the one-body call routes through the SAME splitter (clean content + thinking)', async () => {
		const stub = await startOllamaStub({
			body: { message: { content: '<think>plan</think>ok', thinking: 'wire-side' } },
		})
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)
			expect(result.content).toBe('ok')
			// Both carriers join — the split in-content span first, the wire field after.
			expect(result.thinking).toBe('plan\n\nwire-side')
		} finally {
			await stub.close()
		}
	})

	it('omits thinking when the turn produced none (no empty optional)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: stub.url })
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)
			expect(result.content).toBe('ok')
			expect('thinking' in result).toBe(false)
		} finally {
			await stub.close()
		}
	})
})

// ── Context-framing format (the provider-default cascade level) ──────────────
//
// OllamaOptions.format is the provider's context-framing default — the PROVIDER-
// DEFAULT level of AgentContext's build cascade, EXPOSED on the provider so the
// Agent threads it into build(). It is consumed by core, NOT sent on the wire — it
// is unrelated to Ollama's structured-output `/api/chat` `format` param (which this
// provider does not send). These deterministic guards pin both faces: the configured
// framing is exposed verbatim (undefined when omitted, the agnostic default), and it
// NEVER appears on the captured request body (the same-name collision can't cross).

// The XML-group framing used across the format guards — wrap instructions in a
// `<instructions>…</instructions>` group (mirrors the live context.test.ts shape).
const FRAMING: ContextFormatInterface = {
	instructions: {
		open: '<instructions>',
		render: (one) => `<instruction>${one.content}</instruction>`,
		close: '</instructions>',
	},
}

describe('OllamaProvider (context-framing format)', () => {
	it('exposes the configured ContextFormatInterface verbatim (satisfies the optional ProviderInterface.format)', () => {
		const provider = new OllamaProvider({
			model: 'm',
			url: 'http://localhost:11434',
			format: FRAMING,
		})

		// The exact configured framing is exposed — the provider-default level the Agent
		// reads via `build(provider.format)`. (Reference identity: it is stored, not copied.)
		expect(provider.format).toBe(FRAMING)
	})

	it("defaults format to undefined when omitted (the framing-agnostic default ⇒ core's built-ins)", () => {
		const provider = new OllamaProvider({ model: 'm', url: 'http://localhost:11434' })

		// No `format` configured → the provider is framing-agnostic; core's built-in
		// section framing applies unchanged.
		expect(provider.format).toBeUndefined()
	})

	it('NEVER sends the context-framing format on the /api/chat wire (the same-name collision guard)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			// A provider WITH a context-framing format configured. The framing is for the
			// prompt-CONTEXT cascade (consumed by core's build()), NOT Ollama's structured-
			// output wire `format` — so a generate() must post a body with NO `format` key.
			const provider = new OllamaProvider({ model: 'm', url: stub.url, format: FRAMING })
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			const body = stub.captured[0]?.body ?? {}
			// The two same-named concepts do not cross: the context-framing `format` is
			// EXPOSE-ONLY and never reaches the request (proving `#body` is untouched).
			expect('format' in body).toBe(false)
		} finally {
			await stub.close()
		}
	})
})

// ── Transport seam (the S2 deployment proof) ─────────────────────────────────
//
// OllamaOptions.fetch + headers let a browser-side runtime route the LLM call
// through the developer's OWN server with an obfuscated bearer token: the real API
// key stays server-side, taverna never handles it. These deterministic stub tests
// (a genuine HTTP round-trip, not a mock) prove the dynamic header reaches the
// "server", the custom fetch is the one used, the default is byte-identical to
// before, and the seam is orthogonal to the leak-fixed deadline/abort logic.

describe('OllamaProvider (transport seam — headers)', () => {
	it('merges a dynamically-injected header onto the request (the obfuscated token reaches the server)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({
				model: 'm',
				url: stub.url,
				headers: () => ({ authorization: 'Bearer obfuscated-xyz' }),
			})
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			const request = stub.captured[0]
			if (request === undefined) throw new Error('no captured request')
			// The injected auth header arrived at the "server" …
			expect(request.headers.authorization).toBe('Bearer obfuscated-xyz')
			// … alongside the still-present base content type (the seam ADDS, it doesn't replace).
			expect(request.headers['content-type']).toBe('application/json')
		} finally {
			await stub.close()
		}
	})

	it('applies an ASYNC headers hook (a Promise-returning injector resolves and is merged)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({
				model: 'm',
				url: stub.url,
				// The async form — a token could be refreshed/fetched per call.
				headers: async () => {
					await Promise.resolve()
					return { authorization: 'Bearer async-token', 'x-extra': '1' }
				},
			})
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			const request = stub.captured[0]
			if (request === undefined) throw new Error('no captured request')
			expect(request.headers.authorization).toBe('Bearer async-token')
			expect(request.headers['x-extra']).toBe('1')
			expect(request.headers['content-type']).toBe('application/json')
		} finally {
			await stub.close()
		}
	})

	it('lets the hook override Content-Type when it explicitly returns one', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = new OllamaProvider({
				model: 'm',
				url: stub.url,
				// An explicit Content-Type from the hook wins (merge order: base seeded
				// first, hook overlays) — the documented escape hatch.
				headers: () => ({ 'Content-Type': 'application/json; charset=utf-8' }),
			})
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			expect(stub.captured[0]?.headers['content-type']).toBe('application/json; charset=utf-8')
		} finally {
			await stub.close()
		}
	})

	it('the headers hook applies on the STREAMING path too', async () => {
		const stub = await startOllamaStub({
			chunks: [ndjsonLine({ message: { content: 'x' }, done: true })],
		})
		try {
			const provider = new OllamaProvider({
				model: 'm',
				url: stub.url,
				headers: () => ({ authorization: 'Bearer stream-token' }),
			})
			await drive(provider.stream([createUserMessage('hi')], createAbort().signal))

			expect(stub.captured[0]?.headers.authorization).toBe('Bearer stream-token')
			expect(stub.captured[0]?.headers['content-type']).toBe('application/json')
		} finally {
			await stub.close()
		}
	})

	it('sends ONLY the base Content-Type when headers is omitted (default unchanged)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			// No `headers` hook → today's behaviour: just the JSON content type, no auth.
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			const request = stub.captured[0]
			if (request === undefined) throw new Error('no captured request')
			expect(request.headers['content-type']).toBe('application/json')
			// No authorization (or any injected header) is sent when the hook is absent.
			expect(request.headers.authorization).toBeUndefined()
		} finally {
			await stub.close()
		}
	})
})

describe('OllamaProvider (transport seam — custom fetch)', () => {
	it('uses the injected fetch, not the global (a real delegating recorder)', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			// A recorder per §16.1 — a REAL fetch that delegates to the genuine global and
			// records each call's url; NOT a mock of fetch behaviour. Proves the provider
			// routed through the injected transport rather than `globalThis.fetch`.
			const calls = createRecorder<readonly [string]>()
			const transport: typeof globalThis.fetch = (input, init) => {
				calls.handler(String(input))
				return globalThis.fetch(input, init)
			}
			const provider = new OllamaProvider({ model: 'm', url: stub.url, fetch: transport })
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)

			// The injected transport ran exactly once, against /api/chat, and the real
			// round-trip still produced the stub's content.
			expect(calls.count).toBe(1)
			expect(calls.calls[0]?.[0]).toBe(`${stub.url}/api/chat`)
			expect(result.content).toBe('ok')
			// The request still reached the stub through the delegating fetch.
			expect(stub.captured.length).toBe(1)
		} finally {
			await stub.close()
		}
	})

	it('threads a custom fetch through the STREAMING path', async () => {
		const stub = await startOllamaStub({
			chunks: [ndjsonLine({ message: { content: 'd' }, done: true })],
		})
		try {
			const calls = createRecorder<readonly [string]>()
			const transport: typeof globalThis.fetch = (input, init) => {
				calls.handler(String(input))
				return globalThis.fetch(input, init)
			}
			const provider = new OllamaProvider({ model: 'm', url: stub.url, fetch: transport })
			const { result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)

			expect(calls.count).toBe(1)
			expect(result.content).toBe('d')
		} finally {
			await stub.close()
		}
	})
})

describe('OllamaProvider (transport seam — orthogonal to the deadline)', () => {
	it('a pre-aborted signal with a headers hook still rejects cleanly, leaking no timer', async () => {
		vi.useFakeTimers()
		try {
			// The seam must not perturb the leak-fixed deadline: even WITH a headers hook,
			// a pre-aborted signal makes the call reject and the armed timer must be cleared
			// (the same regression guard as the no-seam case). A real network host so the
			// only armed timer to inspect is the provider's own deadline.
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				headers: () => ({ authorization: 'Bearer x' }),
			})
			const abort = createAbort()
			abort.abort()

			await expect(provider.generate([createUserMessage('hi')], abort.signal)).rejects.toThrow(
				Error,
			)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it('an async-headers hook that REJECTS clears the deadline (no leaked timer)', async () => {
		vi.useFakeTimers()
		try {
			// The hook is awaited inside `#fetch`'s try, so a hook rejection is caught by the
			// same catch that clears the armed deadline — the request never even fires.
			const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
			try {
				const provider = new OllamaProvider({
					model: 'm',
					url: stub.url,
					timeout: 90_000,
					headers: () => Promise.reject(new Error('token fetch failed')),
				})
				await expect(
					provider.generate([createUserMessage('hi')], createAbort().signal),
				).rejects.toThrow('token fetch failed')
				expect(vi.getTimerCount()).toBe(0)
				// The hook rejected before the request was sent — nothing reached the stub.
				expect(stub.captured.length).toBe(0)
			} finally {
				await stub.close()
			}
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('OllamaProvider (response narrowing)', () => {
	it('parses usage from the non-stream body (prompt + completion → total)', async () => {
		const stub = await startOllamaStub({
			body: { message: { content: 'hi' }, prompt_eval_count: 11, eval_count: 4 },
		})
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)

			expect(result.content).toBe('hi')
			expect(result.usage).toEqual({ prompt: 11, completion: 4, total: 15 })
		} finally {
			await stub.close()
		}
	})

	it('omits usage when a count is missing or non-numeric', async () => {
		const stub = await startOllamaStub({
			body: { message: { content: 'hi' }, prompt_eval_count: 11 }, // eval_count absent
		})
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)

			expect(result.usage).toBeUndefined()
		} finally {
			await stub.close()
		}
	})

	it('narrows tool arguments: object as-is, JSON-string parsed, garbage → {}', async () => {
		const stub = await startOllamaStub({
			body: {
				message: {
					content: '',
					tool_calls: [
						// id present, arguments an object → kept verbatim
						{ id: 'has-id', function: { name: 'a', arguments: { x: 1 } } },
						// no id → minted; arguments a JSON string → parsed to a record
						{ function: { name: 'b', arguments: '{"y":2}' } },
						// arguments a NON-JSON string → defaults to {}
						{ function: { name: 'c', arguments: 'not json' } },
						// arguments a non-object/non-string (number) → defaults to {}
						{ id: 'd-id', function: { name: 'd', arguments: 5 } },
					],
				},
			},
		})
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const result = await provider.generate([createUserMessage('go')], createAbort().signal, [
				WEATHER_TOOL,
			])

			const tools = result.tools ?? []
			expect(tools.length).toBe(4)
			const [a, b, c, d] = tools
			if (a === undefined || b === undefined || c === undefined || d === undefined)
				throw new Error('missing tool call')
			expect(a).toEqual({ id: 'has-id', name: 'a', arguments: { x: 1 } })
			// minted id is a non-empty string; arguments parsed from the JSON string
			expect(b.id.length).toBeGreaterThan(0)
			expect(b.name).toBe('b')
			expect(b.arguments).toEqual({ y: 2 })
			expect(c).toEqual({ id: expect.anything(), name: 'c', arguments: {} })
			expect(c.id.length).toBeGreaterThan(0)
			expect(d).toEqual({ id: 'd-id', name: 'd', arguments: {} })
		} finally {
			await stub.close()
		}
	})

	it('drops malformed tool-call entries (missing function / non-string name)', async () => {
		const stub = await startOllamaStub({
			body: {
				message: {
					content: '',
					tool_calls: [
						{ id: 'no-fn' }, // no `function` → dropped
						{ function: { description: 'x' } }, // `function` but no string name → dropped
						{ function: { name: 42 } }, // non-string name → dropped
						{ function: { name: 'kept' } }, // the only valid one
					],
				},
			},
		})
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const result = await provider.generate([createUserMessage('go')], createAbort().signal)

			const tools = result.tools ?? []
			expect(tools.length).toBe(1)
			expect(tools[0]?.name).toBe('kept')
			expect(tools[0]?.arguments).toEqual({})
		} finally {
			await stub.close()
		}
	})

	it('rejects with a SyntaxError on a non-JSON body (the parse itself fails)', async () => {
		const stub = await startOllamaStub({ raw: 'this is not json' })
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			// Field-level narrowing degrades gracefully (empty content / no usage), but a
			// WHOLESALE non-JSON body makes `response.json()` itself reject — the provider
			// doesn't (and shouldn't) swallow a corrupt transport body into a fake-empty
			// result, so the SyntaxError propagates. The deadline is still cleared (finally).
			await expect(
				provider.generate([createUserMessage('hi')], createAbort().signal),
			).rejects.toThrow(SyntaxError)
		} finally {
			await stub.close()
		}
	})

	it('degrades an empty-object body to empty content and no usage/tools', async () => {
		const stub = await startOllamaStub({ body: {} })
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)

			expect(result.content).toBe('')
			expect(result.usage).toBeUndefined()
			expect(result.tools).toBeUndefined()
		} finally {
			await stub.close()
		}
	})

	it('degrades a non-object JSON body (a bare array) to empty content', async () => {
		const stub = await startOllamaStub({ raw: '[1,2,3]' })
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)

			// `isRecord` rejects the array → the provider falls back to `{}` → empty content.
			expect(result.content).toBe('')
			expect(result.usage).toBeUndefined()
		} finally {
			await stub.close()
		}
	})
})

describe('OllamaProvider (streaming wire)', () => {
	it('reassembles a record split across byte reads (multi-byte char + partial line)', async () => {
		// Split one NDJSON line into three raw byte chunks — once mid-way through a
		// multi-byte UTF-8 character, once mid-line — to exercise the TextDecoder (partial
		// CHARS) + NDJSONParser (partial LINES) pairing. The content is the 3-byte '安' plus 'k'.
		const full = ndjsonLine({
			message: { content: '安k' },
			done: true,
			prompt_eval_count: 2,
			eval_count: 1,
		})
		const chunks = [full.slice(0, 12), full.slice(12, 13), full.slice(13)]
		const stub = await startOllamaStub({ chunks })
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const { deltas, result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)

			// Even though the bytes split mid-character and mid-line, the delta + assembled
			// content are the intact '安k', and the usage from the done line is parsed.
			expect(result.content).toBe('安k')
			expect(deltas.join('')).toBe('安k')
			expect(result.usage).toEqual({ prompt: 2, completion: 1, total: 3 })
		} finally {
			await stub.close()
		}
	})

	it('skips empty-content delta lines (yields only non-empty deltas)', async () => {
		const stub = await startOllamaStub({
			chunks: [
				ndjsonLine({ message: { content: 'a' } }),
				ndjsonLine({ message: { content: '' } }), // empty delta — not yielded, not accumulated
				ndjsonLine({ message: { content: 'b' } }),
				ndjsonLine({ message: { content: '' }, done: true, prompt_eval_count: 3, eval_count: 2 }),
			],
		})
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const { deltas, result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)

			expect(deltas).toEqual(['a', 'b'])
			expect(result.content).toBe('ab')
			expect(result.usage).toEqual({ prompt: 3, completion: 2, total: 5 })
		} finally {
			await stub.close()
		}
	})

	it('assembles tool calls collected across multiple stream lines', async () => {
		const stub = await startOllamaStub({
			chunks: [
				ndjsonLine({ message: { content: 'x' } }),
				ndjsonLine({
					message: { tool_calls: [{ id: 't1', function: { name: 'one', arguments: { a: 1 } } }] },
				}),
				ndjsonLine({
					message: { tool_calls: [{ function: { name: 'two', arguments: '{"b":2}' } }] },
				}),
				ndjsonLine({ message: { content: '' }, done: true }),
			],
		})
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const { result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)

			const tools = result.tools ?? []
			expect(tools.length).toBe(2)
			expect(tools[0]).toEqual({ id: 't1', name: 'one', arguments: { a: 1 } })
			expect(tools[1]?.name).toBe('two')
			expect(tools[1]?.arguments).toEqual({ b: 2 })
		} finally {
			await stub.close()
		}
	})

	it('throws "no response body" when the body is null', async () => {
		// A 204 response surfaces `response.body === null` via fetch — the provider clears
		// its armed deadline and throws a clear error (the deadline-leak regression itself
		// is pinned by the pre-aborted / unreachable cleanup tests below, where fetch
		// rejects before any real round-trip so the runtime's own connection timers don't
		// pollute the count; here the body genuinely IS null, so we assert the contract).
		const stub = await startOllamaStub({ empty: true })
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const generator = provider.stream([createUserMessage('hi')], createAbort().signal)
			await expect(generator.next()).rejects.toThrow('no response body')
		} finally {
			await stub.close()
		}
	})
})

describe('OllamaProvider (error status)', () => {
	// LIVE: point the real daemon at a model that does not exist → a genuine non-200.
	it('throws with the status and body text on a non-OK response (live 404)', async () => {
		const provider = new OllamaProvider({ model: 'does-not-exist:zzz', url: OLLAMA_CONFIG.host })
		const abort = createAbort()

		await expect(provider.generate([createUserMessage('hi')], abort.signal)).rejects.toThrow(
			/Ollama API error: 404/,
		)
	})

	// DETERMINISTIC: a stub 500 with a known body — assert the exact message format.
	it('embeds the status and body in the error message', async () => {
		const stub = await startOllamaStub({ status: 500, raw: 'boom' })
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			await expect(
				provider.generate([createUserMessage('hi')], createAbort().signal),
			).rejects.toThrow('Ollama API error: 500 - boom')
		} finally {
			await stub.close()
		}
	})

	it('surfaces a non-OK status on the streaming path too (before any delta)', async () => {
		const stub = await startOllamaStub({ status: 503, raw: 'unavailable' })
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url })
			const generator = provider.stream([createUserMessage('hi')], createAbort().signal)
			await expect(generator.next()).rejects.toThrow('Ollama API error: 503 - unavailable')
		} finally {
			await stub.close()
		}
	})
})

describe('OllamaProvider (deadline)', () => {
	// The provider's OWN armed deadline (not the caller's signal) trips mid-stream: the
	// stub streams one line then hangs, and a tiny timeout fires → the combined signal
	// aborts the read → a ProviderAbortError carrying the partial.
	it('its own timeout aborts a hung stream → ProviderAbortError with the partial', async () => {
		const stub = await startOllamaStub({
			chunks: [ndjsonLine({ message: { content: 'partial' } })],
			hang: true,
		})
		try {
			const provider = new OllamaProvider({ model: 'm', url: stub.url, timeout: 150 })
			const generator = provider.stream([createUserMessage('hi')], createAbort().signal)

			// The first line arrives; the deadline then fires while the stub hangs.
			const first = await generator.next()
			expect(first.done).toBe(false)
			expect(first.value).toEqual({ type: 'content', text: 'partial' })

			let caught: unknown
			try {
				for (;;) {
					const step = await generator.next()
					if (step.done) break
				}
			} catch (error) {
				caught = error
			}
			expect(isProviderAbortError(caught)).toBe(true)
			if (!isProviderAbortError(caught)) throw new Error('expected ProviderAbortError')
			expect(caught.partial.content).toBe('partial')
		} finally {
			await stub.close()
		}
	})
})

// Always runs (no Ollama needed): an unreachable daemon makes generate reject with a
// connection error — the boundary fails loudly rather than hanging.
describe('OllamaProvider (unreachable)', () => {
	it('rejects generate when the daemon is unreachable', async () => {
		const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: 'http://localhost:1' })
		const abort = createAbort()

		await expect(
			provider.generate([createUserMessage('Say hello.')], abort.signal),
		).rejects.toThrow(Error)
	})

	it('rejects stream when the daemon is unreachable, and is NOT a ProviderAbortError', async () => {
		const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: 'http://localhost:1' })
		const abort = createAbort()

		// An unreachable host rejects `fetch` with a TypeError (not an abort) before any
		// stream is in flight, so the FIRST pull rejects with the raw fetch error — the
		// loop's abort-wrapping never engages (the combined signal never aborted).
		const generator = provider.stream([createUserMessage('Say hello.')], abort.signal)
		let caught: unknown
		try {
			await generator.next()
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(Error)
		expect(isProviderAbortError(caught)).toBe(false)
	})
})

// Always runs (no Ollama needed): a pre-aborted signal makes `fetch` reject before any
// network, and the armed deadline timer must NOT outlive the failed call — a regression
// guard for a leak where `#fetch` cleared the deadline only on the success / non-OK path.
describe('OllamaProvider (deadline cleanup)', () => {
	it('clears the deadline timer when the call rejects, leaking no timer', async () => {
		vi.useFakeTimers()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: OLLAMA_CONFIG.host })
			const abort = createAbort()
			abort.abort()

			await expect(
				provider.generate([createUserMessage('Say hello.')], abort.signal),
			).rejects.toThrow(Error)
			// Pre-fix this was 1 — the 120s deadline `setTimeout` stayed armed after the
			// rejected fetch, keeping the event loop alive for up to two minutes.
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it('clears the deadline timer when an UNREACHABLE call rejects (no leak)', async () => {
		vi.useFakeTimers()
		try {
			// A real network failure (connection refused) rather than a pre-aborted signal —
			// the SAME `#fetch` catch must clear the armed deadline. Real timers would let the
			// connect fail; here the fetch rejects synchronously enough that the only armed
			// timer to inspect is the provider's deadline, which must already be cleared.
			const provider = new OllamaProvider({
				model: 'm',
				url: 'http://localhost:1',
				timeout: 90_000,
			})
			const abort = createAbort()
			await expect(provider.generate([createUserMessage('hi')], abort.signal)).rejects.toThrow(
				Error,
			)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
})
