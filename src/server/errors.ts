// Errors for the Ollama provider. A single `OllamaHTTPError` carries the
// `/api/chat` HTTP status at the boundary — non-OK responses and a missing
// response body both throw it — so a `catch` can branch on `error.status`
// rather than parsing a message (AGENTS §12).

import type { OllamaErrorOptions } from './types.js'

/**
 * An error thrown when the Ollama `/api/chat` HTTP transport fails.
 *
 * @remarks
 * Carries the response `status` (0 when no HTTP response was received at all,
 * e.g. a `null` body). Thrown by {@link OllamaProvider} at its two HTTP
 * failure sites — the non-OK status branch and the null-body branch — so a
 * caller can branch on `error.status` instead of parsing the message. Narrow
 * a caught value with {@link isOllamaHTTPError}.
 *
 * @example
 * ```ts
 * try {
 * 	await provider.generate(messages, signal)
 * } catch (error) {
 * 	if (isOllamaHTTPError(error) && error.status === 404) {
 * 		// the configured model isn't pulled
 * 	}
 * }
 * ```
 */
export class OllamaHTTPError extends Error {
	readonly status: number

	constructor(message: string, status: number, options?: OllamaErrorOptions) {
		super(message, options)
		this.name = 'OllamaHTTPError'
		this.status = status
	}
}

/**
 * Whether a value is an {@link OllamaHTTPError}.
 *
 * @param value - The value to test
 * @returns `true` when `value` is an `OllamaHTTPError`
 */
export function isOllamaHTTPError(value: unknown): value is OllamaHTTPError {
	return value instanceof OllamaHTTPError
}
