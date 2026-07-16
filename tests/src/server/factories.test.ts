import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../setup.js'
import { drive, OLLAMA_CONFIG, startOllamaStub } from '../../setupServer.js'

// createOllama returns a working ProviderInterface (AGENTS §16 — real Ollama, no
// mocks). The `src:ollama` project REQUIRES Ollama (`setupOllama.ts` enforces it +
// warms the model), so the live round-trips run UNCONDITIONALLY (no `skipIf`). The
// unreachable + the deterministic stub tests below need no daemon and always run too.

describe('createOllama (live)', () => {
	it('returns a working ProviderInterface that generates content', async () => {
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: { num_predict: 24, temperature: 0 },
		})
		const abort = createAbort()

		expect(provider.name).toBe('ollama')
		expect(provider.id.length).toBeGreaterThan(0)

		const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)
		expect(result.content.length).toBeGreaterThan(0)
	})

	it('returns a ProviderInterface whose stream yields deltas and returns the result', async () => {
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: { num_predict: 24, temperature: 0 },
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
		// The S2 seam is orthogonal to the wire: a dynamic header the real Ollama simply
		// ignores must still produce a normal generation against the live daemon — proof
		// the header-merge doesn't perturb the actual request path.
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: { num_predict: 24, temperature: 0 },
			headers: () => ({ 'x-trace': 'abc' }),
		})
		const abort = createAbort()

		const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)
		expect(result.content.length).toBeGreaterThan(0)
	})
})

// Deterministic (real local stub server): the factory's job is to CONSTRUCT a provider
// with the right defaults; assert those defaults reach the wire when only `model` +
// `url` are given (the option fields are otherwise unobservable). A genuine HTTP
// round-trip, not a mock.
describe('createOllama (defaults)', () => {
	it('defaults keep_alive to 5m and sends think:false with no options/tools', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			// Only the required `model` + the stub `url` — every other option defaulted.
			const provider = createOllama({ model: 'm', url: stub.url })
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			const body = stub.captured[0]?.body ?? {}
			expect(body.keep_alive).toBe('5m')
			expect(body.think).toBe(false)
			expect('options' in body).toBe(false)
			expect('tools' in body).toBe(false)
		} finally {
			await stub.close()
		}
	})

	it('forwards a numeric keepAlive and passthrough options verbatim', async () => {
		const stub = await startOllamaStub({ body: { message: { content: 'ok' } } })
		try {
			const provider = createOllama({
				model: 'm',
				url: stub.url,
				keepAlive: 0,
				options: { seed: 7, num_predict: 12 },
			})
			await provider.generate([createUserMessage('hi')], createAbort().signal)

			const body = stub.captured[0]?.body ?? {}
			expect(body.keep_alive).toBe(0)
			expect(body.options).toEqual({ seed: 7, num_predict: 12 })
		} finally {
			await stub.close()
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
