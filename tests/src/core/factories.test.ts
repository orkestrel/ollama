import { createAbort } from '@orkestrel/abort'
import { createRecorder, waitForDelay } from '@orkestrel/test'
import { createOllama } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../setup.js'
import {
	createRecordingProxy,
	createRecordingTransport,
	createRefusingTransport,
	createStreamingTransport,
	waitForRequest,
} from '../../setupServer.js'

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
	it('defaults the destination and framing while accepting a custom transport', async () => {
		const calls = createRecorder<readonly [string]>()
		const provider = createOllama({
			model: 'test-model',
			fetch: createRecordingTransport(calls, createStreamingTransport([])),
		})

		expect(await provider.generate([], createAbort().signal)).toEqual({ content: '' })
		expect(calls.calls).toEqual([['http://localhost:11434/api/chat']])
		expect(provider.format).toBeUndefined()
	})

	it('accepts inherited transport, headers, timeout, and framing with Ollama options', async () => {
		const proxy = await createRecordingProxy()
		const calls = createRecorder<readonly [string]>()
		const signals = createRecorder<readonly [AbortSignal]>()
		const format = { instructions: { open: '<instructions>', close: '</instructions>' } }
		try {
			const provider = createOllama({
				model: 'test-model',
				url: proxy.url,
				keepAlive: 0,
				options: { seed: 7 },
				think: true,
				fetch: createRecordingTransport(calls),
				headers: (signal) => {
					signals.handler(signal)
					return { 'x-provider': 'factory' }
				},
				timeout: 1_000,
				format,
			})
			await provider.generate([], createAbort().signal).catch(() => {})

			expect(provider.format).toBe(format)
			expect(calls.calls).toEqual([[`${proxy.url}/api/chat`]])
			expect(signals.count).toBe(1)
			expect(proxy.requests[0]?.headers['x-provider']).toBe('factory')
			expect(proxy.requests[0]?.body).toEqual({
				model: 'test-model',
				messages: [],
				stream: true,
				keep_alive: 0,
				think: true,
				options: { seed: 7 },
			})
		} finally {
			await proxy.stop()
		}
	})

	it('passes the configured timeout to the base while a header hook is pending', async () => {
		const transport = createRefusingTransport()
		const signals = createRecorder<readonly [AbortSignal]>()
		const provider = createOllama({
			model: 'test-model',
			timeout: 25,
			fetch: transport.fetch,
			headers: async (signal) => {
				signals.handler(signal)
				await waitForDelay(100)
				return {}
			},
		})

		await expect(provider.generate([], createAbort().signal)).rejects.toThrow(Error)
		expect(signals.count).toBe(1)
		expect(signals.calls[0]?.[0].aborted).toBe(true)
		expect(transport.signals).toEqual([])
	})

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
