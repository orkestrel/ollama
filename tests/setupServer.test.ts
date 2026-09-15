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

import type { AgentResult, ProviderDelta, ProviderResult } from '@orkestrel/agent'
import { isError, isRecord, isString } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import {
	captureError,
	createRecorder,
	createTeardown,
	waitForAbort,
	waitForDelay,
} from '@orkestrel/test'
import { createOllama } from '@src/core'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { describe, expect, it } from 'vitest'
import { createScratch } from '@orkestrel/test/server'
import { createServer as createNetServer } from 'node:net'
import { PAGE_TOOL } from './setup.js'
import type { PageAttempt, PageTool } from './setupServer.js'
import {
	acceptPageAttempt,
	boundPageAttempt,
	buildImportMap,
	buildRelayRoute,
	CONTROL_PATH,
	createPageFixture,
	createRecordingProxy,
	createRecordingTransport,
	createRelayServer,
	createOpenTransport,
	createStreamingTransport,
	describeFailure,
	DIST_PATH,
	expirePageAttempt,
	isAgentOutcome,
	isPageControl,
	isPageGeneration,
	isPageOutcome,
	isPageReceipts,
	isToolOutcome,
	MODULES_PATH,
	OBFUSCATED,
	PAGE_BOUNDS,
	PAGE_DOCUMENT,
	PAGE_INTERVALS,
	drive,
	INSATIABLE_TOOL_CHUNKS,
	insatiableResult,
	readModuleEntry,
	readOutcome,
	readRequest,
	releasePageAttempt,
	reservePort,
	serveFile,
	waitForRequest,
	WEATHER_TOOL,
	WORKSPACE_ROOT,
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

/**
 * The scheduling allowance the elapsed assertions on a bounded attempt add to their nominal,
 * in milliseconds.
 *
 * The property those cases prove is timer-bounded completion, not the nominal sum: a Vitest
 * worker sharing a host with its siblings reaches a fired timer's callback late, and a host timer
 * itself rounds up to its own granularity. So each case asserts that the attempt took at least
 * the deadlines it had to wait out and no more than those deadlines plus this allowance — an
 * interval that excludes both an attempt that returned before its deadlines and an attempt that
 * awaited something unbounded, which is the defect these cases exist for and which ends at the
 * case timeout rather than anywhere near this figure.
 */
const SCHEDULE_SLACK = 500

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

// The page fixture's Node half. The live half — a real browser loading the served
// closure and running an agent in it — is proven by the `service` project, which is the
// only project this workspace gives a browser; nothing here launches one.

describe('readRequest', () => {
	it('records the method, path, headers, parsed body, and text without consuming the request', async () => {
		const request = new Request('http://127.0.0.1:1/inference?trace=1', {
			method: 'POST',
			headers: { authorization: OBFUSCATED, 'x-trace': 'record' },
			body: '{"messages":[]}',
		})

		const record = await readRequest(request)

		expect(record).toEqual({
			method: 'POST',
			path: '/inference',
			headers: expect.objectContaining({ authorization: OBFUSCATED, 'x-trace': 'record' }),
			body: { messages: [] },
			text: '{"messages":[]}',
		})
		// The original still carries its body, which is what lets a relay read it afterwards.
		expect(await request.text()).toBe('{"messages":[]}')
	})

	it('records an empty body for a request carrying no JSON record', async () => {
		const record = await readRequest(new Request('http://127.0.0.1:1/control'))

		expect(record).toMatchObject({ method: 'GET', path: '/control', body: {}, text: '' })
	})
})

describe('buildRelayRoute', () => {
	it('registers the authenticated inference route both server fixtures mount', () => {
		const route = buildRelayRoute(createOllama({ model: 'fixture-model' }), [])

		expect(route.method).toBe('POST')
		expect(route.path).toBe('/inference')
	})
})

describe('readModuleEntry', () => {
	it('reads a declared ESM root entry and refuses a manifest that declares none', () => {
		const declared = { exports: { '.': { import: { default: './dist/src/core/index.js' } } } }

		expect(readModuleEntry(declared)).toBe('dist/src/core/index.js')
		expect(readModuleEntry(undefined)).toBeUndefined()
		expect(readModuleEntry({})).toBeUndefined()
		expect(readModuleEntry({ exports: './index.js' })).toBeUndefined()
		expect(readModuleEntry({ exports: { '.': './index.js' } })).toBeUndefined()
		expect(
			readModuleEntry({ exports: { '.': { require: { default: './index.cjs' } } } }),
		).toBeUndefined()
		expect(
			readModuleEntry({ exports: { '.': { import: { types: './index.d.ts' } } } }),
		).toBeUndefined()
	})
})

describe('buildImportMap', () => {
	it('maps every installed package that declares an ESM root entry, plus the root package itself', () => {
		const scratch = createScratch({
			files: {
				'package.json': JSON.stringify({
					name: '@orkestrel/subject',
					exports: { '.': { import: { default: './dist/src/core/index.js' } } },
				}),
				'node_modules/@orkestrel/alpha/package.json': JSON.stringify({
					name: '@orkestrel/alpha',
					exports: { '.': { import: { default: './dist/src/core/index.js' } } },
				}),
				// The control: a package with no ESM root entry to serve is left out, so a map
				// that reported every directory it read would fail this case.
				'node_modules/@orkestrel/beta/package.json': JSON.stringify({
					name: '@orkestrel/beta',
					exports: { '.': { require: { default: './index.cjs' } } },
				}),
			},
		})
		try {
			expect(buildImportMap(scratch.path)).toEqual({
				'@orkestrel/alpha': `${MODULES_PATH}/alpha/dist/src/core/index.js`,
				'@orkestrel/subject': `${DIST_PATH}/src/core/index.js`,
			})
		} finally {
			scratch.destroy()
		}
	})

	it('maps this workspace and the closure its page imports', () => {
		const map = buildImportMap(WORKSPACE_ROOT)

		// Membership, not a total: the installed tree grows, and what this proof needs is that
		// every specifier the served page imports resolves.
		expect(map['@orkestrel/ollama']).toBe(`${DIST_PATH}/src/core/index.js`)
		for (const name of ['agent', 'tool', 'ndjson', 'contract', 'budget']) {
			expect(map[`@orkestrel/${name}`]).toBe(`${MODULES_PATH}/${name}/dist/src/core/index.js`)
		}
	})
})

describe('PAGE_DOCUMENT', () => {
	it('carries the shared tool definition and the readiness flag in its served text', () => {
		// Presence guards, and nothing more: the served string carries the one tool definition
		// the model is advertised and the test asserts against, and the flag the session waits
		// for. What the page actually parks is a runtime fact this string cannot settle, so
		// `tests/service/page.test.ts` reads the operation table out of the real browser.
		expect(PAGE_DOCUMENT).toContain(JSON.stringify(PAGE_TOOL))
		expect(PAGE_DOCUMENT).toContain('globalThis.ready = true')
	})
})

describe('acceptPageAttempt', () => {
	it('retries only a sampling miss and escapes every failure another launch cannot clear', () => {
		// Inert attempt records, built here rather than observed: the subject is the decision,
		// which is what `retryUntil` asks of its predicate. A predicate that answers `false`
		// spends another browser launch; one that throws ends the retry and fails the case.
		// The traffic an attempt retains is beside the point here, so every record carries the
		// same empty observations and differs only in what the page reported.
		const observed: PageAttempt = {
			receipts: [],
			resources: [],
			page: [],
			relay: [],
			daemon: [],
		}
		const dispatched: PageTool = {
			turn: 0,
			call: { id: 'call-1', name: PAGE_TOOL.name, arguments: { note: 'kyoto' } },
			result: { id: 'call-1', name: PAGE_TOOL.name, success: true, value: 'receipt-1' },
		}
		const answered: AgentResult = { content: 'the note is recorded', partial: false }

		// An attempt whose model completed its answer without dispatching the tool: the one
		// retry-worthy reading, because another launch can sample a different answer.
		expect(
			acceptPageAttempt({ ...observed, outcome: { turns: [0], tools: [], result: answered } }),
		).toBe(false)
		// An attempt whose model dispatched the tool: the reading the retry is waiting for.
		expect(
			acceptPageAttempt({
				...observed,
				outcome: { turns: [0, 1], tools: [dispatched], result: answered },
			}),
		).toBe(true)

		// An attempt the deadline interrupted mid-run reports a partial result and no tool call,
		// which is indistinguishable from a sampling miss by tool selection alone. The deadline
		// is the attempt's own, so another launch cannot clear it: refused before tool selection
		// is read at all, rather than spent as one of the remaining attempts.
		expect(
			captureError(() =>
				acceptPageAttempt({
					...observed,
					outcome: { turns: [0], tools: [], result: { content: 'starting', partial: true } },
				}),
			),
		).toEqual(new Error('the page run was interrupted before it settled: starting'))
		// A partial run that did dispatch the tool is refused on the same reading, because the
		// interruption is what the attempt reports rather than the sample.
		expect(
			captureError(() =>
				acceptPageAttempt({
					...observed,
					outcome: {
						turns: [0, 1],
						tools: [dispatched],
						result: { content: 'starting', partial: true },
					},
				}),
			),
		).toEqual(new Error('the page run was interrupted before it settled: starting'))

		// A relay that answered HTTP 500 reaches the predicate as a serialized run failure. It
		// is not a sampling miss, so retrying it would spend the remaining attempts and report
		// the exhaustion as the model never choosing the tool.
		expect(
			captureError(() =>
				acceptPageAttempt({
					...observed,
					outcome: {
						turns: [0],
						tools: [],
						failure: 'ProviderError: HTTP 500',
						code: 'HTTP',
						status: 500,
					},
				}),
			),
		).toEqual(new Error('the page run failed: ProviderError: HTTP 500'))
		// A fixture fault reaches it the same way, as the failure the page reported.
		expect(
			captureError(() =>
				acceptPageAttempt({
					...observed,
					outcome: { turns: [0], tools: [], failure: 'TypeError: Failed to fetch' },
				}),
			),
		).toEqual(new Error('the page run failed: TypeError: Failed to fetch'))
		// An evaluate that rejected — an acquisition, a read, or a release that threw — leaves
		// the attempt unobserved, so its traffic was never retained and nothing can assert it.
		expect(
			captureError(() =>
				acceptPageAttempt({ ...observed, fault: 'BrowserError: the page is gone' }),
			),
		).toEqual(new Error('the page attempt could not be observed: BrowserError: the page is gone'))
		// A fault the producer failed to record leaves neither reading: refused rather than
		// treated as a miss.
		expect(captureError(() => acceptPageAttempt(observed))).toEqual(
			new Error('the page attempt retained no outcome and no fault'),
		)
		// An outcome carrying neither a settled result nor a failure is refused the same way:
		// only a completed answer can be read for tool selection.
		expect(
			captureError(() => acceptPageAttempt({ ...observed, outcome: { turns: [], tools: [] } })),
		).toEqual(new Error('the page attempt reported neither a result nor a failure'))
	})
})

describe('readOutcome', () => {
	it('narrows a JSON string across the evaluate boundary and refuses every other reading', async () => {
		// The boundary stub implements the one member the reader crosses — `evaluate` — and
		// answers with the strings a real page answers with. The subject is the narrowing.
		const answers: Array<readonly [string, number | undefined]> = []
		const page = {
			evaluate(expression: string, timeout?: number) {
				answers.push([expression, timeout])
				return Promise.resolve(expression === 'ok' ? '{"status":200,"text":"control"}' : undefined)
			},
		}

		expect(await readOutcome(page, 'ok', isPageControl, PAGE_BOUNDS.read)).toEqual({
			status: 200,
			text: 'control',
		})
		// The caller's deadline reaches the boundary, so an attempt spends the allowance its
		// own arithmetic counted rather than one this reader chose.
		expect(answers).toEqual([['ok', PAGE_BOUNDS.read]])

		// A reading that is not a string at all.
		await expect(readOutcome(page, 'absent', isPageControl, PAGE_BOUNDS.read)).rejects.toThrow(
			'the page expression absent returned undefined, not a string',
		)
		// A reading that is a string of JSON the guard refuses.
		const mismatched = { evaluate: () => Promise.resolve('{"status":"200"}') }
		await expect(readOutcome(mismatched, 'wrong', isPageControl, PAGE_BOUNDS.read)).rejects.toThrow(
			'returned an unexpected shape: {"status":"200"}',
		)
		// A reading that is a string but not JSON.
		const unparsed = { evaluate: () => Promise.resolve('control') }
		await expect(readOutcome(unparsed, 'raw', isPageControl, PAGE_BOUNDS.read)).rejects.toThrow(
			'returned an unexpected shape: control',
		)
		// A guard that accepts it narrows to that guard's type rather than to `unknown`.
		const text = { evaluate: () => Promise.resolve('"receipt-1"') }
		expect(
			(await readOutcome(text, 'text', isString, PAGE_BOUNDS.read)).startsWith('receipt-'),
		).toBe(true)
	})
})

describe('expirePageAttempt', () => {
	it('rejects with the attempt-wide deadline error and parks forever while the allowance holds', async () => {
		// The losing side of the race `boundPageAttempt` runs. Its whole job is the translation:
		// a caller reads the attempt's own allowance being exceeded rather than whichever inner
		// CDP call happened to time out first, which is the reading the installed browser
		// surface gives on its own because it accepts per-call `timeout` numbers and no signal.
		const expired = expirePageAttempt(AbortSignal.timeout(20), 20)
		await expect(expired).rejects.toThrow('the page attempt exceeded its 20 ms allowance')

		// An allowance already gone rejects on the same reading rather than waiting for a
		// second abort that will never arrive.
		const reason = new Error('the attempt was already over')
		await expect(expirePageAttempt(AbortSignal.abort(reason), 95_000)).rejects.toThrow(
			'the page attempt exceeded its 95000 ms allowance',
		)
		// The abort's own reason is retained as the cause, so the reading that ended the attempt
		// survives the translation.
		const failure = await expirePageAttempt(AbortSignal.abort(reason), 50).catch(
			(thrown: unknown) => thrown,
		)
		expect(failure).toBeInstanceOf(Error)
		expect(failure instanceof Error ? failure.cause : undefined).toBe(reason)

		// While the allowance holds, this side never settles: the work wins the race on its own
		// result. A promise that rejected eagerly would end every attempt at its first await.
		const controller = new AbortController()
		expect(
			await Promise.race([
				expirePageAttempt(controller.signal, 95_000),
				Promise.resolve('the work settled first'),
			]),
		).toBe('the work settled first')
		controller.abort(new Error('the proof is over'))
		await expect(expirePageAttempt(controller.signal, 95_000)).rejects.toThrow(
			'the page attempt exceeded its 95000 ms allowance',
		)
	})
})

describe('describeFailure', () => {
	it('reads an error message and falls back to the string form of anything else', () => {
		expect(describeFailure(new Error('the release outlasted its share'))).toBe(
			'the release outlasted its share',
		)
		// A thrown value is `unknown` at the boundary `boundPageAttempt` composes two failures
		// at, so a non-error carries its own reading into the composed message rather than
		// collapsing to an empty one.
		expect(describeFailure('the driver rejected with a string')).toBe(
			'the driver rejected with a string',
		)
		expect(describeFailure(undefined)).toBe('undefined')
	})
})

describe('releasePageAttempt', () => {
	it('releases inside its share, reports a stranded browser past it, and reports its own failure', async () => {
		// A settled acquisition is released, which is the ordinary path every attempt takes.
		const destroyed = createRecorder()
		await releasePageAttempt(
			Promise.resolve({ destroy: () => Promise.resolve(destroyed.handler()) }),
			500,
		)
		expect(destroyed.count).toBe(1)

		// An acquisition that rejected released whatever it took on its own way out, so there is
		// nothing here to release and its failure is the caller's to report, not this one's.
		await releasePageAttempt(Promise.reject(new Error('the acquisition failed')), 500)

		// A release that outlasts its share names the browser it stranded rather than waiting on
		// it. This is the reading that separates a residue the host can settle from a hang.
		const stranded = await releasePageAttempt(
			Promise.resolve({ destroy: () => new Promise<void>(() => undefined) }),
			30,
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(stranded)).toBe(
			"the page attempt's release outlasted its 30 ms share, stranding the browser",
		)

		// An acquisition still in flight past the share strands on the same reading, because the
		// browser it is holding is equally out of reach.
		const held = await releasePageAttempt(new Promise(() => undefined), 30).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(held)).toBe(
			"the page attempt's release outlasted its 30 ms share, stranding the browser",
		)

		// A release that fails inside its share reports its own failure, which is a different
		// reading from a browser nobody could reach.
		const refused = await releasePageAttempt(
			Promise.resolve({ destroy: () => Promise.reject(new Error('the browser refused to close')) }),
			500,
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(refused)).toBe('the browser refused to close')
	})
})

