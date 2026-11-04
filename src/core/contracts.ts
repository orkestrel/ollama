import type { ContractInterface } from '@orkestrel/contract'
import { createContract } from '@orkestrel/contract'
import { ollamaJudgeOptionsShape, ollamaOptionsShape } from './shapers.js'

/**
 * Holds the compiled contract a provider's constructor checks its serializable options against.
 *
 * @example
 * ```ts
 * import { ollamaOptionsContract } from '@orkestrel/ollama'
 *
 * ollamaOptionsContract.audit({ model: 'qwen3.5:2b-q4_K_M', keepalive: '5m' })
 * // [{ reason: 'extra', path: ['keepalive'] }]
 * ```
 */
export const ollamaOptionsContract: ContractInterface<unknown> = createContract(ollamaOptionsShape)

/**
 * Holds the compiled contract a judge's constructor checks its serializable options against.
 *
 * @example
 * ```ts
 * import { ollamaJudgeOptionsContract } from '@orkestrel/ollama'
 *
 * ollamaJudgeOptionsContract.is({ model: 'mica', system: 'Judge the state.' }) // true
 * ```
 */
export const ollamaJudgeOptionsContract: ContractInterface<unknown> =
	createContract(ollamaJudgeOptionsShape)
