// The Node-resource half of `tests/setupServer.ts`: the loopback recording proxy, the
// capture wait, the provider-stream driver, and the shared wire tables. The narrowing
// guards, the tool fixtures, and the environment readers that module also exports are
// asserted by `tests/setup.test.ts`, so this proof does not re-assert them.
//
// Every case here runs against real sockets on 127.0.0.1 ephemeral ports. No Ollama
// daemon takes part: a pass-through case forwards to a fixture upstream this file
// starts, and `createRecordingProxy`'s own default upstream is deliberately unreachable.

import type { ProviderDelta, ProviderResult } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { waitForAbort } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import {
	createRecordingProxy,
	drive,
	INSATIABLE_TOOL_CHUNKS,
	insatiableResult,
	waitForRequest,
	WEATHER_TOOL,
} from './setupServer.js'

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
