import { presetStyle, type SavedPreset, type PresetStyle } from './presets';

type StoredPreset = {
  id: string;
  name: string;
  settings: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  quick_look_order: number;
  revision: number;
};

export type PresetCursor = { value: number; id: string };
export type PresetMutation = {
  name?: string;
  settings?: PresetStyle;
  pinned?: boolean;
  quickLookOrder?: number;
  expectedRevision: number;
};
export type PresetUpdateResult =
  | { status: 'updated'; preset: SavedPreset }
  | { status: 'conflict'; preset: SavedPreset }
  | { status: 'missing' };
export type PresetReorderResult =
  | { status: 'updated'; presets: [SavedPreset, SavedPreset] }
  | { status: 'conflict' }
  | { status: 'missing' };

const unpack = (row: StoredPreset): SavedPreset => ({
  id: row.id,
  name: row.name,
  settings: presetStyle(JSON.parse(row.settings)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  pinned: row.pinned === 1,
  quickLookOrder: row.quick_look_order,
  revision: row.revision,
});

const tryUnpack = (row: StoredPreset): SavedPreset | null => {
  try {
    return unpack(row);
  } catch (error) {
    console.error('Skipping invalid saved preset', row.id, error);
    return null;
  }
};

const selectedColumns = 'id,name,settings,created_at,updated_at,pinned,quick_look_order,revision';

/** All queries include the platform user key; shared site viewers never share presets. */
export class PresetStore {
  constructor(private db: D1Database) {}

  async list(userId: string, search = '', cursor?: PresetCursor, pinnedOnly = false) {
    const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const hasCursor = cursor ? 1 : 0;
    const position = cursor?.value ?? 0;
    const cursorId = cursor?.id ?? '';
    const orderColumn = pinnedOnly ? 'quick_look_order' : 'updated_at';
    const comparison = pinnedOnly ? '>' : '<';
    const rows = await this.db.prepare(`
      SELECT ${selectedColumns} FROM visual_presets
      WHERE user_id = ? AND name LIKE ? ESCAPE '\\'${pinnedOnly ? ' AND pinned = 1' : ''}
        AND (? = 0 OR ${orderColumn} ${comparison} ? OR (${orderColumn} = ? AND id ${comparison} ?))
      ORDER BY ${orderColumn} ${pinnedOnly ? 'ASC' : 'DESC'},id ${pinnedOnly ? 'ASC' : 'DESC'}
      LIMIT 41`)
      .bind(userId, like, hasCursor, position, position, cursorId)
      .all<StoredPreset>();

    const page = rows.results.slice(0, 40);
    const last = page.at(-1);
    const value = last ? (pinnedOnly ? last.quick_look_order : last.updated_at) : null;
    return {
      presets: page.map(tryUnpack).filter((preset): preset is SavedPreset => preset !== null),
      cursor: rows.results.length > 40 && last ? `${value}:${last.id}` : null,
    };
  }

  async get(userId: string, id: string) {
    const row = await this.db.prepare(`SELECT ${selectedColumns} FROM visual_presets WHERE user_id = ? AND id = ?`)
      .bind(userId, id)
      .first<StoredPreset>();
    return row ? unpack(row) : null;
  }

  /** Repeating a create with the same id for the same owner returns the original row unchanged. */
  async saveWithStatus(
    userId: string,
    id: string,
    name: string,
    settings: PresetStyle,
    options: { pinned: boolean; quickLookOrder: number } = { pinned: false, quickLookOrder: 0 },
  ) {
    const now = Date.now();
    const result = await this.db.prepare(`
      INSERT INTO visual_presets
        (id,user_id,name,settings,created_at,updated_at,pinned,quick_look_order,revision)
      VALUES (?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO NOTHING`)
      .bind(id, userId, name, JSON.stringify(settings), now, now, options.pinned ? 1 : 0, options.quickLookOrder)
      .run();
    const preset = await this.get(userId, id);
    if (!preset) return null;
    return { preset, created: result.meta.changes > 0 };
  }

  async save(
    userId: string,
    id: string,
    name: string,
    settings: PresetStyle,
    options: { pinned: boolean; quickLookOrder: number } = { pinned: false, quickLookOrder: 0 },
  ) {
    const result = await this.saveWithStatus(userId, id, name, settings, options);
    if (!result) throw new Error('Could not save this preset.');
    return result.preset;
  }

  async update(userId: string, id: string, mutation: PresetMutation): Promise<PresetUpdateResult> {
    const settings = mutation.settings === undefined ? null : JSON.stringify(mutation.settings);
    const pinned = mutation.pinned === undefined ? null : mutation.pinned ? 1 : 0;
    const result = await this.db.prepare(`
      UPDATE visual_presets SET
        name = COALESCE(?,name),
        settings = COALESCE(?,settings),
        pinned = COALESCE(?,pinned),
        quick_look_order = COALESCE(?,quick_look_order),
        updated_at = ?,
        revision = revision + 1
      WHERE user_id = ? AND id = ? AND revision = ?`)
      .bind(
        mutation.name ?? null,
        settings,
        pinned,
        mutation.quickLookOrder ?? null,
        Date.now(),
        userId,
        id,
        mutation.expectedRevision,
      )
      .run();

    if (result.meta.changes > 0) {
      const preset = await this.get(userId, id);
      return preset ? { status: 'updated', preset } : { status: 'missing' };
    }

    const current = await this.get(userId, id);
    return current ? { status: 'conflict', preset: current } : { status: 'missing' };
  }

  /** Backward-compatible helper for code that still performs a simple rename directly. */
  async rename(userId: string, id: string, name: string) {
    const current = await this.get(userId, id);
    if (!current) return null;
    const result = await this.update(userId, id, { name, expectedRevision: current.revision });
    return result.status === 'updated' ? result.preset : null;
  }

  async reorder(
    userId: string,
    first: { id: string; expectedRevision: number },
    second: { id: string; expectedRevision: number },
  ): Promise<PresetReorderResult> {
    const now = Date.now();
    const rows = await this.db.prepare(`
      WITH pair AS MATERIALIZED (
        SELECT id,quick_look_order FROM visual_presets
        WHERE user_id = ? AND pinned = 1
          AND ((id = ? AND revision = ?) OR (id = ? AND revision = ?))
      ), matched AS MATERIALIZED (
        SELECT COUNT(*) AS row_count FROM pair
      )
      UPDATE visual_presets SET
        quick_look_order = CASE id
          WHEN ? THEN (SELECT quick_look_order FROM pair WHERE id = ?)
          WHEN ? THEN (SELECT quick_look_order FROM pair WHERE id = ?)
          ELSE quick_look_order
        END,
        updated_at = ?,
        revision = revision + 1
      WHERE user_id = ? AND pinned = 1
        AND (SELECT row_count FROM matched) = 2
        AND id IN (?,?)
        AND ((id = ? AND revision = ?) OR (id = ? AND revision = ?))
      RETURNING ${selectedColumns}`)
      .bind(
        userId,
        first.id, first.expectedRevision,
        second.id, second.expectedRevision,
        first.id, second.id,
        second.id, first.id,
        now,
        userId,
        first.id, second.id,
        first.id, first.expectedRevision,
        second.id, second.expectedRevision,
      )
      .all<StoredPreset>();

    if (rows.results.length === 2) {
      const updated = new Map<string, SavedPreset>();
      for (const row of rows.results) updated.set(row.id, unpack(row));
      const firstPreset = updated.get(first.id);
      const secondPreset = updated.get(second.id);
      if (firstPreset && secondPreset) return { status: 'updated', presets: [firstPreset, secondPreset] };
    }

    const owned = await this.db.prepare('SELECT id FROM visual_presets WHERE user_id = ? AND id IN (?,?)')
      .bind(userId, first.id, second.id)
      .all<{ id: string }>();
    return owned.results.length === 2 ? { status: 'conflict' } : { status: 'missing' };
  }

  async remove(userId: string, id: string) {
    const result = await this.db.prepare('DELETE FROM visual_presets WHERE user_id = ? AND id = ?').bind(userId, id).run();
    return result.meta.changes > 0;
  }
}
