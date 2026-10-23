import { createHostileValues } from '@orkestrel/test'
import { isOllamaDaemonOptions, isOllamaExecutable, isOllamaModel, OllamaDaemon } from '@src/server'
import { DAEMON_DECLARATION, INVALID_DAEMON_OVERRIDES } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('daemon declaration validators', () => {
	it('accepts a complete dedicated declaration', () => {
		const options = DAEMON_DECLARATION
		expect(isOllamaDaemonOptions(options)).toBe(true)
		expect(isOllamaExecutable(options.executable)).toBe(true)
		expect(isOllamaModel(options.models[0])).toBe(true)
	})

	it('accepts an omitted, undefined, or callable fetch and refuses a throwing fetch accessor', () => {
		expect(isOllamaDaemonOptions({ ...DAEMON_DECLARATION, fetch: undefined })).toBe(true)
		expect(isOllamaDaemonOptions({ ...DAEMON_DECLARATION, fetch: globalThis.fetch })).toBe(true)
		expect(
			isOllamaDaemonOptions({
				...DAEMON_DECLARATION,
				get fetch() {
					throw new Error('unreadable fetch')
				},
			}),
		).toBe(false)
	})

	it.each(INVALID_DAEMON_OVERRIDES)(
		'refuses the malformed %s declaration before I/O',
		(_label, override) => {
			const options = DAEMON_DECLARATION
			expect(isOllamaDaemonOptions({ ...options, ...override })).toBe(false)
			expect(() => Reflect.construct(OllamaDaemon, [{ ...options, ...override }])).toThrow(
				'Invalid dedicated daemon declaration',
			)
		},
	)

	it('returns false for exotic unknown values including throwing accessors and revoked proxies', () => {
		for (const value of createHostileValues()) {
			expect(isOllamaDaemonOptions(value)).toBe(false)
			expect(isOllamaExecutable(value)).toBe(false)
			expect(isOllamaModel(value)).toBe(false)
		}
	})
})
