// The shared test infrastructure's own proof, over two subjects: the conversation
// padding, the throwing summarizer, the workspace seeder, the page tool definition, and
// the timer lead exported from `tests/setup.ts`, and the host-independent half of
// `tests/setupServer.ts` — its request-narrowing guards, its refusing transport, its tool
// fixtures, its agent-stream driver, and its environment readers. Each is real code the
// module, integration, and live-service suites rely on, so it is proved here rather than
// trusted. The timer lead's control runs real host timers measured on `performance.now()`,
// armed late in a loop-clock millisecond by the aligner `tests/setupServer.ts` exports.
//
// The rest of that surface is proved beside this file. `tests/setupServer.test.ts` owns
// the Node-resource half of `tests/setupServer.ts`: the recording proxy, the capture
// wait, the provider-stream driver, the wire tables that module declares, and the
// loop-clock reader and its aligner.
// `tests/setupService.test.ts` owns the hermetic half of `tests/setupService.ts`, whose
// live half the `service` project proves against a real daemon.
//
// This proof covers the workspace's fixtures rather than one module, which is why it
// sits at the tests root in its own `setup` project.

import type { AgentResult, Message } from '@orkestrel/agent'
import type { ToolResult } from '@orkestrel/tool'
import { estimateRequest } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { createRecorder, requireValue, waitForDelay } from '@orkestrel/test'
import { createWorkspace } from '@orkestrel/workspace'
import { describe, expect, it } from 'vitest'
import {
	ABSENT_ITERATORS,
	buildClosingList,
	buildFenceBody,
	buildFenceMessages,
	buildFenceObservation,
	buildIteratorlessList,
	buildRepeatedTokenCases,
	buildSparseList,
	buildTracedRecord,
	buildTurns,
	buildWatched,
	CANNED_STREAM_DELTAS,
	CANNED_STREAM_DONE,
	CASE_TIMEOUT,
	countRequestCharacters,
	createChallengeTools,
	createRecordingSummarizer,
	createThrowingSummarizer,
	createUserMessage,
	DEADLINE_MS,
	DONE_RECORD,
	estimateRequestMessages,
	extractAnchoredFence,
	FENCE_CONTROLS,
	FENCE_MODEL,
	FENCE_SCENARIOS,
	fillWorkspace,
	FILLER_SENTENCE,
	HEAVY_TIMEOUT,
	HELLO_TURN,
	GUIDE_FENCE_PROMPT,
	LONG_ANSWER_PROMPT,
	NON_ADJACENT_DUPLICATE_TOP,
	PAGE_TOOL,
	readStackDepth,
	README_FENCE_PROMPT,
	RECLASSIFIED_TURN,
	RECORDING_SUMMARIZER_DIGEST,
	recordRecursion,
	SETTLE_MS,
	SHORT_ANSWER_PROMPT,
	SHORT_OPTIONS,
	STREAM_FENCE_ANCHOR,
	STREAM_FENCE_CASES,
	THROWING_SUMMARIZER_MESSAGE,
	TINY_PNG_BASE64,
	TOOL_CONTEXT,
	TRUNCATED_INVALID_REASONS,
	TRUNCATED_STRING_REASONS,
	USAGE_FENCE_ANCHOR,
} from './setup.js'
import {
	buildRecordedRequest,
	createInsatiableTool,
	createScriptedAgentStream,
	createLookupTool,
	createRefusingTransport,
	createStreamingTransport,
	createThrowingTool,
	driveAgent,
	env,
	forwardHeaders,
	insatiableResult,
	isFetchAbort,
	LOOKUP_DATUM,
	parseRequestBody,
	REFUSED_TRANSPORT_MESSAGE,
	systemText,
	THROWING_TOOL_MESSAGE,
	wireMessages,
	wireText,
	wireTools,
	withScheme,
} from './setupServer.js'

describe('createChallengeTools', () => {
	it('returns the challenge without revealing the secret code', async () => {
		const [lookup, secret] = createChallengeTools('opaque-challenge', '7193')
		if (lookup === undefined || secret === undefined) throw new Error('Missing lookup tools')
		expect(lookup.name).toBe('lookup_challenge')
		expect(secret.name).toBe('lookup_secret')
		expect(secret.parameters).toEqual({
			type: 'object',
			properties: { challenge: { type: 'string' } },
			required: ['challenge'],
		})
		expect(await lookup.execute({}, TOOL_CONTEXT)).toEqual({ challenge: 'opaque-challenge' })
	})

	it('rejects missing, non-string, and incorrect challenges with TypeError', () => {
		const [, secret] = createChallengeTools('opaque-challenge', '7193')
		if (secret === undefined) throw new Error('Missing secret lookup')
		expect(() => secret.execute({}, TOOL_CONTEXT)).toThrow(TypeError)
		expect(() => secret.execute({ challenge: 7 }, TOOL_CONTEXT)).toThrow(TypeError)
		expect(() => secret.execute({ challenge: 'incorrect' }, TOOL_CONTEXT)).toThrow(TypeError)
	})

	it('reveals the code after the caller supplies the actual lookup result', async () => {
		const [lookup, secret] = createChallengeTools('opaque-challenge', '7193')
		if (lookup === undefined || secret === undefined) throw new Error('Missing lookup tools')
		const result = await lookup.execute({}, TOOL_CONTEXT)
		if (!isRecord(result)) throw new Error('Missing challenge result')
		expect(await secret.execute(result, TOOL_CONTEXT)).toEqual({ code: '7193' })
	})
})

