import type { AgentChunk, AgentResult, AgentStreamInterface } from '@orkestrel/agent'
import { describe, expect, it } from 'vitest'
import { createRecorder } from '../../setup.js'
import {
	createLookupTool,
	createThrowingTool,
	driveAgent,
	env,
	flattenHeaders,
	forwardHeaders,
	isAbortError,
	LOOKUP_DATUM,
	parseRequestBody,
	THROWING_TOOL_MESSAGE,
	withScheme,
} from '../../setupServer.js'

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
