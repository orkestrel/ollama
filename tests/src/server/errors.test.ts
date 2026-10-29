import type { OllamaDaemonOptions, OllamaErrorContext } from '@src/server'
import { createHostileValues } from '@orkestrel/test'
import { isOllamaError, OLLAMA_ERROR_BRAND, OLLAMA_ERROR_CODES, OllamaError } from '@src/server'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('OllamaError', () => {
	it('constructs a named Error with its declared refusal code', () => {
		const error = new OllamaError('The dedicated port is occupied', { code: 'occupied' })

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('OllamaError')
		expect(error.message).toBe('The dedicated port is occupied')
		expect(error.code).toBe('occupied')
		expect(error.stack).toContain('The dedicated port is occupied')
		expect(error.context).toBeUndefined()
		expect(isOllamaError(error)).toBe(true)
	})

	it('keeps the executable digest required in daemon options', () => {
		expectTypeOf<Pick<OllamaDaemonOptions['executable'], 'digest'>>().toEqualTypeOf<{
			readonly digest: string
		}>()
		expectTypeOf<Omit<OllamaDaemonOptions['executable'], 'digest'>>().not.toExtend<
			OllamaDaemonOptions['executable']
		>()
	})

	it('stamps an own immutable hidden self-reference under the shared brand', () => {
		const error = new OllamaError('Executable differs', { code: 'digest' })

		expect(OLLAMA_ERROR_BRAND).toBe(Symbol.for('@orkestrel/ollama.OllamaError'))
		expect(Object.getOwnPropertyDescriptor(error, OLLAMA_ERROR_BRAND)).toEqual({
			value: error,
			writable: false,
			enumerable: false,
			configurable: false,
		})
	})

	it('copies and freezes context without freezing the caller or narrowing unknown observations', () => {
		const expected = { digest: 'declared-digest' }
		const received = { digest: 'observed-digest' }
		const context: OllamaErrorContext = {
			operation: 'start',
			path: process.execPath,
			url: 'http://127.0.0.1:1',
			model: 'fixture-model',
			expected,
			received,
			evidence: 'fixture stderr',
		}
		const error = new OllamaError('Model differs', { code: 'model', context })

		expect(error.context).toEqual(context)
		expect(error.context).not.toBe(context)
		expect(Object.isFrozen(error.context)).toBe(true)
		expect(Object.isFrozen(context)).toBe(false)
		expect(error.context?.expected).toBe(expected)
		expect(error.context?.received).toBe(received)
		expect(isOllamaError(error)).toBe(true)
		Object.defineProperty(context, 'operation', { value: 'stop' })
		expect(error.context?.operation).toBe('start')
	})

	it('accepts a context with omitted optional observations', () => {
		const error = new OllamaError('Startup refused', { code: 'invalid', context: {} })

		expect(error.context).toEqual({})
		expect(isOllamaError(error)).toBe(true)
	})

	it('preserves cause identity and distinguishes omission from an explicit undefined cause', () => {
		const cause = new Error('Process refused')
		const caused = new OllamaError('Spawn failed', { code: 'spawn', cause })
		const absent = new OllamaError('Spawn failed', { code: 'spawn' })
		const explicit = new OllamaError('Spawn failed', { code: 'spawn', cause: undefined })

		expect(caused.cause).toBe(cause)
		expect(Object.hasOwn(caused, 'cause')).toBe(true)
		expect(Object.hasOwn(absent, 'cause')).toBe(false)
		expect(Object.hasOwn(explicit, 'cause')).toBe(true)
		expect(explicit.cause).toBeUndefined()
		expect(isOllamaError(caused)).toBe(true)
		expect(isOllamaError(explicit)).toBe(true)
	})
})

