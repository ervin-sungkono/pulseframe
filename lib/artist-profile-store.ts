import { z } from "zod";
import {
  artistProfileIdSchema,
  artistProfileNameSchema,
  artistProfileRevisionSchema,
  artistProfileStyleSchema,
  validateArtistProfileDraft,
  type ArtistProfile,
  type ArtistProfileAssets,
  type ArtistProfileDraft,
  type ArtistProfileSummary,
} from "./artist-profile";

export const ARTIST_PROFILE_DATABASE = "pulseframe.artistProfiles.v1";
export const ARTIST_PROFILE_CHANGED = "pulseframe:artist-profiles-changed";
const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_STORE = "profiles";
const ASSET_STORE = "assets";

export type ArtistProfileRecord = ArtistProfileSummary & {
  style: ArtistProfile["style"];
};
export type ArtistProfileAssetRecord = { id: string; assets: ArtistProfileAssets };

export class ArtistProfileStoreError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "conflict" | "missing" | "storage",
  ) {
    super(message);
    this.name = "ArtistProfileStoreError";
  }
}

/** Interface keeps revision and failure behavior testable without replacing IndexedDB in browsers. */
export interface ArtistProfileDatabase {
  list(): Promise<ArtistProfileRecord[]>;
  get(id: string): Promise<{ record: ArtistProfileRecord; assets: ArtistProfileAssets } | null>;
  create(record: ArtistProfileRecord, assets: ArtistProfileAssets): Promise<void>;
  update(
    id: string,
    expectedRevision: number,
    record: ArtistProfileRecord,
    assets: ArtistProfileAssets,
  ): Promise<void>;
  delete(id: string, expectedRevision: number): Promise<void>;
}

const storedRecordSchema = z
  .object({
    id: artistProfileIdSchema,
    name: artistProfileNameSchema,
    defaultArtist: z.string().max(120),
    style: artistProfileStyleSchema,
    createdAt: z.number().finite().int().nonnegative(),
    updatedAt: z.number().finite().int().nonnegative(),
    revision: artistProfileRevisionSchema,
  })
  .strict();

function storageError(error: unknown): ArtistProfileStoreError {
  if (error instanceof ArtistProfileStoreError) return error;
  const reason = error instanceof Error ? error.name : "";
  if (reason === "QuotaExceededError") {
    return new ArtistProfileStoreError(
      "Could not save this profile because browser storage is full. Your previous profile is unchanged.",
      "storage",
    );
  }
  return new ArtistProfileStoreError(
    "Could not access artist profiles in this browser. Storage may be blocked or unavailable.",
    "storage",
  );
}

