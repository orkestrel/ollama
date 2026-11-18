import type {
	OllamaDaemonInterface,
	OllamaDaemonOptions,
	OllamaFixtureInterface,
	OllamaFixtureOptions,
} from './types.js'
import { OllamaDaemon } from './OllamaDaemon.js'
import { OllamaFixture } from './OllamaFixture.js'

/**
 * Creates an unstarted daemon with a snapshot of the caller's declaration and lifecycle hooks.
 * @param options - The dedicated executable, endpoint, model, and lifecycle declaration
 * @returns The dedicated daemon observation and control surface
 * @throws OllamaError Thrown when the declaration is malformed.
 * @example
 * ```ts
 * const daemon = createOllamaDaemon(declaration)
 * await daemon.start()
 * await daemon.destroy()
 * ```
 */
export function createOllamaDaemon(options: OllamaDaemonOptions): OllamaDaemonInterface {
	return new OllamaDaemon(options)
}

export async function createOllamaFixture(
	options: OllamaFixtureOptions,
): Promise<OllamaFixtureInterface> {
	const fixture = new OllamaFixture(options)
	try {
		await fixture.start()
	} catch (error) {
		await fixture.destroy()
		throw error
	}
	return fixture
}