describe('isOllamaError', () => {
	it('accepts every declared refusal code', () => {
		expect(OLLAMA_ERROR_CODES.length).toBeGreaterThan(0)
		for (const code of OLLAMA_ERROR_CODES) {
			expect(isOllamaError(new OllamaError('Daemon refused', { code })), `code ${code}`).toBe(true)
		}
	})

	it('accepts a renamed subclass with its own identity brand', () => {
		const error = new (class extends OllamaError {
			override readonly name = 'FixtureDaemonError'
		})('Startup failed', { code: 'readiness' })

		expect(error.name).toBe('FixtureDaemonError')
		expect(Object.getOwnPropertyDescriptor(error, OLLAMA_ERROR_BRAND)?.value).toBe(error)
		expect(isOllamaError(error)).toBe(true)
	})

	it('recognizes the branded contract without requiring this constructor', () => {
		const error = Object.assign(new TypeError('Foreign daemon refusal'), { code: 'invalid' })
		Object.defineProperty(error, Symbol.for('@orkestrel/ollama.OllamaError'), { value: error })

		expect(isOllamaError(error)).toBe(true)
	})

	it('refuses look-alikes with the declared name and code but no brand', () => {
		const error = Object.assign(new TypeError('Startup failed'), {
			name: 'OllamaError',
			code: 'readiness',
		})

		expect(isOllamaError(error)).toBe(false)
	})

	it('refuses a plain object that carries the self-reference brand', () => {
		const value = { name: 'OllamaError', message: 'Startup failed', code: 'readiness' }
		Object.defineProperty(value, OLLAMA_ERROR_BRAND, { value })

		expect(isOllamaError(value)).toBe(false)
	})

	it('refuses a branded base Error', () => {
		const error = Object.assign(new Error('Startup failed'), { code: 'readiness' })
		Object.defineProperty(error, OLLAMA_ERROR_BRAND, { value: error })

		expect(isOllamaError(error)).toBe(false)
	})

	it('refuses an inherited brand and a brand borrowed from another error', () => {
		const error = new OllamaError('Startup failed', { code: 'readiness' })
		const inherited: unknown = Object.create(error)
		const borrowed = Object.assign(new TypeError('Startup failed'), { code: 'readiness' })
		Object.defineProperty(borrowed, OLLAMA_ERROR_BRAND, { value: error })

		expect(isOllamaError(inherited)).toBe(false)
		expect(isOllamaError(borrowed)).toBe(false)
	})

	it('refuses transparent and revoked proxies over branded errors', () => {
		const error = new OllamaError('Startup failed', { code: 'readiness' })
		const revoked = Proxy.revocable(error, {})
		revoked.revoke()

		expect(isOllamaError(error)).toBe(true)
		expect(isOllamaError(new Proxy(error, {}))).toBe(false)
		expect(isOllamaError(revoked.proxy)).toBe(false)
	})

	it('refuses an undeclared code even when the brand matches', () => {
		const error = new OllamaError('Startup failed', { code: 'readiness' })
		Object.defineProperty(error, 'code', { value: 'unsupported' })

		expect(isOllamaError(error)).toBe(false)
	})

	it('refuses non-string Error members and admits an absent stack', () => {
		const error = new OllamaError('Startup failed', { code: 'readiness' })
		for (const key of Object.getOwnPropertyNames(new Error('Reference error'))) {
			const malformed = new OllamaError('Startup failed', { code: 'readiness' })
			Object.defineProperty(malformed, key, { value: 42 })
			expect(isOllamaError(malformed), `member ${key}`).toBe(false)
		}
		Object.defineProperty(error, 'stack', { value: undefined })
		expect(isOllamaError(error)).toBe(true)
		Object.defineProperty(error, 'name', { value: 42 })
		expect(isOllamaError(error)).toBe(true)
	})

	it('refuses a non-object context', () => {
		const error = new OllamaError('Startup failed', { code: 'readiness' })
		Object.defineProperty(error, 'context', { value: null })

		expect(isOllamaError(error)).toBe(false)
	})

	it('validates every declared string observation in a context', () => {
		const context = {
			operation: 'start',
			path: process.execPath,
			url: 'http://127.0.0.1:1',
			model: 'fixture-model',
			evidence: 'fixture stderr',
		}
		for (const key of Object.keys(context)) {
			const error = new OllamaError('Startup failed', { code: 'readiness', context })
			expect(isOllamaError(error), `member ${key}`).toBe(true)
			Object.defineProperty(error, 'context', { value: { ...context, [key]: 42 } })
			expect(isOllamaError(error), `member ${key}`).toBe(false)
		}
	})

	it('contains throwing accessors on declared Error members', () => {
		const reference = new OllamaError('Startup failed', { code: 'readiness' })
		for (const key of Object.getOwnPropertyNames(reference)) {
			const error = new OllamaError('Startup failed', { code: 'readiness' })
			Object.defineProperty(error, key, {
				get() {
					throw new Error('Unreadable member')
				},
			})
			expect(isOllamaError(error), `member ${key}`).toBe(false)
		}
	})

	it('contains a throwing context accessor', () => {
		const error = new OllamaError('Startup failed', { code: 'readiness' })
		Object.defineProperty(error, 'context', {
			value: Object.defineProperty({}, 'operation', {
				get() {
					throw new Error('Unreadable operation')
				},
			}),
		})

		expect(isOllamaError(error)).toBe(false)
	})

	it('refuses an accessor brand without evaluating it', () => {
		const error = Object.assign(new TypeError('Startup failed'), { code: 'readiness' })
		Object.defineProperty(error, OLLAMA_ERROR_BRAND, {
			get() {
				throw new Error('Unreadable brand')
			},
		})

		expect(isOllamaError(error)).toBe(false)
	})

	it('refuses exotic values without throwing', () => {
		const values = createHostileValues()
		expect(values.length).toBeGreaterThan(0)
		for (const [index, value] of values.entries()) {
			expect(isOllamaError(value), `input ${index}`).toBe(false)
		}
		expect(isOllamaError(undefined)).toBe(false)
		expect(isOllamaError(null)).toBe(false)
		expect(isOllamaError(false)).toBe(false)
		expect(isOllamaError(0)).toBe(false)
		expect(isOllamaError(Number.NaN)).toBe(false)
		expect(isOllamaError('readiness')).toBe(false)
		expect(isOllamaError(Symbol('readiness'))).toBe(false)
		expect(isOllamaError(1n)).toBe(false)
	})

	it('leaves unknown context observations and causes uninspected', () => {
		for (const [index, value] of createHostileValues().entries()) {
			const error = new OllamaError('Metadata refused', {
				code: 'metadata',
				context: { expected: value, received: value },
				cause: value,
			})

			expect(error.cause, `input ${index}`).toBe(value)
			expect(error.context?.expected, `input ${index}`).toBe(value)
			expect(error.context?.received, `input ${index}`).toBe(value)
			expect(isOllamaError(error), `input ${index}`).toBe(true)
		}
	})
})
