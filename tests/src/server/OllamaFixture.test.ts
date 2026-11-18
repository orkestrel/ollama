import type { OllamaFixtureRequest } from '@src/server'
import { captureError, createRecorder, waitForCondition, waitForDelay } from '@orkestrel/test'
import { request as openRequest } from 'node:http'
import { createOllama, createOllamaJudge } from '@src/core'
import {
	buildOllamaReadout,
	buildOllamaReply,
	createOllamaFixture,
	isOllamaError,
	OllamaFixture,
	readOllamaJSON,
	readOllamaReply,
	readOllamaTerminal,
	readOllamaVersion,
	retainOllamaBytes,
	verifyOllamaModels,
} from '@src/server'
import { createUserMessage } from '../../setup.js'
import {
	createDaemonFixture,
	DAEMON_CONTEXT,
	DAEMON_FIXTURE_OPTIONS,
	DAEMON_MODEL,
	DAEMON_VERSION,
	DaemonPolicy,
	FIXTURE_CONTENT,
	FIXTURE_JUDGE,
	FIXTURE_MODEL,
	FIXTURE_MODELS,
	FIXTURE_ROUTE_CASES,
	INVALID_FIXTURE_OVERRIDES,
	JUDGE_NOUL_REQUEST,
	MICA_SYSTEM,
	readListening,
	WIDE_SHOW,
} from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

const readout = buildOllamaReadout({
	model: FIXTURE_JUDGE,
	token: 'No',
	top: [
		{ token: 'No', logprob: -0.01 },
		{ token: 'Yes', logprob: -8 },
	],
	counts: { prompt: 10, decode: 1 },
})
const chunked = buildOllamaReply({ model: FIXTURE_MODEL, content: 'Chunked' })

