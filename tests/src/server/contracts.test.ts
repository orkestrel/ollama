import { isOllamaDaemonOptions } from '@src/server'
import { DAEMON_DECLARATION, buildOllamaDaemonContractCases } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('standing daemon contract table', () => {
	it.each(buildOllamaDaemonContractCases())(
		'$name: guard implies admission with named semantic exceptions',
		(row) => {
			const pair = {
				...row,
				direction: 'guard implies is; is implies guard except semantic conditions',
				project: undefined,
				guard: isOllamaDaemonOptions,
				positive: DAEMON_DECLARATION,
				negative: {},
				semantic: {
					condition: 'absolute workspace',
					value: { ...DAEMON_DECLARATION, workspace: 'relative' },
					admitted: true,
					guarded: false,
				},
			}
			expect(pair.direction).toBe('guard implies is; is implies guard except semantic conditions')
			expect(pair.project).toBeUndefined()
			expect(pair.wire.is(pair.positive)).toBe(true)
			expect(pair.guard(pair.positive)).toBe(true)
			expect(pair.wire.is(pair.negative)).toBe(false)
			expect(pair.guard(pair.negative)).toBe(false)
			expect(pair.semantic.condition).toBe('absolute workspace')
			expect(pair.wire.is(pair.semantic.value)).toBe(pair.semantic.admitted)
			expect(pair.guard(pair.semantic.value)).toBe(pair.semantic.guarded)
		},
	)
})
