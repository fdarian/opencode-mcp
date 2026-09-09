import { BunContext } from '@effect/platform-bun';
import { Effect } from 'effect';
import { AcpAgent, AcpSessionError } from './acp-agent.ts';
import { prepareCodexAcpHome } from './codex-config.ts';

export class Codex extends Effect.Service<Codex>()('oagent/Codex', {
	effect: Effect.gen(function* () {
		const binary =
			process.env.OAGENT_CODEX_BIN !== undefined
				? process.env.OAGENT_CODEX_BIN
				: 'codex-acp';
		const acpAgent = yield* AcpAgent.pipe(
			Effect.provide(
				AcpAgent.Default({
					binary,
					args: [],
					clientInfoName: 'oagent',
					prepareEnv: () =>
						prepareCodexAcpHome().pipe(
							Effect.provide(BunContext.layer),
							Effect.mapError((cause) => new AcpSessionError({ cause })),
						),
				}),
			),
		);
		return {
			runTurn: (input: Parameters<typeof acpAgent.runTurn>[0]) =>
				acpAgent.runTurn(input),
			listModels: () => acpAgent.listModels(),
		};
	}),
}) {}