describe('parseRequestBody', () => {
	it('returns the record for valid JSON object text', () => {
		expect(parseRequestBody('{"model":"qwen","stream":false}')).toEqual({
			model: 'qwen',
			stream: false,
		})
	})

	it('returns undefined for invalid JSON', () => {
		expect(parseRequestBody('{not valid json')).toBeUndefined()
	})

	it('returns undefined for a valid JSON array', () => {
		expect(parseRequestBody('[1,2]')).toBeUndefined()
	})

	it('returns undefined for a valid JSON string', () => {
		expect(parseRequestBody('"x"')).toBeUndefined()
	})

	it('returns undefined for a valid JSON number', () => {
		expect(parseRequestBody('42')).toBeUndefined()
	})

	it('returns undefined for JSON null', () => {
		expect(parseRequestBody('null')).toBeUndefined()
	})
})

describe('forwardHeaders', () => {
	it('drops host case-insensitively', () => {
		const headers = new Headers()
		headers.set('Host', 'localhost:11434')
		headers.set('Authorization', 'Bearer token')

		const forwarded = forwardHeaders(headers)

		expect(forwarded.has('host')).toBe(false)
		expect(forwarded.get('authorization')).toBe('Bearer token')
	})

	it('drops content-length case-insensitively', () => {
		const headers = new Headers()
		headers.set('Content-Length', '42')
		headers.set('X-Trace-Id', 'abc')

		const forwarded = forwardHeaders(headers)

		expect(forwarded.has('content-length')).toBe(false)
		expect(forwarded.get('x-trace-id')).toBe('abc')
	})

	it('preserves other entries unchanged', () => {
		const headers = new Headers()
		headers.set('Content-Type', 'application/json')

		const forwarded = forwardHeaders(headers)

		expect(forwarded.get('content-type')).toBe('application/json')
	})
})

describe('isFetchAbort', () => {
	it('returns true for the real AbortSignal.abort() reason', () => {
		const reason: unknown = AbortSignal.abort().reason
		expect(isFetchAbort(reason)).toBe(true)
	})

	it('returns true for an Error named AbortError, narrowing to Error', () => {
		const error = new Error('aborted')
		error.name = 'AbortError'
		const value: unknown = error

		expect(isFetchAbort(value)).toBe(true)
		if (!isFetchAbort(value)) throw new Error('unreachable: isFetchAbort narrowed true earlier')
		expect(value.message).toBe('aborted')
	})

	it('returns false for a plain Error', () => {
		expect(isFetchAbort(new Error('boom'))).toBe(false)
	})

	it('returns false for a string', () => {
		expect(isFetchAbort('AbortError')).toBe(false)
	})

	it('returns false for undefined', () => {
		expect(isFetchAbort(undefined)).toBe(false)
	})

	it('returns false for a plain object with a matching name field', () => {
		expect(isFetchAbort({ name: 'AbortError' })).toBe(false)
	})
})

describe('createRefusingTransport', () => {
	it('refuses every request with the shared message', async () => {
		const transport = createRefusingTransport()

		await expect(transport.fetch('http://127.0.0.1:1/api/chat')).rejects.toThrow(
			REFUSED_TRANSPORT_MESSAGE,
		)
	})

	it('records the signal each request rode, in call order', async () => {
		const transport = createRefusingTransport()
		const first = new AbortController().signal
		const second = new AbortController().signal

		await transport.fetch('http://127.0.0.1:1/api/chat', { signal: first }).catch(() => {})
		await transport.fetch('http://127.0.0.1:1/api/chat', { signal: second }).catch(() => {})

		expect(transport.signals.length).toBe(2)
		expect(transport.signals[0]).toBe(first)
		expect(transport.signals[1]).toBe(second)
	})

	it('reports a recorded signal as unaborted until it aborts', async () => {
		const transport = createRefusingTransport()
		const controller = new AbortController()
		const request = { signal: controller.signal }

		await transport.fetch('http://127.0.0.1:1/api/chat', request).catch(() => {})
		expect(transport.signals[0]?.aborted).toBe(false)

		controller.abort()
		expect(transport.signals[0]?.aborted).toBe(true)
	})

	it('records nothing when a request carries no signal', async () => {
		const transport = createRefusingTransport()

		await transport.fetch('http://127.0.0.1:1/api/chat').catch(() => {})

		expect(transport.signals.length).toBe(0)
	})
})

describe('createStreamingTransport', () => {
	it('answers with an OK response carrying the NDJSON content type', async () => {
		const transport = createStreamingTransport(['{"done":true}\n'])

		const response = await transport('http://127.0.0.1:1/api/chat')

		expect(response.ok).toBe(true)
		expect(response.headers.get('content-type')).toBe('application/x-ndjson')
	})

	it('streams every chunk verbatim, in order and unaltered', async () => {
		const transport = createStreamingTransport(['{"a":1}\n{"b":2}\n', '{"c":3}'])

		const response = await transport('http://127.0.0.1:1/api/chat')

		expect(await response.text()).toBe('{"a":1}\n{"b":2}\n{"c":3}')
	})

	it('serves an empty body when it is given no chunks', async () => {
		const transport = createStreamingTransport([])

		const response = await transport('http://127.0.0.1:1/api/chat')

		expect(await response.text()).toBe('')
	})
})

describe('buildRecordedRequest', () => {
	it('records a POST to the chat path whose text is the serialized body and whose headers are empty', () => {
		const body = { model: 'qwen', stream: false }

		expect(buildRecordedRequest(body)).toEqual({
			method: 'POST',
			path: '/api/chat',
			headers: {},
			body,
			text: '{"model":"qwen","stream":false}',
		})
	})
})