describe('boundPageAttempt', () => {
	it('returns what a satisfied attempt observed and releases the session it acquired', async () => {
		const destroyed = createRecorder()
		const signals: AbortSignal[] = []
		expect(
			await boundPageAttempt(
				{ attempt: 500, release: 500 },
				(signal) => {
					signals.push(signal)
					return Promise.resolve({ destroy: () => Promise.resolve(destroyed.handler()) })
				},
				(session, signal) => {
					signals.push(signal)
					return Promise.resolve(session === undefined ? 'no session' : 'the page answered')
				},
			),
		).toBe('the page answered')
		expect(destroyed.count).toBe(1)
		// One deadline reaches the acquisition and the observation, so a wait either of them
		// parks on ends at the attempt's deadline rather than at its own budget.
		expect(signals[0]).toBe(signals[1])

		// An observation that fails reports its own failure, and the session it was given is
		// still released.
		const failed = createRecorder()
		const refused = await boundPageAttempt(
			{ attempt: 500, release: 500 },
			() => Promise.resolve({ destroy: () => Promise.resolve(failed.handler()) }),
			() => Promise.reject(new Error('the page reported a fault')),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(refused)).toBe('the page reported a fault')
		expect(failed.count).toBe(1)
	})

	it('reports its allowance and the browser it stranded when the acquisition never settles', async () => {
		// An acquisition that never settles. The attempt reports its own allowance and names the
		// browser it could not reach, and it arrives rather than hanging: an attempt that awaited
		// the losing acquisition would still be waiting here, which is what the installed
		// `BrowserContext` produces when a page command it issued outlives the deadline.
		const bounds = { attempt: 50, release: 100 }
		const parked = performance.now()
		const abandoned = await boundPageAttempt(
			bounds,
			() => new Promise<never>(() => undefined),
			() => Promise.resolve('unreached'),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(abandoned)).toBe(
			"the page attempt exceeded its 50 ms allowance, and the page attempt's release outlasted its 100 ms share, stranding the browser",
		)
		// The inner failure stays reachable: the composed message reads as one sentence, and the
		// attempt's own failure — not the strand composed onto it — is what a caller unwrapping
		// the cause finds.
		if (!isError(abandoned)) throw new Error('the attempt reported no error')
		expect(abandoned.cause).toBeInstanceOf(Error)
		expect(describeFailure(abandoned.cause)).toBe('the page attempt exceeded its 50 ms allowance')
		// The elapsed total is the claim: the attempt waits out both deadlines in turn and ends
		// there, rather than returning early or waiting on what it cannot reach.
		const elapsed = performance.now() - parked
		expect(elapsed).toBeGreaterThanOrEqual(bounds.attempt + bounds.release)
		expect(elapsed).toBeLessThan(bounds.attempt + bounds.release + SCHEDULE_SLACK)
	})

	it('releases the acquisition its deadline outran when it settles inside the release share', async () => {
		// An acquisition that settles after the deadline but inside the release share. The
		// attempt reports its own allowance alone, and the browser that acquisition was holding
		// is released rather than abandoned.
		const late = createRecorder()
		const delayed = await boundPageAttempt(
			{ attempt: 30, release: 500 },
			async () => {
				await waitForDelay(80)
				return { destroy: () => Promise.resolve(late.handler()) }
			},
			() => Promise.resolve('unreached'),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(delayed)).toBe('the page attempt exceeded its 30 ms allowance')
		expect(late.count).toBe(1)
	})

	it('reports a release that parks past its share instead of waiting on it', async () => {
		// A release that parks past its share, with the allowance still holding. The attempt
		// reports the release rather than waiting on it, because a browser it cannot reach is a
		// residue reading the host can take and a hang is not.
		const bounds = { attempt: 2_000, release: 50 }
		const held = performance.now()
		const stranded = await boundPageAttempt(
			bounds,
			() => Promise.resolve({ destroy: () => new Promise<void>(() => undefined) }),
			() => Promise.resolve('the page answered'),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(stranded)).toBe(
			"the page attempt's release outlasted its 50 ms share, stranding the browser",
		)
		// The acquisition and the observation settle at once here, so the release share is the
		// only deadline that elapses: the attempt waits it out and ends there, well inside the
		// allowance it never spends.
		const elapsed = performance.now() - held
		expect(elapsed).toBeGreaterThanOrEqual(bounds.release)
		expect(elapsed).toBeLessThan(bounds.release + SCHEDULE_SLACK)
	})

	it('refuses an attempt whose release crossed its allowance', async () => {
		// An observation that completed while the allowance held, with the release crossing it.
		// The attempt's elapsed total is what the allowance is about, so this is a failure naming
		// the release rather than the success the observation on its own would report.
		const crossed = await boundPageAttempt(
			{ attempt: 30, release: 500 },
			() => Promise.resolve({ destroy: () => waitForDelay(80) }),
			() => Promise.resolve('the page answered'),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(crossed)).toBe(
			'the page attempt released its browser after its 30 ms allowance had expired',
		)
		// What expired stays reachable as the cause: `AbortSignal.timeout` aborts with a
		// `TimeoutError`, so a caller reading the cause finds the deadline rather than a second
		// copy of the message.
		if (!isError(crossed)) throw new Error('the attempt reported no error')
		const reason = crossed.cause
		if (!isError(reason)) throw new Error('the attempt reported no abort reason')
		expect(reason.name).toBe('TimeoutError')
	})
})

