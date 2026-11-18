import type { OllamaFixtureRequest } from '@src/server'
import { createHash } from 'node:crypto'
import { isArray, isRecord, parseJSON, parseJSONAs } from '@orkestrel/contract'
import { createRecorder } from '@orkestrel/test'
import { createOllama, createOllamaJudge, extractTiming, extractTopLogprobs } from '@src/core'
import {
	buildOllamaAnswer,
	buildOllamaEnvironment,
	buildOllamaInventory,
	buildOllamaReadout,
	buildOllamaReply,
	buildOllamaTiming,
	matchesOllamaAnnouncement,
	readOllamaReply,
	readOllamaBody,
	readOllamaJSON,
	readOllamaTerminal,
	readOllamaVersion,
	retainOllamaBytes,
	verifyOllamaModels,
	isOllamaModel,
} from '@src/server'
import { createUserMessage } from '../../setup.js'
import {
	createDaemonFixture,
	createRechunkingTransport,
	DAEMON_FIXTURE_OPTIONS,
	DAEMON_INVENTORY,
	DAEMON_MODEL,
	DAEMON_NEXT_VERSION,
	DAEMON_UNLOAD_REPLY,
	DAEMON_VERSION,
	DaemonPolicy,
	FIXTURE_ROUTE_CASES,
	JUDGE_NOUL_REQUEST,
	METADATA_FAULTS,
	MICA_SYSTEM,
	runWithFetch,
} from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('daemon protocol helpers', () => {
	it('keeps byte bounds exact across a collaborator that splits Unicode into single bytes', async () => {
		const fixture = await createDaemonFixture()
		const requests = createRecorder<readonly [Request]>()
		const transport = createRechunkingTransport(globalThis.fetch.bind(globalThis), requests.handler)
		const body = Buffer.from(DAEMON_UNLOAD_REPLY)
		const request = retainOllamaBytes(Buffer.from('{"model":"fixture:雪","keep_alive":0}'), true)
		try {
			await runWithFetch(
				() => Promise.reject(new Error('global fetch reached despite collaborator')),
				async () => {
					const exact = await readOllamaReply(
						fixture.url,
						'/api/generate',
						{ bytes: body.byteLength },
						undefined,
						request,
						transport,
					)
					expect(exact.error).toBeUndefined()
					expect(exact.status).toBe(200)
					expect(exact.response).toEqual({
						content: body.toString('base64'),
						size: body.byteLength,
						digest: createHash('sha256').update(body).digest('hex'),
						complete: true,
					})
					const limit = body.indexOf(Buffer.from('雪')) + 1
					const partial = await readOllamaReply(
						fixture.url,
						'/api/generate',
						{ bytes: limit },
						undefined,
						request,
						transport,
					)
					expect(partial.error).toMatchObject({ code: 'metadata' })
					expect(partial.status).toBe(200)
					expect(partial.response).toEqual({
						content: body.subarray(0, limit).toString('base64'),
						size: limit,
						digest: createHash('sha256').update(body.subarray(0, limit)).digest('hex'),
						complete: false,
					})
					expect(requests.calls.map(([record]) => [record.url, record.method])).toEqual([
						[`${fixture.url}/api/generate`, 'POST'],
						[`${fixture.url}/api/generate`, 'POST'],
					])
					expect(fixture.requests.map(({ path, body: sent }) => ({ path, body: sent }))).toEqual([
						{ path: '/api/generate', body: '{"model":"fixture:雪","keep_alive":0}' },
						{ path: '/api/generate', body: '{"model":"fixture:雪","keep_alive":0}' },
					])
				},
			)
		} finally {
			await fixture.destroy()
		}
	})

	it('refuses an absent announcement even when the candidate origin is malformed', () => {
		expect(matchesOllamaAnnouncement('no listener announcement', 'not-an-origin')).toBe(false)
	})
	it('folds inherited and caller environment names before applying the dedicated values', () => {
		const parent = {
			Ollama_Host: 'parent',
			OLLAMA_MODELS: 'parent-store',
			REMAINS: 'kept',
			REMOVE: 'removed',
		}
		const caller = { ollama_HOST: 'caller', ollama_models: 'caller-store', REMOVE: undefined }
		const environment = buildOllamaEnvironment(parent, caller, 'http://127.0.0.1:31111', '/models')
		expect(environment).toEqual({
			REMAINS: 'kept',
			OLLAMA_HOST: '127.0.0.1:31111',
			OLLAMA_MODELS: '/models',
		})
		expect(buildOllamaEnvironment(parent, caller, 'http://127.0.0.1:31111')).toEqual({
			REMAINS: 'kept',
			ollama_models: 'caller-store',
			OLLAMA_HOST: '127.0.0.1:31111',
		})
		expect(parent.Ollama_Host).toBe('parent')
		expect(caller.ollama_HOST).toBe('caller')
	})

	it('requires an exact loopback port in the owned listen announcement with surrounding fields', () => {
		expect(
			matchesOllamaAnnouncement(
				'time=now level=INFO msg="Listening on 127.0.0.1:31111 (version 0.40.8)"',
				'http://127.0.0.1:31111',
			),
		).toBe(true)
		expect(
			matchesOllamaAnnouncement(
				'Listening on 127.0.0.1:311110 (version 0.40.8)',
				'http://127.0.0.1:31111',
			),
		).toBe(false)
		expect(
			matchesOllamaAnnouncement(
				'Listening on 0.0.0.0:31111 (version 0.40.8)',
				'http://127.0.0.1:31111',
			),
		).toBe(false)
		expect(
			matchesOllamaAnnouncement('a reply without a listen line', 'http://127.0.0.1:31111'),
		).toBe(false)
	})

	it('retains exact Unicode CRLF bytes with an independent digest and immutable receipt', () => {
		const bytes = Buffer.from('雪\r\n🌲\n')
		const retained = retainOllamaBytes(bytes, false)
		expect(Buffer.from(retained.content, 'base64')).toEqual(bytes)
		expect(retained.size).toBe(bytes.byteLength)
		expect(retained.digest).toBe(createHash('sha256').update(bytes).digest('hex'))
		expect(retained.complete).toBe(false)
		expect(Object.isFrozen(retained)).toBe(true)
	})

	it('reads whatever version a reply reports and refuses a reply that reports none', () => {
		expect(readOllamaVersion({ version: DAEMON_VERSION })).toBe(DAEMON_VERSION)
		expect(readOllamaVersion({ version: DAEMON_NEXT_VERSION, other: true })).toBe(
			DAEMON_NEXT_VERSION,
		)
		for (const value of [{}, { version: '' }, { version: 42 }, null, 'text', [DAEMON_VERSION]])
			expect(() => readOllamaVersion(value)).toThrow(expect.objectContaining({ code: 'metadata' }))
	})

	it('accepts only every exact model digest', () => {
		expect(() => verifyOllamaModels({ models: [DAEMON_MODEL] }, [DAEMON_MODEL])).not.toThrow()
		expect(() =>
			verifyOllamaModels({ models: [{ ...DAEMON_MODEL, digest: 'other' }] }, [DAEMON_MODEL]),
		).toThrow(expect.objectContaining({ code: 'model' }))
		expect(() => verifyOllamaModels({ models: [] }, [DAEMON_MODEL])).toThrow(
			expect.objectContaining({ code: 'model' }),
		)
		expect(() => verifyOllamaModels({ models: [{ name: 7 }] }, [DAEMON_MODEL])).toThrow(
			expect.objectContaining({ code: 'metadata' }),
		)
	})

	// The reply is foreign and a declaration is owned, so one entry must pass the reader and refuse the guard.
	it('reads only the name and digest of a real inventory, and leaves the declaration guard exact', () => {
		const inventory = parseJSON(
			buildOllamaInventory([
				{ name: 'undeclared:latest', digest: 'undeclared-digest' },
				DAEMON_MODEL,
			]),
		)
		const entries = isRecord(inventory) && isArray(inventory.models) ? inventory.models : []

		expect(() => verifyOllamaModels(inventory, [DAEMON_MODEL])).not.toThrow()
		expect(entries).toHaveLength(2)
		expect(entries[1]).toMatchObject(DAEMON_MODEL)
		expect(isOllamaModel(entries[1])).toBe(false)
	})

	it('still compares a real inventory entry, and refuses one whose two read fields are malformed', () => {
		expect(() =>
			verifyOllamaModels(parseJSON(buildOllamaInventory([{ ...DAEMON_MODEL, digest: 'other' }])), [
				DAEMON_MODEL,
			]),
		).toThrow(expect.objectContaining({ code: 'model' }))
		for (const entry of [
			{ name: DAEMON_MODEL.name, size: 7 },
			{ digest: DAEMON_MODEL.digest, size: 7 },
			{ ...DAEMON_MODEL, digest: 7 },
			'fixture',
		]) {
			expect(() => verifyOllamaModels({ models: [entry] }, [DAEMON_MODEL])).toThrow(
				expect.objectContaining({ code: 'metadata' }),
			)
		}
	})

	it('accepts a version reply delayed past 1500 ms within the declared bound', async () => {
		const fixture = await createDaemonFixture({ policy: new DaemonPolicy({ delay: 1550 }) })
		try {
			const reply = await readOllamaReply(fixture.url, '/api/version', { timeout: 5000 })
			expect(reply.error).toBeUndefined()
			expect(reply.status).toBe(200)
			expect(reply.response?.complete).toBe(true)
			expect(fixture.requests.map((request) => request.path)).toEqual(['/api/version'])
		} finally {
			await fixture.destroy()
		}
	}, 10_000)

	it.each(METADATA_FAULTS)(
		'refuses the metadata %s fault without issuing a model request',
		async (fault) => {
			const fixture = await createDaemonFixture({ policy: new DaemonPolicy({ fault }) })
			try {
				const reply = await readOllamaReply(fixture.url, '/api/version', {
					timeout: 150,
					bytes: 256,
				})
				expect(reply.error).toEqual(expect.objectContaining({ code: 'metadata' }))
				expect(fixture.requests.map((request) => request.path)).toEqual(['/api/version'])
				expect(fault !== 'oversized' || reply.response?.size === 256).toBe(true)
				expect(fault !== 'oversized' || reply.response?.complete === false).toBe(true)
			} finally {
				await fixture.destroy()
			}
		},
	)

	it('sends only the declared unload body and retains both bodies before validating its model', async () => {
		const fixture = await createDaemonFixture({
			policy: new DaemonPolicy({ unload: 'another-model' }),
		})
		try {
			const request = retainOllamaBytes(
				Buffer.from(JSON.stringify({ model: DAEMON_MODEL.name, keep_alive: 0 })),
				true,
			)
			const reply = await readOllamaReply(fixture.url, '/api/generate', {}, undefined, request)
			expect(fixture.requests.map(({ path, body }) => ({ path, body }))).toEqual([
				{ path: '/api/generate', body: Buffer.from(request.content, 'base64').toString() },
			])
			expect(reply.response).toBeDefined()
			const response = reply.response
			if (response === undefined) throw new Error('Missing retained response')
			expect(() => readOllamaTerminal(response, DAEMON_MODEL)).toThrow(
				expect.objectContaining({ code: 'unload' }),
			)
			expect(response.digest).toBe(
				createHash('sha256').update(Buffer.from(response.content, 'base64')).digest('hex'),
			)
		} finally {
			await fixture.destroy()
		}
	})

	it('validates a complete terminal model reply before exposing its timing', () => {
		const bytes = retainOllamaBytes(
			Buffer.from(`${JSON.stringify({ model: DAEMON_MODEL.name, done: true, eval_count: 0 })}\r\n`),
			true,
		)
		expect(readOllamaTerminal(bytes, DAEMON_MODEL)?.counts.decode).toBe(0)
		expect(() => readOllamaTerminal({ ...bytes, complete: false }, DAEMON_MODEL)).toThrow(
			'Unload reply',
		)
		expect(() =>
			readOllamaTerminal(retainOllamaBytes(Buffer.from('{"done":false}'), true), DAEMON_MODEL),
		).toThrow('Unload reply')
	})

	it('accepts complete metadata JSON and refuses missing, malformed, or incomplete records', () => {
		expect(
			readOllamaJSON(retainOllamaBytes(Buffer.from(' {"version":"0.40.8"}\r\n'), true)),
		).toEqual({ version: '0.40.8' })
		expect(() => readOllamaJSON(retainOllamaBytes(Buffer.from('[]'), true))).toThrow(
			'Incomplete or malformed',
		)
		expect(() => readOllamaJSON(retainOllamaBytes(Buffer.from('{'), true))).toThrow(
			'Incomplete or malformed',
		)
		expect(() => readOllamaJSON(retainOllamaBytes(Buffer.from('{}'), false))).toThrow(
			'Incomplete or malformed',
		)
	})

	it('retains the response observation when cancellation interrupts an open body', async () => {
		const fixture = await createDaemonFixture({ policy: new DaemonPolicy({ fault: 'partial' }) })
		const controller = new AbortController()
		const received = createRecorder<readonly [OllamaFixtureRequest]>()
		try {
			fixture.emitter.once('request', received.handler)
			const response = await fetch(`${fixture.url}/api/version`, { signal: controller.signal })
			const pending = readOllamaBody(response, 256)
			controller.abort(new Error('cancelled'))
			const reply = await pending
			expect(reply.error).toBeDefined()
			expect(reply.response?.complete).toBe(false)
			expect(received.calls).toEqual([[expect.objectContaining({ path: '/api/version' })]])
		} finally {
			controller.abort()
			await fixture.destroy()
		}
	})
})

