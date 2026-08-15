/// <reference types="bun" />

import { EventEmitter } from 'node:events';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { randomUUIDv7 } from 'bun';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { Effect, Fiber, Schema } from 'effect';
import { Codex } from './codex.ts';
import { Cursor } from './cursor.ts';
import { assembleEvent } from './db/assembleEvent.ts';
import { Db } from './db/client.ts';
import * as schema from './db/schema.ts';
import { Grok } from './grok.ts';
import { OpenCode } from './opencode.ts';

class JobNotFound extends Schema.TaggedError<JobNotFound>()('JobNotFound', {
	jobId: Schema.String,
}) {}

export class ModelResolutionError extends Schema.TaggedError<ModelResolutionError>()(
	'ModelResolutionError',
	{
		code: Schema.Literal(
			'MISSING',
			'INVALID_FORMAT',
			'UNKNOWN_BACKEND',
			'UNKNOWN_ALIAS',
		),
		message: Schema.String,
	},
) {}

type JobOk = {
	readonly sessionId: string;
	readonly text: string;
	readonly stopReason: string | undefined;
};

type WaitResult =
	| { readonly status: 'running' }
	| {
			readonly status: 'done';
			readonly sessionId: string;
			readonly text: string;
			readonly stopReason: string | undefined;
	  }
	| { readonly status: 'error'; readonly message: string }
	| { readonly status: 'cancelled' };

type EventPage = {
	events: { event: SessionUpdate; sequence: number }[];
	nextCursor: number | null;
};

type JobsChange = {
	type: 'created' | 'status';
	jobId: string;
	status?: string;
};

const TIMEOUT_DEFAULT_MS = 50_000;

export const DEFAULT_START_TIMEOUT_MS = 30 * 60 * 1000;

/** Sentinel event type emitted to SSE subscribers when a job reaches terminal status. */
const TERMINAL_EVENT = '__terminal__';