describe('OllamaFixture listener and lifecycle', () => {
	it('listens on 127.0.0.1 at an ephemeral port and keeps its url readable after destroy frees the port', async () => {
		const fixture = await createOllamaFixture(DAEMON_FIXTURE_OPTIONS)
		const { url } = fixture
		const port = Number(/^http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(url)?.[1])
		expect(port).toBeGreaterThan(0)
		expect((await fetch(`${url}/api/version`)).status).toBe(200)
		expect(await readListening(url)).toBe(true)

		await fixture.destroy()

		expect(fixture.url).toBe(url)
		expect(await readListening(url)).toBe(false)
	})

	it('refuses url before start and start after destroy with code state, and shares one start among callers', async () => {
		const fixture = new OllamaFixture(DAEMON_FIXTURE_OPTIONS)
		expect(captureError(() => fixture.url)).toMatchObject({ code: 'state' })
		const first = fixture.start()
		const second = fixture.start()
		expect(second).toBe(first)
		expect(captureError(() => fixture.url)).toMatchObject({ code: 'state' })
		await first
		const { url } = fixture

		await fixture.destroy()

		await expect(fixture.start()).rejects.toMatchObject({ code: 'state' })
		expect(fixture.url).toBe(url)
	})

	it('accepts the valid control options', async () => {
		const fixture = new OllamaFixture({ ...DAEMON_FIXTURE_OPTIONS, reply: () => undefined })
		await fixture.destroy()
		expect(fixture.emitter.destroyed).toBe(true)
	})

	it.each(INVALID_FIXTURE_OVERRIDES)(
		'refuses %s with code invalid and opens no listener',
		async (_label, override) => {
			const listeners = process
				.getActiveResourcesInfo()
				.filter((name) => name === 'TCPServerWrap').length
			const options = { ...DAEMON_FIXTURE_OPTIONS, ...override }
			expect(captureError(() => Reflect.construct(OllamaFixture, [options]))).toMatchObject({
				code: 'invalid',
				message: expect.stringContaining('Invalid fixture options'),
			})
			const pending: unknown = Reflect.apply(createOllamaFixture, undefined, [options])
			await expect(pending).rejects.toMatchObject({ code: 'invalid' })
			expect(
				process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length,
			).toBe(listeners)
		},
	)

	it('refuses options that are no record with code invalid', () => {
		for (const value of [null, undefined, 'options', [DAEMON_FIXTURE_OPTIONS]])
			expect(captureError(() => Reflect.construct(OllamaFixture, [value]))).toMatchObject({
				code: 'invalid',
			})
	})

	it('closes the listener a pending start opens when destroy races it, so no port survives', async () => {
		const fixture = new OllamaFixture(DAEMON_FIXTURE_OPTIONS)
		const started = fixture.start()
		const destroyed = fixture.destroy()

		await expect(started).resolves.toBeUndefined()
		await expect(destroyed).resolves.toBeUndefined()
		expect(await readListening(fixture.url)).toBe(false)
		expect(fixture.emitter.destroyed).toBe(true)
	})

	it('destroys idempotently before start, and never rejects', async () => {
		const fixture = new OllamaFixture(DAEMON_FIXTURE_OPTIONS)
		const first = fixture.destroy()
		const second = fixture.destroy()
		expect(second).toBe(first)
		await expect(first).resolves.toBeUndefined()
		expect(fixture.emitter.destroyed).toBe(true)
		await expect(fixture.start()).rejects.toMatchObject({ code: 'state' })
	})

	it('aborts every held callback signal and cancels each held body before it destroys the emitter, and frees the port', async () => {
		const aborted = createRecorder<readonly [path: string, destroyed: boolean, code: unknown]>()
		const cancelled = createRecorder<readonly [path: string]>()
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			reply: (request, signal) => {
				signal.addEventListener('abort', () => {
					aborted.handler(
						request.path,
						fixture.emitter.destroyed,
						isOllamaError(signal.reason) ? signal.reason.code : undefined,
					)
				})
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel: () => {
							cancelled.handler(request.path)
						},
					}),
				)
			},
		})
		const { url } = fixture
		const held = ['/api/version', '/api/tags'].map((path) =>
			fetch(`${url}${path}`).then(
				() => 'answered',
				(error: unknown) => (error instanceof Error ? error.message : 'refused'),
			),
		)
		await waitForCondition(
			'both held requests to reach the callback',
			() => fixture.requests.length === 2,
		)

		const first = fixture.destroy()
		const second = fixture.destroy()

		expect(second).toBe(first)
		await expect(first).resolves.toBeUndefined()
		expect(await Promise.all(held)).toEqual(['fetch failed', 'fetch failed'])
		expect(aborted.calls.toSorted()).toEqual([
			['/api/tags', false, 'state'],
			['/api/version', false, 'state'],
		])
		expect(cancelled.calls.toSorted()).toEqual([['/api/tags'], ['/api/version']])
		expect(fixture.emitter.destroyed).toBe(true)
		expect(await readListening(url)).toBe(false)
	})

	it('writes nothing and emits no error for a callback that settles after destroy', async () => {
		const gate = Promise.withResolvers<void>()
		const cancelled = createRecorder<readonly []>()
		const errors = createRecorder<readonly [error: unknown]>()
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			on: { error: errors.handler },
			reply: async () => {
				await gate.promise
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel: () => {
							cancelled.handler()
						},
					}),
				)
			},
		})
		const pending = fetch(`${fixture.url}/api/version`).then(
			() => 'answered',
			() => 'refused',
		)
		await waitForCondition('the request to reach the callback', () => fixture.requests.length === 1)

		await fixture.destroy()
		gate.resolve()

		expect(await pending).toBe('refused')
		await waitForCondition('the late reply to be cancelled', () => cancelled.calls.length === 1)
		expect(errors.calls).toEqual([])
	})
})

