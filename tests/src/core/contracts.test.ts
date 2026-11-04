import { createContract, isRecord, seededRandom } from '@orkestrel/contract'
import { scanOptionFaults } from '@src/core'
import { buildOllamaContractCases } from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('standing options contract table', () => {
	it.each(buildOllamaContractCases())(
		'$name: strict serializable options preserve shape admission',
		(row) => {
			const pair = { ...row, negative: {} }
			for (const wire of [pair.wire, createContract(pair.shape)]) {
				for (const seed of Array.from({ length: 40 }, (_, index) => index)) {
					const value = wire.generate(seededRandom(seed))
					expect(wire.is(value)).toBe(true)
					expect(isRecord(value)).toBe(true)
					if (!isRecord(value)) throw new Error('Generated options must be a record')
					expect(scanOptionFaults(wire, value, [])).toEqual([])
				}
				expect(wire.is(pair.positive)).toBe(true)
				expect(wire.is(pair.negative)).toBe(false)
				expect(scanOptionFaults(wire, pair.positive, [])).toEqual([])
				expect(scanOptionFaults(wire, pair.negative, []).length).toBeGreaterThan(0)
				for (const value of pair.negatives) {
					expect(wire.is(value)).toBe(false)
					expect(scanOptionFaults(wire, value, []).length).toBeGreaterThan(0)
				}
				expect(
					scanOptionFaults(wire, { ...pair.positive, timeout: '100' }, []).length,
				).toBeGreaterThan(0)
				expect(
					scanOptionFaults(wire, { ...pair.positive, undeclared: true }, []).length,
				).toBeGreaterThan(0)
			}
		},
	)
})
