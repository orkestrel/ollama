// Errors for the Ollama provider. A single `OllamaHTTPError` carries the
// `/api/chat` HTTP status at the boundary — non-OK responses and a missing
// response body both throw it — so a `catch` can branch on `error.status`
// rather than parsing a message.

import type { OllamaHTTPErrorOptions } from './types.js'

/**
 * Represents an error thrown when the Ollama `/api/chat` HTTP transport fails.
 *
 * @remarks
 * Carries the machine-readable `code` `'HTTP'` and the response `status` (0 when no
 * HTTP response was received at all, for example a `null` body). Thrown by
 * {@link OllamaProvider} at its HTTP failure sites — the non-OK status branch and the
 * null-body branch — so a caller can branch on `error.code` and read `error.status`
 * for the HTTP number instead of parsing the message. Narrow a caught value with
 * {@link isOllamaHTTPError}.
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
	/**
	 * Names the machine-readable condition this error reports — `'HTTP'`: an `/api/chat`
	 * transport, status, or body failure.
	 */
	readonly code = 'HTTP' as const
	readonly status: number

	constructor(message: string, status: number, options?: OllamaHTTPErrorOptions) {
		super(message, options)
		this.name = 'OllamaHTTPError'
		this.status = status
	}
}

/**
 * Checks whether a value is an {@link OllamaHTTPError}.
 *
 * @param value - The value to test
 * @returns True if `value` is an `OllamaHTTPError`; false otherwise
 */
export function isOllamaHTTPError(value: unknown): value is OllamaHTTPError {
	return value instanceof OllamaHTTPError
}
