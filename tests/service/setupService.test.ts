import type { AgentChunk, AgentResult, AgentStreamInterface } from '@orkestrel/agent'
import { describe, expect, it } from 'vitest'
import { LOOKUP_DATUM } from '../setupServer.js'
import { driveAgent, env, withScheme } from '../setupService.js'

/** Build an in-process agent stream over deterministic chunks. */
export function createScriptedAgentStream(
	chunks: readonly AgentChunk[],
	result: AgentResult,
): AgentStreamInterface {
	return {
		events: (async function* () {
			for (const chunk of chunks) yield chunk
		})(),
		result: Promise.resolve(result),
		abort() {},
	}
}

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
		const driven = await driveAgent(createScriptedAgentStream([], settled))

		expect(driven.tokens).toEqual([])
		expect(driven.thoughts).toEqual([])
		expect(driven.tools).toEqual([])
		expect(driven.usages).toEqual([])
		expect(driven.result).toBe(settled)
	})
})
