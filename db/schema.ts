import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
export const visualPresets = sqliteTable('visual_presets', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  settings: text('settings').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  quickLookOrder: integer('quick_look_order').notNull().default(0),
  revision: integer('revision').notNull().default(1),
}, table => [
  index('idx_visual_presets_user_updated').on(table.userId,table.updatedAt,table.id),
  index('idx_visual_presets_user_pinned_order').on(table.userId,table.pinned,table.quickLookOrder,table.id),
]);
