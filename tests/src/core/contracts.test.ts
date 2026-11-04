import { createContract } from '@orkestrel/contract'
import { scanOptionFaults } from '@src/core'
import { buildOllamaContractCases } from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('standing options contract table', () => {
	it.each(buildOllamaContractCases())(
		'$name: strict serializable options preserve shape admission',
		(row) => {
			const pair = { ...row, direction: 'strict options', project: undefined, negative: {} }
			expect(pair.direction).toBe('strict options')
			expect(pair.project).toBeUndefined()
			for (const wire of [pair.wire, createContract(pair.shape)]) {
				expect(wire.is(pair.positive)).toBe(true)
				expect(wire.is(pair.negative)).toBe(false)
				expect(scanOptionFaults(wire, pair.positive, [])).toEqual([])
				expect(scanOptionFaults(wire, pair.negative, []).length).toBeGreaterThan(0)
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
