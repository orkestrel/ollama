import {
	// These exports remain available to proofs emitted by earlier scaffold releases.
	buildDistributionCases,
	createDistributionSuite,
} from './setupDistribution.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OLLAMA_ERROR_COPIES_DRIVER, readSpawnOutput, runNode } from './setupServer.js'

const DISTRIBUTION_SUITE = createDistributionSuite()

beforeAll(() => DISTRIBUTION_SUITE.start())

afterAll(() => DISTRIBUTION_SUITE.destroy())

describe('installed package consumer', () => {
	for (const row of buildDistributionCases(DISTRIBUTION_SUITE)) {
		it(`${row.label}`, async (context) => {
			const observation = await row.observe(context)
			expect(observation.actual).toStrictEqual(observation.expected)
		})
	}
	it('publishes no browser face this proof cannot drive [requires the registry]', (context) => {
		const faces = DISTRIBUTION_SUITE.read(context).entries.filter((entry) => entry.browsable)
		expect(faces.map((entry) => entry.subpath)).toStrictEqual([])
	})
	it('recognizes errors across packed module formats and installations [requires the registry]', (context) => {
		const stage = DISTRIBUTION_SUITE.read(context)
		const driver = join(stage.consumer, 'ollama-error-copies.mjs')
		writeFileSync(driver, OLLAMA_ERROR_COPIES_DRIVER)
		const result = runNode([driver, stage.installed], stage.consumer)
		expect({ status: result.status, output: readSpawnOutput(result).trim() }).toEqual({
			status: 0,
			output: 'Cross-format and cross-installation error guards passed',
		})
	})
})
