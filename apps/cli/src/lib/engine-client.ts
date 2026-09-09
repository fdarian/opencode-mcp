import type { EngineRouter } from '@oagent/engine';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';

export type EngineClient = RouterClient<EngineRouter>;

export const defaultEngineUrl = `http://localhost:${process.env.OPENCODE_MCP_PORT ?? '17777'}`;

/**
 * Custom fetch that disables Bun's default 300s timeout so long-poll wait
 * requests (held up to CHUNK_MS = 10 min by the engine) aren't guillotined
 * before the server responds.
 */
function fetchNoTimeout(
	request: Request,
	init: { redirect?: Request['redirect'] },
): Promise<Response> {
	return fetch(request, {
		...init,
		timeout: false,
	});
}

export function createEngineClient(engineUrl: string): EngineClient {
	const link = new RPCLink({
		url: new URL('/rpc', engineUrl),
		fetch: fetchNoTimeout,
	});
	return createORPCClient(link);
}
