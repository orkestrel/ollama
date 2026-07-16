import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../setup.js'
import {
	createRecordingProxy,
	drive,
	FAST_OPTIONS,
	OLLAMA_CONFIG,
	STREAM_OPTIONS,
} from '../../setupServer.js'

// createOllama returns a working ProviderInterface (AGENTS §16 — real Ollama, no
// mocks). The `src:ollama` project REQUIRES Ollama (`setupOllama.ts` enforces it +
// warms the model), so the live round-trips run UNCONDITIONALLY (no `skipIf`). The
// unreachable test needs no daemon and always runs too. The default-forwarding tests
// use the centralized recording proxy (a real HTTP server that forwards verbatim to
// the live daemon) to observe the exact request body createOllama produces.

describe('createOllama (live)', () => {
	it('returns a working ProviderInterface that generates content', async () => {
		// Recipe: FAST_OPTIONS (num_predict:8, temperature:0) — minimal warm chat, structural assert.
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: FAST_OPTIONS,
		})
		const abort = createAbort()

		expect(provider.name).toBe('ollama')
		expect(provider.id.length).toBeGreaterThan(0)

		const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)
		expect(result.content.length).toBeGreaterThan(0)
	})

	it('returns a ProviderInterface whose stream yields deltas and returns the result', async () => {
		// Recipe: STREAM_OPTIONS (num_predict:16, temperature:0) — multi-delta streaming.
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: STREAM_OPTIONS,
		})
		const abort = createAbort()

		const { deltas, result } = await drive(
			provider.stream([createUserMessage('Say hi.')], abort.signal),
		)

		expect(deltas.length).toBeGreaterThan(0)
		expect(result.content).toBe(deltas.join(''))
	})

	it('conforms to ProviderInterface (id + name data, generate + stream callable)', () => {
		const provider = createOllama({ model: OLLAMA_CONFIG.model, url: OLLAMA_CONFIG.host })

		// The full abstract shape: stable string id + the backend name, plus both
		// call-signature members present as functions (no live call needed for the shape).
		expect(typeof provider.id).toBe('string')
		expect(provider.id.length).toBeGreaterThan(0)
		expect(provider.name).toBe('ollama')
		expect(typeof provider.generate).toBe('function')
		expect(typeof provider.stream).toBe('function')
	})

	it('mints a distinct id per created provider', () => {
		const a = createOllama({ model: OLLAMA_CONFIG.model, url: OLLAMA_CONFIG.host })
		const b = createOllama({ model: OLLAMA_CONFIG.model, url: OLLAMA_CONFIG.host })

		expect(a.id).not.toBe(b.id)
	})

	it('the transport seam (a headers hook) does not break the real daemon path', async () => {
		// Recipe: FAST_OPTIONS. The S2 seam is orthogonal to the wire: a dynamic header the real
		// Ollama simply ignores must still produce a normal generation against the live daemon —
		// proof the header-merge doesn't perturb the actual request path.
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: FAST_OPTIONS,
			headers: () => ({ 'x-trace': 'abc' }),
		})
		const abort = createAbort()

		const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)
		expect(result.content.length).toBeGreaterThan(0)
	})
})

// Live (recording proxy): the factory's job is to CONSTRUCT a provider with the right
// defaults; assert those defaults reach the wire when only `model` + `url` are given
// (the option fields are otherwise unobservable). The proxy records the request BEFORE
// forwarding verbatim to the real daemon — a genuine HTTP round-trip, not a mock.
describe('createOllama (defaults)', () => {
	it('defaults keep_alive to 5m and sends think:false with no options/tools', async () => {
		// Recipe: default options (no options bag passed) — asserts the constructed body shape only.
		const proxy = await createRecordingProxy()
		try {
			const provider = createOllama({ model: OLLAMA_CONFIG.model, url: proxy.url })
			await provider.generate([createUserMessage('hi')], createAbort().signal).catch(() => {})

			const body = proxy.requests[0]?.body ?? {}
			expect(body.keep_alive).toBe('5m')
			expect(body.think).toBe(false)
			expect('options' in body).toBe(false)
			expect('tools' in body).toBe(false)
		} finally {
			await proxy.close()
		}
	})

	it('forwards a numeric keepAlive and passthrough options verbatim', async () => {
		// Recipe: SEED-style small options bag {seed:7, num_predict:12} — asserts verbatim passthrough.
		const proxy = await createRecordingProxy()
		try {
			const provider = createOllama({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				keepAlive: 0,
				options: { seed: 7, num_predict: 12 },
			})
			await provider.generate([createUserMessage('hi')], createAbort().signal).catch(() => {})

			const body = proxy.requests[0]?.body ?? {}
			expect(body.keep_alive).toBe(0)
			expect(body.options).toEqual({ seed: 7, num_predict: 12 })
		} finally {
			await proxy.close()
		}
	})
})

describe('createOllama (unreachable)', () => {
	it('returns a ProviderInterface whose generate rejects when unreachable', async () => {
		const provider = createOllama({ model: OLLAMA_CONFIG.model, url: 'http://localhost:1' })
		const abort = createAbort()

		expect(provider.name).toBe('ollama')
		await expect(
			provider.generate([createUserMessage('Say hello.')], abort.signal),
		).rejects.toThrow(Error)
	})
})
