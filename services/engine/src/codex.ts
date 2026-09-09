import { Effect } from 'effect';
import { AcpAgent } from './acp-agent.ts';

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
