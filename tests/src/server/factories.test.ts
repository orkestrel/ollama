import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../setup.js'
import { createRecordingProxy, waitForRequest } from '../../setupServer.js'

describe('createOllama (shape)', () => {
	it('conforms to ProviderInterface (id + name data, generate + stream callable)', () => {
		const provider = createOllama({ model: 'test-model', url: 'http://127.0.0.1:1' })

		// The full abstract shape: stable string id + the backend name, plus both
		// call-signature members present as functions (no live call needed for the shape).
		expect(typeof provider.id).toBe('string')
		expect(provider.id.length).toBeGreaterThan(0)
		expect(provider.name).toBe('ollama')
		expect(typeof provider.generate).toBe('function')
		expect(typeof provider.stream).toBe('function')
	})

	it('mints a distinct id per created provider', () => {
		const a = createOllama({ model: 'test-model', url: 'http://127.0.0.1:1' })
		const b = createOllama({ model: 'test-model', url: 'http://127.0.0.1:1' })

		expect(a.id).not.toBe(b.id)
	})
})

// Hermetic recording-proxy coverage makes provider-behavior assertions that factory
// defaults reach the wire when only `model` + `url` are given. The deliberately
// unreachable upstream cannot affect the request captured before forwarding, so the
// suite passes with the daemon down.
describe('createOllama (defaults)', () => {
	it('defaults keep_alive to 5m and sends think:false with no options/tools', async () => {
		// Recipe: default options (no options bag passed) — asserts the constructed body shape only.
		// bounded by abort-once-recorded, no generation awaited.
		const proxy = await createRecordingProxy()
		try {
			const provider = createOllama({ model: 'test-model', url: proxy.url })
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			const body = proxy.requests[0]?.body ?? {}
			expect(body.keep_alive).toBe('5m')
			expect(body.think).toBe(false)
			expect('options' in body).toBe(false)
			expect('tools' in body).toBe(false)
		} finally {
			await proxy.stop()
		}
	})

	it('forwards a numeric keepAlive and passthrough options verbatim', async () => {
		// Recipe: SEED-style small options bag {seed:7, num_predict:12} — asserts verbatim passthrough.
		const proxy = await createRecordingProxy()
		try {
			const provider = createOllama({
				model: 'test-model',
				url: proxy.url,
				keepAlive: 0,
				options: { seed: 7, num_predict: 12 },
			})
			await provider.generate([createUserMessage('hi')], createAbort().signal).catch(() => {})

			const body = proxy.requests[0]?.body ?? {}
			expect(body.keep_alive).toBe(0)
			expect(body.options).toEqual({ seed: 7, num_predict: 12 })
		} finally {
			await proxy.stop()
		}
	})
})

describe('createOllama (unreachable)', () => {
	it('returns a ProviderInterface whose generate rejects when unreachable', async () => {
		const provider = createOllama({ model: 'test-model', url: 'http://localhost:1' })
		const abort = createAbort()

		expect(provider.name).toBe('ollama')
		await expect(
			provider.generate([createUserMessage('Say hello.')], abort.signal),
		).rejects.toThrow(Error)
	})
})
