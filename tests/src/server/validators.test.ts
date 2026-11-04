import { attempt } from '@orkestrel/contract'
import { createHostileValues } from '@orkestrel/test'
import {
	isOllamaDaemonOptions,
	isOllamaError,
	isOllamaExecutable,
	isOllamaModel,
	OLLAMA_DAEMON_KEYS,
	OLLAMA_DAEMON_LIVE,
	OllamaDaemon,
	ollamaDaemonContract,
	ollamaDaemonShape,
} from '@src/server'
import { scanOptionFaults } from '@src/core'
import {
	DAEMON_DECLARATION,
	EXTRA_DAEMON_OVERRIDES,
	INVALID_DAEMON_OVERRIDES,
} from '../../setupServer.js'
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

	it.each(EXTRA_DAEMON_OVERRIDES)(
		'refuses an undeclared %s with its path under code invalid',
		(_label, override, path) => {
			const options = { ...DAEMON_DECLARATION, ...override }

			expect(isOllamaDaemonOptions(options)).toBe(false)
			expect(() => Reflect.construct(OllamaDaemon, [options])).toThrow(
				expect.objectContaining({
					code: 'invalid',
					message: expect.stringContaining(path.join('.')),
					context: { faults: [{ reason: 'extra', path }] },
				}),
			)
		},
	)

	it('carries the faults through the error guard', () => {
		const refused = attempt(() =>
			Reflect.construct(OllamaDaemon, [{ ...DAEMON_DECLARATION, wrokspace: '.' }]),
		)

		expect(!refused.success && isOllamaError(refused.error)).toBe(true)
	})

	it('holds the guards and the shape in lockstep over the declared keys', () => {
		const shape = ollamaDaemonShape.properties
		const declared = OLLAMA_DAEMON_KEYS.daemon.filter((key) => !OLLAMA_DAEMON_LIVE.includes(key))

		expect(declared.toSorted()).toEqual(Object.keys(shape).toSorted())
		expect(OLLAMA_DAEMON_KEYS.executable.toSorted()).toEqual(
			Object.keys(shape.executable.properties).toSorted(),
		)
		expect(OLLAMA_DAEMON_KEYS.model.toSorted()).toEqual(
			Object.keys(shape.models.items.properties).toSorted(),
		)
		expect(OLLAMA_DAEMON_KEYS.metadata.toSorted()).toEqual(
			Object.keys(shape.metadata.inner.properties).toSorted(),
		)
		expect(OLLAMA_DAEMON_KEYS.termination.toSorted()).toEqual(
			Object.keys(shape.termination.inner.properties).toSorted(),
		)
	})

	it('finds no fault in a declaration the guard admits, so the guard refuses no less than the shape', () => {
		expect(scanOptionFaults(ollamaDaemonContract, DAEMON_DECLARATION, OLLAMA_DAEMON_LIVE)).toEqual(
			[],
		)
		const faulted = [...INVALID_DAEMON_OVERRIDES, ...EXTRA_DAEMON_OVERRIDES]
			.map(([, override]) => ({ ...DAEMON_DECLARATION, ...override }))
			.filter(
				(options) => scanOptionFaults(ollamaDaemonContract, options, OLLAMA_DAEMON_LIVE).length > 0,
			)

		expect(faulted.length).toBeGreaterThan(0)
		expect(faulted.filter((options) => isOllamaDaemonOptions(options))).toEqual([])
	})

	it('returns false for exotic unknown values including throwing accessors and revoked proxies', () => {
		for (const value of createHostileValues()) {
			expect(isOllamaDaemonOptions(value)).toBe(false)
			expect(isOllamaExecutable(value)).toBe(false)
			expect(isOllamaModel(value)).toBe(false)
		}
	})
})
