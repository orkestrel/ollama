// This raw protocol entry must run without a TypeScript loader or sibling imports.
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs'

const [mode = 'normal'] = process.argv.slice(2)
const origin = new URL(`http://${process.env.OLLAMA_HOST}`)
const models = process.env.FIXTURE_MODELS
	? JSON.parse(process.env.FIXTURE_MODELS)
	: [{ name: 'fixture:雪', digest: mode === 'digest' ? 'wrong-digest' : 'fixture-digest' }]
if (origin.hostname !== '127.0.0.1' || origin.port === '11434' || origin.port === '') {
	throw new Error('The fixture requires a dedicated loopback port')
}
if (process.env.FIXTURE_PID) writeFileSync(process.env.FIXTURE_PID, String(process.pid))
if (mode === 'sentinel' || mode === 'runner') {
	process.stdout.write(`${process.pid}\n`)
	setInterval(() => {}, 60_000)
} else if (mode === 'exit') {
	process.exitCode = 7
} else {
	const runner =
		mode === 'tree'
			? spawn(process.execPath, [process.argv[1], 'runner'], {
					stdio: ['ignore', 'ignore', 'ignore'],
					env: process.env,
				})
			: undefined
	if (runner && process.env.FIXTURE_RUNNER)
		writeFileSync(process.env.FIXTURE_RUNNER, String(runner.pid))
	const server = createServer(async (request, response) => {
		const chunks = []
		for await (const chunk of request) chunks.push(chunk)
		if (process.env.FIXTURE_REQUESTS)
			appendFileSync(
				process.env.FIXTURE_REQUESTS,
				`${JSON.stringify({ path: request.url, body: Buffer.concat(chunks).toString() })}\n`,
			)
		if (mode === 'die-reply') {
			process.exit(8)
			return
		}
		if (mode === 'redirect') {
			response.writeHead(302, { location: '/api/generate' }).end()
			return
		}
		if (mode === 'oversized') {
			response.end('x'.repeat(4096))
			return
		}
		if (mode === 'slow') return
		if (mode === 'delayed' && request.url === '/api/version')
			await new Promise((resolve) => setTimeout(resolve, 1550))
		response.setHeader('content-type', 'application/json')
		response.end(
			JSON.stringify(
				request.url === '/api/version'
					? { version: mode === 'version' ? 'wrong-version' : '0.40.8' }
					: request.url === '/api/tags'
						? { models }
						: {
								model:
									process.env.FIXTURE_UNLOAD && existsSync(process.env.FIXTURE_UNLOAD)
										? readFileSync(process.env.FIXTURE_UNLOAD, 'utf8')
										: mode === 'unload'
											? 'other-model'
											: JSON.parse(Buffer.concat(chunks).toString()).model,
								done: true,
								eval_count: 0,
							},
			),
		)
	})
	server.on('error', (error) => {
		process.stderr.write(`${error.message}\n`)
		process.exit(9)
	})
	if (mode === 'bind') {
		const occupant = createNetServer()
		occupant.listen(Number(origin.port), origin.hostname, () =>
			server.listen(Number(origin.port), origin.hostname),
		)
	} else {
		server.listen(Number(origin.port), origin.hostname, () => {
			if (mode !== 'silence')
				process.stderr.write(
					`time=2026 level=INFO msg="Listening on 127.0.0.1:${origin.port} (version 0.40.8)"\n`,
				)
		})
	}
}
