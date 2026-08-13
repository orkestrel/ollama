// The shared test infrastructure's own proof. Every helper, fixture, recorder, and
// guard exported from `tests/setup.ts` and `tests/setupServer.ts` is real code that the
// module, integration, and live-service suites rely on, so each one is proved here
// rather than trusted. It covers the whole workspace's fixtures rather than one module,
// which is why it sits at the tests root in its own `setup` project.

import type { AgentResult } from '@orkestrel/agent'
import type { ToolResult } from '@orkestrel/tool'
import type { WorkspaceInterface } from '@orkestrel/workspace'
import { createRecorder } from '@orkestrel/test'
import { createWorkspace } from '@orkestrel/workspace'
import { describe, expect, it } from 'vitest'
import {
	buildTurns,
	createThrowingSummarizer,
	fillWorkspace,
	THROWING_SUMMARIZER_MESSAGE,
} from './setup.js'
import {
	createInsatiableTool,
	createScriptedAgentStream,
	createLookupTool,
	createThrowingTool,
	driveAgent,
	env,
	flattenHeaders,
	forwardHeaders,
	insatiableResult,
	isAbortError,
	LOOKUP_DATUM,
	parseRequestBody,
	systemText,
	THROWING_TOOL_MESSAGE,
	wireMessages,
	wireText,
	wireTools,
	withScheme,
} from './setupServer.js'

// Build a minimal RecordedRequest-shaped value for the wire-narrowing helper tests
// below — method/path/headers are irrelevant to wireMessages/wireText/systemText, so
// only `body` varies per case.
function requestWithBody(body: Record<string, unknown>): {
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: Record<string, unknown>
} {
	return { method: 'POST', path: '/api/chat', headers: {}, body }
}

