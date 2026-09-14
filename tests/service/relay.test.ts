import { createRelayProvider, isProviderAbortError } from '@orkestrel/agent'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { createOllama } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createRecordingTransport, createRelayServer, drive, OBFUSCATED } from '../setupServer.js'
import { FAST_OPTIONS, OLLAMA_CONFIG, STREAM_OPTIONS } from '../setupService.js'

describe('RelayProvider through a real server and the live daemon', () => {
	it('generate returns a live answer through the authenticated relay', async () => {
		const daemon = createRecordingTransport()
		const server = await createRelayServer(
			createOllama({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				options: FAST_OPTIONS,
				fetch: daemon.fetch,
			}),
		)
		try {
			const browser = createRelayProvider({
				url: `${server.url}/inference`,
				parser: createNDJSONParser,
				headers: () => ({ authorization: OBFUSCATED }),
			})
			const result = await browser.generate(
				[{ id: 'greeting', role: 'user', content: 'Reply with exactly: ok' }],
				AbortSignal.timeout(60_000),
			)
			expect(result.content.length).toBeGreaterThan(0)
			expect(server.requests).toHaveLength(1)
			expect(server.requests[0]).toMatchObject({
				method: 'POST',
				path: '/inference',
				headers: { authorization: OBFUSCATED, 'content-type': 'application/json' },
			})
			expect(daemon.requests[0]?.path).toBe('/api/chat')
			expect(daemon.requests[0]?.body.messages).not.toEqual([])
		} finally {
			await server.stop()
		}
	})

	it('streamed live deltas join to the settled relay content', async () => {
		const daemon = createRecordingTransport()
		const server = await createRelayServer(
			createOllama({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				options: STREAM_OPTIONS,
				fetch: daemon.fetch,
			}),
		)
		try {
			const browser = createRelayProvider({
				url: `${server.url}/inference`,
				parser: createNDJSONParser,
				headers: () => ({ authorization: OBFUSCATED }),
			})
			const { deltas, result } = await drive(
				browser.stream(
					[{ id: 'counting', role: 'user', content: 'Count: one two three.' }],
					AbortSignal.timeout(60_000),
				),
			)
			expect(deltas.length).toBeGreaterThan(0)
			expect(deltas.join('')).toBe(result.content)
			expect(result.content.length).toBeGreaterThan(0)
			expect(server.requests[0]?.headers.authorization).toBe(OBFUSCATED)
			expect(daemon.requests[0]?.path).toBe('/api/chat')
			expect(daemon.requests[0]?.body.messages).not.toEqual([])
		} finally {
			await server.stop()
		}
	})

	it('aborting after a live delta throws with the relay partial', async () => {
		const daemon = createRecordingTransport()
		const server = await createRelayServer(
			createOllama({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				options: STREAM_OPTIONS,
				fetch: daemon.fetch,
			}),
		)
		const abort = new AbortController()
		try {
			const browser = createRelayProvider({
				url: `${server.url}/inference`,
				parser: createNDJSONParser,
				headers: () => ({ authorization: OBFUSCATED }),
			})
			const stream = browser.stream(
				[{ id: 'counting', role: 'user', content: 'Count from one to twenty.' }],
				AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
			)
			const first = await stream.next()
			expect(first.done).toBe(false)
			if (first.done) throw new Error('live relay settled before a delta arrived')
			expect(first.value.channel).toBe('content')
			expect(first.value.text.length).toBeGreaterThan(0)
			abort.abort()
			const error = await stream.next().catch((failure: unknown) => failure)
			expect(isProviderAbortError(error)).toBe(true)
			expect(error).toMatchObject({ partial: { content: first.value.text } })
			expect(server.requests[0]?.headers.authorization).toBe(OBFUSCATED)
			expect(daemon.requests[0]?.path).toBe('/api/chat')
			expect(daemon.requests[0]?.body.messages).not.toEqual([])
		} finally {
			abort.abort()
			await server.stop()
		}
	})
})