describe('wireMessages', () => {
	it('narrows a well-formed messages array', () => {
		const request = buildRecordedRequest({
			messages: [
				{ role: 'system', content: 'rules' },
				{ role: 'user', content: 'hi' },
			],
		})

		expect(wireMessages(request)).toEqual([
			{ role: 'system', content: 'rules' },
			{ role: 'user', content: 'hi' },
		])
	})

	it('preserves optional image payloads', () => {
		const request = buildRecordedRequest({
			messages: [{ role: 'user', content: 'look', images: ['base64-image'] }],
		})

		expect(wireMessages(request)).toEqual([
			{ role: 'user', content: 'look', images: ['base64-image'] },
		])
	})

	it('rejects malformed image payloads', () => {
		expect(
			wireMessages(
				buildRecordedRequest({
					messages: [{ role: 'user', content: 'look', images: [42] }],
				}),
			),
		).toEqual([])
	})

	it('returns [] when messages is absent', () => {
		expect(wireMessages(buildRecordedRequest({}))).toEqual([])
	})

	it('returns [] when messages is not an array', () => {
		expect(wireMessages(buildRecordedRequest({ messages: 'nope' }))).toEqual([])
	})

	it('returns [] when an element is malformed (missing content)', () => {
		expect(wireMessages(buildRecordedRequest({ messages: [{ role: 'user' }] }))).toEqual([])
	})

	it('returns [] when an element is not a record', () => {
		expect(wireMessages(buildRecordedRequest({ messages: ['nope'] }))).toEqual([])
	})
})

describe('wireTools', () => {
	it('returns function names from a well-formed tools array', () => {
		const request = buildRecordedRequest({
			tools: [
				{ type: 'function', function: { name: 'lookup' } },
				{ type: 'function', function: { name: 'more' } },
			],
		})

		expect(wireTools(request)).toEqual(['lookup', 'more'])
	})

	it('returns [] when tools are absent or malformed', () => {
		expect(wireTools(buildRecordedRequest({}))).toEqual([])
		expect(wireTools(buildRecordedRequest({ tools: [{ function: {} }] }))).toEqual([])
	})
})

describe('wireText', () => {
	it('joins every wire message content with a newline', () => {
		const request = buildRecordedRequest({
			messages: [
				{ role: 'system', content: 'rules' },
				{ role: 'user', content: 'hi' },
			],
		})

		expect(wireText(request)).toBe('rules\nhi')
	})

	it('returns an empty string when there are no messages', () => {
		expect(wireText(buildRecordedRequest({}))).toBe('')
	})
})

describe('systemText', () => {
	it("returns the first message's content when its role is system", () => {
		const request = buildRecordedRequest({
			messages: [
				{ role: 'system', content: 'rules' },
				{ role: 'user', content: 'hi' },
			],
		})

		expect(systemText(request)).toBe('rules')
	})

	it('returns an empty string when the first message is not a system turn', () => {
		const request = buildRecordedRequest({ messages: [{ role: 'user', content: 'hi' }] })

		expect(systemText(request)).toBe('')
	})

	it('returns an empty string when there are no messages', () => {
		expect(systemText(buildRecordedRequest({}))).toBe('')
	})
})

describe('buildTurns', () => {
	it('alternates user/assistant roles, starting with user', () => {
		const turns = buildTurns(4)

		expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
	})

	it('varies content deterministically by index', () => {
		const first = buildTurns(2)
		const second = buildTurns(2)

		expect(first.map((turn) => turn.content)).toEqual(second.map((turn) => turn.content))
		expect(first[0]?.content).not.toBe(first[1]?.content)
	})

	it('returns an empty array for count 0', () => {
		expect(buildTurns(0)).toEqual([])
	})
})

describe('countRequestCharacters', () => {
	it('sums the content length of every message', () => {
		const messages = [createUserMessage('abc'), createUserMessage('de')]

		expect(countRequestCharacters({ messages })).toBe(5)
	})

	it('counts nothing for a request without messages', () => {
		expect(countRequestCharacters({ messages: [] })).toBe(0)
	})
})

describe('estimateRequestMessages', () => {
	it('estimates the messages alone, whatever tools the request advertises', () => {
		const messages = [createUserMessage('hello')]
		const tools = [{ name: 'weather', description: 'x'.repeat(400) }]

		expect(estimateRequestMessages({ messages })).toBe(6)
		expect(estimateRequestMessages({ messages, tools })).toBe(6)
		expect(estimateRequest({ messages, tools })).toBeGreaterThan(6)
	})

	it('estimates nothing for a request without messages', () => {
		expect(estimateRequestMessages({ messages: [] })).toBe(0)
	})
})

describe('createThrowingSummarizer', () => {
	it('rejects with the default message', async () => {
		const summarizer = createThrowingSummarizer()
		await expect(summarizer([])).rejects.toThrow(THROWING_SUMMARIZER_MESSAGE)
	})

	it('rejects with a custom message', async () => {
		const summarizer = createThrowingSummarizer('custom-failure')
		await expect(summarizer([])).rejects.toThrow('custom-failure')
	})
})

describe('createRecordingSummarizer', () => {
	it('records the turns it was handed and resolves the default digest', async () => {
		const invocations = createRecorder<[readonly Message[]]>()
		const summarize = createRecordingSummarizer(invocations)
		const turns = buildTurns(2)

		expect(await summarize(turns)).toBe(RECORDING_SUMMARIZER_DIGEST)
		expect(invocations.calls).toEqual([[turns]])
	})

	it('resolves a custom digest and records nothing until it is called', async () => {
		const invocations = createRecorder<[readonly Message[]]>()
		const summarize = createRecordingSummarizer(invocations, 'custom-digest')
		const turns = buildTurns(1)

		expect(invocations.calls).toEqual([])
		expect(await summarize(turns)).toBe('custom-digest')
		expect(invocations.calls).toEqual([[turns]])
	})
})

