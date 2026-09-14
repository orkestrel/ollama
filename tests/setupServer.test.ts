// The Node-resource half of `tests/setupServer.ts`: the loopback recording proxy, the
// relay server, the capture wait, the provider-stream driver, the transport fixtures,
// and the shared wire tables. The narrowing guards, the tool fixtures, and the
// environment readers that module also exports are asserted by `tests/setup.test.ts`,
// so this proof does not re-assert them.
//
// The proxy and relay-server cases run against real sockets on 127.0.0.1 ephemeral
// ports: a pass-through case forwards to a fixture upstream this file starts, and
// `createRecordingProxy`'s own default upstream is deliberately unreachable. The
// transport fixtures drive in-memory responses instead. No Ollama daemon takes part
// in any of these cases.

import type { ProviderDelta, ProviderResult } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { waitForAbort } from '@orkestrel/test'
import { createOllama } from '@src/core'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { describe, expect, it } from 'vitest'
import {
	createRecordingProxy,
	createRecordingTransport,
	createRelayServer,
	createOpenTransport,
	createStreamingTransport,
	OBFUSCATED,
	drive,
	INSATIABLE_TOOL_CHUNKS,
	insatiableResult,
	waitForRequest,
	WEATHER_TOOL,
} from './setupServer.js'

describe('createRelayServer', () => {
	it('records accepted and refused request fields and mounts the authenticated inference route', async () => {
		const daemon = createRecordingTransport(
			createStreamingTransport(['{"message":{"content":"answer"}}\n']),
		)
		const server = await createRelayServer(
			createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
		)
		try {
			const body = { messages: [{ id: 'question', role: 'user', content: 'Hello' }] }
			const accepted = await fetch(`${server.url}/inference`, {
				method: 'POST',
				headers: { authorization: OBFUSCATED, 'x-trace': 'relay-fixture' },
				body: JSON.stringify(body),
			})
			expect(accepted.status).toBe(200)
			expect(createNDJSONParser().parse(await accepted.text())).toEqual([
				{ channel: 'content', text: 'answer' },
				{ channel: 'result', result: { content: 'answer' } },
			])
			const refused = await fetch(`${server.url}/inference`, {
				method: 'POST',
				headers: { authorization: `${OBFUSCATED}-wrong` },
				body: JSON.stringify(body),
			})
			expect(refused.status).toBe(401)
			expect(await refused.text()).toBe('')
			expect(daemon.requests).toHaveLength(1)
			expect(server.requests).toHaveLength(2)
			expect(server.requests[0]).toMatchObject({
				method: 'POST',
				path: '/inference',
				body,
				headers: { authorization: OBFUSCATED, 'x-trace': 'relay-fixture' },
				text: JSON.stringify(body),
			})
			expect(server.requests[1]).toMatchObject({
				method: 'POST',
				path: '/inference',
				body,
				headers: { authorization: `${OBFUSCATED}-wrong` },
			})
		} finally {
			await server.stop()
		}
		await expect(fetch(`${server.url}/inference`, { method: 'POST', body: '{}' })).rejects.toThrow(
			'fetch failed',
		)
	})
})

