import { presetStyle, type SavedPreset, type PresetStyle } from './presets';
type StoredPreset = { id: string; name: string; settings: string; created_at: number; updated_at: number };
const unpack = (row: StoredPreset): SavedPreset => ({id:row.id,name:row.name,settings:presetStyle(JSON.parse(row.settings)),createdAt:row.created_at,updatedAt:row.updated_at});
/** All queries include the platform user key; shared site viewers never share presets. */
export class PresetStore {
  constructor(private db: D1Database) {}
  async list(userId: string, search = '', cursor?: {time:number;id:string}) {
    const like = `%${search.replace(/[\\%_]/g,'\\$&')}%`;
    const rows = await this.db.prepare(`SELECT id,name,settings,created_at,updated_at FROM visual_presets WHERE user_id = ? AND name LIKE ? ESCAPE '\\'
      AND (? = 0 OR updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC,id DESC LIMIT 41`)
      .bind(userId,like,cursor?.time ?? 0,cursor?.time ?? 0,cursor?.time ?? 0,cursor?.id ?? '').all<StoredPreset>();
    const page = rows.results.slice(0,40), last = page.at(-1);
    return {presets:page.map(unpack),cursor:rows.results.length > 40 && last ? `${last.updated_at}:${last.id}` : null};
  }
  async get(userId:string,id:string) {
    const row = await this.db.prepare('SELECT id,name,settings,created_at,updated_at FROM visual_presets WHERE user_id = ? AND id = ?').bind(userId,id).first<StoredPreset>();
    return row ? unpack(row) : null;
  }
  async save(userId:string,id:string,name:string,settings:PresetStyle) {
    const now=Date.now();
    await this.db.prepare('INSERT INTO visual_presets (id,user_id,name,settings,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,userId,name,JSON.stringify(settings),now,now).run();
    const saved=await this.get(userId,id); if(!saved) throw new Error('Could not save this preset.');
    return saved;
  }
  async rename(userId:string,id:string,name:string) {
    await this.db.prepare('UPDATE visual_presets SET name = ?,updated_at = ? WHERE user_id = ? AND id = ?').bind(name,Date.now(),userId,id).run();
    return this.get(userId,id);
  }
  async remove(userId:string,id:string) {
    const result=await this.db.prepare('DELETE FROM visual_presets WHERE user_id = ? AND id = ?').bind(userId,id).run();
    return result.meta.changes > 0;
  }
}
