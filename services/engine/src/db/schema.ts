import type {
	AvailableCommand,
	ContentBlock,
	PlanEntry,
	SessionConfigOption,
	ToolCallContent,
	ToolCallLocation,
} from '@agentclientprotocol/sdk';
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const jobs = sqliteTable(
	'jobs',
	{
		id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
		uuid: text().notNull(),
		status: text({ enum: ['running', 'done', 'error', 'cancelled'] }).notNull(),
		prompt: text().notNull(),
		cwd: text().notNull(),
		model: text(),
		backend: text().notNull(),
		created_at: integer({ mode: 'timestamp_ms' })
			.notNull()
			.$defaultFn(() => new Date()),
		terminated_at: integer({ mode: 'timestamp_ms' }),
		session_id: text(),
		mcp_session_id: text(),
		text: text(),
		stop_reason: text(),
		error_message: text(),
	},
	(table) => [
		uniqueIndex('jobs_uuid_uq').on(table.uuid),
		index('jobs_status_created_at_idx').on(table.status, table.created_at),
	],
);

export const events = sqliteTable(
	'events',
	{
		id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
		job_id: integer({ mode: 'number' })
			.notNull()
			.references(() => jobs.id, { onDelete: 'cascade' }),
		created_at: integer({ mode: 'timestamp_ms' })
			.notNull()
			.$defaultFn(() => new Date()),
		type: text({
			enum: [
				'user_message_chunk',
				'agent_message_chunk',
				'agent_thought_chunk',
				'tool_call',
				'tool_call_update',
				'plan',
				'available_commands_update',
				'current_mode_update',
				'config_option_update',
				'session_info_update',
				'usage_update',
				'cursor_extension',
			],
		}).notNull(),
		meta: text({ mode: 'json' }).$type<Record<string, unknown> | null>(),
	},
	(table) => [
		index('events_job_created_at_id_idx').on(
			table.job_id,
			table.created_at,
			table.id,
		),
	],
);

export const chunkEvents = sqliteTable('chunk_events', {
	event_id: integer({ mode: 'number' })
		.primaryKey()
		.references(() => events.id, { onDelete: 'cascade' }),
	message_id: text(),
	content: text({ mode: 'json' }).$type<ContentBlock>().notNull(),
});

export const toolCallEvents = sqliteTable('tool_call_events', {
	event_id: integer({ mode: 'number' })
		.primaryKey()
		.references(() => events.id, { onDelete: 'cascade' }),
	tool_call_id: text().notNull(),
	title: text(),
	status: text({ enum: ['pending', 'in_progress', 'completed', 'failed'] }),
	kind: text({
		enum: [
			'read',
			'edit',
			'delete',
			'move',
			'search',
			'execute',
			'think',
			'fetch',
			'switch_mode',
			'other',
		],
	}),
	content: text({ mode: 'json' }).$type<ToolCallContent[] | null>(),
	locations: text({ mode: 'json' }).$type<ToolCallLocation[] | null>(),
	raw_input: text({ mode: 'json' }).$type<unknown>(),
	raw_output: text({ mode: 'json' }).$type<unknown>(),
});

export const planEvents = sqliteTable('plan_events', {
	event_id: integer({ mode: 'number' })
		.primaryKey()
		.references(() => events.id, { onDelete: 'cascade' }),
	entries: text({ mode: 'json' }).$type<PlanEntry[]>().notNull(),
});

export const availableCommandsEvents = sqliteTable(
	'available_commands_events',
	{
		event_id: integer({ mode: 'number' })
			.primaryKey()
			.references(() => events.id, { onDelete: 'cascade' }),
		available_commands: text({ mode: 'json' })
			.$type<AvailableCommand[]>()
			.notNull(),
	},
);

export const currentModeEvents = sqliteTable('current_mode_events', {
	event_id: integer({ mode: 'number' })
		.primaryKey()
		.references(() => events.id, { onDelete: 'cascade' }),
	current_mode_id: text().notNull(),
});

export const configOptionEvents = sqliteTable('config_option_events', {
	event_id: integer({ mode: 'number' })
		.primaryKey()
		.references(() => events.id, { onDelete: 'cascade' }),
	config_options: text({ mode: 'json' })
		.$type<SessionConfigOption[]>()
		.notNull(),
});

export const sessionInfoEvents = sqliteTable('session_info_events', {
	event_id: integer({ mode: 'number' })
		.primaryKey()
		.references(() => events.id, { onDelete: 'cascade' }),
	title: text(),
	updated_at: text(),
});

export const usageEvents = sqliteTable('usage_events', {
	event_id: integer({ mode: 'number' })
		.primaryKey()
		.references(() => events.id, { onDelete: 'cascade' }),
	size: integer({ mode: 'number' }).notNull(),
	used: integer({ mode: 'number' }).notNull(),
	cost_amount: real(),
	cost_currency: text(),
});

export const modelAliases = sqliteTable(
	'model_aliases',
	{
		id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
		name: text().notNull(),
		backend: text().notNull(),
		model_id: text().notNull(),
		description: text(),
		created_at: integer({ mode: 'timestamp_ms' })
			.notNull()
			.$defaultFn(() => new Date()),
		updated_at: integer({ mode: 'timestamp_ms' })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [uniqueIndex('model_aliases_name_uq').on(table.name)],
);

export const settings = sqliteTable(
	'settings',
	{
		id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
		key: text().notNull(),
		value: text().notNull(),
		created_at: integer({ mode: 'timestamp_ms' })
			.notNull()
			.$defaultFn(() => new Date()),
		updated_at: integer({ mode: 'timestamp_ms' })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [uniqueIndex('settings_key_uq').on(table.key)],
);