export class Jobs extends Effect.Service<Jobs>()('oagent/Jobs', {
	effect: Effect.gen(function* () {
		const opencode = yield* OpenCode;
		const cursor = yield* Cursor;
		const grok = yield* Grok;
		const codex = yield* Codex;
		const { db } = yield* Db;

		const resolveModel = (
			model: string,
		): Effect.Effect<
			{ backend: string; modelId: string },
			ModelResolutionError,
			never
		> =>
			Effect.gen(function* () {
				const colonIdx = model.indexOf(':');
				if (colonIdx !== -1) {
					const backend = model.slice(0, colonIdx);
					const modelId = model.slice(colonIdx + 1);
					if (
						backend !== 'opencode' &&
						backend !== 'cursor' &&
						backend !== 'grok' &&
						backend !== 'codex'
					) {
						return yield* new ModelResolutionError({
							code: 'UNKNOWN_BACKEND',
							message: `Unknown backend "${backend}". Valid backends: opencode, cursor, grok, codex.`,
						});
					}
					return { backend, modelId };
				}

				const alias = db
					.select()
					.from(schema.modelAliases)
					.where(eq(schema.modelAliases.name, model))
					.limit(1)
					.get();

				if (alias === undefined) {
					return yield* new ModelResolutionError({
						code: 'UNKNOWN_ALIAS',
						message: `Model "${model}" is not a defined alias. Pass <backend>:<modelId> or define an alias first.`,
					});
				}

				return { backend: alias.backend, modelId: alias.model_id };
			});

		const liveEmitters = new Map<string, EventEmitter>();
		const liveFibers = new Map<string, Fiber.RuntimeFiber<JobOk, unknown>>();
		const jobsEmitter = new EventEmitter();
		jobsEmitter.setMaxListeners(0);

		const insertEvent = (jobId: number, event: SessionUpdate): number => {
			return db.transaction((tx) => {
				const meta =
					'_meta' in event && event._meta !== undefined && event._meta !== null
						? (event._meta as Record<string, unknown>)
						: null;

				const eventRow = tx
					.insert(schema.events)
					.values({
						job_id: jobId,
						type: event.sessionUpdate,
						meta,
					})
					.returning({ id: schema.events.id })
					.get();
				if (eventRow === undefined) {
					throw new Error('Failed to insert event');
				}
				const eventId = eventRow.id;

				switch (event.sessionUpdate) {
					case 'user_message_chunk':
					case 'agent_message_chunk':
					case 'agent_thought_chunk': {
						tx.insert(schema.chunkEvents)
							.values({
								event_id: eventId,
								message_id: event.messageId ?? null,
								content: event.content,
							})
							.run();
						break;
					}
					case 'tool_call':
					case 'tool_call_update': {
						tx.insert(schema.toolCallEvents)
							.values({
								event_id: eventId,
								tool_call_id: event.toolCallId,
								title: event.title ?? null,
								status: event.status ?? null,
								kind: event.kind ?? null,
								content: event.content ?? null,
								locations: event.locations ?? null,
								raw_input: event.rawInput ?? null,
								raw_output: event.rawOutput ?? null,
							})
							.run();
						break;
					}
					case 'plan': {
						tx.insert(schema.planEvents)
							.values({
								event_id: eventId,
								entries: event.entries,
							})
							.run();
						break;
					}
					case 'available_commands_update': {
						tx.insert(schema.availableCommandsEvents)
							.values({
								event_id: eventId,
								available_commands: event.availableCommands,
							})
							.run();
						break;
					}
					case 'current_mode_update': {
						tx.insert(schema.currentModeEvents)
							.values({
								event_id: eventId,
								current_mode_id: event.currentModeId,
							})
							.run();
						break;
					}
					case 'config_option_update': {
						tx.insert(schema.configOptionEvents)
							.values({
								event_id: eventId,
								config_options: event.configOptions,
							})
							.run();
						break;
					}
					case 'session_info_update': {
						tx.insert(schema.sessionInfoEvents)
							.values({
								event_id: eventId,
								title: event.title ?? null,
								updated_at: event.updatedAt ?? null,
							})
							.run();
						break;
					}
					case 'usage_update': {
						tx.insert(schema.usageEvents)
							.values({
								event_id: eventId,
								size: event.size,
								used: event.used,
								cost_amount: event.cost?.amount ?? null,
								cost_currency: event.cost?.currency ?? null,
							})
							.run();
						break;
					}
				}

				return eventId;
			});
		};

		const readEventsPage = (
			jobId: number,
			sinceId: number,
			limit: number,
		): EventPage => {
			const rows = db
				.select()
				.from(schema.events)
				.leftJoin(
					schema.chunkEvents,
					eq(schema.events.id, schema.chunkEvents.event_id),
				)
				.leftJoin(
					schema.toolCallEvents,
					eq(schema.events.id, schema.toolCallEvents.event_id),
				)
				.leftJoin(
					schema.planEvents,
					eq(schema.events.id, schema.planEvents.event_id),
				)
				.leftJoin(
					schema.availableCommandsEvents,
					eq(schema.events.id, schema.availableCommandsEvents.event_id),
				)
				.leftJoin(
					schema.currentModeEvents,
					eq(schema.events.id, schema.currentModeEvents.event_id),
				)
				.leftJoin(
					schema.configOptionEvents,
					eq(schema.events.id, schema.configOptionEvents.event_id),
				)
				.leftJoin(
					schema.sessionInfoEvents,
					eq(schema.events.id, schema.sessionInfoEvents.event_id),
				)
				.leftJoin(
					schema.usageEvents,
					eq(schema.events.id, schema.usageEvents.event_id),
				)
				.where(
					and(eq(schema.events.job_id, jobId), gt(schema.events.id, sinceId)),
				)
				.orderBy(schema.events.created_at, schema.events.id)
				.limit(limit + 1)
				.all();

			const hasMore = rows.length === limit + 1;
			const pageRows = hasMore ? rows.slice(0, limit) : rows;

			const events = pageRows.map((row) => {
				const event = assembleEvent(
					{
						id: row.events.id,
						job_id: row.events.job_id,
						created_at: row.events.created_at,
						type: row.events.type,
						meta: row.events.meta,
					},
					{
						message_id: row.chunk_events?.message_id ?? null,
						content: row.chunk_events?.content ?? null,
						tool_call_id: row.tool_call_events?.tool_call_id ?? null,
						tool_content: row.tool_call_events?.content ?? null,
						title: row.tool_call_events?.title ?? null,
						status: row.tool_call_events?.status ?? null,
						kind: row.tool_call_events?.kind ?? null,
						locations: row.tool_call_events?.locations ?? null,
						raw_input: row.tool_call_events?.raw_input ?? null,
						raw_output: row.tool_call_events?.raw_output ?? null,
						entries: row.plan_events?.entries ?? null,
						available_commands:
							row.available_commands_events?.available_commands ?? null,
						current_mode_id: row.current_mode_events?.current_mode_id ?? null,
						config_options: row.config_option_events?.config_options ?? null,
						updated_at: row.session_info_events?.updated_at ?? null,
						size: row.usage_events?.size ?? null,
						used: row.usage_events?.used ?? null,
						cost_amount: row.usage_events?.cost_amount ?? null,
						cost_currency: row.usage_events?.cost_currency ?? null,
					},
				);
				return { event, sequence: row.events.id };
			});

			const nextCursor = (() => {
				if (!hasMore) return null;
				const last = pageRows[pageRows.length - 1];
				if (last === undefined) return null;
				return last.events.id;
			})();

			return { events, nextCursor };
		};

		const start = (input: {
			prompt: string;
			model?: string;
			sessionId?: string;
			mcpSessionId?: string;
			cwd: string;
		}): Effect.Effect<{ jobId: string }, ModelResolutionError, never> =>
			Effect.gen(function* () {
				const uuid = randomUUIDv7();

				const model = input.model;
				if (model === undefined) {
					return yield* new ModelResolutionError({
						code: 'MISSING',
						message:
							'model is required: specify `<backend>:<modelId>` or an alias name',
					});
				}

				const { backend, modelId: rest } = yield* resolveModel(model);

				const jobRow = db
					.insert(schema.jobs)
					.values({
						uuid,
						status: 'running',
						prompt: input.prompt,
						cwd: input.cwd,
						model: rest,
						backend,
						mcp_session_id: input.mcpSessionId,
					})
					.returning({ id: schema.jobs.id })
					.get();
				if (jobRow === undefined) {
					throw new Error('Failed to insert job');
				}
				const internalId = jobRow.id;
				jobsEmitter.emit('change', { type: 'created', jobId: uuid });

				const emitter = new EventEmitter();
				emitter.setMaxListeners(0);
				liveEmitters.set(uuid, emitter);

				const onEvent = (event: SessionUpdate): void => {
					const eventId = insertEvent(internalId, event);
					emitter.emit('event', { event, sequence: eventId });
				};

				const closeResources = Effect.sync(() => {
					liveEmitters.delete(uuid);
					liveFibers.delete(uuid);
					emitter.emit(TERMINAL_EVENT);
				});

				const runTurnEffect = (() => {
					if (backend === 'opencode') {
						return opencode.runTurn({
							prompt: input.prompt,
							model: rest,
							sessionId: input.sessionId,
							cwd: input.cwd,
							onEvent,
						});
					}
					if (backend === 'grok') {
						return grok.runTurn({
							prompt: input.prompt,
							model: rest,
							sessionId: input.sessionId,
							cwd: input.cwd,
							onEvent,
						});
					}
					if (backend === 'codex') {
						return codex.runTurn({
							prompt: input.prompt,
							model: rest,
							sessionId: input.sessionId,
							cwd: input.cwd,
							onEvent,
						});
					}
					return cursor.runTurn({
						prompt: input.prompt,
						model: rest,
						sessionId: input.sessionId,
						cwd: input.cwd,
						onEvent,
						onExtensionEvent: (method, params) => {
							onEvent({
								sessionUpdate: 'cursor_extension',
								_meta: { method, params },
							} as unknown as SessionUpdate);
						},
					});
				})();

				const fiber = yield* Effect.forkDaemon(
					runTurnEffect.pipe(
						Effect.tap((result) =>
							Effect.sync(() => {
								db.update(schema.jobs)
									.set({
										status: 'done',
										session_id: result.sessionId,
										text: result.text,
										stop_reason: result.stopReason ?? null,
										terminated_at: new Date(),
									})
									.where(eq(schema.jobs.id, internalId))
									.run();
								jobsEmitter.emit('change', {
									type: 'status',
									jobId: uuid,
									status: 'done',
								});
							}),
						),
						Effect.tapError((error) =>
							Effect.sync(() => {
								db.update(schema.jobs)
									.set({
										status: 'error',
										error_message: formatJobError(error),
										terminated_at: new Date(),
									})
									.where(eq(schema.jobs.id, internalId))
									.run();
								jobsEmitter.emit('change', {
									type: 'status',
									jobId: uuid,
									status: 'error',
								});
							}),
						),
						Effect.ensuring(closeResources),
					),
				);

				liveFibers.set(uuid, fiber);
				return { jobId: uuid };
			});

		const cancel = (input: {
			jobId: string;
		}): Effect.Effect<void, JobNotFound, never> =>
			Effect.gen(function* () {
				const job = db
					.select()
					.from(schema.jobs)
					.where(eq(schema.jobs.uuid, input.jobId))
					.limit(1)
					.get();

				if (job === undefined) {
					return yield* Effect.fail(new JobNotFound({ jobId: input.jobId }));
				}

				if (job.status !== 'running') {
					return;
				}

				db.update(schema.jobs)
					.set({ status: 'cancelled', terminated_at: new Date() })
					.where(eq(schema.jobs.id, job.id))
					.run();
				jobsEmitter.emit('change', {
					type: 'status',
					jobId: input.jobId,
					status: 'cancelled',
				});

				const fiber = liveFibers.get(input.jobId);
				if (fiber !== undefined) {
					yield* Fiber.interrupt(fiber);
				}
			});

		const wait = (input: {
			jobId: string;
			timeoutMs?: number;
		}): Effect.Effect<WaitResult, JobNotFound, never> =>
			Effect.gen(function* () {
				const job = db
					.select()
					.from(schema.jobs)
					.where(eq(schema.jobs.uuid, input.jobId))
					.limit(1)
					.get();

				if (job === undefined) {
					return yield* Effect.fail(new JobNotFound({ jobId: input.jobId }));
				}

				if (job.status !== 'running') {
					return toWaitResult(job);
				}

				const cap = input.timeoutMs ?? TIMEOUT_DEFAULT_MS;
				const fiber = liveFibers.get(input.jobId);

				if (fiber !== undefined) {
					yield* Fiber.join(fiber).pipe(Effect.exit, Effect.timeoutOption(cap));

					const updated = db
						.select()
						.from(schema.jobs)
						.where(eq(schema.jobs.uuid, input.jobId))
						.limit(1)
						.get();
					if (updated === undefined) {
						return yield* Effect.fail(new JobNotFound({ jobId: input.jobId }));
					}
					return toWaitResult(updated);
				}

				// Defensive fallback: poll the row at 500ms cadence
				const startTime = Date.now();
				const deadline = startTime + cap;
				while (Date.now() < deadline) {
					const row = db
						.select()
						.from(schema.jobs)
						.where(eq(schema.jobs.uuid, input.jobId))
						.limit(1)
						.get();
					if (row === undefined) {
						return yield* Effect.fail(new JobNotFound({ jobId: input.jobId }));
					}
					if (row.status !== 'running') {
						return toWaitResult(row);
					}
					Bun.sleepSync(500);
				}
				return { status: 'running' };
			});

		type JobSummary = {
			id: string;
			status: 'running' | 'done' | 'error' | 'cancelled';
			createdAt: number;
			terminatedAt?: number;
			prompt: string;
			cwd: string;
			model?: string;
			mcpSessionId?: string;
		};

		const toJobSummary = (
			row: typeof schema.jobs.$inferSelect,
		): JobSummary => ({
			id: row.uuid,
			status: row.status,
			createdAt: row.created_at.getTime(),
			terminatedAt: row.terminated_at?.getTime(),
			prompt: row.prompt,
			cwd: row.cwd,
			model: row.model ?? undefined,
			mcpSessionId: row.mcp_session_id ?? undefined,
		});

		const list = (): JobSummary[] => {
			const rows = db
				.select()
				.from(schema.jobs)
				.orderBy(
					sql`(${schema.jobs.status} = 'running') DESC`,
					desc(schema.jobs.created_at),
				)
				.all();

			return rows.map(toJobSummary);
		};

		const listByMcpSession = (mcpSessionId: string): JobSummary[] => {
			const rows = db
				.select()
				.from(schema.jobs)
				.where(eq(schema.jobs.mcp_session_id, mcpSessionId))
				.orderBy(
					sql`(${schema.jobs.status} = 'running') DESC`,
					desc(schema.jobs.created_at),
				)
				.all();

			return rows.map(toJobSummary);
		};

		const getDetail = (
			jobId: string,
		):
			| {
					id: string;
					status: 'running' | 'done' | 'error' | 'cancelled';
					createdAt: number;
					terminatedAt?: number;
					prompt: string;
					cwd: string;
					model?: string;
					recentEvents: SessionUpdate[];
			  }
			| undefined => {
			const job = db
				.select()
				.from(schema.jobs)
				.where(eq(schema.jobs.uuid, jobId))
				.limit(1)
				.get();
			if (job === undefined) return undefined;

			const allEvents: SessionUpdate[] = [];
			let cursor = 0;
			while (true) {
				const page = readEventsPage(job.id, cursor, 100);
				for (const item of page.events) {
					allEvents.push(item.event);
				}
				if (page.nextCursor === null) break;
				cursor = page.nextCursor;
			}
			return {
				id: job.uuid,
				status: job.status,
				createdAt: job.created_at.getTime(),
				terminatedAt: job.terminated_at?.getTime(),
				prompt: job.prompt,
				cwd: job.cwd,
				model: job.model ?? undefined,
				recentEvents: allEvents,
			};
		};

		const subscribe = (
			jobId: string,
			listener: (
				payload:
					| { type: 'event'; event: SessionUpdate; sequence: number }
					| { type: 'terminal' },
			) => void,
		): (() => void) => {
			const emitter = liveEmitters.get(jobId);
			if (emitter === undefined) {
				return () => {};
			}

			const onEvent = (payload: { event: SessionUpdate; sequence: number }) =>
				listener({
					type: 'event',
					event: payload.event,
					sequence: payload.sequence,
				});
			const onTerminal = () => listener({ type: 'terminal' });

			emitter.on('event', onEvent);
			emitter.once(TERMINAL_EVENT, onTerminal);

			return () => {
				emitter.off('event', onEvent);
				emitter.off(TERMINAL_EVENT, onTerminal);
			};
		};

		const subscribeJobs = (
			listener: (change: JobsChange) => void,
		): (() => void) => {
			jobsEmitter.on('change', listener);
			return () => {
				jobsEmitter.off('change', listener);
			};
		};

		const listAliases = () => {
			return db
				.select()
				.from(schema.modelAliases)
				.orderBy(schema.modelAliases.name)
				.all();
		};

		const saveAlias = (input: {
			name: string;
			backend: string;
			model_id: string;
			description?: string | null;
		}) => {
			const now = new Date();
			db.insert(schema.modelAliases)
				.values({
					name: input.name,
					backend: input.backend,
					model_id: input.model_id,
					description: input.description ?? null,
					created_at: now,
					updated_at: now,
				})
				.onConflictDoUpdate({
					target: schema.modelAliases.name,
					set: {
						backend: input.backend,
						model_id: input.model_id,
						description: input.description ?? null,
						updated_at: now,
					},
				})
				.run();
			return {
				name: input.name,
				backend: input.backend,
				model_id: input.model_id,
				description: input.description ?? undefined,
			};
		};

		const deleteAlias = (name: string): boolean => {
			const existing = db
				.select()
				.from(schema.modelAliases)
				.where(eq(schema.modelAliases.name, name))
				.limit(1)
				.get();
			if (existing === undefined) {
				return false;
			}
			db.delete(schema.modelAliases)
				.where(eq(schema.modelAliases.name, name))
				.run();
			return true;
		};

		const getSetting = (key: string): string | undefined => {
			const row = db
				.select()
				.from(schema.settings)
				.where(eq(schema.settings.key, key))
				.limit(1)
				.get();
			if (row === undefined) {
				return undefined;
			}
			return row.value;
		};

		const setSetting = (key: string, value: string) => {
			const now = new Date();
			db.insert(schema.settings)
				.values({
					key,
					value,
					created_at: now,
					updated_at: now,
				})
				.onConflictDoUpdate({
					target: schema.settings.key,
					set: {
						value,
						updated_at: now,
					},
				})
				.run();
		};

		/**
		 * Max time the start tool blocks waiting for a job before returning a running handle.
		 *
		 * Safe because Claude Code's MCP tool-call timeout defaults to ~27.7h (1e8 ms): from
		 * the client binary, the per-call limit resolves as `.mcp.json` timeout → MCP_TOOL_TIMEOUT
		 * env → 1e8 ms default, floored at 1s, ceiled at INT32_MAX (~24.8 days). The server can NOT
		 * read that value — Claude Code injects no timeout into the MCP subprocess env (only
		 * CLAUDE_PROJECT_DIR) — and progress notifications do NOT extend it (hard wall-clock). So we
		 * pick our own conservative cap well under the default and hand back a {status:"running"}
		 * resume handle if it elapses, rather than trying to detect the client's limit.
		 */
		const getStartTimeoutMs = (): number => {
			const raw = getSetting('start_timeout_ms');
			if (raw === undefined) {
				return DEFAULT_START_TIMEOUT_MS;
			}
			const parsed = Number.parseInt(raw, 10);
			if (Number.isNaN(parsed)) {
				throw new Error(`Corrupt start_timeout_ms setting: ${raw}`);
			}
			return parsed;
		};

		return {
			start,
			cancel,
			wait,
			list,
			listByMcpSession,
			getDetail,
			subscribe,
			subscribeJobs,
			listAliases,
			saveAlias,
			deleteAlias,
			getSetting,
			setSetting,
			getStartTimeoutMs,
			readEventsPage: (jobId: string, sinceId: number, limit: number) => {
				const job = db
					.select()
					.from(schema.jobs)
					.where(eq(schema.jobs.uuid, jobId))
					.limit(1)
					.get();
				if (job === undefined) return { events: [], nextCursor: null };
				return readEventsPage(job.id, sinceId, limit);
			},
		};
	}),
	dependencies: [
		OpenCode.Default,
		Cursor.Default,
		Grok.Default,
		Codex.Default,
		Db.Default,
	],
}) {}