describe('PAGE_BOUNDS', () => {
	it('declares the two shares one attempt spends and the shares inside them, never a schedule of operations', () => {
		// The membership, asserted whole: the allowance the acquisition and the observation are
		// raced against, the share the release after it is raced against, the per-call shares
		// spent inside them, and the retry's own bounds. No count over the dependency's
		// operations appears, because `boundPageAttempt` races the lifecycle rather than summing
		// per-call values — a sum the installed `@orkestrel/browser` surface cannot support,
		// because one of its calls issues several separately bounded CDP commands.
		expect(Object.keys(PAGE_BOUNDS)).toEqual([
			'command',
			'ready',
			'read',
			'run',
			'evaluate',
			'attempt',
			'release',
			'case',
			'launches',
			'budget',
			'retry',
		])
		// Every per-call share is spent inside the one allowance, so no share can outlast the
		// attempt that races it.
		expect(PAGE_BOUNDS.command).toBeLessThan(PAGE_BOUNDS.attempt)
		expect(PAGE_BOUNDS.ready).toBeLessThan(PAGE_BOUNDS.attempt)
		expect(PAGE_BOUNDS.read).toBeLessThan(PAGE_BOUNDS.attempt)
		expect(PAGE_BOUNDS.evaluate).toBeLessThan(PAGE_BOUNDS.attempt)
		// The release share holds a browser release, whose own CDP requests take `command`.
		expect(PAGE_BOUNDS.command).toBeLessThanOrEqual(PAGE_BOUNDS.release)
		// What one attempt ends within — its allowance plus its release share — fits the case
		// that holds one attempt.
		expect(PAGE_BOUNDS.attempt + PAGE_BOUNDS.release).toBeLessThanOrEqual(PAGE_BOUNDS.case)
		// The innermost bound fires first: the in-page deadline before the evaluate around it,
		// and an instant read never outlasts the run it follows.
		expect(PAGE_BOUNDS.run).toBeLessThan(PAGE_BOUNDS.evaluate)
		expect(PAGE_BOUNDS.read).toBeLessThan(PAGE_BOUNDS.evaluate)
		// The bounded retry ends on its launch count, never on an expired budget: every launch
		// it allows fits inside the budget whole, and the budget inside the case it runs in.
		expect(PAGE_BOUNDS.launches * (PAGE_BOUNDS.attempt + PAGE_BOUNDS.release)).toBeLessThanOrEqual(
			PAGE_BOUNDS.budget,
		)
		expect(PAGE_BOUNDS.budget).toBeLessThanOrEqual(PAGE_BOUNDS.retry)
		expect(Object.isFrozen(PAGE_BOUNDS)).toBe(true)
	})
})

