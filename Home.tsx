import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Archive, ArrowDownToLine, Boxes, Check, CheckCircle2, ChevronDown, CircleAlert,
  Clock3, FileText, Filter, Folder, FolderOpen, Gamepad2, HardDrive, History, LibraryBig,
  PackageCheck, PackagePlus, Plus, RotateCcw, Search, ShieldAlert, ShieldCheck, SlidersHorizontal,
  Sparkles, Trash2, X,
} from "lucide-react";
import { readModArchive } from "@/lib/archive";
import {
  EMPTY_STATE, deleteModFiles, getGameHandle, getModFiles, listBackups, loadState,
  saveGameHandle, saveModFiles, saveState, type LocalMod, type ModProfile, type ModState,
  type OfflineGame, type Operation,
} from "@/lib/mod-store";
import { applyFiles, chooseGameFolder, readExistingFile, restoreFiles } from "@/lib/game-files";

type Section = "overview" | "library" | "profiles" | "diagnostics" | "history";
type ModalName = "game" | "profile" | null;
type Issue = { level: "error" | "warning"; title: string; detail: string; paths?: string[] };

const sections: { id: Section; label: string; icon: typeof Boxes }[] = [
  { id: "overview", label: "Visão geral", icon: Boxes },
  { id: "library", label: "Biblioteca", icon: LibraryBig },
  { id: "profiles", label: "Perfis", icon: SlidersHorizontal },
  { id: "diagnostics", label: "Diagnóstico", icon: CircleAlert },
  { id: "history", label: "Histórico", icon: History },
];

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function timestamp() { return new Date().toISOString(); }
function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function plural(value: number, singular: string, pluralLabel = `${singular}s`) { return `${value} ${value === 1 ? singular : pluralLabel}`; }

function logOperation(state: ModState, operation: Omit<Operation, "id" | "date">): ModState {
  return { ...state, history: [{ ...operation, id: newId(), date: timestamp() }, ...state.history].slice(0, 150) };
}

function activeModsFor(state: ModState, gameId: string) {
  return state.mods.filter((mod) => mod.gameId === gameId && mod.active);
}

function collectIssues(state: ModState, gameId: string, modIds: string[]): Issue[] {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return [{ level: "error", title: "Jogo não cadastrado", detail: "Cadastre o jogo offline antes de aplicar mods." }];
  if (game.onlineBlocked) return [{ level: "error", title: "Operação bloqueada para este jogo", detail: "O executável ou modo foi marcado como online. A ferramenta não aplicará alterações aqui." }];
  const selected = state.mods.filter((mod) => mod.gameId === gameId && modIds.includes(mod.id));
  const issues: Issue[] = [];
  for (const mod of selected) {
    if (mod.supportedGameVersion && mod.supportedGameVersion !== game.version) {
      issues.push({ level: "error", title: `Versão incompatível: ${mod.name}`, detail: `O pacote informa suporte a ${mod.supportedGameVersion}; o cadastro do jogo está em ${game.version}.` });
    }
    for (const dependency of mod.dependencies) {
      const found = selected.some((candidate) => candidate.id === dependency || candidate.name.toLowerCase() === dependency.toLowerCase());
      if (!found) issues.push({ level: "error", title: `Dependência ausente: ${mod.name}`, detail: `Adicione “${dependency}” ao conjunto antes de aplicar este mod.` });
    }
  }
  const owners = new Map<string, string>();
  for (const mod of selected) {
    for (const path of mod.files) {
      const previous = owners.get(path.toLowerCase());
      if (previous && previous !== mod.id) {
        const other = selected.find((candidate) => candidate.id === previous);
        issues.push({ level: "error", title: "Conflito entre arquivos", detail: `${other?.name ?? "Outro mod"} e ${mod.name} alteram o mesmo arquivo.`, paths: [path] });
      } else owners.set(path.toLowerCase(), mod.id);
    }
  }
  return issues;
}

function currentIssues(state: ModState): Issue[] {
  return state.games.flatMap((game) => {
    const active = activeModsFor(state, game.id);
    const activeIds = active.map((mod) => mod.id);
    const candidates = state.mods.filter((mod) => mod.gameId === game.id && !mod.active);
    const scenarios = [activeIds, ...candidates.map((mod) => [...activeIds, mod.id])];
    const unique = new Map<string, Issue>();
    for (const ids of scenarios) {
      for (const issue of collectIssues(state, game.id, ids)) unique.set(`${issue.title}:${issue.detail}`, issue);
    }
    return [...unique.values()].map((issue) => ({ ...issue, detail: `${game.name}: ${issue.detail}` }));
  });
}

function ModalFrame({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-topline"><div><p className="eyebrow">CONFIGURAÇÃO LOCAL</p><h2>{title}</h2><p className="modal-subtitle">{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={18} /></button></div>
        {children}
      </section>
    </div>
  );
}