describe('fillWorkspace', () => {
	it('writes the default count of doc-NN.md files', () => {
		const workspace = createWorkspace()
		fillWorkspace(workspace)

		const names = workspace.files().map((file) => file.path)
		expect(names).toHaveLength(12)
		expect(names).toContain('doc-01.md')
		expect(names).toContain('doc-12.md')
	})

	it('honors a custom count and approximate byte size', () => {
		const workspace = createWorkspace()
		fillWorkspace(workspace, { count: 3, bytesEach: 100 })

		const names = workspace.files().map((file) => file.path)
		expect(names).toEqual(['doc-01.md', 'doc-02.md', 'doc-03.md'])
		const file = workspace.file('doc-01.md')
		const content = file?.content
		expect(content !== undefined && 'text' in content ? content.text.length : -1).toBe(100)
	})

	it('fills each document with the exported filler sentence', () => {
		const workspace = createWorkspace()
		fillWorkspace(workspace, { count: 1, bytesEach: 200 })

		const content = workspace.file('doc-01.md')?.content
		const text = content !== undefined && 'text' in content ? content.text : ''
		expect(text.startsWith(FILLER_SENTENCE)).toBe(true)
	})

	it('writes an optional sentinel file alongside the filler docs', () => {
		const workspace = createWorkspace()
		fillWorkspace(workspace, { count: 2, sentinelPath: 'find-me.md', sentinelText: 'needle' })

		expect(workspace.files().map((file) => file.path)).toContain('find-me.md')
		const content = workspace.file('find-me.md')?.content
		expect(content !== undefined && 'text' in content ? content.text : undefined).toBe('needle')
	})
})

describe('PAGE_TOOL', () => {
	it('is frozen and declares note as its only required parameter', () => {
		expect(Object.isFrozen(PAGE_TOOL)).toBe(true)
		expect(PAGE_TOOL.name).toBe('record')
		const parameters: unknown = PAGE_TOOL.parameters
		if (!isRecord(parameters)) throw new Error('PAGE_TOOL declares no parameter schema')
		expect(parameters.type).toBe('object')
		expect(parameters.required).toEqual(['note'])
		const properties: unknown = parameters.properties
		if (!isRecord(properties)) throw new Error('PAGE_TOOL declares no parameter properties')
		expect(Object.keys(properties)).toEqual(['note'])
	})
})

describe('TRUNCATED_STRING_REASONS and TRUNCATED_INVALID_REASONS', () => {
	it('are frozen and hold no case that reads as truncation', () => {
		expect(Object.isFrozen(TRUNCATED_STRING_REASONS)).toBe(true)
		expect(Object.isFrozen(TRUNCATED_INVALID_REASONS)).toBe(true)
		expect(TRUNCATED_STRING_REASONS).not.toContain('length')
		expect(TRUNCATED_INVALID_REASONS.every(([reason]) => typeof reason !== 'string')).toBe(true)
	})
})

describe('CANNED_STREAM_DELTAS and CANNED_STREAM_DONE', () => {
	it('are frozen NDJSON lines that stream content deltas and end in one stop record with usage', () => {
		expect(Object.isFrozen(CANNED_STREAM_DELTAS)).toBe(true)
		const parser = createNDJSONParser()

		const deltas = CANNED_STREAM_DELTAS.flatMap((line) => parser.parse(line))
		const terminal = parser.parse(CANNED_STREAM_DONE)

		expect(deltas.map((record) => Reflect.get(record, 'done'))).toEqual([false, false, false])
		expect(deltas.map((record) => Reflect.get(record, 'message'))).toEqual([
			{ content: 'abcdefgh' },
			{ content: 'ijklmnop' },
			{ content: 'qrstuvwx' },
		])
		expect(terminal).toEqual([
			{ done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 9 },
		])
	})
})

describe('readStackDepth and recordRecursion', () => {
	it('read a deeper stack at each frame of a recursion, and the same stack at each pass of a loop', () => {
		const depths = createRecorder<[number]>()

		recordRecursion(5, depths.handler)
		const recursed = depths.calls.map(([depth]) => depth)
		const looped = Array.from({ length: 6 }, () => readStackDepth())

		expect(recursed).toHaveLength(6)
		expect(recursed.slice(1).map((depth, index) => depth - (recursed[index] ?? depth))).toEqual([
			1, 1, 1, 1, 1,
		])
		expect(new Set(looped).size).toBe(1)
		expect(readStackDepth()).toBeGreaterThan(1)
	})

	it('leave the engine stack-trace limit as it found it', () => {
		const limit = Error.stackTraceLimit

		readStackDepth()

		expect(Error.stackTraceLimit).toBe(limit)
	})

	it('report a single depth for a recursion asked for no further levels', () => {
		const depths = createRecorder<[number]>()
		const callerDepth = readStackDepth()

		recordRecursion(0, depths.handler)

		expect(depths.calls).toEqual([[callerDepth + 1]])
	})
})

describe('buildRepeatedTokenCases, NON_ADJACENT_DUPLICATE_TOP, and ABSENT_ITERATORS', () => {
	it('build lists whose two entries share one token the way a map key is shared', () => {
		const [notANumber, zeros, object] = buildRepeatedTokenCases()
		if (notANumber === undefined || zeros === undefined || object === undefined)
			throw new Error('Missing repeated-token case')

		expect(buildRepeatedTokenCases()).toHaveLength(3)
		expect(Number.isNaN(notANumber[0]?.token)).toBe(true)
		expect(Number.isNaN(notANumber[1]?.token)).toBe(true)
		expect(Object.is(zeros[0]?.token, 0)).toBe(true)
		expect(Object.is(zeros[1]?.token, -0)).toBe(true)
		expect(object[0]?.token).toBe(object[1]?.token)
		expect(buildRepeatedTokenCases()[2]?.[0]?.token).not.toBe(object[0]?.token)
	})

	it('hold a repeated token with another token between its occurrences, and the values an iterator must not hold', () => {
		expect(NON_ADJACENT_DUPLICATE_TOP.map((entry) => entry.token)).toEqual(['No', 'Yes', 'No'])
		expect(Object.isFrozen(NON_ADJACENT_DUPLICATE_TOP)).toBe(true)
		expect(ABSENT_ITERATORS).toEqual([undefined, null])
	})
})