describe('PAGE_INTERVALS', () => {
	it('orders the allowances the attempt-bound controls spend and contains the delay beside them', () => {
		// The membership, asserted whole: the allowances chosen to expire at a named point of a
		// real attempt, and the delay a control adds to one step to keep it in flight past the
		// allowance beside it.
		expect(Object.keys(PAGE_INTERVALS)).toEqual(['launch', 'observe', 'late', 'hold'])
		// The order each control's reading depends on. `launch` expires before any acquisition
		// completes; `late` outlasts an acquisition and nothing more; `observe` outlasts the
		// acquisition by enough that the deadline lands in the observation instead.
		expect(PAGE_INTERVALS.launch).toBeLessThan(PAGE_INTERVALS.late)
		expect(PAGE_INTERVALS.late).toBeLessThan(PAGE_INTERVALS.observe)
		// The held step crosses the allowance it is added to, which is the whole point of the
		// delayed-acquisition and crossed-release controls: a `hold` inside `late` would let both
		// attempts finish on time and pass their cases vacuously.
		expect(PAGE_INTERVALS.late).toBeLessThan(PAGE_INTERVALS.hold)
		// And it is contained by the share the release is raced against, so the step it delays
		// still finishes inside that share. A `hold` past `release` would report a stranded
		// browser instead of the crossing each control names.
		expect(PAGE_INTERVALS.hold).toBeLessThan(PAGE_BOUNDS.release)
		// Every control asserts its elapsed call against its own allowance plus that share, and
		// runs under the case bound, so each pair fits the case.
		for (const allowance of [PAGE_INTERVALS.launch, PAGE_INTERVALS.observe, PAGE_INTERVALS.late]) {
			expect(allowance + PAGE_BOUNDS.release).toBeLessThanOrEqual(PAGE_BOUNDS.case)
		}
		expect(Object.isFrozen(PAGE_INTERVALS)).toBe(true)
	})
})

