import { join } from 'node:path';
import { cli, defineDevCli } from '@oagent/common';
import { Effect } from 'effect';
import webPackage from '../package.json' with { type: 'json' };

const REPO_ROOT = join(import.meta.dirname, '../../..');

const main = defineDevCli({
	name: webPackage.name,
	dir: join(REPO_ROOT, 'apps/web'),
	options: {
		local: cli.Options.text('local').pipe(
			cli.Options.withDefault(''),
			cli.Options.withDescription(
				'Use a local engine service (e.g., "engine")',
			),
		),
	},
	run: (ctx, opts) =>
		Effect.gen(function* () {
			const s = yield* ctx.session;
			yield* Effect.logInfo(`[dev] session: ${s.name}`);

			const localEngine = opts.local as string;
			let engineUrl: string;

			if (localEngine === 'engine') {
				const engine = yield* ctx.awaitRunning<{ url: string }>(
					'@oagent/engine',
				);
				engineUrl = engine.url;
				yield* Effect.logInfo(`[dev] using local engine url: ${engineUrl}`);
			} else {
				engineUrl = 'http://localhost:17777';
				yield* Effect.logInfo(`[dev] using default engine url: ${engineUrl}`);
			}

			yield* ctx.runManagedSubprocess('pnpm', ['vite'], {
				env: { ENGINE_URL: engineUrl },
			});
		}),
});

main(process.argv);
