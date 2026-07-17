import { describe, expect, it } from 'vitest'
import {
	env,
	flattenHeaders,
	forwardHeaders,
	isAbortError,
	parseRequestBody,
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
