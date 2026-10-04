import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
export const visualPresets = sqliteTable('visual_presets', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  settings: text('settings').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, table => [index('idx_visual_presets_user_updated').on(table.userId,table.updatedAt,table.id)]);