describe('fixture wire builders', () => {
	it('maps each timing member onto its wire field and leaves every unset member out', () => {
		expect(
			buildOllamaTiming(
				{ total: 4, load: 5, prompt: 6, decode: 7 },
				{ prompt: 1, decode: 2, cached: 3 },
			),
		).toEqual({
			total_duration: 4,
			load_duration: 5,
			prompt_eval_duration: 6,
			eval_duration: 7,
			prompt_eval_count: 1,
			eval_count: 2,
			prompt_eval_cached_count: 3,
		})
		expect(buildOllamaTiming({ load: 0 }, { cached: 0 })).toEqual({
			load_duration: 0,
			prompt_eval_cached_count: 0,
		})
		expect(buildOllamaTiming()).toEqual({})
		expect(Object.isFrozen(buildOllamaTiming())).toBe(true)
	})

	it('builds one terminal row by default, and delta rows before it carrying only what a caller sets', () => {
		expect(buildOllamaReply()).toBe(
			'{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n',
		)
		expect(
			buildOllamaReply({
				model: 'fixture',
				parts: ['a', 'b'],
				content: 'c',
				thinking: 't',
				calls: [{ id: 'call-1', name: 'lookup', arguments: { query: 'x' } }],
				reason: 'length',
				counts: { prompt: 1, decode: 2, cached: 3 },
				durations: { total: 4, load: 5, prompt: 6, decode: 7 },
			}),
		).toBe(
			[
				'{"model":"fixture","message":{"role":"assistant","content":"a"},"done":false}',
				'{"model":"fixture","message":{"role":"assistant","content":"b"},"done":false}',
				'{"model":"fixture","message":{"role":"assistant","content":"c","thinking":"t","tool_calls":[{"id":"call-1","function":{"name":"lookup","arguments":{"query":"x"}}}]},"done":true,"done_reason":"length","total_duration":4,"load_duration":5,"prompt_eval_duration":6,"eval_duration":7,"prompt_eval_count":1,"eval_count":2,"prompt_eval_cached_count":3}',
				'',
			].join('\n'),
		)
	})

	it("round-trips a reply through Ollama's provider and terminal timing reader", async () => {
		const text = buildOllamaReply({
			model: 'fixture',
			parts: ['a', 'b'],
			content: 'c',
			thinking: 't',
			calls: [{ id: 'call-1', name: 'lookup', arguments: { query: 'x' } }],
			reason: 'length',
			counts: { prompt: 1, decode: 2, cached: 3 },
			durations: { total: 4, load: 5, prompt: 6, decode: 7 },
		})
		const provider = createOllama({
			model: 'fixture',
			fetch: () => Promise.resolve(new Response(text)),
		})
		const result = await provider.generate(
			[createUserMessage('Count the orders')],
			new AbortController().signal,
		)
		const terminal = parseJSONAs(
			text
				.split(/\r\n|\n/)
				.filter(Boolean)
				.at(-1) ?? '',
			isRecord,
		)

		expect(result.content).toBe('abc')
		expect(result.thinking).toBe('t')
		expect(result.tools).toEqual([{ id: 'call-1', name: 'lookup', arguments: { query: 'x' } }])
		expect(result.usage).toEqual({ prompt: 1, completion: 2, total: 3 })
		expect(result.truncated).toBe(true)
		expect(terminal === undefined ? undefined : extractTiming(terminal)).toEqual({
			durations: { total: 4, load: 5, prompt: 6, decode: 7 },
			counts: { prompt: 1, decode: 2, cached: 3 },
			invalid: [],
		})
	})

	it('leaves the model out of a reply that sets none, so a provider under any tag reads it', async () => {
		const result = await createOllama({
			model: 'any-tag',
			fetch: () => Promise.resolve(new Response(buildOllamaReply({ content: 'plain' }))),
		}).generate([createUserMessage('Count the orders')], new AbortController().signal)

		expect(result.content).toBe('plain')
		expect(result.truncated).toBeUndefined()
	})

	it('builds a one-token readout with its top list, naming the token logprob only when the list holds it', () => {
		const top = [
			{ token: 'No', logprob: -0.01 },
			{ token: 'Yes', logprob: -8 },
		]
		expect(
			buildOllamaReadout({ model: 'judge', token: 'No', top, counts: { prompt: 10, decode: 1 } }),
		).toBe(
			'{"model":"judge","response":"No","done":true,"done_reason":"length","prompt_eval_count":10,"eval_count":1,"logprobs":[{"token":"No","logprob":-0.01,"top_logprobs":[{"token":"No","logprob":-0.01},{"token":"Yes","logprob":-8}]}]}',
		)
		expect(buildOllamaReadout({ token: 'Maybe', top })).toBe(
			'{"response":"Maybe","done":true,"done_reason":"length","logprobs":[{"token":"Maybe","top_logprobs":[{"token":"No","logprob":-0.01},{"token":"Yes","logprob":-8}]}]}',
		)
	})

	it("round-trips a readout through Ollama's top-list reader and judge", async () => {
		const top = [
			{ token: 'No', logprob: -0.01 },
			{ token: 'Yes', logprob: -8 },
		]
		const text = buildOllamaReadout({
			model: 'judge',
			token: 'No',
			top,
			counts: { prompt: 10, decode: 1 },
		})
		const result = await createOllamaJudge({
			model: 'judge',
			system: MICA_SYSTEM,
			fetch: () => Promise.resolve(new Response(text)),
		}).ask(JUDGE_NOUL_REQUEST, new AbortController().signal)

		expect(extractTopLogprobs(parseJSON(text))).toEqual(top)
		expect(result.answers.deletion).toMatchObject({ form: 'noul' })
		expect(result.refusals).toBeUndefined()
		expect(result.usage).toEqual({ prompt: 10, completion: 1, total: 11 })
	})

	it('builds a listing as a real daemon sends it, and an empty one for no models', () => {
		expect(buildOllamaInventory([DAEMON_MODEL])).toBe(DAEMON_INVENTORY)
		expect(buildOllamaInventory([])).toBe('{"models":[]}')
		expect(() =>
			verifyOllamaModels(
				readOllamaJSON(retainOllamaBytes(Buffer.from(buildOllamaInventory([DAEMON_MODEL])), true)),
				[DAEMON_MODEL],
			),
		).not.toThrow()
	})

	it.each(FIXTURE_ROUTE_CASES)(
		'answers $label with its route-table status and body',
		async (row) => {
			const request: OllamaFixtureRequest = {
				method: row.method,
				path: row.path,
				headers: {},
				body: row.body,
			}
			const answer = buildOllamaAnswer(request, DAEMON_FIXTURE_OPTIONS)

			expect([answer.status, await answer.text()]).toEqual([row.status, row.text])
			expect(answer.headers.get('content-type')).toBe(row.text === '' ? null : 'application/json')
		},
	)

	it("confirms a built unload through Ollama's terminal reader", async () => {
		const answer = buildOllamaAnswer(
			{
				method: 'POST',
				path: '/api/generate',
				headers: {},
				body: JSON.stringify({ model: DAEMON_MODEL.name, keep_alive: 0 }),
			},
			DAEMON_FIXTURE_OPTIONS,
		)
		const bytes = retainOllamaBytes(Buffer.from(await answer.arrayBuffer()), true)

		expect(readOllamaTerminal(bytes, DAEMON_MODEL)).toMatchObject({ invalid: [] })
		expect(() => readOllamaTerminal(bytes, { name: 'other', digest: 'other' })).toThrow(
			expect.objectContaining({ code: 'unload' }),
		)
	})
})