describe('OllamaFixture reply order', () => {
	it('hands every request to the callback first, after appending it to the log and emitting request', async () => {
		const order = createRecorder<readonly [step: string, path: string, logged: boolean]>()
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			on: {
				request: (request) => {
					order.handler('event', request.path, fixture.requests.at(-1) === request)
				},
			},
			reply: (request) => {
				order.handler('reply', request.path, fixture.requests.at(-1) === request)
				if (request.path === '/api/version') return Response.json({ version: 'scripted' })
				if (request.path === '/api/tags') return Response.json({ models: [] })
				if (request.path === '/api/show') return new Response(WIDE_SHOW)
				if (request.path === '/api/generate') return Response.json({ scripted: true })
				if (request.path === '/api/chat')
					return new Response(buildOllamaReply({ content: 'scripted' }))
				return undefined
			},
		})
		try {
			const show = { method: 'POST', body: JSON.stringify({ model: DAEMON_MODEL.name }) }
			const unload = JSON.stringify({ model: DAEMON_MODEL.name, keep_alive: 0 })
			const texts = [
				await (await fetch(`${fixture.url}/api/version`)).text(),
				await (await fetch(`${fixture.url}/api/tags`)).text(),
				await (await fetch(`${fixture.url}/api/show`, show)).text(),
				await (await fetch(`${fixture.url}/api/generate`, { method: 'POST', body: unload })).text(),
				await (await fetch(`${fixture.url}/api/chat`, { method: 'POST', body: '{}' })).text(),
			]

			expect(texts).toEqual([
				'{"version":"scripted"}',
				'{"models":[]}',
				WIDE_SHOW,
				'{"scripted":true}',
				'{"message":{"role":"assistant","content":"scripted"},"done":true,"done_reason":"stop"}\n',
			])
			expect(order.calls).toEqual(
				['/api/version', '/api/tags', '/api/show', '/api/generate', '/api/chat'].flatMap((path) => [
					['event', path, true],
					['reply', path, true],
				]),
			)
		} finally {
			await fixture.destroy()
		}
	})

	it('answers each request the callback declines with its own answer, and hands a path Ollama does not serve to the callback', async () => {
		const seen = createRecorder<readonly [path: string]>()
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			reply: (request) => {
				seen.handler(request.path)
				return request.path === '/v1/systemone' ? Response.json({ answers: {} }) : undefined
			},
		})
		try {
			const version = await fetch(`${fixture.url}/api/version`)
			const triage = await fetch(`${fixture.url}/v1/systemone`, { method: 'POST', body: '{}' })

			expect([version.status, await version.text()]).toEqual([200, '{"version":"0.40.8"}'])
			expect([triage.status, await triage.text()]).toEqual([200, '{"answers":{}}'])
			expect(seen.calls).toEqual([['/api/version'], ['/v1/systemone']])
		} finally {
			await fixture.destroy()
		}
	})

	it("serves a head-of-line script first, then its own answers, to Ollama's provider and judge", async () => {
		const fixture = await createDaemonFixture({
			models: FIXTURE_MODELS,
			policy: new DaemonPolicy({
				script: [
					{ path: '/api/show', chunks: [WIDE_SHOW] },
					{
						path: '/api/chat',
						chunks: [
							buildOllamaReply({
								model: FIXTURE_MODEL,
								parts: ['Re', 'ceipt'],
								counts: { prompt: 7, decode: 2 },
							}),
						],
					},
					{ path: '/api/chat', chunks: [chunked.slice(0, 24), chunked.slice(24)] },
				],
				answers: [
					{ path: '/api/generate', chunks: [readout] },
					{ path: '/v1/systemone', chunks: ['{"answers":{"accept":0.9}}'] },
				],
			}),
		})
		try {
			const show = { method: 'POST', body: JSON.stringify({ model: FIXTURE_MODEL }) }
			const version = await (await fetch(`${fixture.url}/api/version`)).json()
			const widened = await (await fetch(`${fixture.url}/api/show`, show)).json()
			const provider = createOllama({ model: FIXTURE_MODEL, url: fixture.url })
			const signal = new AbortController().signal
			const streamed = await provider.generate([createUserMessage('Count the orders')], signal)
			const piecewise = await provider.generate([createUserMessage('Count the orders')], signal)
			const ordinary = await (await fetch(`${fixture.url}/api/show`, show)).json()
			const judged = await createOllamaJudge({
				model: FIXTURE_JUDGE,
				system: MICA_SYSTEM,
				url: fixture.url,
			}).ask(JUDGE_NOUL_REQUEST, signal)
			const triage = await (
				await fetch(`${fixture.url}/v1/systemone`, { method: 'POST', body: '{}' })
			).text()

			// The script widens only the first `/api/show` reply; the later one is the fixture's own.
			expect(version).toEqual({ version: DAEMON_VERSION })
			expect(widened).toEqual(JSON.parse(WIDE_SHOW))
			expect(ordinary).toEqual({
				model_info: { 'general.architecture': 'fixture', 'fixture.context_length': DAEMON_CONTEXT },
			})
			expect([streamed.content, piecewise.content]).toEqual(['Receipt', 'Chunked'])
			expect(streamed.usage).toEqual({ prompt: 7, completion: 2, total: 9 })
			expect(judged.usage).toEqual({ prompt: 10, completion: 1, total: 11 })
			expect(Object.keys(judged.answers)).toEqual(['deletion'])
			expect(triage).toBe('{"answers":{"accept":0.9}}')
			expect(fixture.requests.filter(({ path }) => path === '/v1/systemone')).toHaveLength(1)
		} finally {
			await fixture.destroy()
		}
	})

	it("serves standing answers while the script's head names another path, then the chat answer once the script drains", async () => {
		const fixture = await createDaemonFixture({
			models: FIXTURE_MODELS,
			policy: new DaemonPolicy({
				script: [
					{
						path: '/api/chat',
						chunks: [buildOllamaReply({ model: FIXTURE_MODEL, parts: ['Scri', 'pted'] })],
					},
					{ path: '/api/chat', chunks: [chunked.slice(0, 24), chunked.slice(24)] },
				],
				answers: [
					{ path: '/api/show', chunks: [WIDE_SHOW] },
					{ path: '/api/generate', chunks: [readout] },
				],
			}),
		})
		try {
			const show = { method: 'POST', body: JSON.stringify({ model: FIXTURE_MODEL }) }
			const provider = createOllama({ model: FIXTURE_MODEL, url: fixture.url })
			const signal = new AbortController().signal
			const before = await (await fetch(`${fixture.url}/api/show`, show)).json()
			const contents = [
				(await provider.generate([createUserMessage('Count the orders')], signal)).content,
				(await provider.generate([createUserMessage('Count the orders')], signal)).content,
				(await provider.generate([createUserMessage('Count the orders')], signal)).content,
			]
			const after = await (await fetch(`${fixture.url}/api/show`, show)).json()
			const judged = await createOllamaJudge({
				model: FIXTURE_JUDGE,
				system: MICA_SYSTEM,
				url: fixture.url,
			}).ask(JUDGE_NOUL_REQUEST, signal)
			// The policy declines the triage path, so the fixture's refusal of an unowned path arrives.
			const triage = await fetch(`${fixture.url}/v1/systemone`, { method: 'POST', body: '{}' })

			expect([before, after]).toEqual([JSON.parse(WIDE_SHOW), JSON.parse(WIDE_SHOW)])
			expect(contents).toEqual(['Scripted', 'Chunked', FIXTURE_CONTENT])
			expect(judged.usage).toEqual({ prompt: 10, completion: 1, total: 11 })
			expect(triage.status).toBe(404)
			expect(fixture.requests.filter(({ path }) => path === '/v1/systemone')).toHaveLength(1)
		} finally {
			await fixture.destroy()
		}
	})
})

