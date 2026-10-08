import { z } from 'zod';
import {
  presetIdSchema, presetNameSchema, presetRevisionSchema, presetStyle,
  quickLookOrderSchema, type PresetStyle, type SavedPreset,
} from './presets';

export const PRESET_STORAGE_KEY = 'pulseframe.presets.v1';

export type CreatePresetInput = {
  id: string;
  name: string;
  settings: PresetStyle;
  pinned?: boolean;
  quickLookOrder?: number;
};
export type UpdatePresetInput = {
  name?: string;
  settings?: PresetStyle;
  pinned?: boolean;
  quickLookOrder?: number;
  expectedRevision: number;
};

export class PresetStoreError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'conflict' | 'missing' | 'storage') {
    super(message);
    this.name = 'PresetStoreError';
  }
}

const timestampSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const storedSchema = z.object({
  id: presetIdSchema, name: presetNameSchema, settings: z.unknown(),
  createdAt: timestampSchema, updatedAt: timestampSchema,
  pinned: z.boolean(), quickLookOrder: quickLookOrderSchema, revision: presetRevisionSchema,
}).strict();
const createSchema = storedSchema.pick({ id: true, name: true, settings: true }).extend({
  pinned: z.boolean().optional(), quickLookOrder: quickLookOrderSchema.optional(),
});
const updateSchema = storedSchema.pick({ name: true, settings: true, pinned: true, quickLookOrder: true })
  .partial().extend({ expectedRevision: presetRevisionSchema }).strict();

/** Browser persistence adapter. Settings validation stays in the shared model. */
export class PresetStore {
  constructor(private getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage) {}

  list(): SavedPreset[] {
    try {
      const raw = this.getStorage().getItem(PRESET_STORAGE_KEY);
      if (raw === null) return [];
      const envelope = z.object({ schemaVersion: z.literal(1), presets: z.array(storedSchema) }).strict().parse(JSON.parse(raw));
      const seen = new Set<string>();
      const presets = envelope.presets.map(row => {
        if (seen.has(row.id)) throw new Error('Duplicate preset ID.');
        seen.add(row.id);
        return { ...row, settings: presetStyle(row.settings) };
      });
      return presets.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    } catch {
      // Never overwrite unreadable or unsupported stored data with an empty list.
      throw new PresetStoreError('Could not read your saved looks. Browser storage may be blocked or contain invalid data.', 'storage');
    }
  }

  private write(presets: SavedPreset[]) {
    try {
      this.getStorage().setItem(PRESET_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, presets }));
    } catch {
      throw new PresetStoreError('Could not save your looks. Browser storage may be full or blocked; your previous saved looks are unchanged.', 'storage');
    }
  }

  private mutate<T>(operation: () => T): Promise<T> {
    // Serialize read/modify/write across same-origin tabs when Web Locks exists.
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(PRESET_STORAGE_KEY, operation);
    }
    return Promise.resolve().then(operation);
  }

  create(input: CreatePresetInput): Promise<SavedPreset> {
    return this.mutate(() => {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) throw new PresetStoreError('Enter a name of 1–80 characters and valid settings.', 'invalid');
      const settings = presetStyle(parsed.data.settings);
      const presets = this.list();
      const existing = presets.find(preset => preset.id === parsed.data.id);
      if (existing) return existing; // Stable dialog IDs make save retries idempotent.
      const now = Date.now();
      const quickLookOrder = parsed.data.quickLookOrder ?? presets.reduce((order, preset) => Math.max(order, preset.quickLookOrder + 1), now);
      if (!quickLookOrderSchema.safeParse(quickLookOrder).success) throw new PresetStoreError('Quick Look order is invalid.', 'invalid');
      const preset = { ...parsed.data, settings, pinned: parsed.data.pinned ?? false, quickLookOrder, createdAt: now, updatedAt: now, revision: 1 };
      this.write([...presets, preset]);
      return preset;
    });
  }

  update(id: string, input: UpdatePresetInput): Promise<SavedPreset> {
    return this.mutate(() => {
      const parsed = updateSchema.safeParse(input);
      if (!presetIdSchema.safeParse(id).success || !parsed.success) throw new PresetStoreError('This preset update is invalid.', 'invalid');
      const presets = this.list();
      const current = presets.find(preset => preset.id === id);
      if (!current) throw new PresetStoreError('This preset no longer exists.', 'missing');
      if (current.revision !== parsed.data.expectedRevision) throw new PresetStoreError('This preset changed in another tab. Review its latest version or save a copy.', 'conflict');
      const { expectedRevision: _revision, settings, ...patch } = parsed.data;
      void _revision;
      if (!presetRevisionSchema.safeParse(current.revision + 1).success) throw new PresetStoreError('This preset cannot be updated again. Save a copy.', 'invalid');
      const updated = { ...current, name: patch.name ?? current.name, pinned: patch.pinned ?? current.pinned, quickLookOrder: patch.quickLookOrder ?? current.quickLookOrder, settings: settings === undefined ? current.settings : presetStyle(settings), updatedAt: Date.now(), revision: current.revision + 1 };
      this.write(presets.map(preset => preset.id === id ? updated : preset));
      return updated;
    });
  }

  reorder(first: SavedPreset, second: SavedPreset): Promise<[SavedPreset, SavedPreset]> {
    return this.mutate(() => {
      const presets = this.list();
      const a = presets.find(preset => preset.id === first.id);
      const b = presets.find(preset => preset.id === second.id);
      if (!a || !b) throw new PresetStoreError('A Quick Look no longer exists.', 'missing');
      if (a.id === b.id || !a.pinned || !b.pinned || a.revision !== first.revision || b.revision !== second.revision) {
        throw new PresetStoreError('These Quick Looks changed in another tab. Refresh and try again.', 'conflict');
      }
      if (![a, b].every(preset => presetRevisionSchema.safeParse(preset.revision + 1).success)) throw new PresetStoreError('These Quick Looks cannot be reordered again.', 'invalid');
      const now = Date.now();
      const moved = { ...a, quickLookOrder: b.quickLookOrder, revision: a.revision + 1, updatedAt: now };
      const shifted = { ...b, quickLookOrder: a.quickLookOrder, revision: b.revision + 1, updatedAt: now };
      this.write(presets.map(preset => preset.id === a.id ? moved : preset.id === b.id ? shifted : preset));
      return [moved, shifted];
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(() => {
      const presets = this.list();
      if (!presets.some(preset => preset.id === id)) throw new PresetStoreError('This preset no longer exists.', 'missing');
      this.write(presets.filter(preset => preset.id !== id));
    });
  }
}