function validateRecord(value: unknown): ArtistProfileRecord {
  const parsed = storedRecordSchema.safeParse(value);
  if (!parsed.success)
    throw new ArtistProfileStoreError("A saved artist profile could not be read.", "storage");
  return parsed.data;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

class IndexedDbArtistProfileDatabase implements ArtistProfileDatabase {
  private opening: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is unavailable."));
        return;
      }
      const request = indexedDB.open(ARTIST_PROFILE_DATABASE, PROFILE_SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROFILE_STORE))
          db.createObjectStore(PROFILE_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(ASSET_STORE))
          db.createObjectStore(ASSET_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
      request.onblocked = () => reject(new Error("Artist profile storage upgrade is blocked."));
    }).catch((error) => {
      this.opening = null;
      throw error;
    });
    return this.opening!;
  }

  async list(): Promise<ArtistProfileRecord[]> {
    const db = await this.open();
    const tx = db.transaction(PROFILE_STORE, "readonly");
    const result = await requestValue(tx.objectStore(PROFILE_STORE).getAll());
    await transactionFinished(tx);
    return (result as unknown[]).map(validateRecord);
  }

  async get(
    id: string,
  ): Promise<{ record: ArtistProfileRecord; assets: ArtistProfileAssets } | null> {
    const db = await this.open();
    const tx = db.transaction([PROFILE_STORE, ASSET_STORE], "readonly");
    const metadataRequest = tx.objectStore(PROFILE_STORE).get(id);
    const assetsRequest = tx.objectStore(ASSET_STORE).get(id);
    const [metadata, assetRecord] = await Promise.all([
      requestValue(metadataRequest),
      requestValue(assetsRequest),
    ]);
    await transactionFinished(tx);
    if (!metadata) return null;
    return {
      record: validateRecord(metadata),
      assets: (assetRecord as ArtistProfileAssetRecord | undefined)?.assets ?? {},
    };
  }

  async create(record: ArtistProfileRecord, assets: ArtistProfileAssets): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([PROFILE_STORE, ASSET_STORE], "readwrite");
    const profileStore = tx.objectStore(PROFILE_STORE);
    profileStore.add(record);
    tx.objectStore(ASSET_STORE).put({ id: record.id, assets } satisfies ArtistProfileAssetRecord);
    await transactionFinished(tx);
  }

  async update(
    id: string,
    expectedRevision: number,
    record: ArtistProfileRecord,
    assets: ArtistProfileAssets,
  ): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([PROFILE_STORE, ASSET_STORE], "readwrite");
    const profileStore = tx.objectStore(PROFILE_STORE);
    let rejection: ArtistProfileStoreError | undefined;
    const request = profileStore.get(id);
    request.onsuccess = () => {
      const current = request.result as ArtistProfileRecord | undefined;
      if (!current) {
        rejection = new ArtistProfileStoreError("This artist profile no longer exists.", "missing");
        tx.abort();
        return;
      }
      if (current.revision !== expectedRevision) {
        rejection = new ArtistProfileStoreError(
          "This artist profile changed in another tab. Refresh it before updating.",
          "conflict",
        );
        tx.abort();
        return;
      }
      profileStore.put(record);
      tx.objectStore(ASSET_STORE).put({ id, assets } satisfies ArtistProfileAssetRecord);
    };
    await transactionFinished(tx, () => rejection);
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([PROFILE_STORE, ASSET_STORE], "readwrite");
    const profileStore = tx.objectStore(PROFILE_STORE);
    let rejection: ArtistProfileStoreError | undefined;
    const request = profileStore.get(id);
    request.onsuccess = () => {
      const current = request.result as ArtistProfileRecord | undefined;
      if (!current) {
        rejection = new ArtistProfileStoreError("This artist profile no longer exists.", "missing");
        tx.abort();
        return;
      }
      if (current.revision !== expectedRevision) {
        rejection = new ArtistProfileStoreError(
          "This artist profile changed in another tab. Refresh it before deleting.",
          "conflict",
        );
        tx.abort();
        return;
      }
      profileStore.delete(id);
      tx.objectStore(ASSET_STORE).delete(id);
    };
    await transactionFinished(tx, () => rejection);
  }
}

function transactionFinished(
  tx: IDBTransaction,
  getRejection: () => ArtistProfileStoreError | undefined = () => undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => {
      reject(getRejection() ?? tx.error ?? new Error("IndexedDB transaction failed."));
    };
  });
}

export function announceArtistProfileChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ARTIST_PROFILE_CHANGED));
  if (typeof BroadcastChannel !== "undefined") {
    try {
      changeChannel ??= new BroadcastChannel(ARTIST_PROFILE_DATABASE);
      changeChannel.postMessage("changed");
    } catch {
      // Storage has already committed; notification support must not change that result.
    }
  }
}

let changeChannel: BroadcastChannel | null = null;

export function listenForArtistProfileChanges(callback: () => void): () => void {
  if (typeof window !== "undefined") window.addEventListener(ARTIST_PROFILE_CHANGED, callback);
  let channel: BroadcastChannel | null = null;
  try {
    channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(ARTIST_PROFILE_DATABASE);
  } catch {
    channel = null;
  }
  if (channel) channel.onmessage = callback;
  return () => {
    if (typeof window !== "undefined") window.removeEventListener(ARTIST_PROFILE_CHANGED, callback);
    channel?.close();
  };
}

