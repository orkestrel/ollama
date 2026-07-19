import type {
	AgentChunk,
	AgentResult,
	AgentStreamInterface,
	WorkspaceInterface,
} from '@orkestrel/agent'
import { createWorkspace } from '@orkestrel/agent'
import { describe, expect, it } from 'vitest'
import {
	buildTurns,
	createRecorder,
	createThrowingSummarizer,
	fillWorkspace,
	THROWING_SUMMARIZER_MESSAGE,
} from '../../setup.js'
import {
	createInsatiableTool,
	createLookupTool,
	createThrowingTool,
	driveAgent,
	env,
	flattenHeaders,
	forwardHeaders,
	INSATIABLE_TOOL_RESULT,
	isAbortError,
	LOOKUP_DATUM,
	parseRequestBody,
	systemText,
	THROWING_TOOL_MESSAGE,
	wireMessages,
	wireText,
	withScheme,
} from '../../setupServer.js'

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

// The Ollama-project setup helpers as pure units (AGENTS §16 — no mocks, real
// values). These are the recording-proxy internals + config normalizers
// (`withScheme`, `env`, `flattenHeaders`, `parseRequestBody`, `forwardHeaders`,
// `isAbortError`) — none of them make daemon requests, so this file is safe to run
// even though the suite's setup gate still contacts a live Ollama.

describe('withScheme', () => {
	it('prefixes a scheme-less host:port with http://', () => {
		expect(withScheme('127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
	})

	it('passes an existing http:// URL through unchanged', () => {
		expect(withScheme('http://localhost:11434')).toBe('http://localhost:11434')
	})

	it('passes an existing https:// URL through unchanged', () => {
		expect(withScheme('https://ollama.example.com')).toBe('https://ollama.example.com')
	})
})

describe('env', () => {
	const name = 'ORKESTREL_OLLAMA_SETUP_TEST'

	it('returns the variable value when set', () => {
		process.env[name] = 'live-value'
		try {
			expect(env(name, 'fallback')).toBe('live-value')
		} finally {
			delete process.env[name]
		}
	})

	it('returns the fallback when unset', () => {
		delete process.env[name]
		expect(env(name, 'fallback')).toBe('fallback')
	})

	it('returns the fallback when set to the empty string', () => {
		process.env[name] = ''
		try {
			expect(env(name, 'fallback')).toBe('fallback')
		} finally {
			delete process.env[name]
		}
	})
})

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

// Build a real, hand-rolled AgentStreamInterface over a scripted chunk list — not a
// mock library, a genuine small in-process implementation of the interface
// (AGENTS §16.1).
function createScriptedAgentStream(
	chunks: readonly AgentChunk[],
	result: AgentResult,
): AgentStreamInterface {
	async function* events(): AsyncGenerator<AgentChunk> {
		for (const chunk of chunks) yield chunk
	}
	return {
		events: events(),
		result: Promise.resolve(result),
		abort() {},
	}
}

describe('driveAgent', () => {
	it('buckets token, think, tool, and usage chunks and passes through the result', async () => {
		const call = { id: 'c1', name: 'lookup', arguments: { query: 'weather' } }
		const toolResult = { id: 'c1', name: 'lookup', value: LOOKUP_DATUM }
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
		const stream = createScriptedAgentStream([], settled)

		const driven = await driveAgent(stream)

		expect(driven.tokens).toEqual([])
		expect(driven.thoughts).toEqual([])
		expect(driven.tools).toEqual([])
		expect(driven.usages).toEqual([])
		expect(driven.result).toBe(settled)
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
	it('always returns INSATIABLE_TOOL_RESULT', async () => {
		const tool = createInsatiableTool()
		const value = await tool.execute({})
		expect(value).toBe(INSATIABLE_TOOL_RESULT)
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
		expect(value).toBe(INSATIABLE_TOOL_RESULT)
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