describe('buildSparseList', () => {
	it('leaves a hole where a slot is undefined and keeps the length', () => {
		const list = buildSparseList(['a', undefined, 'c', undefined])
		expect(list).toHaveLength(4)
		expect(Object.keys(list)).toEqual(['0', '2'])
		expect(1 in list).toBe(false)
		expect(list[2]).toBe('c')
		expect(buildSparseList([])).toEqual([])
	})
})

describe('buildIteratorlessList', () => {
	it('keeps the entries and holds undefined as the iterator, which for…of refuses', () => {
		const list = buildIteratorlessList(['a', 'b'])
		expect(list).toHaveLength(2)
		expect(list[1]).toBe('b')
		expect(list[Symbol.iterator]).toBeUndefined()
		expect(() => {
			for (const entry of list) expect(entry).toBeDefined()
		}).toThrow(TypeError)
	})
})

describe('buildClosingList', () => {
	it('yields every entry in order and reports no close when a loop reads to the end', () => {
		const closed = createRecorder<[]>()
		const seen: string[] = []
		for (const entry of buildClosingList(['a', 'b', 'c'], closed.handler)) seen.push(entry)
		expect(seen).toEqual(['a', 'b', 'c'])
		expect(closed.calls).toEqual([])
	})

	it('reports the close once when a loop leaves early', () => {
		const closed = createRecorder<[]>()
		for (const entry of buildClosingList(['a', 'b', 'c'], closed.handler)) {
			if (entry === 'a') break
		}
		expect(closed.calls).toEqual([[]])
	})
})

describe('buildWatched', () => {
	it('reports each read of the watched property and returns the original value', () => {
		const reads = createRecorder<[]>()
		const watched = buildWatched({ role: 'user', content: 'Hello.' }, 'role', reads.handler)
		expect(reads.calls).toEqual([])
		expect(watched.content).toBe('Hello.')
		expect(reads.calls).toEqual([])
		expect(watched.role).toBe('user')
		expect(reads.calls).toEqual([[]])
		expect(watched.role).toBe('user')
		expect(reads.calls).toEqual([[], []])
	})
})

describe('buildTracedRecord', () => {
	it('reports each read of an own property by name and returns the original value', () => {
		const reads: string[] = []
		const traced = buildTracedRecord({ category: 'think', content: 'Plan.' }, (key) => {
			reads.push(key)
		})
		expect(reads).toEqual([])
		expect(traced.content).toBe('Plan.')
		expect(traced.category).toBe('think')
		expect(traced.content).toBe('Plan.')
		expect(reads).toEqual(['content', 'category', 'content'])
	})

	it('reports a spread of the copy once per property, in property order', () => {
		const reads: string[] = []
		const traced = buildTracedRecord({ a: 1, b: 2, c: 3 }, (key) => {
			reads.push(key)
		})
		expect({ ...traced }).toEqual({ a: 1, b: 2, c: 3 })
		expect(reads).toEqual(['a', 'b', 'c'])
	})
})

describe('DONE_RECORD and SHORT_OPTIONS', () => {
	it('close every canned turn with the counted record, and fix the short deterministic call', () => {
		expect(DONE_RECORD).toBe('{"done":true,"prompt_eval_count":3,"eval_count":4}\n')
		expect(HELLO_TURN.at(-1)).toBe(DONE_RECORD)
		expect(RECLASSIFIED_TURN.at(-1)).toBe(DONE_RECORD)
		expect(SHORT_OPTIONS).toEqual({ num_predict: 8, temperature: 0 })
		expect(Object.isFrozen(SHORT_OPTIONS)).toBe(true)
	})
})

describe('HELLO_TURN and RECLASSIFIED_TURN', () => {
	it('are frozen chunk lists whose records spell the marked turn and the inline-reasoning turn', () => {
		expect(Object.isFrozen(HELLO_TURN)).toBe(true)
		expect(Object.isFrozen(RECLASSIFIED_TURN)).toBe(true)
		const marked = createNDJSONParser()
		const inline = createNDJSONParser()

		expect(HELLO_TURN.flatMap((chunk) => marked.parse(chunk))).toEqual([
			{ message: { content: 'Hel' } },
			{ message: { thinking: 'weighing it' } },
			{ message: { content: 'lo' } },
			{ done: true, prompt_eval_count: 3, eval_count: 4 },
		])
		expect(RECLASSIFIED_TURN.flatMap((chunk) => inline.parse(chunk))).toEqual([
			{ message: { content: 'reasoning' } },
			{ message: { content: '</think>answer' } },
			{ done: true, prompt_eval_count: 3, eval_count: 4 },
		])
	})
})

describe('LONG_ANSWER_PROMPT and SHORT_ANSWER_PROMPT', () => {
	it('hold two distinct non-empty prompts', () => {
		expect(LONG_ANSWER_PROMPT).not.toBe('')
		expect(SHORT_ANSWER_PROMPT).not.toBe('')
		expect(LONG_ANSWER_PROMPT).not.toBe(SHORT_ANSWER_PROMPT)
	})
})

