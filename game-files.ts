import { backupKey, deleteBackup, getBackup, saveBackup, type ModFile } from "./mod-store";

type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle> };

export function supportsLocalFolders() {
  return typeof (window as PickerWindow).showDirectoryPicker === "function" && typeof indexedDB !== "undefined";
}

export async function chooseGameFolder(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("O acesso a pastas locais exige Chrome ou Edge atualizados em uma origem segura (HTTPS ou localhost).");
  return picker({ mode: "readwrite" });
}

export async function ensurePermission(handle: FileSystemDirectoryHandle) {
  const permissionHandle = handle as FileSystemDirectoryHandle & {
    queryPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
  };
  let permission = permissionHandle.queryPermission ? await permissionHandle.queryPermission({ mode: "readwrite" }) : "granted";
  if (permission !== "granted" && permissionHandle.requestPermission) permission = await permissionHandle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error("Permissão de leitura e gravação negada. Reautorize o acesso à pasta do jogo.");
}

export function safeRelativePath(path: string) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || path.startsWith("/") || /^[A-Za-z]:/.test(path) || parts.some((part) => part === "." || part === ".." || part.includes(":") || /[\u0000-\u001f]/.test(part))) {
    throw new Error(`Caminho inseguro bloqueado: ${path}`);
  }
  return parts;
}

async function fileHandleAt(root: FileSystemDirectoryHandle, path: string, create: boolean) {
  const parts = safeRelativePath(path);
  let directory = root;
  for (const segment of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create });
  return directory.getFileHandle(parts[parts.length - 1], { create });
}

export async function readExistingFile(root: FileSystemDirectoryHandle, path: string): Promise<Blob | undefined> {
  try {
    const handle = await fileHandleAt(root, path, false);
    return await handle.getFile();
  } catch (error) {
    const name = (error as DOMException)?.name;
    if (name === "NotFoundError") return undefined;
    throw error;
  }
}

export async function writeGameFile(root: FileSystemDirectoryHandle, path: string, blob: Blob) {
  const handle = await fileHandleAt(root, path, true);
  const writer = await handle.createWritable();
  await writer.write(blob);
  await writer.close();
}

export async function removeGameFile(root: FileSystemDirectoryHandle, path: string) {
  const parts = safeRelativePath(path);
  let directory = root;
  for (const segment of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create: false });
  await directory.removeEntry(parts[parts.length - 1]);
}

export async function applyFiles(gameId: string, root: FileSystemDirectoryHandle, files: ModFile[]) {
  await ensurePermission(root);
  const changed: string[] = [];
  try {
    for (const file of files) {
      const path = safeRelativePath(file.path).join("/");
      const existing = await readExistingFile(root, path);
      const oldBackup = await getBackup(gameId, path);
      if (existing && !oldBackup) await saveBackup({ key: backupKey(gameId, path), gameId, path, blob: existing });
      changed.push(path);
      await writeGameFile(root, path, file.blob);
    }
  } catch (error) {
    try {
      if (changed.length) await restoreFiles(gameId, root, changed);
    } catch (rollbackError) {
      throw new Error(`A instalação falhou e a restauração automática também encontrou um erro: ${(rollbackError as Error).message}`);
    }
    throw new Error(`A instalação falhou; os arquivos alterados foram restaurados. ${(error as Error).message}`);
  }
  return changed;
}

export async function restoreFiles(gameId: string, root: FileSystemDirectoryHandle, paths: string[]) {
  await ensurePermission(root);
  const changed: string[] = [];
  for (const path of paths) {
    const backup = await getBackup(gameId, path);
    if (backup) {
      await writeGameFile(root, path, backup.blob);
      await deleteBackup(gameId, path);
    } else {
      try { await removeGameFile(root, path); }
      catch (error) { if ((error as DOMException)?.name !== "NotFoundError") throw error; }
    }
    changed.push(path);
  }
  return changed;
}
