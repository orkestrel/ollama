import { createAbort } from '@orkestrel/abort'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../setup.js'
import { drive } from '../setupServer.js'
import { FAST_OPTIONS, OLLAMA_CONFIG, STREAM_OPTIONS } from '../setupService.js'

describe('createOllama (live)', () => {
	it('returns a working ProviderInterface that generates content', async () => {
		// Recipe: FAST_OPTIONS (num_predict:8, temperature:0) — minimal warm chat, structural assert.
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: FAST_OPTIONS,
		})
		const abort = createAbort()

		expect(provider.name).toBe('ollama')
		expect(provider.id.length).toBeGreaterThan(0)

		const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)
		expect(result.content.length).toBeGreaterThan(0)
	})

	it('returns a ProviderInterface whose stream yields deltas and returns the result', async () => {
		// Recipe: STREAM_OPTIONS (num_predict:16, temperature:0) — multi-delta streaming.
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: STREAM_OPTIONS,
		})
		const abort = createAbort()

		const { deltas, result } = await drive(
			provider.stream([createUserMessage('Say hi.')], abort.signal),
		)

		expect(deltas.length).toBeGreaterThan(0)
		expect(result.content).toBe(deltas.join(''))
	})
	it('the transport seam (a headers hook) does not break the real daemon path', async () => {
		// Recipe: FAST_OPTIONS. The S2 seam is orthogonal to the wire: a dynamic header the real
		// Ollama simply ignores must still produce a normal generation against the live daemon —
		// proof the header-merge doesn't perturb the actual request path.
		const provider = createOllama({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: FAST_OPTIONS,
			headers: () => ({ 'x-trace': 'abc' }),
		})
		const abort = createAbort()

		const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)
		expect(result.content.length).toBeGreaterThan(0)
	})
})