export default function Home() {
  const [state, setState] = useState<ModState>(() => {
    try { return loadState(); } catch { return EMPTY_STATE; }
  });
  const [section, setSection] = useState<Section>("overview");
  const [selectedGameId, setSelectedGameId] = useState("");
  const [modal, setModal] = useState<ModalName>(null);
  const [detailMod, setDetailMod] = useState<LocalMod | null>(null);
  const [gameName, setGameName] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [executable, setExecutable] = useState("");
  const [onlineBlocked, setOnlineBlocked] = useState(false);
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [profileName, setProfileName] = useState("");
  const [searchText, setSearchText] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("Todas as categorias");
  const [statusFilter, setStatusFilter] = useState("Todos os mods");
  const [toast, setToast] = useState<{ text: string; type: "success" | "error" | "info" | "warning" } | null>(null);
  const [busy, setBusy] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const update = (change: (previous: ModState) => ModState) => {
    setState((previous) => {
      const next = change(previous);
      try { saveState(next); } catch { setToast({ text: "O armazenamento local está cheio. Remova pacotes grandes e tente novamente.", type: "error" }); }
      return next;
    });
  };
  const notify = (text: string, type: "success" | "error" | "info" | "warning" = "info") => {
    setToast({ text, type });
    window.setTimeout(() => setToast((current) => current?.text === text ? null : current), 4400);
  };
  const selectedGame = state.games.find((game) => game.id === selectedGameId) ?? state.games[0];
  const gameMods = state.mods.filter((mod) => !selectedGame || mod.gameId === selectedGame.id);
  const categories = useMemo(() => ["Todas as categorias", ...new Set(gameMods.map((mod) => mod.category).filter(Boolean))], [gameMods]);
  const visibleMods = gameMods.filter((mod) => {
    const query = searchText.trim().toLowerCase();
    const matchesQuery = !query || [mod.name, mod.author, mod.description, mod.category].some((value) => value.toLowerCase().includes(query));
    const matchesCategory = categoryFilter === "Todas as categorias" || mod.category === categoryFilter;
    const matchesStatus = statusFilter === "Todos os mods" || (statusFilter === "Ativos" ? mod.active : !mod.active);
    return matchesQuery && matchesCategory && matchesStatus;
  });
  const issueList = currentIssues(state);
  const activeCount = state.mods.filter((mod) => mod.active).length;

  const openGameModal = () => {
    setGameName(""); setGameVersion(""); setExecutable(""); setOnlineBlocked(false); setDirectory(null); setModal("game");
  };

  const selectFolder = async () => {
    try {
      const handle = await chooseGameFolder();
      setDirectory(handle);
      notify(`Pasta “${handle.name}” selecionada.`, "success");
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") notify((error as Error).message || "Não foi possível selecionar a pasta.", "error");
    }
  };

  const addGame = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!gameName.trim() || !gameVersion.trim() || !executable.trim() || !directory) {
      notify("Preencha os campos e escolha a pasta do jogo.", "error"); return;
    }
    setBusy("game");
    try {
      const executableFile = await readExistingFile(directory, executable.trim());
      if (!executableFile) throw new Error(`Não encontrei “${executable.trim()}” dentro da pasta selecionada. Informe um caminho relativo válido, como bin/Game.exe.`);
      const game: OfflineGame = { id: newId(), name: gameName.trim(), version: gameVersion.trim(), executable: executable.trim(), directoryName: directory.name, onlineBlocked, createdAt: timestamp() };
      await saveGameHandle(game.id, directory);
      update((previous) => logOperation({ ...previous, games: [game, ...previous.games] }, { kind: "profile", gameId: game.id, message: `Jogo offline cadastrado: ${game.name}.`, paths: [game.executable] }));
      setSelectedGameId(game.id); setSection("overview"); setModal(null);
      notify(onlineBlocked ? "Jogo cadastrado e bloqueado para qualquer alteração." : "Jogo offline cadastrado com acesso local.", onlineBlocked ? "info" : "success");
    } catch (error) { notify((error as Error).message || "Falha ao cadastrar jogo.", "error"); }
    finally { setBusy(""); }
  };

  const importMod = async (file?: File) => {
    if (!file) return;
    if (!selectedGame) { notify("Cadastre ou selecione um jogo antes de importar mods.", "error"); return; }
    if (selectedGame.onlineBlocked) { notify("A importação está bloqueada: este jogo/modo foi marcado como online.", "error"); return; }
    setBusy("import");
    try {
      const imported = await readModArchive(file);
      const modId = newId();
      const mod: LocalMod = {
        id: modId, gameId: selectedGame.id, name: imported.name, version: imported.version, author: imported.author,
        description: imported.description, instructions: imported.instructions, category: imported.category,
        dependencies: imported.dependencies, supportedGameVersion: imported.supportedGameVersion,
        files: imported.files.map((item) => item.path), active: false, importedAt: timestamp(),
      };
      await saveModFiles(modId, imported.files);
      update((previous) => logOperation({ ...previous, mods: [mod, ...previous.mods] }, { kind: "import", gameId: selectedGame.id, modId, message: `Pacote importado: ${mod.name}.`, paths: mod.files }));
      setSection("library"); setCategoryFilter("Todas as categorias"); setStatusFilter("Todos os mods");
      notify(`${mod.name} importado. Revise os avisos antes de ativar.`, "success");
    } catch (error) { notify((error as Error).message || "Não foi possível importar o pacote.", "error"); }
    finally { setBusy(""); if (fileInput.current) fileInput.current.value = ""; }
  };

  const activateMod = async (mod: LocalMod) => {
    const game = state.games.find((item) => item.id === mod.gameId);
    if (!game) return;
    const desired = [...new Set([...activeModsFor(state, game.id).map((item) => item.id), mod.id])];
    const issues = collectIssues(state, game.id, desired);
    if (issues.length) { notify(issues[0].detail, "error"); setSection("diagnostics"); return; }
    setBusy(mod.id);
    try {
      const handle = await getGameHandle(game.id);
      if (!handle) throw new Error("A pasta vinculada não está disponível. Edite o cadastro e escolha novamente a pasta do jogo.");
      const files = await getModFiles(mod.id);
      if (!files.length) throw new Error("Os arquivos deste pacote não estão mais no armazenamento local. Importe o ZIP novamente.");
      const changed = await applyFiles(game.id, handle, files);
      update((previous) => logOperation({ ...previous, mods: previous.mods.map((item) => item.id === mod.id ? { ...item, active: true } : item) }, { kind: "activate", gameId: game.id, modId: mod.id, message: `Mod ativado: ${mod.name}.`, paths: changed }));
      notify(`${mod.name} aplicado com backup dos arquivos originais quando necessário.`, "success");
    } catch (error) {
      update((previous) => logOperation(previous, { kind: "error", gameId: game.id, modId: mod.id, message: `Falha ao ativar ${mod.name}: ${(error as Error).message}`, paths: mod.files }));
      notify((error as Error).message || "Falha ao ativar mod.", "error");
    } finally { setBusy(""); }
  };

  const deactivateMod = async (mod: LocalMod, silent = false) => {
    const game = state.games.find((item) => item.id === mod.gameId);
    if (!game) return false;
    const handle = await getGameHandle(game.id);
    if (!handle) throw new Error("A pasta vinculada não está disponível. Escolha novamente a pasta do jogo para restaurar os arquivos.");
    const changed = await restoreFiles(game.id, handle, mod.files);
    update((previous) => logOperation({ ...previous, mods: previous.mods.map((item) => item.id === mod.id ? { ...item, active: false } : item) }, { kind: "deactivate", gameId: game.id, modId: mod.id, message: `Mod desativado e arquivos restaurados: ${mod.name}.`, paths: changed }));
    if (!silent) notify(`${mod.name} desativado; originais restaurados.`, "success");
    return true;
  };

  const toggleMod = async (mod: LocalMod) => {
    setBusy(mod.id);
    try {
      if (mod.active) await deactivateMod(mod);
      else await activateMod(mod);
    } catch (error) {
      update((previous) => logOperation(previous, { kind: "error", gameId: mod.gameId, modId: mod.id, message: `Falha ao desativar ${mod.name}: ${(error as Error).message}`, paths: mod.files }));
      notify((error as Error).message || "Falha na operação do mod.", "error");
    } finally { setBusy(""); }
  };

  const removeMod = async (mod: LocalMod) => {
    if (mod.active && !window.confirm(`Desativar “${mod.name}”, restaurar os arquivos originais e remover o pacote local?`)) return;
    setBusy(mod.id);
    try {
      if (mod.active) await deactivateMod(mod, true);
      await deleteModFiles(mod.id);
      update((previous) => logOperation({ ...previous, mods: previous.mods.filter((item) => item.id !== mod.id), profiles: previous.profiles.map((profile) => ({ ...profile, modIds: profile.modIds.filter((id) => id !== mod.id) })) }, { kind: "remove", gameId: mod.gameId, modId: mod.id, message: `Pacote removido da biblioteca: ${mod.name}.`, paths: mod.files }));
      notify("Pacote removido da biblioteca local.", "success");
    } catch (error) { notify((error as Error).message || "Falha ao remover o pacote.", "error"); }
    finally { setBusy(""); }
  };

  const createProfile = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedGame || !profileName.trim()) return;
    const profile: ModProfile = { id: newId(), gameId: selectedGame.id, name: profileName.trim(), modIds: activeModsFor(state, selectedGame.id).map((mod) => mod.id), createdAt: timestamp() };
    update((previous) => logOperation({ ...previous, profiles: [profile, ...previous.profiles] }, { kind: "profile", gameId: selectedGame.id, message: `Perfil salvo: ${profile.name}.`, paths: [] }));
    setProfileName(""); setModal(null); notify("Combinação atual salva como perfil.", "success");
  };

  const applyProfile = async (profile: ModProfile) => {
    const game = state.games.find((item) => item.id === profile.gameId);
    if (!game) return;
    const issues = collectIssues(state, game.id, profile.modIds);
    if (issues.length) { notify(issues[0].detail, "error"); setSection("diagnostics"); return; }
    setBusy(profile.id);
    try {
      const desired = new Set(profile.modIds);
      const currentlyActive = activeModsFor(state, game.id);
      for (const mod of currentlyActive) if (!desired.has(mod.id)) await deactivateMod(mod, true);
      const fresh = loadState();
      for (const id of profile.modIds) {
        const mod = fresh.mods.find((item) => item.id === id);
        if (mod && !mod.active) {
          const handle = await getGameHandle(game.id);
          if (!handle) throw new Error("Escolha novamente a pasta vinculada ao jogo.");
          await applyFiles(game.id, handle, await getModFiles(mod.id));
          update((previous) => ({ ...previous, mods: previous.mods.map((item) => item.id === mod.id ? { ...item, active: true } : item) }));
        }
      }
      update((previous) => logOperation(previous, { kind: "profile", gameId: game.id, message: `Perfil aplicado: ${profile.name}.`, paths: [] }));
      notify(`Perfil “${profile.name}” aplicado.`, "success");
    } catch (error) { notify((error as Error).message || "Não foi possível aplicar o perfil.", "error"); }
    finally { setBusy(""); }
  };

  const requestRestore = async (game: OfflineGame) => {
    setBusy(`restore-${game.id}`);
    try {
      const handle = await getGameHandle(game.id);
      if (!handle) throw new Error("A pasta vinculada não está disponível. Edite o cadastro e escolha novamente.");
      const active = activeModsFor(state, game.id);
      for (const mod of active) await deactivateMod(mod, true);
      const remainingBackups = await listBackups(game.id);
      if (remainingBackups.length) await restoreFiles(game.id, handle, remainingBackups.map((backup) => backup.path));
      update((previous) => logOperation(previous, { kind: "restore", gameId: game.id, message: `Restauração do estado sem mods solicitada para ${game.name}.`, paths: remainingBackups.map((backup) => backup.path) }));
      notify(`Restauração concluída para ${game.name}.`, "success");
    } catch (error) { notify((error as Error).message || "Falha ao restaurar o jogo.", "error"); }
    finally { setBusy(""); }
  };

  const reselectFolder = async (game: OfflineGame) => {
    try {
      const handle = await chooseGameFolder();
      const oldHandle = await getGameHandle(game.id);
      const sameEntry = oldHandle ? await oldHandle.isSameEntry(handle).catch(() => false) : false;
      if (!sameEntry && !window.confirm(`A pasta selecionada (“${handle.name}”) pode ser diferente da pasta original (“${game.directoryName}”). Vincular este novo local pode alterar ou restaurar arquivos em outra pasta. Continuar?`)) return;
      await saveGameHandle(game.id, handle);
      notify(`Acesso à pasta de ${game.name} atualizado.`, "success");
    } catch (error) { if ((error as DOMException)?.name !== "AbortError") notify((error as Error).message || "Falha ao selecionar a pasta.", "error"); }
  };

  const changeOnlineBlock = (game: OfflineGame, nextValue: boolean) => {
    if (nextValue && activeModsFor(state, game.id).length && !window.confirm("Este jogo tem mods ativos. Ao bloquear o cadastro, os mods ativos serão restaurados primeiro. Continuar?")) return;
    void (async () => {
      try {
        if (nextValue) for (const mod of activeModsFor(state, game.id)) await deactivateMod(mod, true);
        update((previous) => logOperation({ ...previous, games: previous.games.map((item) => item.id === game.id ? { ...item, onlineBlocked: nextValue } : item) }, { kind: "profile", gameId: game.id, message: nextValue ? `${game.name} marcado como online e bloqueado.` : `Bloqueio online removido de ${game.name}.`, paths: [] }));
        notify(nextValue ? "Jogo bloqueado para instalação ou alteração de mods." : "Bloqueio removido. Confirme que o uso será exclusivamente offline.", nextValue ? "info" : "warning");
      } catch (error) { notify((error as Error).message || "Não foi possível alterar o bloqueio.", "error"); }
    })();
  };

  const renderModCard = (mod: LocalMod) => {
    const game = state.games.find((item) => item.id === mod.gameId);
    const modIssues = game ? collectIssues(state, game.id, [...activeModsFor(state, game.id).map((item) => item.id).filter((id) => id !== mod.id), ...(mod.active ? [] : [mod.id])]) : [];
    const blocked = Boolean(game?.onlineBlocked);
    return (
      <article className={`mod-card ${mod.active ? "is-active" : ""}`} key={mod.id}>
        <div className="mod-card-top"><div className={`mod-icon ${mod.active ? "mod-icon-active" : ""}`}><Archive size={19} /></div><span className={`status-pill ${mod.active ? "status-on" : "status-ready"}`}><i />{mod.active ? "Ativo" : "Disponível"}</span></div>
        <div className="mod-heading"><div><h3>{mod.name}</h3><p className="mod-subline">v{mod.version} <span>·</span> {mod.author}</p></div><button className="icon-button subtle" title="Remover da biblioteca" onClick={() => void removeMod(mod)} disabled={busy === mod.id}><Trash2 size={16} /></button></div>
        <p className="mod-description">{mod.description}</p>
        <div className="mod-tags"><span className="tag">{mod.category}</span><span className="tag tag-file">{plural(mod.files.length, "arquivo")}</span>{mod.supportedGameVersion && <span className="tag">Jogo {mod.supportedGameVersion}</span>}</div>
        {(modIssues.length > 0 || blocked) && !mod.active && <p className="mod-warning"><AlertTriangle size={14} />{blocked ? "Aplicação bloqueada para jogo/modo online" : modIssues[0]?.title}</p>}
        <div className="mod-card-footer"><button className="detail-button" onClick={() => setDetailMod(mod)}><FileText size={13} />Detalhes</button><button className={mod.active ? "button button-ghost button-small" : "button button-primary button-small"} onClick={() => void toggleMod(mod)} disabled={busy === mod.id || (blocked && !mod.active)}>{busy === mod.id ? <span className="spinner" /> : mod.active ? <RotateCcw size={15} /> : <ArrowDownToLine size={15} />}{mod.active ? "Desativar" : "Ativar"}</button></div>
      </article>
    );
  };

  const renderGameCard = (game: OfflineGame) => {
    const mods = state.mods.filter((mod) => mod.gameId === game.id);
    const profiles = state.profiles.filter((profile) => profile.gameId === game.id);
    const active = mods.filter((mod) => mod.active).length;
    return (
      <article className={`game-card ${selectedGame?.id === game.id ? "game-card-selected" : ""}`} key={game.id}>
        <div className="game-card-banner"><div className="game-art-grid" /><span className={game.onlineBlocked ? "game-status game-status-blocked" : "game-status"}><i />{game.onlineBlocked ? "Bloqueado" : "Modo offline"}</span><div className="game-platform-icon"><Gamepad2 size={25} /></div></div>
        <div className="game-card-body"><div className="game-title-row"><div><h3>{game.name}</h3><p className="mod-subline">Versão {game.version}</p></div><button className="icon-button subtle" title="Selecionar jogo" onClick={() => { setSelectedGameId(game.id); setSection("library"); }}><ChevronDown size={17} /></button></div>
          <div className="game-path"><Folder size={14} /><span>{game.directoryName}</span><span className="path-separator">/</span><code>{game.executable}</code></div>
          <div className="game-card-stats"><span><PackageCheck size={14} />{plural(active, "mod ativo")}</span><span><SlidersHorizontal size={14} />{plural(profiles.length, "perfil")}</span><span><Archive size={14} />{plural(mods.length, "mod")}</span></div>
          <div className="game-actions"><button className="button button-ghost button-small" onClick={() => void reselectFolder(game)}><FolderOpen size={14} />Pasta local</button><button className="button button-ghost button-small" onClick={() => void requestRestore(game)} disabled={busy === `restore-${game.id}`}><RotateCcw size={14} />Restaurar originais</button></div>
          <label className="online-check"><input type="checkbox" checked={game.onlineBlocked} onChange={(event) => changeOnlineBlock(game, event.target.checked)} /><span>Bloquear este jogo/modo como online</span></label>
        </div>
      </article>
    );
  };

  const renderMain = () => {
    if (section === "overview") return (
      <>
        <div className="page-heading"><div><p className="eyebrow">PAINEL LOCAL · {new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(new Date()).toUpperCase()}</p><h1>Sua oficina de mods.</h1><p className="page-description">Tudo organizado no seu dispositivo. Você decide o que entra, o que sai e onde.</p></div><button className="button button-primary" onClick={openGameModal}><Plus size={17} />Adicionar jogo offline</button></div>
        <div className="stats-row">
          <div className="stat-card"><span className="stat-label">JOGOS NA BIBLIOTECA</span><div className="stat-value">{state.games.length.toString().padStart(2, "0")}<Gamepad2 size={18} /></div><span className="stat-foot">Pastas locais vinculadas</span></div>
          <div className="stat-card"><span className="stat-label">MODS ATIVOS</span><div className="stat-value">{activeCount.toString().padStart(2, "0")}<PackageCheck size={18} /></div><span className="stat-foot">Aplicados com backup</span></div>
          <div className="stat-card"><span className="stat-label">PERFIS SALVOS</span><div className="stat-value">{state.profiles.length.toString().padStart(2, "0")}<SlidersHorizontal size={18} /></div><span className="stat-foot">Combinações por jogo</span></div>
          <div className="stat-card stat-alert"><span className="stat-label">ALERTAS DE COMPATIBILIDADE</span><div className="stat-value">{issueList.length.toString().padStart(2, "0")}<ShieldCheck size={18} /></div><span className="stat-foot">{issueList.length ? "Revise antes de ativar" : "Nenhum problema detectado"}</span></div>
        </div>
        <div className="welcome-strip"><div className="welcome-icon"><ShieldCheck size={20} /></div><div className="welcome-copy"><strong>Mods só em sessões offline.</strong><span>Sem conexão com partidas, sem executar o jogo e sem enviar seus arquivos para servidores.</span></div><span className="local-only"><span /> SOMENTE NESTE DISPOSITIVO</span></div>
        <div className="content-columns"><section className="content-panel game-panel"><div className="panel-heading"><div><p className="eyebrow">SEU ACERVO</p><h2>Jogos offline</h2></div><button className="text-button" onClick={() => setSection("library")}>Abrir biblioteca <span>→</span></button></div>
          {state.games.length ? <div className="game-grid">{state.games.map(renderGameCard)}</div> : <div className="empty-state"><div className="empty-symbol"><Gamepad2 size={25} /></div><h3>Seu primeiro jogo começa aqui.</h3><p>Vincule uma pasta local e marque os jogos que precisam permanecer bloqueados para uso online.</p><button className="button button-primary" onClick={openGameModal}><Plus size={16} />Cadastrar jogo offline</button></div>}
        </section><aside className="content-panel activity-panel"><div className="panel-heading"><div><p className="eyebrow">NO DISPOSITIVO</p><h2>Atividade recente</h2></div><button className="icon-button subtle" title="Ver histórico" onClick={() => setSection("history")}><History size={17} /></button></div>
          {state.history.length ? <div className="activity-list">{state.history.slice(0, 5).map((item) => <div className="activity-item" key={item.id}><div className={`activity-dot activity-${item.kind}`}><Check size={13} /></div><div><strong>{item.message}</strong><span>{formatDate(item.date)}</span></div></div>)}</div> : <div className="activity-empty"><Clock3 size={19} /><span>As operações feitas aqui aparecerão neste histórico local.</span></div>}
          <div className="quick-tip"><Sparkles size={15} /><p><strong>Dica de segurança</strong> Faça uma cópia dos saves por fora antes de testar alterações grandes.</p></div>
        </aside></div>
      </>
    );

    if (section === "library") return (
      <>
        <div className="page-heading"><div><p className="eyebrow">CATÁLOGO LOCAL</p><h1>Biblioteca de mods.</h1><p className="page-description">Pacotes importados ficam neste dispositivo até você escolher aplicá-los.</p></div><button className="button button-primary" onClick={() => fileInput.current?.click()} disabled={!selectedGame || selectedGame.onlineBlocked || busy === "import"}>{busy === "import" ? <span className="spinner" /> : <PackagePlus size={17} />}Importar pacote ZIP</button></div>
        {!state.games.length ? <div className="content-panel empty-state large-empty"><div className="empty-symbol"><FolderOpen size={25} /></div><h3>Cadastre um jogo para começar.</h3><p>O pacote importado ficará vinculado ao jogo selecionado e só será aplicado após uma ação explícita.</p><button className="button button-primary" onClick={openGameModal}><Plus size={16} />Adicionar jogo offline</button></div> : <>
          <div className="library-toolbar"><label className="game-select-wrap"><Gamepad2 size={16} /><select value={selectedGame?.id ?? ""} onChange={(event) => setSelectedGameId(event.target.value)}>{state.games.map((game) => <option key={game.id} value={game.id}>{game.name}{game.onlineBlocked ? " · bloqueado" : ""}</option>)}</select><ChevronDown size={14} /></label><label className="search-box"><Search size={16} /><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Buscar por nome, autor ou categoria" /></label><label className="filter-select"><Filter size={15} /><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label className="filter-select"><SlidersHorizontal size={15} /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>Todos os mods</option><option>Ativos</option><option>Disponíveis</option></select></label></div>
          {selectedGame?.onlineBlocked && <div className="inline-alert"><ShieldAlert size={18} /><div><strong>Este jogo está bloqueado.</strong><span>Mods podem ser visualizados e removidos da biblioteca, mas não aplicados enquanto o bloqueio online estiver ativo.</span></div></div>}
          {visibleMods.length ? <div className="mod-grid">{visibleMods.map(renderModCard)}</div> : <div className="content-panel empty-state large-empty"><div className="empty-symbol"><Archive size={25} /></div><h3>{gameMods.length ? "Nenhum mod corresponde aos filtros." : "A biblioteca ainda está vazia."}</h3><p>{gameMods.length ? "Ajuste a busca ou os filtros para encontrar seus pacotes." : "Importe um arquivo ZIP com os arquivos do mod, mod.json/manifest.json opcional e instruções em README."}</p><button className="button button-primary" onClick={() => fileInput.current?.click()} disabled={selectedGame?.onlineBlocked}><PackagePlus size={16} />Importar pacote local</button></div>}
          <div className="browser-note"><HardDrive size={15} /><span>Os pacotes e metadados são armazenados localmente no navegador. Nada é enviado para partidas ou serviços de mods.</span></div>
        </>}
      </>
    );

    if (section === "profiles") return (
      <>
        <div className="page-heading"><div><p className="eyebrow">COMBINAÇÕES SALVAS</p><h1>Perfis de mods.</h1><p className="page-description">Guarde conjuntos por jogo e volte a uma configuração conhecida com poucos passos.</p></div><button className="button button-primary" onClick={() => selectedGame ? setModal("profile") : notify("Cadastre um jogo antes de salvar um perfil.", "error")} disabled={!selectedGame}><Plus size={17} />Salvar combinação atual</button></div>
        {selectedGame && <div className="library-toolbar"><label className="game-select-wrap"><Gamepad2 size={16} /><select value={selectedGame.id} onChange={(event) => setSelectedGameId(event.target.value)}>{state.games.map((game) => <option key={game.id} value={game.id}>{game.name}</option>)}</select><ChevronDown size={14} /></label><span className="toolbar-hint">A combinação salva inclui os mods ativos deste jogo.</span></div>}
        {state.profiles.filter((profile) => !selectedGame || profile.gameId === selectedGame.id).length ? <div className="profile-list">{state.profiles.filter((profile) => !selectedGame || profile.gameId === selectedGame.id).map((profile) => { const game = state.games.find((item) => item.id === profile.gameId); const names = profile.modIds.map((id) => state.mods.find((mod) => mod.id === id)?.name).filter(Boolean); return <article className="profile-card" key={profile.id}><div className="profile-icon"><SlidersHorizontal size={20} /></div><div className="profile-main"><div className="profile-title-row"><h3>{profile.name}</h3><span className="tag">{game?.name ?? "Jogo removido"}</span></div><p>{names.length ? names.join(" · ") : "Perfil vazio — nenhum mod ativo ao salvar."}</p><span className="subtle-copy">Salvo em {formatDate(profile.createdAt)} · {plural(profile.modIds.length, "mod")}</span></div><button className="button button-primary button-small" onClick={() => void applyProfile(profile)} disabled={busy === profile.id || !game || game.onlineBlocked}>{busy === profile.id ? <span className="spinner" /> : <CheckCircle2 size={15} />}Aplicar perfil</button></article>; })}</div> : <div className="content-panel empty-state large-empty"><div className="empty-symbol"><SlidersHorizontal size={25} /></div><h3>Nenhuma combinação salva.</h3><p>Ative os mods desejados na biblioteca e salve a combinação como um perfil para este jogo.</p>{selectedGame && <button className="button button-primary" onClick={() => setModal("profile")}><Plus size={16} />Criar perfil</button>}</div>}
      </>
    );

    if (section === "diagnostics") return (
      <>
        <div className="page-heading"><div><p className="eyebrow">COMPATIBILIDADE E SEGURANÇA</p><h1>Diagnóstico local.</h1><p className="page-description">Conflitos, dependências, versões e bloqueios antes de aplicar alterações.</p></div><div className="diagnostic-score"><span className={issueList.length ? "score-dot score-warn" : "score-dot"} />{issueList.length ? `${issueList.length} alerta(s)` : "Tudo em ordem"}</div></div>
        <div className="diagnostic-banner"><div className="diagnostic-banner-icon"><ShieldCheck size={22} /></div><div><strong>Checagem antes de aplicar</strong><span>Os conflitos entre mods ativos são comparados por caminho de arquivo. Dependências e versão do jogo vêm do manifesto local, quando disponível.</span></div></div>
        {issueList.length ? <div className="issue-list">{issueList.map((issue, index) => <article className={`issue-card issue-${issue.level}`} key={`${issue.title}-${index}`}><div className="issue-icon">{issue.level === "error" ? <AlertTriangle size={18} /> : <CircleAlert size={18} />}</div><div><strong>{issue.title}</strong><p>{issue.detail}</p>{issue.paths?.length ? <div className="issue-paths">{issue.paths.map((path) => <code key={path}>{path}</code>)}</div> : null}</div><span className="issue-level">{issue.level === "error" ? "BLOQUEANTE" : "AVISO"}</span></article>)}</div> : <div className="content-panel clear-diagnostics"><div className="clear-check"><Check size={24} /></div><h3>Nenhum conflito encontrado.</h3><p>Não há mods ativos incompatíveis nem jogos marcados como online no seu catálogo.</p></div>}
        <div className="section-subhead"><div><p className="eyebrow">PROTEÇÃO POR JOGO</p><h2>Jogos cadastrados</h2></div></div>
        {state.games.length ? <div className="game-grid">{state.games.map(renderGameCard)}</div> : <div className="content-panel empty-state"><p>Cadastre um jogo para acompanhar compatibilidade e bloqueios.</p><button className="button button-primary" onClick={openGameModal}><Plus size={16} />Adicionar jogo</button></div>}
      </>
    );

    return (
      <>
        <div className="page-heading"><div><p className="eyebrow">TRILHA DE AUDITORIA</p><h1>Histórico local.</h1><p className="page-description">Registro neste navegador das importações, alterações e restaurações realizadas.</p></div><span className="local-only history-local"><span /> ARMAZENADO LOCALMENTE</span></div>
        {state.history.length ? <div className="history-list">{state.history.map((item) => { const game = state.games.find((entry) => entry.id === item.gameId); const mod = state.mods.find((entry) => entry.id === item.modId); const Icon = item.kind === "error" ? AlertTriangle : item.kind === "import" ? Archive : item.kind === "restore" || item.kind === "deactivate" ? RotateCcw : item.kind === "profile" ? SlidersHorizontal : item.kind === "install" || item.kind === "activate" ? PackageCheck : Trash2; return <article className="history-item" key={item.id}><div className={`history-icon history-${item.kind}`}><Icon size={16} /></div><div className="history-copy"><strong>{item.message}</strong><span>{game?.name ?? "Biblioteca local"}{mod ? ` · ${mod.name}` : ""}</span>{item.paths.length > 0 && <details><summary>{plural(item.paths.length, "caminho afetado")}</summary><div className="history-paths">{item.paths.slice(0, 20).map((path) => <code key={path}>{path}</code>)}</div></details>}</div><time>{formatDate(item.date)}</time></article>; })}</div> : <div className="content-panel empty-state large-empty"><div className="empty-symbol"><History size={25} /></div><h3>Nenhuma operação registrada.</h3><p>O histórico fica neste dispositivo e ajuda a identificar caminhos alterados, avisos e erros.</p></div>}
        <div className="browser-note"><HardDrive size={15} /><span>O histórico é salvo no armazenamento local do navegador. Limpar os dados do navegador também pode removê-lo.</span></div>
      </>
    );
  };

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div className="brand-word"><strong>MODOTECA</strong><span>OFFLINE TOOLKIT</span></div></div>
        <div className="sidebar-kicker">ESPAÇO DE TRABALHO</div>
        <nav className="side-nav" aria-label="Navegação principal">{sections.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-link ${section === id ? "nav-link-active" : ""}`} onClick={() => setSection(id)}><Icon size={18} /><span>{label}</span>{id === "diagnostics" && issueList.length > 0 && <b>{issueList.length}</b>}</button>)}</nav>
        <div className="sidebar-game-list"><div className="sidebar-kicker">JOGOS OFFLINE <button className="tiny-add" onClick={openGameModal} aria-label="Adicionar jogo"><Plus size={14} /></button></div>{state.games.length ? state.games.slice(0, 4).map((game) => <button key={game.id} className={`sidebar-game ${selectedGame?.id === game.id ? "sidebar-game-active" : ""}`} onClick={() => { setSelectedGameId(game.id); setSection("library"); }}><span className="sidebar-game-icon"><Gamepad2 size={14} /></span><span>{game.name}</span><i className={game.onlineBlocked ? "dot-locked" : ""} /></button>) : <p className="sidebar-empty">Nenhum jogo cadastrado</p>}</div>
        <div className="sidebar-spacer" />
        <div className="offline-shield"><div><ShieldCheck size={16} /><span>SESSÕES OFFLINE</span></div><p>Sem conexão com partidas.<br />Sem execução de jogos.</p><div className="offline-indicator"><span /> CONTROLE LOCAL ATIVO</div></div>
        <div className="sidebar-footer"><div className="avatar-mark">M</div><div><strong>Armazenamento local</strong><span>Este dispositivo</span></div><HardDrive size={15} /></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div className="topbar-crumb"><span>MODOTECA</span><span className="crumb-slash">/</span><strong>{sections.find((item) => item.id === section)?.label}</strong></div><div className="topbar-actions"><div className="topbar-status"><span className="status-light" /> LOCAL · PRIVADO</div><div className="topbar-divider" /><div className="topbar-device"><HardDrive size={15} /><span>Somente neste navegador</span></div></div></header>
        <div className="mobile-brand"><div className="brand-mark"><span /><span /><span /></div><div className="brand-word"><strong>MODOTECA</strong><span>OFFLINE TOOLKIT</span></div><span className="topbar-status"><span className="status-light" /> LOCAL</span></div>
        <div className="safety-bar"><ShieldCheck size={16} /><span>Ferramenta para jogos e sessões offline. Não conecta a partidas nem contorna sistemas anti-cheat.</span><span className="safety-tag">LOCAL ONLY</span></div>
        <div className="page-content">{renderMain()}</div>
        <footer className="app-footer"><span>MODOTECA OFFLINE <span className="footer-sep">/</span> SEUS ARQUIVOS FICAM NO SEU DISPOSITIVO</span><span>SEM ACESSO A PARTIDAS ONLINE</span></footer>
      </main>
      <input ref={fileInput} className="visually-hidden" type="file" accept=".zip,application/zip" onChange={(event) => void importMod(event.target.files?.[0])} />

      {modal === "game" && <ModalFrame title="Adicionar jogo offline" subtitle="Vincule uma pasta local e identifique o executável que você usa para jogar offline." onClose={() => setModal(null)}>
        <form className="modal-form" onSubmit={(event) => void addGame(event)}>
          <label className="field-label">Nome do jogo<input className="text-input" value={gameName} onChange={(event) => setGameName(event.target.value)} placeholder="Ex.: Aurora Valley" required /></label>
          <div className="form-row"><label className="field-label">Versão instalada<input className="text-input" value={gameVersion} onChange={(event) => setGameVersion(event.target.value)} placeholder="Ex.: 1.2.0" required /></label><label className="field-label">Executável (relativo à pasta)<input className="text-input" value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder="bin/Game.exe" required /></label></div>
          <div className="field-label">Pasta de instalação<div className={`folder-picker ${directory ? "folder-picker-selected" : ""}`}><div className="folder-picker-icon"><FolderOpen size={18} /></div><div className="folder-picker-copy"><strong>{directory?.name ?? "Nenhuma pasta selecionada"}</strong><span>{directory ? "Acesso local vinculado a este navegador" : "Escolha a pasta raiz do jogo"}</span></div><button type="button" className="button button-ghost button-small" onClick={() => void selectFolder()}><Folder size={14} />Selecionar</button></div><span className="field-help">O navegador não revela o caminho completo do sistema. A permissão da pasta permanece local e pode precisar ser renovada.</span></div>
          <label className="online-block-option"><input type="checkbox" checked={onlineBlocked} onChange={(event) => setOnlineBlocked(event.target.checked)} /><span><strong>Este executável ou modo também é usado online</strong><small>Bloqueia instalação, ativação e aplicação de perfis para este cadastro.</small></span><ShieldAlert size={18} /></label>
          <div className="modal-safety"><ShieldCheck size={16} /><span>O aplicativo não executa o jogo nem se conecta a serviços online. Cada gravação exige uma ação sua e gera backup quando um arquivo será substituído.</span></div>
          <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setModal(null)}>Cancelar</button><button type="submit" className="button button-primary" disabled={busy === "game" || !directory}>{busy === "game" ? <span className="spinner" /> : <Check size={16} />}Cadastrar jogo</button></div>
        </form>
      </ModalFrame>}

      {detailMod && <ModalFrame title={detailMod.name} subtitle={`${detailMod.version} · ${detailMod.author} · ${state.games.find((game) => game.id === detailMod.gameId)?.name ?? "Jogo local"}`} onClose={() => setDetailMod(null)}>
        <div className="mod-details-body"><div className="detail-facts"><div><span>VERSÃO DO PACOTE</span><strong>{detailMod.version}</strong></div><div><span>CATEGORIA</span><strong>{detailMod.category}</strong></div><div><span>JOGO COMPATÍVEL</span><strong>{detailMod.supportedGameVersion || "Não informada"}</strong></div><div><span>IMPORTADO EM</span><strong>{formatDate(detailMod.importedAt)}</strong></div></div><section className="detail-section"><h3>Descrição</h3><p>{detailMod.description}</p></section><section className="detail-section"><h3>Instruções do pacote</h3>{detailMod.instructions ? <pre className="instructions-text">{detailMod.instructions}</pre> : <p className="detail-muted">O pacote não trouxe README ou instruções reconhecíveis.</p>}</section><section className="detail-section"><h3>Arquivos ({detailMod.files.length})</h3><div className="detail-files">{detailMod.files.slice(0, 80).map((path) => <code key={path}>{path}</code>)}{detailMod.files.length > 80 && <span className="detail-muted">e mais {detailMod.files.length - 80} arquivos…</span>}</div></section>{detailMod.dependencies.length > 0 && <section className="detail-section"><h3>Dependências declaradas</h3><div className="profile-preview-tags">{detailMod.dependencies.map((dependency) => <span className="tag" key={dependency}>{dependency}</span>)}</div></section>}<div className="modal-safety"><ShieldCheck size={16} /><span>O conteúdo é mostrado como texto simples; arquivos do pacote não são executados pelo aplicativo.</span></div><div className="modal-actions"><button className="button button-ghost" onClick={() => setDetailMod(null)}>Fechar</button><button className="button button-primary" onClick={() => { setDetailMod(null); void toggleMod(detailMod); }} disabled={Boolean(state.games.find((game) => game.id === detailMod.gameId)?.onlineBlocked && !detailMod.active)}>{detailMod.active ? <RotateCcw size={15} /> : <ArrowDownToLine size={15} />}{detailMod.active ? "Desativar mod" : "Ativar mod"}</button></div></div>
      </ModalFrame>}

      {modal === "profile" && selectedGame && <ModalFrame title="Salvar perfil" subtitle={`A combinação atual de mods ativos será guardada para ${selectedGame.name}.`} onClose={() => setModal(null)}><form className="modal-form" onSubmit={createProfile}><label className="field-label">Nome do perfil<input className="text-input" value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Ex.: Exploração tranquila" required autoFocus /></label><div className="profile-preview"><p className="eyebrow">COMBINAÇÃO ATUAL</p>{activeModsFor(state, selectedGame.id).length ? <div className="profile-preview-tags">{activeModsFor(state, selectedGame.id).map((mod) => <span className="tag tag-active" key={mod.id}>{mod.name}</span>)}</div> : <p>Nenhum mod está ativo; será criado um perfil vazio.</p>}</div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setModal(null)}>Cancelar</button><button type="submit" className="button button-primary"><Check size={16} />Salvar perfil</button></div></form></ModalFrame>}

      {toast && <div className={`toast toast-${toast.type}`} role="status"><span>{toast.type === "error" ? <AlertTriangle size={17} /> : toast.type === "success" ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}</span><p>{toast.text}</p><button onClick={() => setToast(null)} aria-label="Fechar aviso"><X size={15} /></button></div>}
    </div>
  );
}
