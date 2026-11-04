import type { ContractInterface } from '@orkestrel/contract'
import { createContract } from '@orkestrel/contract'
import { ollamaDaemonShape } from './shapers.js'

/**
 * Holds the compiled contract whose audit names a refused daemon declaration's faults by path.
 *
 * @example
 * ```ts
 * import { ollamaDaemonContract } from '@orkestrel/ollama/server'
 *
 * ollamaDaemonContract.is({}) // false
 * ```
 */
export const ollamaDaemonContract: ContractInterface<unknown> = createContract(ollamaDaemonShape)