describe('CASE_TIMEOUT, DEADLINE_MS, and SETTLE_MS', () => {
	it('arm a real deadline that has fired by the time the settle wait ends', async () => {
		const deadline = AbortSignal.timeout(DEADLINE_MS)

		expect(deadline.aborted).toBe(false)
		await waitForDelay(SETTLE_MS)

		expect(deadline.aborted).toBe(true)
		expect(SETTLE_MS).toBeGreaterThan(DEADLINE_MS)
	})

	it('give a case a whole-millisecond deadline well beyond the settle wait', () => {
		expect(Number.isInteger(CASE_TIMEOUT)).toBe(true)
		expect(CASE_TIMEOUT).toBeGreaterThan(SETTLE_MS * 100)
	})

	it('give a case that retries a long generation a whole-millisecond deadline beyond an ordinary case', () => {
		expect(Number.isInteger(HEAVY_TIMEOUT)).toBe(true)
		expect(HEAVY_TIMEOUT).toBe(120_000)
		expect(HEAVY_TIMEOUT).toBeGreaterThan(CASE_TIMEOUT)
	})
})

describe('FENCE_SCENARIOS and STREAM_FENCE_CASES', () => {
	it('name the plain, reclassified, cancelled, and refused turns, each with the lines both fences log', () => {
		expect(
			STREAM_FENCE_CASES.map((scenario) => [scenario.label, scenario.cancel, scenario.status]),
		).toEqual([
			['a plain turn', false, 200],
			['a reclassified turn', false, 200],
			['a turn cancelled after its first delta', true, 200],
			['a turn the daemon refuses', false, 404],
		])
		expect(Object.values(FENCE_SCENARIOS)).toEqual(
			STREAM_FENCE_CASES.map((scenario) => scenario.label),
		)
		expect(STREAM_FENCE_CASES.map((scenario) => scenario.guide.length)).toEqual([3, 3, 1, 0])
		expect(STREAM_FENCE_CASES.map((scenario) => scenario.readme.length)).toEqual([2, 2, 0, 0])
		expect(STREAM_FENCE_CASES[0]?.chunks).toBe(HELLO_TURN)
		expect(STREAM_FENCE_CASES[1]?.chunks).toBe(RECLASSIFIED_TURN)
	})

	it('state the deltas each turn yields, the result each settles to, and the error the refused turn throws', () => {
		expect(STREAM_FENCE_CASES.map((scenario) => scenario.deltas?.length)).toEqual([
			3,
			2,
			1,
			undefined,
		])
		expect(STREAM_FENCE_CASES.map((scenario) => scenario.settled?.content)).toEqual([
			'Hello',
			'answer',
			undefined,
			undefined,
		])
		expect(STREAM_FENCE_CASES.map((scenario) => scenario.settled?.thinking)).toEqual([
			'weighing it',
			'reasoning',
			undefined,
			undefined,
		])
		expect(STREAM_FENCE_CASES.map((scenario) => scenario.thrown?.status)).toEqual([
			undefined,
			undefined,
			undefined,
			404,
		])
		expect(STREAM_FENCE_CASES[3]?.thrown).toEqual({
			name: 'ProviderError',
			message: 'provider error: 404 - {"error":"model \'qwen3.5:2b-q4_K_M\' not found"}\n',
			code: 'HTTP',
			status: 404,
		})
		expect(Object.isFrozen(STREAM_FENCE_CASES)).toBe(true)
		expect(Object.isFrozen(FENCE_SCENARIOS)).toBe(true)
	})
})

describe('buildFenceMessages, buildFenceBody, and buildFenceObservation', () => {
	it('spell the one user message a fence declares, and the whole body the provider sends for it', () => {
		expect(buildFenceMessages(GUIDE_FENCE_PROMPT)).toEqual([
			{ id: '1', role: 'user', content: 'Say hello.' },
		])
		expect(buildFenceBody(GUIDE_FENCE_PROMPT)).toEqual({
			model: 'qwen3.5:2b-q4_K_M',
			messages: [{ role: 'user', content: 'Say hello.' }],
			stream: true,
			keep_alive: '5m',
			think: false,
		})
		expect(buildFenceBody(README_FENCE_PROMPT)).not.toEqual(buildFenceBody(GUIDE_FENCE_PROMPT))
	})

	it('state what each fence must observe over a plain, a cancelled, and a refused turn', () => {
		const [plain, cancelled, refused] = [
			FENCE_SCENARIOS.plain,
			FENCE_SCENARIOS.cancelled,
			FENCE_SCENARIOS.refused,
		].map((label) =>
			requireValue(
				STREAM_FENCE_CASES.find((scenario) => scenario.label === label),
				'Missing scenario',
			),
		)
		if (plain === undefined || cancelled === undefined || refused === undefined) {
			throw new Error('Missing scenario')
		}

		expect(buildFenceObservation(plain, 'guide')).toEqual({
			logged: [['Hello'], ['Hello'], ['weighing it']],
			deltas: plain.deltas,
			messages: [{ id: '1', role: 'user', content: 'Say hello.' }],
			requests: [buildFenceBody('Say hello.')],
			error: undefined,
		})
		expect(buildFenceObservation(plain, 'readme')).toEqual({
			logged: [['Hello'], ['Hello']],
			deltas: plain.deltas,
			messages: [{ id: '1', role: 'user', content: 'Reply with exactly: ok' }],
			requests: [
				buildFenceBody('Reply with exactly: ok'),
				buildFenceBody('Reply with exactly: ok'),
			],
			error: undefined,
		})
		expect(buildFenceObservation(cancelled, 'guide').requests).toEqual([])
		expect(buildFenceObservation(refused, 'guide')).toEqual({
			logged: [],
			deltas: undefined,
			messages: undefined,
			requests: [buildFenceBody('Say hello.')],
			error: refused.thrown,
		})
	})
})

