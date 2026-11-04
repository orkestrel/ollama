import { createContract, integerShape, seededRandom } from '@orkestrel/contract'
import { isOllamaDaemonOptions } from '@src/server'
import { buildOllamaDaemonContractCases } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('standing daemon contract table', () => {
	it.each(buildOllamaDaemonContractCases())(
		'$name: serializable guard implies admission with named semantic exceptions',
		(row) => {
			for (const value of row.positives) {
				expect(isOllamaDaemonOptions(value)).toBe(true)
				expect(row.wire.is(value)).toBe(true)
			}
			for (const seed of Array.from({ length: 40 }, (_, index) => index)) {
				const value = {
					...row.positive,
					readiness: createContract(integerShape({ min: 1, max: 1000 })).generate(
						seededRandom(seed),
					),
				}
				expect(isOllamaDaemonOptions(value)).toBe(true)
				expect(row.wire.is(value)).toBe(true)
			}
			for (const value of row.negatives) {
				expect(row.wire.is(value)).toBe(false)
				expect(isOllamaDaemonOptions(value)).toBe(false)
			}
			const absent = { ...row.positive, store: undefined }
			expect(isOllamaDaemonOptions(absent)).toBe(false)
			expect(row.wire.is(absent)).toBe(false)
			for (const scenario of row.semantics) {
				expect({ condition: scenario.condition, admitted: row.wire.is(scenario.value) }).toEqual({
					condition: scenario.condition,
					admitted: true,
				})
				expect({
					condition: scenario.condition,
					guarded: isOllamaDaemonOptions(scenario.value),
				}).toEqual({
					condition: scenario.condition,
					guarded: false,
				})
			}
		},
	)
})
