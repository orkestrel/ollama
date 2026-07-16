import type { UserConfig } from 'vite'
import { defineConfig, mergeConfig } from 'vitest/config'
import tsconfig from './tsconfig.json' with { type: 'json' }
import { fileURLToPath, URL } from 'node:url'

export function resolveWorkspacePath(relativePath: string): string {
	return fileURLToPath(new URL(relativePath, import.meta.url))
}

const resolve = {
	alias: Object.entries(tsconfig.compilerOptions.paths).reduce(
		(a, [k, v]) => Object.assign(a, { [k]: resolveWorkspacePath(v[0]) }),
		{},
	),
}

// Base: shared resolve + build defaults + src:server tests (includes the Ollama
// provider surface — OllamaProvider + createOllama over a local Ollama daemon).
//
// The test project hits a REAL local Ollama: `setupOllama.ts` REQUIRES the daemon and
// WARMS the model before the suite, so a cold model load can't flake the live tests —
// hence the generous 60s test/hook timeouts and `fileParallelism: false` (serial, so
// the suite never hammers the daemon with concurrent files).
export const srcServer = (config?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			build: {
				emptyOutDir: true,
				sourcemap: true,
				minify: false,
				lib: {
					entry: resolveWorkspacePath('src/server/index.ts'),
					formats: ['es', 'cjs'],
					fileName: (format: string) => (format === 'es' ? 'index.js' : 'index.cjs'),
				},
				outDir: 'dist/src/server',
				target: 'node24',
				rolldownOptions: {
					external: (id: string) => id.startsWith('node:') || id.startsWith('@orkestrel/'),
				},
			},
			test: {
				name: { label: 'src:server', color: 'red' },
				include: ['tests/src/server/**/*.test.ts'],
				setupFiles: ['./tests/setup.ts', './tests/setupServer.ts'],
				environment: 'node',
				browser: { enabled: false },
				// The live Ollama tests warm + drive a real model; a cold load can take
				// seconds, so the 5s default would flake. Serial so the suite never hits
				// the daemon with concurrent files.
				testTimeout: 120_000,
				hookTimeout: 120_000,
				fileParallelism: false,
			},
		},
		config ?? {},
	)

// Extends shared resolve/build only — NOT srcServer's test setup (which loads
// setupOllama). The guides-parity suite reads guides/*.md off disk and must not
// require a live Ollama daemon.
export const guides = (config?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			test: {
				name: { label: 'guides', color: 'green' },
				include: ['tests/guides/**/*.test.ts'],
				exclude: ['tests/src/**/*.test.ts', 'tests/setup.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
				testTimeout: 5_000,
				hookTimeout: 5_000,
				fileParallelism: true,
			},
		},
		config ?? {},
	)

export default defineConfig({
	resolve,
	test: {
		projects: [srcServer, guides],
	},
})