describe('serveFile', () => {
	it('serves a contained file, refuses an escape, and reports a miss', async () => {
		const scratch = createScratch({ files: { 'entry.js': 'export const value = 1\n' } })
		try {
			const served = serveFile(scratch.path, 'entry.js')
			expect(served.status).toBe(200)
			expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
			expect(await served.text()).toBe('export const value = 1\n')

			expect(serveFile(scratch.path, '../escape.js').status).toBe(404)
			expect(serveFile(scratch.path, 'absent.js').status).toBe(404)
		} finally {
			scratch.destroy()
		}
	})
})

describe('createPageFixture', () => {
	it('serves the page, the module tree, and the control route, and mounts no relay without a provider', async () => {
		const fixture = await createPageFixture({ document: PAGE_DOCUMENT })
		try {
			const page = await fetch(fixture.url)
			expect(page.status).toBe(200)
			expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
			const html = await page.text()
			// The derived map and the shared tool definition both reach the served document.
			expect(html).toContain('<script type="importmap">')
			expect(html).toContain(`${MODULES_PATH}/agent/dist/src/core/index.js`)
			expect(html).toContain(JSON.stringify(PAGE_TOOL))
			// No favicon request: the page declares an inert icon, so the browser asks for none.
			expect(html).toContain('<link rel="icon" href="data:,">')

			const module = await fetch(`${fixture.url}${MODULES_PATH}/contract/dist/src/core/index.js`)
			expect(module.status).toBe(200)
			expect(module.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
			expect((await module.text()).length).toBeGreaterThan(0)

			expect((await fetch(`${fixture.url}${MODULES_PATH}/absent/index.js`)).status).toBe(404)

			const control = await fetch(`${fixture.url}${CONTROL_PATH}`)
			expect(control.status).toBe(200)
			expect(control.headers.get('cache-control')).toBe('no-store')
			expect(await control.text()).toBe('control')

			// No provider, no relay route: the fixture answers the inference path with the
			// dispatcher's own miss rather than relaying.
			expect((await fetch(`${fixture.url}/inference`, { method: 'POST', body: '{}' })).ok).toBe(
				false,
			)

			expect(fixture.requests.map((request) => request.path)).toEqual([
				'/',
				`${MODULES_PATH}/contract/dist/src/core/index.js`,
				`${MODULES_PATH}/absent/index.js`,
				CONTROL_PATH,
			])
		} finally {
			await fixture.stop()
		}
	})

	it('mounts the same authenticated relay route the relay server mounts when given a provider', async () => {
		const daemon = createRecordingTransport(
			createStreamingTransport(['{"message":{"content":"answer"}}\n']),
		)
		const fixture = await createPageFixture({
			document: PAGE_DOCUMENT,
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
		})
		try {
			const body = JSON.stringify({ messages: [{ id: 'q', role: 'user', content: 'Hello' }] })
			const accepted = await fetch(`${fixture.url}/inference`, {
				method: 'POST',
				headers: { authorization: OBFUSCATED },
				body,
			})
			expect(accepted.status).toBe(200)
			expect(createNDJSONParser().parse(await accepted.text())).toEqual([
				{ channel: 'content', text: 'answer' },
				{ channel: 'result', result: { content: 'answer' } },
			])

			const refused = await fetch(`${fixture.url}/inference`, {
				method: 'POST',
				headers: { authorization: `${OBFUSCATED}-wrong` },
				body,
			})
			expect(refused.status).toBe(401)
			// The refusal never entered the provider, so the daemon transport saw one call.
			expect(daemon.requests).toHaveLength(1)
			expect(fixture.requests.map((request) => request.path)).toEqual(['/inference', '/inference'])
		} finally {
			await fixture.stop()
		}
	})
})

describe('the page session release order', () => {
	it('stops a real fixture through the teardown registry when the release before it rejects', async () => {
		// The control, drawn from outside the registry: the sequential shape — release the
		// browser, then stop the fixture — leaves a real listener bound when the first release
		// rejects, which is the defect the registry exists to close.
		const stranded = await createPageFixture({ document: PAGE_DOCUMENT })
		let sequential: unknown
		try {
			await Promise.reject(new Error('the browser refused to be released'))
			await stranded.stop()
		} catch (failure) {
			sequential = failure
		}
		expect(String(sequential)).toContain('the browser refused to be released')
		expect((await fetch(stranded.url)).status).toBe(200)
		await stranded.stop()

		// The registry `createPageSession` uses: every release runs, newest first, and the
		// failure is still reported.
		const released: string[] = []
		const teardown = createTeardown()
		const fixture = await createPageFixture({ document: PAGE_DOCUMENT })
		teardown.add(async () => {
			released.push('fixture')
			await fixture.stop()
		})
		teardown.add(() => {
			released.push('browser')
			throw new Error('the browser refused to be released')
		})

		await expect(teardown.destroy()).rejects.toThrow('the browser refused to be released')

		expect(released).toEqual(['browser', 'fixture'])
		await expect(fetch(fixture.url)).rejects.toThrow('fetch failed')
	})

	it('releases a real fixture when the acquisition registered after it rejects', async () => {
		// Partial acquisition: the fixture is listening and its stop is registered, and the
		// step `createPageSession` takes next — the port reservation — is made to fail. The
		// caller's catch releases what was already taken and reports the acquisition failure.
		const teardown = createTeardown()
		const fixture = await createPageFixture({ document: PAGE_DOCUMENT })
		teardown.add(() => fixture.stop())
		const { url } = fixture
		let acquired: unknown
		try {
			await Promise.reject(new Error('the port reservation failed'))
		} catch (failure) {
			acquired = failure
			await Promise.allSettled([teardown.destroy()])
		}

		expect(String(acquired)).toContain('the port reservation failed')
		await expect(fetch(url)).rejects.toThrow('fetch failed')
	})
})

describe('reservePort', () => {
	it('returns a free loopback port a listener can then bind', async () => {
		const port = await reservePort()

		expect(Number.isInteger(port)).toBe(true)
		expect(port).toBeGreaterThan(0)
		expect(port).toBeLessThan(65_536)
		// The number is genuinely free at the moment it is returned: a listener takes it.
		const taken = createNetServer()
		try {
			await new Promise<void>((resolve, reject) => {
				taken.on('error', reject)
				taken.listen(port, '127.0.0.1', resolve)
			})
		} finally {
			await new Promise<void>((resolve) => taken.close(() => resolve()))
		}
	})
})

describe('the page outcome guards', () => {
	it('narrow a settled run, a failed run, the receipts, the control, and the generation', () => {
		const call = { id: 'call-1', name: PAGE_TOOL.name, arguments: { note: 'kyoto' } }
		const settled = {
			turns: [0, 1],
			tools: [
				{
					turn: 0,
					call,
					result: { id: 'call-1', name: PAGE_TOOL.name, success: true, value: 'r' },
				},
			],
			result: { content: 'done', partial: false },
		}
		const failed = {
			turns: [0],
			tools: [],
			failure: 'ProviderError: HTTP 401',
			code: 'HTTP',
			status: 401,
		}

		expect(isPageOutcome(settled)).toBe(true)
		expect(isPageOutcome(failed)).toBe(true)
		// Each refusal names one malformed field, so a guard that stopped reading after the
		// first would fail one of these.
		expect(isPageOutcome({ turns: ['0'], tools: [] })).toBe(false)
		expect(
			isPageOutcome({ turns: [0], tools: [{ turn: 0, call, result: { id: 'call-1' } }] }),
		).toBe(false)
		// The turn a call was dispatched in is what pins the feedback to the request after it,
		// so a call reporting none is refused rather than narrowed.
		expect(
			isPageOutcome({
				turns: [0],
				tools: [
					{ call, result: { id: 'call-1', name: PAGE_TOOL.name, success: true, value: 'r' } },
				],
			}),
		).toBe(false)
		expect(isPageOutcome({ turns: [0], tools: [], result: { content: 'done' } })).toBe(false)
		expect(isPageOutcome({ turns: [0], tools: [], failure: 7 })).toBe(false)
		// Absence is `undefined`: a failure reporting `null` for either field is off-shape,
		// because the type it narrows to declares neither as nullable.
		expect(isPageOutcome({ turns: [0], tools: [], failure: 'boom', code: null })).toBe(false)
		expect(isPageOutcome({ turns: [0], tools: [], failure: 'boom', status: null })).toBe(false)
		expect(isPageOutcome({ turns: [0], tools: [], failure: 'boom' })).toBe(true)
		expect(isPageOutcome(undefined)).toBe(false)

		expect(isToolOutcome({ id: 'c', name: 'n', success: false, error: 'boom' })).toBe(true)
		expect(isToolOutcome({ id: 'c', name: 'n', success: false })).toBe(false)
		expect(isAgentOutcome({ content: 'done', partial: false })).toBe(true)
		expect(isAgentOutcome({ content: 'done' })).toBe(false)

		expect(isPageReceipts([{ note: 'kyoto', receipt: 'receipt-1' }])).toBe(true)
		expect(isPageReceipts([{ note: 'kyoto' }])).toBe(false)
		expect(isPageControl({ status: 200, text: 'control' })).toBe(true)
		expect(isPageControl({ status: '200', text: 'control' })).toBe(false)
		expect(isPageGeneration({ name: 'ollama', content: 'hi' })).toBe(true)
		expect(isPageGeneration({ name: 'ollama' })).toBe(false)
	})
})
