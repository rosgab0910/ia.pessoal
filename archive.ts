import type { ModFile } from "./mod-store";

export type ImportedArchive = {
  name: string;
  version: string;
  author: string;
  description: string;
  instructions: string;
  category: string;
  dependencies: string[];
  supportedGameVersion: string;
  files: ModFile[];
};

const MAX_ENTRIES = 1500;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_TOTAL_SIZE = 250 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: false });

function findEndRecord(bytes: DataView) {
  const min = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= min; offset--) {
    if (bytes.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("O arquivo não parece ser um ZIP válido.");
}

function sanitizePath(raw: string) {
  if (!raw || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const segments = raw.split("/").filter(Boolean);
  if (!segments.length || segments.some((part) => part === "." || part === ".." || part.includes(":") || /[\u0000-\u001f]/.test(part))) return null;
  return segments.join("/");
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("Este navegador não oferece descompactação ZIP compatível. Use Chrome ou Edge atualizados.");
  try {
    const stream = new Blob([data.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FILE_SIZE) {
        await reader.cancel();
        throw new Error("O arquivo descompactado excede o limite de segurança de 100 MB.");
      }
      chunks.push(value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  } catch (error) {
    if (error instanceof Error && error.message.includes("excede o limite de segurança")) throw error;
    throw new Error("Não foi possível descompactar o pacote. Verifique se o ZIP não está protegido por senha e tente outro arquivo.");
  }
}

function readField(value: unknown, ...keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  for (const key of keys) if (typeof obj[key] === "string") return (obj[key] as string).trim();
  return "";
}

export async function readModArchive(file: File): Promise<ImportedArchive> {
  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("Selecione um pacote .zip.");
  if (file.size > MAX_TOTAL_SIZE) throw new Error("O pacote excede o limite de 250 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(view);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const entries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (disk || centralDisk || entries > MAX_ENTRIES || centralOffset + centralSize > bytes.length) {
    throw new Error("Este ZIP usa um formato dividido, ZIP64 ou possui metadados fora do limite suportado.");
  }

  const extracted: { path: string; blob: Blob }[] = [];
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("A lista de arquivos do ZIP está corrompida.");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > bytes.length) throw new Error("O ZIP contém um nome de arquivo inválido.");
    const rawName = decoder.decode(bytes.subarray(nameStart, nameEnd));
    cursor = nameEnd + extraLength + commentLength;
    if (rawName.endsWith("/")) continue;
    const mode = externalAttributes >>> 16;
    if ((mode & 0o170000) === 0o120000) throw new Error("O pacote contém links simbólicos e não será instalado por segurança.");
    const path = sanitizePath(rawName);
    if (!path) throw new Error(`Caminho inseguro rejeitado no pacote: ${rawName.slice(0, 100)}`);
    if (flags & 1) throw new Error("Pacotes ZIP protegidos por senha não são aceitos.");
    if (method !== 0 && method !== 8) throw new Error(`Método de compactação não suportado no arquivo ${path}.`);
    if (uncompressedSize > MAX_FILE_SIZE || total + uncompressedSize > MAX_TOTAL_SIZE) throw new Error("O conteúdo descompactado excede o limite de segurança.");
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Cabeçalho inválido para ${path}.`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > bytes.length) throw new Error(`Dados incompletos para ${path}.`);
    const compressed = bytes.subarray(dataOffset, dataEnd);
    const content = method === 0 ? new Uint8Array(compressed) : await inflateRaw(compressed);
    if (content.byteLength !== uncompressedSize) throw new Error(`Tamanho descompactado inesperado para ${path}.`);
    total += content.byteLength;
    extracted.push({ path, blob: new Blob([content.slice().buffer as ArrayBuffer]) });
  }
  if (!extracted.length) throw new Error("Nenhum arquivo instalável foi encontrado no pacote.");

  const firstSegments = extracted.map((item) => item.path.split("/")[0]);
  const commonRoot = firstSegments.length && firstSegments.every((segment) => segment === firstSegments[0]) && extracted.every((item) => item.path.includes("/")) ? `${firstSegments[0]}/` : "";
  const normalized = extracted.map((item) => ({ ...item, path: commonRoot ? item.path.slice(commonRoot.length) : item.path })).filter((item) => item.path);
  const metadataFile = normalized.find((item) => ["mod.json", "manifest.json"].includes(item.path.toLowerCase()));
  let metadata: Record<string, unknown> = {};
  if (metadataFile) {
    try { metadata = JSON.parse(await metadataFile.blob.text()) as Record<string, unknown>; }
    catch { throw new Error(`${metadataFile.path} não contém JSON válido.`); }
  }
  const readmeReference = readField(metadata, "readme").toLowerCase();
  const readme = normalized.find((item) => (item.path.toLowerCase() === readmeReference || /(^|\/)(readme|instructions|instrucoes)(\.[a-z0-9]+)?$/i.test(item.path)) && item.blob.size <= 250_000);
  const instructions = readField(metadata, "instructions").slice(0, 12_000) || (readme ? (await readme.blob.text()).slice(0, 12_000) : "");
  const installFiles = normalized.filter((item) => !["mod.json", "manifest.json"].includes(item.path.toLowerCase()) && !/(^|\/)(readme|instructions|instrucoes)(\.[a-z0-9]+)?$/i.test(item.path));
  if (!installFiles.length) throw new Error("O pacote não contém arquivos de mod para instalar.");
  const metaDependencies = metadata.dependencies;
  const dependencies = Array.isArray(metaDependencies) ? metaDependencies.filter((item): item is string => typeof item === "string") : [];

  return {
    name: readField(metadata, "name", "title") || file.name.replace(/\.zip$/i, ""),
    version: readField(metadata, "version") || "Sem versão",
    author: readField(metadata, "author", "creator") || "Não informado",
    description: readField(metadata, "description", "summary") || "Pacote importado localmente.",
    instructions,
    category: readField(metadata, "category", "type") || "Geral",
    dependencies,
    supportedGameVersion: readField(metadata, "gameVersion", "supportedGameVersion"),
    files: installFiles,
  };
}