describe('STREAM_FENCE_ANCHOR and USAGE_FENCE_ANCHOR', () => {
	it('each locate one block, and two different blocks, by a line only that block holds', () => {
		const markdown = [
			'```ts',
			USAGE_FENCE_ANCHOR,
			'```',
			'',
			'```ts',
			`  ${STREAM_FENCE_ANCHOR}`,
			'```',
		].join('\n')

		expect(STREAM_FENCE_ANCHOR).not.toBe(USAGE_FENCE_ANCHOR)
		expect(extractAnchoredFence(markdown, USAGE_FENCE_ANCHOR)).toBe(USAGE_FENCE_ANCHOR)
		expect(extractAnchoredFence(markdown, STREAM_FENCE_ANCHOR)).toBe(`  ${STREAM_FENCE_ANCHOR}`)
		expect(
			extractAnchoredFence('```ts\nconst deltas = []\n```', STREAM_FENCE_ANCHOR),
		).toBeUndefined()
	})
})

describe('FENCE_MODEL, GUIDE_FENCE_PROMPT, and README_FENCE_PROMPT', () => {
	it('hold the model and the two prompts the fences name', () => {
		expect(FENCE_MODEL).toBe('qwen3.5:2b-q4_K_M')
		expect(GUIDE_FENCE_PROMPT).toBe('Say hello.')
		expect(README_FENCE_PROMPT).toBe('Reply with exactly: ok')
	})
})

describe('extractAnchoredFence', () => {
	const markdown = [
		'# Title',
		'',
		'```ts',
		"import { a } from 'mod'",
		'',
		'const a = 1',
		'',
		'\tconst b = 2  ',
		'```',
		'',
		'const a = 1',
		'```ts',
		'const c = 3',
		'```',
	].join('\n')

	it('extracts every line of the block that holds the anchor, imports and blank lines included', () => {
		expect(extractAnchoredFence(markdown, 'const a = 1')).toBe(
			"import { a } from 'mod'\n\nconst a = 1\n\n\tconst b = 2  ",
		)
		expect(extractAnchoredFence(markdown, '  const c = 3 ')).toBe('const c = 3')
	})

	it('reads a block of Windows line endings and a block whose anchor is on its first line', () => {
		expect(extractAnchoredFence(markdown.replaceAll('\n', '\r\n'), 'const c = 3')).toBe(
			'const c = 3',
		)
		expect(extractAnchoredFence(markdown, "import { a } from 'mod'")).toBe(
			"import { a } from 'mod'\n\nconst a = 1\n\n\tconst b = 2  ",
		)
	})

	it('yields undefined when no block holds the anchor, or the anchor sits outside every block', () => {
		expect(extractAnchoredFence(markdown, 'const absent = 0')).toBeUndefined()
		expect(extractAnchoredFence(markdown, '# Title')).toBeUndefined()
		expect(extractAnchoredFence('```ts\nconst a = 1', 'const a = 1')).toBeUndefined()
		expect(extractAnchoredFence('', 'const a = 1')).toBeUndefined()
	})
})

describe('FENCE_CONTROLS', () => {
	it('lists each kind of edit in each fence it reaches, every one over a scenario the fences run over', () => {
		const { plain, cancelled, refused } = FENCE_SCENARIOS

		expect(FENCE_CONTROLS.map((control) => [control.fence, control.scenario])).toEqual([
			['guide', plain],
			['readme', plain],
			['guide', plain],
			['readme', plain],
			['guide', plain],
			['readme', plain],
			['guide', plain],
			['readme', plain],
			['guide', cancelled],
			['readme', plain],
			['guide', plain],
			['readme', plain],
			['guide', plain],
			['readme', plain],
			['guide', plain],
			['readme', plain],
			['guide', plain],
			['readme', plain],
			['guide', plain],
			['readme', plain],
			['guide', refused],
		])
		expect(
			FENCE_CONTROLS.every((control) =>
				STREAM_FENCE_CASES.some((scenario) => scenario.label === control.scenario),
			),
		).toBe(true)
		expect(new Set(FENCE_CONTROLS.map((control) => control.label)).size).toBe(FENCE_CONTROLS.length)
		expect(Object.isFrozen(FENCE_CONTROLS)).toBe(true)
	})

	it('reaches the message role and id, a provider option, a transport the fence supplies, and the else arm', () => {
		const labels = FENCE_CONTROLS.map((control) => control.label)

		for (const kind of [
			'message role',
			'message id',
			'think provider option',
			'transport that rejects',
		]) {
			expect(labels.filter((label) => label.includes(kind))).toHaveLength(2)
		}
		expect(labels.filter((label) => label.includes('else arm'))).toHaveLength(1)
	})
})

describe('TOOL_CONTEXT', () => {
	it('carries a live signal and no caller, which is all a fixture tool reads', () => {
		expect(TOOL_CONTEXT.signal.aborted).toBe(false)
		expect(TOOL_CONTEXT.caller).toBeUndefined()
	})
})

describe('TINY_PNG_BASE64', () => {
	it('decodes to a 1x1 PNG: the signature, then an IHDR chunk of width 1 and height 1', () => {
		const bytes = Uint8Array.from(atob(TINY_PNG_BASE64), (character) => character.charCodeAt(0))

		expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		expect(new TextDecoder().decode(bytes.slice(12, 16))).toBe('IHDR')
		const header = new DataView(bytes.buffer, bytes.byteOffset + 16, 8)
		expect([header.getUint32(0), header.getUint32(4)]).toEqual([1, 1])
	})
})