describe('createRecordingTransport', () => {
	it('records request fields and cancellation while preserving streamed response bytes and headers', async () => {
		const transport = createRecordingTransport(createStreamingTransport(['{"word":"caf', 'é"}\n']))
		const abort = new AbortController()
		const response = await transport.fetch('http://127.0.0.1/api/chat', {
			method: 'POST',
			headers: { authorization: 'Bearer fixture' },
			body: '{"model":"fixture"}',
			signal: abort.signal,
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('application/x-ndjson')
		expect(await response.text()).toBe('{"word":"café"}\n')
		expect(transport.chunks.join('')).toBe('{"word":"café"}\n')
		expect(transport.requests[0]).toMatchObject({
			method: 'POST',
			path: '/api/chat',
			headers: { authorization: 'Bearer fixture' },
			body: { model: 'fixture' },
			text: '{"model":"fixture"}',
		})
		expect(transport.requests[0]?.signal.aborted).toBe(false)
		abort.abort()
		expect(transport.requests[0]?.signal.aborted).toBe(true)
	})

	it('preserves a bodyless refusal response', async () => {
		const transport = createRecordingTransport(() =>
			Promise.resolve(new Response(null, { status: 401 })),
		)
		const response = await transport.fetch('http://127.0.0.1/inference')
		expect(response.status).toBe(401)
		expect(response.body).toBeNull()
		expect(transport.chunks).toEqual([])
	})

	it('defaults to the global fetch, forwarding a real request to a live server', async () => {
		const proxy = await createRecordingProxy()
		try {
			const transport = createRecordingTransport()
			const url = `${proxy.url}/api/chat`
			await transport.fetch(url, { method: 'POST', body: '{}' }).catch(() => {})

			await waitForRequest(proxy)

			expect(transport.requests[0]?.path).toBe('/api/chat')
			expect(proxy.requests[0]?.path).toBe('/api/chat')
		} finally {
			await proxy.stop()
		}
	})
})

describe('createOpenTransport', () => {
	it('delivers the supplied bytes and reports cancellation of its open body', async () => {
		const transport = createOpenTransport('first\n')
		const response = await transport.fetch('http://127.0.0.1/api/chat')
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('open transport returned no body')
		try {
			expect(await reader.read()).toEqual({
				done: false,
				value: new TextEncoder().encode('first\n'),
			})
			await reader.cancel()
			await transport.cancelled
		} finally {
			await reader.cancel()
			reader.releaseLock()
		}
	})

	it('errors a pending read after its supplied bytes and rejects failure before a call', async () => {
		const transport = createOpenTransport('first\n')
		const error = new Error('fixture failure')
		expect(() => transport.fail(error)).toThrow('daemon transport has not been called')
		const response = await transport.fetch('http://127.0.0.1/api/chat')
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('open transport returned no body')
		try {
			expect((await reader.read()).done).toBe(false)
			const pending = reader.read()
			transport.fail(error)
			await expect(pending).rejects.toBe(error)
		} finally {
			await reader.cancel().catch(() => {})
			reader.releaseLock()
		}
	})
})

/** A fixture upstream a recording proxy forwards to. */
interface UpstreamInterface {
	/** The absolute base URL the fixture listens on. */
	readonly url: string
	/** Every `/api/chat` body the fixture received, in call order. */
	readonly bodies: readonly string[]
	stop(): Promise<void>
}

/**
 * Start a fixture upstream that records each `/api/chat` body and answers with `reply`.
 *
 * The reply receives the request's own abort signal so a case can park the route until
 * the proxy gives up on it.
 */
async function createUpstream(
	reply: (signal: AbortSignal) => Promise<Response>,
): Promise<UpstreamInterface> {
	const bodies: string[] = []
	const dispatcher = createDispatcher<Record<string, never>>()
	dispatcher.add({
		method: 'POST',
		path: '/api/chat',
		async handler(request) {
			bodies.push(await request.text())
			return await reply(request.signal)
		},
	})
	const server = createServer({ dispatcher, state: () => ({}), host: '127.0.0.1' })
	const port = await server.start()
	return {
		url: `http://127.0.0.1:${port}`,
		get bodies() {
			return bodies
		},
		stop() {
			return server.stop()
		},
	}
}

/** The settled value `driveScript` returns, held by identity so `drive` can be shown to pass it through. */
const DRIVEN_RESULT: ProviderResult = {
	content: 'ab',
	thinking: 'weighing it up',
	usage: { prompt: 1, completion: 2, total: 3 },
}

/** The deltas `driveScript` replays, interleaving both channels so bucketing is observable. */
const DRIVEN_DELTAS: readonly ProviderDelta[] = [
	{ channel: 'content', text: 'a' },
	{ channel: 'thinking', text: 'weighing it up' },
	{ channel: 'content', text: 'b' },
]

/** The settled value the empty-stream case returns. */
const EMPTY_RESULT: ProviderResult = { content: '' }

/** Replay a scripted delta sequence as a provider stream returning `result`. */
async function* driveScript(
	deltas: readonly ProviderDelta[],
	result: ProviderResult,
): AsyncGenerator<ProviderDelta, ProviderResult> {
	yield* deltas
	return result
}

describe('createRecordingProxy', () => {
	it("captures a call's method, path, headers, and parsed body before forwarding it", async () => {
		const proxy = await createRecordingProxy()
		try {
			const sent = { model: 'fixture-model', stream: false }
			await fetch(`${proxy.url}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-trace': 'capture-case' },
				body: JSON.stringify(sent),
			}).catch(() => {})

			await waitForRequest(proxy)

			const request = proxy.requests[0]
			if (request === undefined) throw new Error('the recording proxy captured no request')
			expect(request.method).toBe('POST')
			expect(request.path).toBe('/api/chat')
			expect(request.headers['x-trace']).toBe('capture-case')
			expect(request.body).toEqual(sent)
		} finally {
			await proxy.stop()
		}
	})

	it('forwards the body to a reachable upstream and returns its status and body verbatim', async () => {
		const answer = '{"message":{"content":"pong"}}'
		const upstream = await createUpstream(() =>
			Promise.resolve(new Response(answer, { status: 202 })),
		)
		const proxy = await createRecordingProxy(upstream.url)
		try {
			const body = JSON.stringify({ model: 'fixture-model', stream: false })

			const response = await fetch(`${proxy.url}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			})

			expect(response.status).toBe(202)
			expect(await response.text()).toBe(answer)
			expect(upstream.bodies).toEqual([body])
		} finally {
			await proxy.stop()
			await upstream.stop()
		}
	})

	it('answers 499 when stop cancels a call still waiting on the upstream', async () => {
		const park = new AbortController()
		const upstream = await createUpstream(async (signal) => {
			await waitForAbort(AbortSignal.any([signal, park.signal]))
			return new Response(undefined, { status: 204 })
		})
		const proxy = await createRecordingProxy(upstream.url)
		try {
			const pending = fetch(`${proxy.url}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{"model":"fixture-model"}',
			})
			await waitForRequest(proxy)

			const stopped = proxy.stop()

			expect((await pending).status).toBe(499)
			await stopped
		} finally {
			park.abort()
			await upstream.stop()
		}
	})

	it('releases its port on stop', async () => {
		const proxy = await createRecordingProxy()
		const url = `${proxy.url}/api/chat`

		await proxy.stop()

		await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow(Error)
	})
})

describe('waitForRequest', () => {
	it('resolves after the proxy has captured the requested count', async () => {
		const proxy = await createRecordingProxy()
		try {
			const first = fetch(`${proxy.url}/api/chat`, { method: 'POST', body: '{"n":1}' }).catch(
				() => {},
			)
			const second = fetch(`${proxy.url}/api/chat`, { method: 'POST', body: '{"n":2}' }).catch(
				() => {},
			)

			await waitForRequest(proxy, 2)

			expect(proxy.requests.length).toBeGreaterThanOrEqual(2)
			await first
			await second
		} finally {
			await proxy.stop()
		}
	})

	it('rejects naming the count it waited for when the budget expires', async () => {
		const proxy = await createRecordingProxy()
		try {
			await expect(waitForRequest(proxy, 2, 40)).rejects.toThrow(
				'the recording proxy to capture 2 request(s)',
			)
		} finally {
			await proxy.stop()
		}
	})
})

describe('drive', () => {
	it('separates content deltas from thinking deltas and hands back the settled result', async () => {
		const driven = await drive(driveScript(DRIVEN_DELTAS, DRIVEN_RESULT))

		expect(driven.deltas).toEqual(['a', 'b'])
		expect(driven.thoughts).toEqual(['weighing it up'])
		expect(driven.result).toBe(DRIVEN_RESULT)
	})

	it('returns empty buckets for a stream that yields nothing', async () => {
		const driven = await drive(driveScript([], EMPTY_RESULT))

		expect(driven.deltas).toEqual([])
		expect(driven.thoughts).toEqual([])
		expect(driven.result).toBe(EMPTY_RESULT)
	})
})

describe('WEATHER_TOOL', () => {
	it('is frozen and declares city as its only required parameter', () => {
		expect(Object.isFrozen(WEATHER_TOOL)).toBe(true)
		expect(WEATHER_TOOL.name).toBe('get_weather')
		const parameters: unknown = WEATHER_TOOL.parameters
		if (!isRecord(parameters)) throw new Error('WEATHER_TOOL declares no parameter schema')
		expect(parameters.type).toBe('object')
		expect(parameters.required).toEqual(['city'])
		const properties: unknown = parameters.properties
		if (!isRecord(properties)) throw new Error('WEATHER_TOOL declares no parameter properties')
		expect(Object.keys(properties)).toEqual(['city'])
	})
})

describe('insatiableResult', () => {
	it('names its own chunk, the shared total, and the next chunk on every line', () => {
		for (let chunk = 1; chunk <= INSATIABLE_TOOL_CHUNKS; chunk += 1) {
			const line = insatiableResult(chunk)

			expect(line).toContain(`Chunk ${chunk} of ${INSATIABLE_TOOL_CHUNKS}`)
			expect(line).toContain(`chunk ${chunk + 1}`)
		}
	})
})
