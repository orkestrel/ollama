// The artifact a consumer installs, measured rather than described. This workspace
// is packed and installed into a throwaway consumer, and every following claim is read
// off that installed tree: the exports map it publishes, the declarations it ships,
// and the module objects a real runtime hands a consumer. Nothing here names this
// package, one of its exports, or how many there are, so the proof stays true as
// the published surface moves. The readers, runners, and classifiers that measure the
// tree live in `tests/setupServer.ts`, and `tests/setupServer.test.ts` proves them
// without a registry; this file registers the claims that need the packed archive.
import type { TestContext } from 'vitest'
import { isRecord } from '@orkestrel/contract'
import { createScratch } from '@orkestrel/test/server'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { DistributionStage } from './setupServer.js'
import {
	ABSENT_SUBPATH,
	CLASSIFIER_FILES,
	checkResolution,
	checkSurface,
	CJS_DRIVER,
	driveRuntime,
	ESM_DRIVER,
	FORMATS,
	openStage,
	readJson,
	readManifestName,
	readSpawnOutput,
	RELEASE_MODE,
	resolvesBrowser,
	resolvesCommonJS,
	RESOLUTIONS,
	runNode,
	selectDrivers,
	selectUntypable,
} from './setupServer.js'

const SCRATCH = mkdtempSync(join(tmpdir(), 'distribution-'))
// The scratch tree holds the npm cache, the packed archive, and the installed
// consumer, so its removal is registered before the first thing that can throw.
afterAll(() => {
	rmSync(SCRATCH, { force: true, recursive: true })
})

const STAGE = openStage(SCRATCH, RELEASE_MODE)
const STAGED = STAGE !== undefined

describe('distribution classifiers', () => {
	it('classifies synthetic export mappings without a registry stage', () => {
		const scratch = createScratch({ files: CLASSIFIER_FILES })
		try {
			const manifest = readJson(join(scratch.path, 'package.json'))
			if (!isRecord(manifest) || !isRecord(manifest.exports)) {
				throw new Error('The classifier fixture declares no exports map')
			}
			const mappings = manifest.exports
			expect({
				condition: resolvesBrowser(mappings.condition),
				convention: resolvesBrowser(mappings.convention),
				universal: resolvesBrowser(mappings.universal),
				import: resolvesBrowser(mappings['import-shared']),
				require: resolvesBrowser(mappings['require-shared']),
				node: resolvesBrowser(mappings.node),
			}).toStrictEqual({
				condition: true,
				convention: true,
				universal: false,
				import: false,
				require: false,
				node: false,
			})
			expect({
				silent: resolvesCommonJS(mappings.silent, scratch.path),
				module: resolvesCommonJS(mappings.module, scratch.path),
				nestedModule: resolvesCommonJS(mappings['nested-module'], scratch.path),
				nestedCommonJS: resolvesCommonJS(mappings['nested-commonjs'], scratch.path),
				esm: resolvesCommonJS(mappings.esm, scratch.path),
			}).toStrictEqual({
				silent: true,
				module: false,
				nestedModule: false,
				nestedCommonJS: true,
				esm: false,
			})
		} finally {
			scratch.destroy()
		}
	})
})

// The staged consumer, or a skip naming what the run could not reach. `it.skipIf`
// carries no reason, so the gate sits here where the test context can state one.
function requireStage(context: TestContext): DistributionStage {
	if (!STAGED) {
		return context.skip('`npm ping` did not answer, so nothing was packed or installed')
	}
	return STAGE
}