describe('createLookupTool', () => {
	it('always returns the fixed LOOKUP_DATUM', async () => {
		const tool = createLookupTool()
		const value = await tool.execute({ query: 'anything' }, TOOL_CONTEXT)
		expect(value).toBe(LOOKUP_DATUM)
	})

	it('records each call via an optional recorder', async () => {
		const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
		const tool = createLookupTool(recorder)

		await tool.execute({ query: 'weather' }, TOOL_CONTEXT)
		await tool.execute({ query: 'time' }, TOOL_CONTEXT)

		expect(recorder.count).toBe(2)
		expect(recorder.calls[0]).toEqual([{ query: 'weather' }])
		expect(recorder.calls[1]).toEqual([{ query: 'time' }])
	})

	it('works with no recorder passed', async () => {
		const tool = createLookupTool()
		const value = await tool.execute({ query: 'x' }, TOOL_CONTEXT)
		expect(value).toBe(LOOKUP_DATUM)
	})
})

describe('createThrowingTool', () => {
	it('always throws THROWING_TOOL_MESSAGE', () => {
		const tool = createThrowingTool()
		expect(() => tool.execute({}, TOOL_CONTEXT)).toThrow(THROWING_TOOL_MESSAGE)
	})

	it('records the call before throwing, via an optional recorder', () => {
		const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
		const tool = createThrowingTool(recorder)

		expect(() => tool.execute({ x: 1 }, TOOL_CONTEXT)).toThrow(THROWING_TOOL_MESSAGE)

		expect(recorder.calls).toEqual([[{ x: 1 }]])
	})
})

describe('createInsatiableTool', () => {
	it('reports chunk 1 on the first call', async () => {
		const tool = createInsatiableTool()
		const value = await tool.execute({}, TOOL_CONTEXT)
		expect(value).toBe(insatiableResult(1))
	})

	it('reports chunk 2 on the second call', async () => {
		const tool = createInsatiableTool()
		await tool.execute({}, TOOL_CONTEXT)
		const value = await tool.execute({}, TOOL_CONTEXT)
		expect(value).toBe(insatiableResult(2))
	})

	it('records each call via an optional recorder', async () => {
		const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
		const tool = createInsatiableTool(recorder)

		await tool.execute({ cursor: 'a' }, TOOL_CONTEXT)
		await tool.execute({ cursor: 'b' }, TOOL_CONTEXT)

		expect(recorder.count).toBe(2)
		expect(recorder.calls[0]).toEqual([{ cursor: 'a' }])
		expect(recorder.calls[1]).toEqual([{ cursor: 'b' }])
	})

	it('works with no recorder passed', async () => {
		const tool = createInsatiableTool()
		const value = await tool.execute({}, TOOL_CONTEXT)
		expect(value).toBe(insatiableResult(1))
	})

	it('keeps independent per-instance counters', async () => {
		const toolA = createInsatiableTool()
		const toolB = createInsatiableTool()

		await toolA.execute({}, TOOL_CONTEXT)
		const first = await toolA.execute({}, TOOL_CONTEXT)
		const second = await toolB.execute({}, TOOL_CONTEXT)

		expect(first).toBe(insatiableResult(2))
		expect(second).toBe(insatiableResult(1))
	})
})

describe('withScheme', () => {
	it('prefixes a scheme-less host:port with http://', () => {
		expect(withScheme('127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
	})

	it('passes existing HTTP schemes through unchanged', () => {
		expect(withScheme('http://localhost:11434')).toBe('http://localhost:11434')
		expect(withScheme('https://ollama.example.com')).toBe('https://ollama.example.com')
	})
})

describe('env', () => {
	const name = 'ORKESTREL_OLLAMA_SETUP_TEST'

	it('returns a non-empty variable value', () => {
		process.env[name] = 'live-value'
		try {
			expect(env(name, 'fallback')).toBe('live-value')
		} finally {
			delete process.env[name]
		}
	})

	it('returns the fallback when unset or empty', () => {
		delete process.env[name]
		expect(env(name, 'fallback')).toBe('fallback')
		process.env[name] = ''
		try {
			expect(env(name, 'fallback')).toBe('fallback')
		} finally {
			delete process.env[name]
		}
	})
})

describe('driveAgent', () => {
	it('buckets chunks and preserves the settled result', async () => {
		const call = { id: 'c1', name: 'lookup', arguments: { query: 'weather' } }
		const toolResult: ToolResult = {
			success: true,
			id: 'c1',
			name: 'lookup',
			value: LOOKUP_DATUM,
		}
		const usage = { prompt: 3, completion: 5, total: 8 }
		const settled: AgentResult = { content: 'ab', partial: false }
		const stream = createScriptedAgentStream(
			[
				{ category: 'think', content: 'reasoning-1' },
				{ category: 'token', content: 'a' },
				{ category: 'tool', call, result: toolResult },
				{ category: 'token', content: 'b' },
				{ category: 'usage', usage, estimate: 2 },
			],
			settled,
		)

		const driven = await driveAgent(stream)

		expect(driven.tokens).toEqual(['a', 'b'])
		expect(driven.thoughts).toEqual(['reasoning-1'])
		expect(driven.tools).toEqual([{ call, result: toolResult }])
		expect(driven.usages).toEqual([usage])
		expect(driven.result).toBe(settled)
	})

	it('returns empty buckets for a stream with no chunks', async () => {
		const settled: AgentResult = { content: '', partial: false }
		const driven = await driveAgent(createScriptedAgentStream([], settled))

		expect(driven.tokens).toEqual([])
		expect(driven.thoughts).toEqual([])
		expect(driven.tools).toEqual([])
		expect(driven.usages).toEqual([])
		expect(driven.result).toBe(settled)
	})
})
