import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileSystem } from '@effect/platform/FileSystem';
import type { Path } from '@effect/platform/Path';
import { BunContext } from '@effect/platform-bun';
import { Effect } from 'effect';
import { createAcpConnection } from './acp-agent.ts';
import { prepareCodexAcpHome, projectCodexConfig } from './codex-config.ts';

async function withTemporaryDirectory(
	run: (directory: string) => Promise<void>,
): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oagent-codex-'));
	try {
		await run(directory);
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
}

function runConfigEffect<A, E>(
	effect: Effect.Effect<A, E, FileSystem | Path>,
): Promise<A> {
	return Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)));
}

describe('Codex ACP configuration', () => {
	test('projects only the incompatible scalar and resolves role config files', async () => {
		const projected = await runConfigEffect(
			projectCodexConfig(
				`[agents]\ndefault_subagent_reasoning_effort = "high"\n\n[agents.reviewer]\nconfig_file = "roles/reviewer.toml"\nmodel = "gpt-5"\n\n[projects."/workspace"]\ntrust_level = "trusted"\n\n[mcp_servers.example]\ncommand = "example"\n`,
				'/source/.codex',
			),
		);
		const document = Bun.TOML.parse(projected) as Record<string, unknown>;
		const agents = document.agents as Record<string, unknown>;
		const reviewer = agents.reviewer as Record<string, unknown>;
		const projects = document.projects as Record<string, unknown>;
		const project = projects['/workspace'] as Record<string, unknown>;
		const mcpServers = document.mcp_servers as Record<string, unknown>;
		const server = mcpServers.example as Record<string, unknown>;

		expect(agents.default_subagent_reasoning_effort).toBeUndefined();
		expect(reviewer.config_file).toBe('/source/.codex/roles/reviewer.toml');
		expect(reviewer.model).toBe('gpt-5');
		expect(project.trust_level).toBe('trusted');
		expect(server.command).toBe('example');
	});

	test('reconciles a persistent isolated home without copying credentials', async () => {
		await withTemporaryDirectory(async (directory) => {
			const sourceHome = path.join(directory, 'source');
			const baseDir = path.join(directory, 'oagent');
			await fs.mkdir(path.join(sourceHome, 'skills'), { recursive: true });
			await fs.writeFile(
				path.join(sourceHome, 'config.toml'),
				'[agents]\ndefault_subagent_reasoning_effort = "high"\n',
			);
			await fs.writeFile(
				path.join(sourceHome, 'auth.json'),
				'{"fixture":true}',
			);
			await fs.writeFile(path.join(sourceHome, 'AGENTS.md'), 'fixture');

			const environment = await runConfigEffect(
				prepareCodexAcpHome({ oagentBaseDir: baseDir, sourceHome }),
			);
			const projectedConfig = await fs.readFile(
				path.join(environment.CODEX_HOME, 'config.toml'),
				'utf8',
			);

			expect(Bun.TOML.parse(projectedConfig)).toEqual({ agents: {} });
			expect(
				await fs.readlink(path.join(environment.CODEX_HOME, 'auth.json')),
			).toBe(path.join(sourceHome, 'auth.json'));
			expect(
				await fs.readlink(path.join(environment.CODEX_HOME, 'AGENTS.md')),
			).toBe(path.join(sourceHome, 'AGENTS.md'));
			expect(
				await fs.readlink(path.join(environment.CODEX_HOME, 'skills')),
			).toBe(path.join(sourceHome, 'skills'));

			await fs.rm(path.join(sourceHome, 'config.toml'));
			await runConfigEffect(
				prepareCodexAcpHome({ oagentBaseDir: baseDir, sourceHome }),
			);
			expect(
				await Bun.file(
					path.join(environment.CODEX_HOME, 'config.toml'),
				).exists(),
			).toBe(false);
		});
	});

	test('refuses to overwrite a regular ACP credential file', async () => {
		await withTemporaryDirectory(async (directory) => {
			const sourceHome = path.join(directory, 'source');
			const baseDir = path.join(directory, 'oagent');
			await fs.mkdir(sourceHome, { recursive: true });
			const environment = await runConfigEffect(
				prepareCodexAcpHome({ oagentBaseDir: baseDir, sourceHome }),
			);
			await fs.writeFile(
				path.join(environment.CODEX_HOME, 'auth.json'),
				'{"local":true}',
			);
			await fs.writeFile(path.join(sourceHome, 'auth.json'), '{"source":true}');

			await expect(
				runConfigEffect(
					prepareCodexAcpHome({ oagentBaseDir: baseDir, sourceHome }),
				),
			).rejects.toThrow('Refusing to replace regular file');
		});
	});

	test.skipIf(Bun.which('codex-acp') === null)(
		'starts the installed ACP against a projected home within five seconds',
		async () => {
			await withTemporaryDirectory(async (directory) => {
				const sourceHome = path.join(directory, 'source');
				const baseDir = path.join(directory, 'oagent');
				await fs.mkdir(sourceHome, { recursive: true });
				await fs.writeFile(
					path.join(sourceHome, 'config.toml'),
					'[agents]\ndefault_subagent_reasoning_effort = "high"\n',
				);
				const environment = await runConfigEffect(
					prepareCodexAcpHome({ oagentBaseDir: baseDir, sourceHome }),
				);

				const connection = Effect.scoped(
					createAcpConnection({
						args: [],
						binary: 'codex-acp',
						clientInfoName: 'oagent-test',
						prepareEnv: () => Effect.succeed(environment),
					}),
				).pipe(
					Effect.timeoutFail({
						duration: '5 seconds',
						onTimeout: () =>
							new Error('codex-acp did not initialize within 5 seconds'),
					}),
				);

				await Effect.runPromise(connection);
			});
		},
	);
});
