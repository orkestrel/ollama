import type { OllamaHTTPErrorOptions } from '@src/server'
import { isOllamaHTTPError, OllamaHTTPError } from '@src/server'
import { describe, expect, it } from 'vitest'

describe('OllamaHTTPError', () => {
	// The constructor's third parameter is the named, exported `OllamaHTTPErrorOptions`, so a
	// consumer can declare the value it passes instead of restating an anonymous shape at
	// the call site. Annotating the local is the assertion: the declaration is what fails
	// to compile if the type stops being exported or stops matching the parameter.
	it('accepts a declared OllamaHTTPErrorOptions and keeps its cause', () => {
		const transport = new TypeError('fetch failed')
		const options: OllamaHTTPErrorOptions = { cause: transport }

		const error = new OllamaHTTPError(
			'Ollama API error: 500 - (error body unavailable)',
			500,
			options,
		)

		expect(error.cause).toBe(transport)
		expect(error.status).toBe(500)
		expect(error.name).toBe('OllamaHTTPError')
		expect(isOllamaHTTPError(error)).toBe(true)
	})

	it('carries no cause when the options are omitted', () => {
		const error = new OllamaHTTPError('Ollama API error: no response body', 0)

		expect(error.cause).toBeUndefined()
		expect(error.status).toBe(0)
	})
})