describe('flattenHeaders', () => {
	it('lowercases keys and flattens a Headers instance to a plain record', () => {
		const headers = new Headers()
		headers.set('Content-Type', 'application/json')
		headers.set('X-Trace-Id', 'abc123')

		expect(flattenHeaders(headers)).toEqual({
			'content-type': 'application/json',
			'x-trace-id': 'abc123',
		})
	})

	it('comma-joins repeated header entries into a single flattened value', () => {
		const headers = new Headers([
			['accept', 'a'],
			['accept', 'b'],
		])

		expect(flattenHeaders(headers)).toEqual({
			accept: 'a, b',
		})
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

describe('isAbortError', () => {
	it('returns true for the real AbortSignal.abort() reason', () => {
		const reason: unknown = AbortSignal.abort().reason
		expect(isAbortError(reason)).toBe(true)
	})

	it('returns true for an Error named AbortError, narrowing to Error', () => {
		const error = new Error('aborted')
		error.name = 'AbortError'
		const value: unknown = error

		expect(isAbortError(value)).toBe(true)
		if (!isAbortError(value)) throw new Error('unreachable: isAbortError narrowed true above')
		expect(value.message).toBe('aborted')
	})

	it('returns false for a plain Error', () => {
		expect(isAbortError(new Error('boom'))).toBe(false)
	})

	it('returns false for a string', () => {
		expect(isAbortError('AbortError')).toBe(false)
	})

	it('returns false for undefined', () => {
		expect(isAbortError(undefined)).toBe(false)
	})

	it('returns false for a plain object with a matching name field', () => {
		expect(isAbortError({ name: 'AbortError' })).toBe(false)
	})
})

describe('wireMessages', () => {
	it('narrows a well-formed messages array', () => {
		const request = requestWithBody({
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
		const request = requestWithBody({
			messages: [{ role: 'user', content: 'look', images: ['base64-image'] }],
		})

		expect(wireMessages(request)).toEqual([
			{ role: 'user', content: 'look', images: ['base64-image'] },
		])
	})

	it('rejects malformed image payloads', () => {
		expect(
			wireMessages(
				requestWithBody({
					messages: [{ role: 'user', content: 'look', images: [42] }],
				}),
			),
		).toEqual([])
	})

	it('returns [] when messages is absent', () => {
		expect(wireMessages(requestWithBody({}))).toEqual([])
	})

	it('returns [] when messages is not an array', () => {
		expect(wireMessages(requestWithBody({ messages: 'nope' }))).toEqual([])
	})

	it('returns [] when an element is malformed (missing content)', () => {
		expect(wireMessages(requestWithBody({ messages: [{ role: 'user' }] }))).toEqual([])
	})

	it('returns [] when an element is not a record', () => {
		expect(wireMessages(requestWithBody({ messages: ['nope'] }))).toEqual([])
	})
})

describe('wireTools', () => {
	it('returns function names from a well-formed tools array', () => {
		const request = requestWithBody({
			tools: [
				{ type: 'function', function: { name: 'lookup' } },
				{ type: 'function', function: { name: 'more' } },
			],
		})

		expect(wireTools(request)).toEqual(['lookup', 'more'])
	})

	it('returns [] when tools are absent or malformed', () => {
		expect(wireTools(requestWithBody({}))).toEqual([])
		expect(wireTools(requestWithBody({ tools: [{ function: {} }] }))).toEqual([])
	})
})

describe('wireText', () => {
	it('joins every wire message content with a newline', () => {
		const request = requestWithBody({
			messages: [
				{ role: 'system', content: 'rules' },
				{ role: 'user', content: 'hi' },
			],
		})

		expect(wireText(request)).toBe('rules\nhi')
	})

	it('returns an empty string when there are no messages', () => {
		expect(wireText(requestWithBody({}))).toBe('')
	})
})

describe('systemText', () => {
	it("returns the first message's content when its role is system", () => {
		const request = requestWithBody({
			messages: [
				{ role: 'system', content: 'rules' },
				{ role: 'user', content: 'hi' },
			],
		})

		expect(systemText(request)).toBe('rules')
	})

	it('returns an empty string when the first message is not a system turn', () => {
		const request = requestWithBody({ messages: [{ role: 'user', content: 'hi' }] })

		expect(systemText(request)).toBe('')
	})

	it('returns an empty string when there are no messages', () => {
		expect(systemText(requestWithBody({}))).toBe('')
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

describe('fillWorkspace', () => {
	function paths(workspace: WorkspaceInterface): readonly string[] {
		return workspace.files().map((file) => file.path)
	}

	it('writes the default count of doc-NN.md files', () => {
		const workspace = createWorkspace()
		fillWorkspace(workspace)

		const names = paths(workspace)
		expect(names).toHaveLength(12)
		expect(names).toContain('doc-01.md')
		expect(names).toContain('doc-12.md')
	})

	it('honors a custom count and approximate byte size', () => {
		const workspace = createWorkspace()
		fillWorkspace(workspace, { count: 3, bytesEach: 100 })

		const names = paths(workspace)
		expect(names).toEqual(['doc-01.md', 'doc-02.md', 'doc-03.md'])
		const file = workspace.file('doc-01.md')
		const content = file?.content
		expect(content !== undefined && 'text' in content ? content.text.length : -1).toBe(100)
	})

	it('writes an optional sentinel file alongside the filler docs', () => {
		const workspace = createWorkspace()
		fillWorkspace(workspace, { count: 2, sentinelPath: 'find-me.md', sentinelText: 'needle' })

		expect(paths(workspace)).toContain('find-me.md')
		const content = workspace.file('find-me.md')?.content
		expect(content !== undefined && 'text' in content ? content.text : undefined).toBe('needle')
	})
})

describe('createLookupTool', () => {
	it('always returns the fixed LOOKUP_DATUM', async () => {
		const tool = createLookupTool()
		const value = await tool.execute({ query: 'anything' })
		expect(value).toBe(LOOKUP_DATUM)
	})

	it('records each call via an optional recorder', async () => {
		const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
		const tool = createLookupTool(recorder)

		await tool.execute({ query: 'weather' })
		await tool.execute({ query: 'time' })

		expect(recorder.count).toBe(2)
		expect(recorder.calls[0]).toEqual([{ query: 'weather' }])
		expect(recorder.calls[1]).toEqual([{ query: 'time' }])
	})

	it('works with no recorder passed', async () => {
		const tool = createLookupTool()
		const value = await tool.execute({ query: 'x' })
		expect(value).toBe(LOOKUP_DATUM)
	})
})

describe('createThrowingTool', () => {
	it('always throws THROWING_TOOL_MESSAGE', () => {
		const tool = createThrowingTool()
		expect(() => tool.execute({})).toThrow(THROWING_TOOL_MESSAGE)
	})

	it('records the call before throwing, via an optional recorder', () => {
		const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
		const tool = createThrowingTool(recorder)

		expect(() => tool.execute({ x: 1 })).toThrow(THROWING_TOOL_MESSAGE)

		expect(recorder.count).toBe(1)
		expect(recorder.calls[0]).toEqual([{ x: 1 }])
	})
})

describe('createInsatiableTool', () => {
	it('reports chunk 1 on the first call', async () => {
		const tool = createInsatiableTool()
		const value = await tool.execute({})
		expect(value).toBe(insatiableResult(1))
	})

	it('reports chunk 2 on the second call', async () => {
		const tool = createInsatiableTool()
		await tool.execute({})
		const value = await tool.execute({})
		expect(value).toBe(insatiableResult(2))
	})

	it('records each call via an optional recorder', async () => {
		const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
		const tool = createInsatiableTool(recorder)

		await tool.execute({ cursor: 'a' })
		await tool.execute({ cursor: 'b' })

		expect(recorder.count).toBe(2)
		expect(recorder.calls[0]).toEqual([{ cursor: 'a' }])
		expect(recorder.calls[1]).toEqual([{ cursor: 'b' }])
	})

	it('works with no recorder passed', async () => {
		const tool = createInsatiableTool()
		const value = await tool.execute({})
		expect(value).toBe(insatiableResult(1))
	})

	it('keeps independent per-instance counters', async () => {
		const toolA = createInsatiableTool()
		const toolB = createInsatiableTool()

		await toolA.execute({})
		const first = await toolA.execute({})
		const second = await toolB.execute({})

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
				{ type: 'think', content: 'reasoning-1' },
				{ type: 'token', content: 'a' },
				{ type: 'tool', call, result: toolResult },
				{ type: 'token', content: 'b' },
				{ type: 'usage', usage },
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