/** IndexedDB owns both profile metadata and image Blobs in each write transaction. */
export class ArtistProfileStore {
  constructor(
    private readonly database: ArtistProfileDatabase = new IndexedDbArtistProfileDatabase(),
  ) {}

  async list(): Promise<ArtistProfileSummary[]> {
    try {
      const rows = await this.database.list();
      return rows
        .map((row) => validateRecord(row))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
    } catch (error) {
      throw storageError(error);
    }
  }

  async get(id: string): Promise<ArtistProfile | null> {
    if (!artistProfileIdSchema.safeParse(id).success)
      throw new ArtistProfileStoreError("This artist profile ID is invalid.", "invalid");
    try {
      const result = await this.database.get(id);
      if (!result) return null;
      const record = validateRecord(result.record);
      const validated = validateArtistProfileDraft({
        name: record.name,
        defaultArtist: record.defaultArtist,
        style: record.style,
        assets: result.assets,
      });
      return { ...record, assets: validated.assets ?? {} };
    } catch (error) {
      throw storageError(error);
    }
  }

  async create(id: string, value: ArtistProfileDraft): Promise<ArtistProfile> {
    const parsed = this.parseInput(id, value);
    const now = Date.now();
    const record: ArtistProfileRecord = {
      ...parsed.record,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    try {
      await this.database.create(record, parsed.assets);
      announceArtistProfileChange();
      return { ...record, assets: parsed.assets };
    } catch (error) {
      throw storageError(error);
    }
  }

  async update(
    id: string,
    expectedRevision: number,
    value: ArtistProfileDraft,
  ): Promise<ArtistProfile> {
    if (!artistProfileRevisionSchema.safeParse(expectedRevision).success)
      throw new ArtistProfileStoreError("This artist profile revision is invalid.", "invalid");
    const parsed = this.parseInput(id, value);
    try {
      const current = await this.database.get(id);
      if (!current)
        throw new ArtistProfileStoreError("This artist profile no longer exists.", "missing");
      if (current.record.revision !== expectedRevision)
        throw new ArtistProfileStoreError(
          "This artist profile changed in another tab. Refresh it before updating.",
          "conflict",
        );
      if (expectedRevision >= Number.MAX_SAFE_INTEGER)
        throw new ArtistProfileStoreError("This profile cannot be updated again.", "invalid");
      const record: ArtistProfileRecord = {
        ...parsed.record,
        createdAt: current.record.createdAt,
        updatedAt: Date.now(),
        revision: expectedRevision + 1,
      };
      await this.database.update(id, expectedRevision, record, parsed.assets);
      announceArtistProfileChange();
      return { ...record, assets: parsed.assets };
    } catch (error) {
      throw storageError(error);
    }
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    if (
      !artistProfileIdSchema.safeParse(id).success ||
      !artistProfileRevisionSchema.safeParse(expectedRevision).success
    )
      throw new ArtistProfileStoreError("This artist profile removal is invalid.", "invalid");
    try {
      await this.database.delete(id, expectedRevision);
      announceArtistProfileChange();
    } catch (error) {
      throw storageError(error);
    }
  }

  private parseInput(
    id: string,
    value: ArtistProfileDraft,
  ): {
    record: Pick<ArtistProfileRecord, "id" | "name" | "defaultArtist" | "style">;
    assets: ArtistProfileAssets;
  } {
    if (!artistProfileIdSchema.safeParse(id).success)
      throw new ArtistProfileStoreError("This artist profile ID is invalid.", "invalid");
    try {
      const draft = validateArtistProfileDraft(value);
      return {
        record: { id, name: draft.name, defaultArtist: draft.defaultArtist, style: draft.style },
        assets: draft.assets ?? {},
      };
    } catch (error) {
      throw new ArtistProfileStoreError(
        error instanceof Error ? error.message : "This artist profile is invalid.",
        "invalid",
      );
    }
  }
}

export function createArtistProfileId(): string {
  return globalThis.crypto.randomUUID();
}
