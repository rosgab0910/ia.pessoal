export type OfflineGame = {
  id: string;
  name: string;
  version: string;
  executable: string;
  directoryName: string;
  onlineBlocked: boolean;
  createdAt: string;
};

export type ModFile = { path: string; blob: Blob };

export type LocalMod = {
  id: string;
  gameId: string;
  name: string;
  version: string;
  author: string;
  description: string;
  instructions: string;
  category: string;
  dependencies: string[];
  supportedGameVersion: string;
  files: string[];
  active: boolean;
  importedAt: string;
};

export type ModProfile = {
  id: string;
  gameId: string;
  name: string;
  modIds: string[];
  createdAt: string;
};

export type Operation = {
  id: string;
  date: string;
  kind: "import" | "install" | "activate" | "deactivate" | "remove" | "profile" | "restore" | "error";
  gameId?: string;
  modId?: string;
  message: string;
  paths: string[];
};

export type ModState = {
  games: OfflineGame[];
  mods: LocalMod[];
  profiles: ModProfile[];
  history: Operation[];
};

const STORAGE_KEY = "modoteca-offline-state-v1";
const DB_NAME = "modoteca-offline-files-v1";
const DB_VERSION = 1;

export const EMPTY_STATE: ModState = { games: [], mods: [], profiles: [], history: [] };

export function loadState(): ModState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const value = JSON.parse(raw) as Partial<ModState>;
    return {
      games: Array.isArray(value.games) ? value.games : [],
      mods: Array.isArray(value.mods) ? value.mods : [],
      profiles: Array.isArray(value.profiles) ? value.profiles : [],
      history: Array.isArray(value.history) ? value.history : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveState(state: ModState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let dbPromise: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("modFiles")) {
        const store = db.createObjectStore("modFiles", { keyPath: "key" });
        store.createIndex("modId", "modId", { unique: false });
      }
      if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles", { keyPath: "gameId" });
      if (!db.objectStoreNames.contains("backups")) db.createObjectStore("backups", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Não foi possível abrir o armazenamento local."));
  });
  return dbPromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Falha no armazenamento local."));
  });
}

export async function saveModFiles(modId: string, files: ModFile[]) {
  const db = await database();
  const tx = db.transaction("modFiles", "readwrite");
  const store = tx.objectStore("modFiles");
  for (const file of files) store.put({ key: `${modId}:${file.path}`, modId, path: file.path, blob: file.blob });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Falha ao guardar os arquivos do mod."));
    tx.onabort = () => reject(tx.error ?? new Error("Gravação local cancelada."));
  });
}

export async function getModFiles(modId: string): Promise<ModFile[]> {
  const db = await database();
  const tx = db.transaction("modFiles", "readonly");
  const rows = await requestValue(tx.objectStore("modFiles").index("modId").getAll(IDBKeyRange.only(modId)));
  return rows.map((row: { path: string; blob: Blob }) => ({ path: row.path, blob: row.blob }));
}

export async function deleteModFiles(modId: string) {
  const db = await database();
  const tx = db.transaction("modFiles", "readwrite");
  const store = tx.objectStore("modFiles");
  const rows = await requestValue(store.index("modId").getAll(IDBKeyRange.only(modId)));
  rows.forEach((row: { key: string }) => store.delete(row.key));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Falha ao remover arquivos locais do mod."));
  });
}

export async function saveGameHandle(gameId: string, handle: FileSystemDirectoryHandle) {
  const db = await database();
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").put({ gameId, handle });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Não foi possível guardar o acesso à pasta."));
  });
}

export async function getGameHandle(gameId: string): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await database();
  const row = await requestValue(db.transaction("handles", "readonly").objectStore("handles").get(gameId));
  return row?.handle as FileSystemDirectoryHandle | undefined;
}

export async function deleteGameHandle(gameId: string) {
  const db = await database();
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").delete(gameId);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Não foi possível remover a pasta salva."));
  });
}

export type BackupRecord = { key: string; gameId: string; path: string; blob: Blob };
export function backupKey(gameId: string, path: string) { return `${gameId}:${path}`; }

export async function saveBackup(record: BackupRecord) {
  const db = await database();
  const tx = db.transaction("backups", "readwrite");
  tx.objectStore("backups").put(record);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Falha ao guardar backup original."));
  });
}

export async function getBackup(gameId: string, path: string): Promise<BackupRecord | undefined> {
  const db = await database();
  return requestValue(db.transaction("backups", "readonly").objectStore("backups").get(backupKey(gameId, path)));
}

export async function deleteBackup(gameId: string, path: string) {
  const db = await database();
  const tx = db.transaction("backups", "readwrite");
  tx.objectStore("backups").delete(backupKey(gameId, path));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Falha ao limpar backup."));
  });
}

export async function listBackups(gameId: string): Promise<BackupRecord[]> {
  const db = await database();
  const rows = await requestValue(db.transaction("backups", "readonly").objectStore("backups").getAll());
  return rows.filter((row: BackupRecord) => row.gameId === gameId);
}