describe('OllamaFixture own answers', () => {
	it('answers its route table itself when no callback is given, and logs each request in arrival order', async () => {
		const fixture = await createOllamaFixture(DAEMON_FIXTURE_OPTIONS)
		try {
			const received: Array<{
				readonly label: string
				readonly status: number
				readonly text: string
			}> = []
			for (const row of FIXTURE_ROUTE_CASES) {
				const response = await fetch(`${fixture.url}${row.path}`, {
					method: row.method,
					...(row.method === 'GET' ? {} : { body: row.body }),
				})
				received.push({ label: row.label, status: response.status, text: await response.text() })
			}

			expect(received).toEqual(
				FIXTURE_ROUTE_CASES.map((row) => ({
					label: row.label,
					status: row.status,
					text: row.text,
				})),
			)
			expect(fixture.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual(
				FIXTURE_ROUTE_CASES.map(({ method, path, body }) => ({ method, path, body })),
			)
		} finally {
			await fixture.destroy()
		}
	})

	it("answers the daemon's own metadata readers and confirms an unload with no prompt", async () => {
		const fixture = await createOllamaFixture(DAEMON_FIXTURE_OPTIONS)
		try {
			const version = await readOllamaReply(fixture.url, '/api/version')
			const tags = await readOllamaReply(fixture.url, '/api/tags')
			const request = retainOllamaBytes(
				Buffer.from(JSON.stringify({ model: DAEMON_MODEL.name, keep_alive: 0 })),
				true,
			)
			const unload = await readOllamaReply(fixture.url, '/api/generate', {}, undefined, request)
			const listing = tags.response
			if (version.response === undefined || listing === undefined)
				throw new Error('Missing metadata response')
			if (unload.response === undefined) throw new Error('Missing unload response')

			expect([version.error, tags.error, unload.error]).toEqual([undefined, undefined, undefined])
			expect(readOllamaVersion(readOllamaJSON(version.response))).toBe(DAEMON_VERSION)
			expect(() => verifyOllamaModels(readOllamaJSON(listing), [DAEMON_MODEL])).not.toThrow()
			expect(readOllamaTerminal(unload.response, DAEMON_MODEL)).toMatchObject({ invalid: [] })
			expect(fixture.requests.at(-1)?.body).toBe('{"model":"fixture:雪","keep_alive":0}')
		} finally {
			await fixture.destroy()
		}
	})

	it('records the method, path, every header, and the whole body of a request, frozen, and hands out copies of its log', async () => {
		const fixture = await createOllamaFixture(DAEMON_FIXTURE_OPTIONS)
		try {
			const before = fixture.requests
			await fetch(`${fixture.url}/api/show`, {
				method: 'POST',
				headers: { 'x-trace': 'record-case', 'content-type': 'application/json' },
				body: '{"model":"fixture:雪"}',
			})
			const [record] = fixture.requests

			expect(before).toEqual([])
			expect(record).toMatchObject({
				method: 'POST',
				path: '/api/show',
				headers: { 'x-trace': 'record-case', 'content-type': 'application/json' },
				body: '{"model":"fixture:雪"}',
			})
			expect(Object.isFrozen(record)).toBe(true)
			expect(Object.isFrozen(record?.headers)).toBe(true)
			expect(fixture.requests).not.toBe(fixture.requests)
			expect(Object.isFrozen(fixture.requests)).toBe(true)
		} finally {
			await fixture.destroy()
		}
	})
})

describe('OllamaFixture verbatim replies', () => {
	it('writes a callback Response verbatim and streams each chunk before the next one exists', async () => {
		const controllers = createRecorder<readonly [ReadableStreamDefaultController<Uint8Array>]>()
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			reply: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start: (controller) => {
							controllers.handler(controller)
							controller.enqueue(new TextEncoder().encode('alpha'))
						},
					}),
					{ status: 207, headers: { 'x-trace': 'verbatim', 'content-type': 'text/plain' } },
				),
		})
		try {
			const response = await fetch(`${fixture.url}/api/chat`, { method: 'POST', body: '{}' })
			const reader = response.body?.getReader()
			if (reader === undefined) throw new Error('Missing streamed body')
			const first = await reader.read()
			const [controller] = controllers.calls[0] ?? []
			if (controller === undefined) throw new Error('Missing body controller')
			controller.enqueue(new TextEncoder().encode('beta'))
			controller.close()
			const second = await reader.read()
			const end = await reader.read()

			expect(response.status).toBe(207)
			expect(response.headers.get('x-trace')).toBe('verbatim')
			expect(response.headers.get('content-type')).toBe('text/plain')
			expect(new TextDecoder().decode(first.value)).toBe('alpha')
			expect(new TextDecoder().decode(second.value)).toBe('beta')
			expect(end.done).toBe(true)
		} finally {
			await fixture.destroy()
		}
	})

	it('destroys the connection before the head when the body errors before its first chunk, and keeps serving', async () => {
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			reply: (request) =>
				request.path === '/api/chat'
					? new Response(
							new ReadableStream<Uint8Array>({
								start: (controller) => {
									controller.error(new Error('reset'))
								},
							}),
						)
					: undefined,
		})
		try {
			await expect(
				fetch(`${fixture.url}/api/chat`, { method: 'POST', body: '{}' }),
			).rejects.toThrow('fetch failed')
			expect((await fetch(`${fixture.url}/api/version`)).status).toBe(200)
		} finally {
			await fixture.destroy()
		}
	})

	it('destroys the connection after the head when the body errors after a chunk', async () => {
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			reply: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start: (controller) => {
							controller.enqueue(new TextEncoder().encode('partial'))
						},
						// The fixture asks for the next chunk only after it wrote the first.
						pull: (controller) => {
							controller.error(new Error('reset'))
						},
					}),
				),
		})
		try {
			const response = await fetch(`${fixture.url}/api/chat`, { method: 'POST', body: '{}' })

			expect(response.status).toBe(200)
			await expect(response.text()).rejects.toThrow(Error)
		} finally {
			await fixture.destroy()
		}
	})

	it('releases a held body when the client disconnects, aborting the callback signal', async () => {
		const aborted = createRecorder<readonly [code: unknown]>()
		const cancelled = createRecorder<readonly []>()
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			reply: (_request, signal) => {
				signal.addEventListener('abort', () => {
					aborted.handler(isOllamaError(signal.reason) ? signal.reason.code : undefined)
				})
				return new Response(
					new ReadableStream<Uint8Array>({
						start: (controller) => {
							controller.enqueue(new TextEncoder().encode('held'))
						},
						cancel: () => {
							cancelled.handler()
						},
					}),
				)
			},
		})
		const client = new AbortController()
		try {
			const response = await fetch(`${fixture.url}/api/chat`, {
				method: 'POST',
				body: '{}',
				signal: client.signal,
			})
			const reader = response.body?.getReader()
			if (reader === undefined) throw new Error('Missing held body')
			expect(new TextDecoder().decode((await reader.read()).value)).toBe('held')

			client.abort()

			await waitForCondition('the held body to be cancelled', () => cancelled.calls.length === 1)
			expect(aborted.calls).toEqual([['aborted']])
			expect(fixture.emitter.destroyed).toBe(false)
			expect((await fetch(`${fixture.url}/api/version`)).status).toBe(200)
		} finally {
			await fixture.destroy()
		}
	})

	it('answers a throwing callback with 500 carrying its message and an error event, and keeps serving', async () => {
		const errors = createRecorder<readonly [error: unknown]>()
		const fault = new Error('the policy broke')
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			on: { error: errors.handler },
			reply: (request) => {
				if (request.path === '/api/chat') throw fault
				if (request.path === '/api/show') return Promise.reject('a bare refusal')
				return undefined
			},
		})
		try {
			const chat = await fetch(`${fixture.url}/api/chat`, { method: 'POST', body: '{}' })
			const show = await fetch(`${fixture.url}/api/show`, { method: 'POST', body: '{}' })
			const version = await fetch(`${fixture.url}/api/version`)

			expect([chat.status, await chat.text()]).toEqual([500, '{"error":"the policy broke"}'])
			expect([show.status, await show.json()]).toEqual([
				500,
				{ error: expect.stringContaining('a bare refusal') },
			])
			expect(errors.calls).toEqual([[fault], ['a bare refusal']])
			expect([version.status, await version.text()]).toEqual([200, '{"version":"0.40.8"}'])
		} finally {
			await fixture.destroy()
		}
	})

	it('logs a request and hands it to the callback only after its whole body arrives, across a split character', async () => {
		const bodies = createRecorder<readonly [request: OllamaFixtureRequest]>()
		const fixture = await createOllamaFixture({
			...DAEMON_FIXTURE_OPTIONS,
			reply: (request) => {
				bodies.handler(request)
				return undefined
			},
		})
		const outgoing = openRequest(`${fixture.url}/api/show`, { method: 'POST' })
		try {
			const bytes = Buffer.from('{"model":"fixture:雪"}')
			outgoing.on('response', (incoming) => {
				incoming.resume()
			})
			// Byte 19 falls inside the three bytes of the last character.
			outgoing.write(bytes.subarray(0, 19))
			await waitForDelay(50)

			expect(fixture.requests).toEqual([])
			expect(bodies.calls).toEqual([])

			outgoing.end(bytes.subarray(19))
			await waitForCondition(
				'the whole body to reach the callback',
				() => bodies.calls.length === 1,
			)

			expect(bodies.calls.map(([record]) => record.body)).toEqual(['{"model":"fixture:雪"}'])
			expect(fixture.requests.map(({ body }) => body)).toEqual(['{"model":"fixture:雪"}'])
		} finally {
			outgoing.destroy()
			await fixture.destroy()
		}
	})
})
