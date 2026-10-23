import type { OllamaDaemonInterface, OllamaDaemonOptions } from './types.js'
import { OllamaDaemon } from './OllamaDaemon.js'

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
