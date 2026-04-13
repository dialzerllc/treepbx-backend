import { pgTable, uuid, text, integer, timestamp, index, customType } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { kbSources } from './kb-sources';

// pgvector type placeholder - actual vector ops handled via raw SQL
const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return 'vector(1536)';
  },
  toDriver(value: number[]) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: unknown) {
    const str = value as string;
    return str.slice(1, -1).split(',').map(Number);
  },
});

export const kbChunks = pgTable('kb_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  kbSourceId: uuid('kb_source_id').notNull().references(() => kbSources.id, { onDelete: 'cascade' }),
  voicebotConfigId: uuid('voicebot_config_id').notNull(),
  content: text('content').notNull(),
  embedding: vector('embedding'),
  tokenCount: integer('token_count'),
  chunkIndex: integer('chunk_index'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_kb_chunks_voicebot').on(table.voicebotConfigId),
]);