describe('installed package consumer', () => {
	it('packs one archive and installs it in isolation [requires the registry]', (context) => {
		const stage = requireStage(context)
		expect(stage.archives).toHaveLength(1)
		expect(existsSync(join(stage.installed, 'package.json'))).toBe(true)
		expect(stage.entries.length).toBeGreaterThan(0)
	})

	it('ships every relative target its exports map names [requires the registry]', (context) => {
		const stage = requireStage(context)
		const relative = stage.targets.filter((target) => target.startsWith('./'))
		expect(relative).not.toStrictEqual([])
		expect(relative.filter((target) => !existsSync(join(stage.installed, target)))).toStrictEqual(
			[],
		)
	})

	// Every published subpath is driven, excluded by name, or reported here. A dropped
	// one leaves no trace: no runtime test, no declaration comparison, and no place in
	// the resolution compile, so the run reports success for a subpath it never
	// measured.
	it('declares types for every module it publishes [requires the registry]', (context) => {
		const stage = requireStage(context)
		const partitioned = [
			...stage.entries.map((entry) => entry.subpath),
			...stage.undeclared,
			...stage.excluded,
		]
		expect(stage.undeclared).toStrictEqual([])
		expect(partitioned.sort()).toStrictEqual([...stage.subpaths].sort())
		// A driven subpath answers a runtime condition. One resolving a declaration and
		// no Node or browser target compiles for a consumer and throws when that consumer
		// loads it. Each later drive retires itself for that entry, so this assertion names
		// the subpath rather than counting it as driven.
		const unreachable = stage.entries.filter(
			(entry) => !entry.module && !entry.required && !entry.browser,
		)
		expect(unreachable.map((entry) => entry.subpath)).toStrictEqual([])
		const untypable = selectUntypable(stage.entries, stage.installed)
		expect(untypable.map((entry) => entry.subpath)).toStrictEqual([])
	})

	it('refuses a subpath its exports map does not name [requires the registry]', (context) => {
		const stage = requireStage(context)
		const name = readManifestName(join(stage.installed, 'package.json'))
		const driver = join(stage.consumer, ESM_DRIVER)
		const result = runNode([driver, `${name}${ABSENT_SUBPATH}`], stage.consumer)
		expect(result.status).not.toBe(0)
		expect(readSpawnOutput(result)).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED')
	})

	// The absent subpath is the firing control: a resolution that reports nothing
	// for every published entry has not been shown to resolve anything at all. Each
	// module format carries its own control, because a format that resolves nothing
	// is silent for the same reason a resolution that resolves nothing is.
	it('compiles a consumer under every module resolution [requires the registry]', (context) => {
		const stage = requireStage(context)
		const name = readManifestName(join(stage.installed, 'package.json'))
		const compilations = RESOLUTIONS.flatMap((driver) =>
			FORMATS.flatMap(([extension, format]) => {
				const compilation = checkResolution(stage, name, driver, extension, format)
				return compilation === undefined ? [] : [compilation]
			}),
		)
		expect(compilations.flatMap((compilation) => compilation.reported)).toStrictEqual([])
		expect(
			compilations
				.filter((compilation) => compilation.silent)
				.map((compilation) => compilation.label),
		).toStrictEqual([])
	})

	// This proof drives a Node import and a Node require and carries no browser
	// branch: the workspace published no browser face when it was written, and the
	// browser drive measures the packed artifact, so only a published face is owed
	// one. A private browser application does not select this branch. It declares the
	// browser launcher and its Vitest browser provider and gets the generated browser
	// configuration module beside it, but installed browser tooling does not stand for
	// a published browser face. `vite` selects nothing either, though the branch
	// imports it: scaffold puts `vite` in every workspace's base development
	// dependencies, whatever that workspace publishes. The later Node
	// `it.runIf` predicates retire each matching Node drive for a face published
	// later, which leaves nothing measuring it. So it reddens here and names the
	// subpath a browser branch is owed for. A workspace that gains one deletes this
	// file and runs the `repair` verb, which writes the variant carrying that branch.
	it('publishes no browser face this proof cannot drive [requires the registry]', (context) => {
		const stage = requireStage(context)
		const faces = stage.entries.filter((entry) => entry.browser)
		expect(faces.map((entry) => entry.subpath)).toStrictEqual([])
	})
})

for (const entry of STAGE?.entries ?? []) {
	describe(`installed entry ${entry.subpath}`, () => {
		it.runIf(entry.module)(
			'publishes what it declares to a Node import, and no more',
			(context) => {
				const stage = requireStage(context)
				// The exports-map walk resolved a declaration a typed importer reads, so an
				// entry reaching this drive without one is reported for that rather than for
				// what a consumer of a missing declaration goes on to say.
				if (!entry.declaration.module) {
					throw new Error(`${entry.subpath} publishes no import declaration`)
				}
				const published = driveRuntime(stage, entry.specifier, ESM_DRIVER)
				const drivers = selectDrivers(entry, 'module')
				expect(drivers).not.toStrictEqual([])
				const reported = drivers.flatMap((driver) =>
					checkSurface(stage, { entry, extension: 'ts', published, driver }),
				)
				expect(reported).toStrictEqual([])
			},
		)

		it.runIf(entry.required)(
			'publishes what it declares to a Node require, and no more',
			(context) => {
				const stage = requireStage(context)
				if (!entry.declaration.commonjs) {
					throw new Error(`${entry.subpath} publishes no require declaration`)
				}
				const published = driveRuntime(stage, entry.specifier, CJS_DRIVER)
				// A subpath whose `require` resolves to a module that no typed CommonJS
				// consumer can compile against carries no declared side to compare here, and
				// whether it may publish one at all is the untypable set's question rather
				// than this drive's. The preceding runtime drive ran either way.
				const drivers = selectDrivers(entry, 'commonjs')
				expect(drivers).not.toStrictEqual([])
				const reported = drivers.flatMap((driver) =>
					checkSurface(stage, { entry, extension: 'cts', published, driver }),
				)
				expect(reported).toStrictEqual([])
			},
		)
	})
}
