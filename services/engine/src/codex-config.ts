import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { PlatformError } from '@effect/platform/Error';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { Config, type ConfigError, Effect, Option, Schema } from 'effect';
import { getOagentBaseDir } from './paths.ts';

type TomlTable = Record<string, unknown>;

const COMPATIBILITY_KEY = 'default_subagent_reasoning_effort';

export class CodexConfigError extends Schema.TaggedError<CodexConfigError>()(
	'CodexConfigError',
	{
		message: Schema.String,
		cause: Schema.Defect,
	},
) {}

function isTomlTable(value: unknown): value is TomlTable {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
	return (
		value === null || (typeof value !== 'object' && typeof value !== 'function')
	);
}

function sourceHomeHash(sourceHome: string): string {
	return createHash('sha256').update(sourceHome).digest('hex').slice(0, 16);
}

function stringifyToml(document: TomlTable): string {
	const serialized = Bun.TOML.stringify(document);
	if (serialized === undefined) {
		throw new Error('Codex configuration could not be serialized');
	}
	return serialized;
}

export function projectCodexConfig(
	raw: string,
	sourceConfigDir: string,
): Effect.Effect<string, CodexConfigError> {
	return Effect.try({
		try: () => {
			const document = Bun.TOML.parse(raw);
			if (!isTomlTable(document)) {
				throw new Error('Codex configuration must be a TOML table');
			}

			const agents = document.agents;
			if (!isTomlTable(agents)) {
				return stringifyToml(document);
			}

			const compatibilityValue = agents[COMPATIBILITY_KEY];
			if (isScalar(compatibilityValue)) {
				delete agents[COMPATIBILITY_KEY];
			}

			for (const entry of Object.entries(agents)) {
				const roleName = entry[0];
				const role = entry[1];
				if (roleName === COMPATIBILITY_KEY || !isTomlTable(role)) {
					continue;
				}

				const configFile = role.config_file;
				if (typeof configFile === 'string' && !path.isAbsolute(configFile)) {
					role.config_file = path.resolve(sourceConfigDir, configFile);
				}
			}

			return stringifyToml(document);
		},
		catch: (cause) =>
			new CodexConfigError({
				message: `Unable to project Codex configuration: ${String(cause)}`,
				cause,
			}),
	});
}

function reconcileLink(
	fs: FileSystem,
	source: string,
	destination: string,
	retryAfterConcurrentCreate = true,
): Effect.Effect<void, PlatformError | CodexConfigError> {
	return Effect.gen(function* () {
		const sourceExists = yield* fs.exists(source);
		const existingLink = yield* fs.readLink(destination).pipe(Effect.either);

		if (existingLink._tag === 'Right') {
			if (existingLink.right !== source) {
				return yield* new CodexConfigError({
					message: `Refusing to replace unexpected Codex ACP link at ${destination}`,
					cause: new Error(`Expected ${source}, found ${existingLink.right}`),
				});
			}
			if (!sourceExists) {
				yield* fs.remove(destination);
			}
			return;
		}

		const destinationExists = yield* fs.exists(destination);
		if (destinationExists) {
			return yield* new CodexConfigError({
				message: `Refusing to replace regular file at ${destination}`,
				cause: existingLink.left,
			});
		}
		if (sourceExists) {
			yield* fs.symlink(source, destination).pipe(
				Effect.catchAll((cause) => {
					if (
						cause._tag !== 'SystemError' ||
						cause.reason !== 'AlreadyExists' ||
						!retryAfterConcurrentCreate
					) {
						return Effect.fail(cause);
					}
					return reconcileLink(fs, source, destination, false);
				}),
			);
		}
	});
}

function writeProjectedConfig(
	fs: FileSystem,
	configPath: string,
	contents: string,
): Effect.Effect<void, PlatformError> {
	const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
	return fs
		.writeFileString(temporaryPath, contents, { flag: 'wx', mode: 0o600 })
		.pipe(
			Effect.zipRight(fs.rename(temporaryPath, configPath)),
			Effect.ensuring(
				fs.remove(temporaryPath, { force: true }).pipe(Effect.orDie),
			),
		);
}

export function prepareCodexAcpHome(options?: {
	sourceHome?: string;
	oagentBaseDir?: string;
}): Effect.Effect<
	{ CODEX_HOME: string },
	ConfigError.ConfigError | PlatformError | CodexConfigError,
	FileSystem | Path
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem;
		const path = yield* Path;
		const configuredSourceHome = Option.getOrNull(
			yield* Config.string('CODEX_HOME').pipe(Config.option),
		);
		const requestedSourceHome = options?.sourceHome;
		const sourceHome = path.resolve(
			requestedSourceHome !== undefined
				? requestedSourceHome
				: configuredSourceHome !== null
					? configuredSourceHome
					: path.join(os.homedir(), '.codex'),
		);
		const baseDir =
			options?.oagentBaseDir !== undefined
				? path.resolve(options.oagentBaseDir)
				: yield* getOagentBaseDir;
		const acpHome = path.join(baseDir, 'codex-acp', sourceHomeHash(sourceHome));
		const sourceConfigPath = path.join(sourceHome, 'config.toml');
		const projectedConfigPath = path.join(acpHome, 'config.toml');

		yield* fs.makeDirectory(acpHome, { recursive: true, mode: 0o700 });
		yield* fs.chmod(acpHome, 0o700);

		if (yield* fs.exists(sourceConfigPath)) {
			const sourceConfig = yield* fs.readFileString(sourceConfigPath);
			const projectedConfig = yield* projectCodexConfig(
				sourceConfig,
				sourceHome,
			);
			yield* writeProjectedConfig(fs, projectedConfigPath, projectedConfig);
		} else {
			yield* fs.remove(projectedConfigPath, { force: true });
		}

		for (const name of ['auth.json', 'AGENTS.md', 'skills']) {
			yield* reconcileLink(
				fs,
				path.join(sourceHome, name),
				path.join(acpHome, name),
			);
		}

		return { CODEX_HOME: acpHome };
	});
}