function toWaitResult(job: {
	uuid: string;
	status: 'running' | 'done' | 'error' | 'cancelled';
	session_id: string | null;
	text: string | null;
	stop_reason: string | null;
	error_message: string | null;
}): WaitResult {
	if (job.status === 'running') return { status: 'running' };
	if (job.status === 'cancelled') return { status: 'cancelled' };
	if (job.status === 'done') {
		if (job.session_id === null || job.text === null) {
			throw new Error(
				`Invariant violated: done job ${job.uuid} missing session_id or text`,
			);
		}
		return {
			status: 'done',
			sessionId: job.session_id,
			text: job.text,
			stopReason: job.stop_reason ?? undefined,
		};
	}
	if (job.error_message === null) {
		throw new Error(
			`Invariant violated: error job ${job.uuid} missing error_message`,
		);
	}
	return { status: 'error', message: job.error_message };
}

function formatJobError(error: unknown): string {
	if (error !== null && typeof error === 'object') {
		const tag =
			'_tag' in error && typeof error._tag === 'string' ? error._tag : 'Error';
		const message =
			'message' in error && typeof error.message === 'string'
				? error.message
				: String(error);
		const code =
			'code' in error && typeof error.code === 'string'
				? `(${error.code})`
				: '';
		return `${tag}${code}: ${message}`;
	}
	return String(error);
}
