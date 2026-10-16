import {
    type ExpertClient, ExpertError, type RemoteFile, type RemotePage, SOURCE_PROPERTY, SYNC_PROPERTY,
    OVERVIEW_PROPERTY, type SyncMeta, toEditTime,
} from "./expertApi.ts";
import type { FileStat, Logger, StateStore, VaultIO } from "./io.ts";
import {
    collectFileLinks, FLAG_KEY, joinFrontmatter, readFlag, setFlag, splitFrontmatter, stripComments, toLocalMarkdown, toPublishMarkdown,
} from "./markdown.ts";
import {
    attachmentDir, basename, conflictPath, dirname, isIgnoredNote, isInside, joinPath, mimeTypeFor, relativeTo,
    stripMd, titleToFileName, titleToSegment, uniquePath,
} from "./paths.ts";

export interface SyncSettings {
    siteUrl: string;

    // site page path of the sync root, "" for the site home page
    rootPath: string;

    // vault folder that mirrors the root page, "" for the whole vault
    localFolder: string;

    // "" as localFolder publishes every note in the vault, so it needs an explicit opt-in
    allowWholeVault?: boolean;

    // store %%comments%% in the page's source property (readable by anyone who can read the page)
    keepComments?: boolean;
}

export interface FileState {
    fileId: string;
    revision: number;
    localPath: string;
    hash: string;
    mtime: number;
    size: number;
}

export interface PageState {
    id: string;
    pagePath: string;
    notePath: string;
    revision: number;
    modified: string;
    localHash: string;
    mtime: number;
    size: number;
    dynamic: boolean;
    files: Record<string, FileState>;
}

export type PendingDelete =
    | { kind: "site-page"; pageId: string; pagePath: string; notePath: string }
    | { kind: "local-note"; pageId: string; notePath: string }
    | { kind: "site-file"; pageId: string; fileId: string; name: string; localPath: string }
    | { kind: "local-file"; pageId: string; name: string; localPath: string };

export interface SyncState {
    version: 1;
    siteUrl: string;
    rootPath: string;
    localFolder: string;
    rootId: string;
    pages: Record<string, PageState>;
    pending: PendingDelete[];
}

export interface SyncReport {
    pulled: string[];
    pushed: string[];
    created: string[];
    moved: string[];
    uploaded: string[];
    downloaded: string[];
    conflicts: string[];
    blocked: string[];
    skipped: { path: string; reason: string }[];
    errors: { path: string; message: string }[];
    pending: PendingDelete[];
}

const ARTICLE_PREFIX = "article:";

// IDF hierarchy: category > guide > topic > how-to/reference
const CHILD_ARTICLE_TYPE: Record<string, string> = {
    "topic-category": "topic-guide",
    "topic-guide": "topic",
    "topic": "howto",
};

export function pendingKey(item: PendingDelete): string {
    return "fileId" in item ? `${item.kind}:${item.fileId}` : `${item.kind}:${item.pageId}:${"name" in item ? item.name : ""}`;
}

export async function sha256(data: string | ArrayBuffer): Promise<string> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function emptyReport(): SyncReport {
    return { pulled: [], pushed: [], created: [], moved: [], uploaded: [], downloaded: [], conflicts: [], blocked: [], skipped: [], errors: [], pending: [] };
}

function depth(path: string): number {
    return path === "" ? 0 : path.split("/").length;
}

function sameStat(stat: FileStat | null, mtime: number, size: number): boolean {
    return !!stat && stat.mtime === mtime && stat.size === size;
}

export class SyncEngine {
    private readonly _client: ExpertClient;
    private readonly _vault: VaultIO;
    private readonly _store: StateStore<SyncState>;
    private readonly _settings: SyncSettings;
    private readonly _log: Logger;
    private readonly _now: () => Date;

    private _state!: SyncState;
    private _report!: SyncReport;
    private _files = new Set<string>();
    private _remoteById = new Map<string, RemotePage>();
    private _remoteByPath = new Map<string, RemotePage>();
    private _plannedNotes = new Map<string, string>();
    private _articleTypes = new Map<string, string | null>();
    private _usesArticleTypes: boolean | null = null;
    private _rootPagePath = "";

    constructor(client: ExpertClient, vault: VaultIO, store: StateStore<SyncState>, settings: SyncSettings, log: Logger, now: () => Date = () => new Date()) {
        this._client = client;
        this._vault = vault;
        this._store = store;
        this._settings = { ...settings, localFolder: settings.localFolder.replace(/^\/+|\/+$/g, "") };
        this._log = log;
        this._now = now;
    }

    // --- public API ---

    async sync(): Promise<SyncReport> {
        this._report = emptyReport();
        await this._loadState();
        try {
            if(this._settings.localFolder === "" && !this._settings.allowWholeVault) {
                throw new Error("No vault folder is set, which would publish every note in this vault. Choose a vault folder, or turn on \"Sync the whole vault\".");
            }
            if(!(await this._client.markdownEnabled())) {
                throw new Error("Markdown is not enabled on this site. Ask your NiCE Knowledge contact to enable markdown.");
            }
            const remote = await this._client.tree(this._settings.rootPath);
            const root = remote[0];
            this._state.rootId = root.id;
            this._rootPagePath = root.path;
            const pages = remote.slice(1).filter((page) => page.draftState !== "unpublished");
            this._remoteById = new Map(pages.map((page) => [page.id, page]));
            this._remoteByPath = new Map(pages.map((page) => [page.path, page]));
            this._files = new Set(await this._vault.listFiles());

            this._planNotePaths(pages);
            await this._pullRemoteChanges(pages);
            await this._handleRemoteDeletes();
            await this._pushLocalChanges();
        } finally {
            this._report.pending = [...this._state.pending];
            await this._store.save(this._state);
        }
        return this._report;
    }

    async pending(): Promise<PendingDelete[]> {
        await this._loadState();
        return [...this._state.pending];
    }

    // action "delete" carries the deletion through; "keep" restores the other side on the next sync
    async resolvePending(item: PendingDelete, action: "delete" | "keep"): Promise<void> {
        await this._loadState();
        const key = pendingKey(item);
        const page = this._state.pages[item.pageId];
        switch(item.kind) {
        case "site-page":
            if(action === "delete") {
                if(await this._client.hasChildPages(item.pageId)) {
                    throw new Error(`${item.pagePath} has child pages on the site. Deleting it would delete them too; move or delete them first.`);
                }
                await this._client.deletePage(item.pageId);
            }
            delete this._state.pages[item.pageId];
            break;
        case "local-note":
            if(action === "delete") {
                for(const file of Object.values(page?.files ?? {})) {
                    await this._removeIfExists(file.localPath);
                }
                await this._removeIfExists(item.notePath);
            }
            delete this._state.pages[item.pageId];
            break;
        case "site-file":
            if(action === "delete") {
                await this._client.deleteFile(item.fileId);
            } else {
                await this._vault.writeBinary(item.localPath, await this._client.downloadFile(item.fileId));
            }
            if(page) {
                delete page.files[item.name];
            }
            break;
        case "local-file":
            if(action === "delete") {
                await this._removeIfExists(item.localPath);
            }
            if(page) {
                delete page.files[item.name];
            }
            break;
        }
        this._state.pending = this._state.pending.filter((other) => pendingKey(other) !== key);
        await this._store.save(this._state);
    }

    // removes the site-edited/conflict flag so the note becomes the source again
    async acceptNote(notePath: string): Promise<string> {
        await this._loadState();
        const page = Object.values(this._state.pages).find((p) => p.notePath === notePath);
        if(page?.dynamic) {
            throw new Error("This page uses DekiScript on the site. Its note is a read-only snapshot and can't become the source.");
        }
        const text = await this._vault.readText(notePath);
        const flag = readFlag(text);
        if(!flag) {
            return "This note isn't flagged; nothing to accept.";
        }
        await this._vault.writeText(notePath, setFlag(text, null));
        return `Cleared "${FLAG_KEY}: ${flag}". The note will be pushed on the next sync.`;
    }

    // --- state ---

    private async _loadState(): Promise<void> {
        const loaded = await this._store.load();
        const { siteUrl, rootPath, localFolder } = this._settings;
        if(loaded && loaded.version === 1 && loaded.siteUrl === siteUrl && loaded.rootPath === rootPath && loaded.localFolder === localFolder) {
            this._state = loaded;
            return;
        }
        if(loaded) {
            this._log.warn("Sync settings changed; starting with fresh sync state.");
        }
        this._state = { version: 1, siteUrl, rootPath, localFolder, rootId: "", pages: {}, pending: [] };
    }

    private _addPending(item: PendingDelete): void {
        const key = pendingKey(item);
        if(!this._state.pending.some((other) => pendingKey(other) === key)) {
            this._state.pending.push(item);
        }
    }

    private _isPending(kind: PendingDelete["kind"], pageId: string): boolean {
        return this._state.pending.some((item) => item.kind === kind && item.pageId === pageId);
    }

    // --- planning: which note path each remote page maps to ---

    private _planNotePaths(pages: RemotePage[]): void {
        this._plannedNotes.clear();
        const claimed = new Set<string>();
        for(const page of Object.values(this._state.pages)) {
            if(this._remoteById.get(page.id)?.path === page.pagePath) {
                this._plannedNotes.set(page.id, page.notePath);
                claimed.add(page.notePath.toLowerCase());
            }
        }
        const tracked = new Set(Object.values(this._state.pages).map((p) => p.notePath.toLowerCase()));
        for(const page of [...pages].sort((a, b) => depth(a.path) - depth(b.path))) {
            if(this._plannedNotes.has(page.id)) {
                continue;
            }
            const parentDir = page.parentId === this._state.rootId || !page.parentId
                ? this._settings.localFolder
                : stripMd(this._plannedNotes.get(page.parentId) ?? joinPath(this._settings.localFolder, titleToFileName(page.parentId)));
            const desired = joinPath(parentDir, `${titleToFileName(page.title)}.md`);

            // a note tracked for a different page already owns that path
            const path = uniquePath(desired, (candidate) => claimed.has(candidate.toLowerCase())
                || (tracked.has(candidate.toLowerCase()) && this._state.pages[page.id]?.notePath !== candidate), page.id);
            this._plannedNotes.set(page.id, path);
            claimed.add(path.toLowerCase());
        }
    }

    // --- remote -> local ---

    private async _pullRemoteChanges(pages: RemotePage[]): Promise<void> {
        for(const page of [...pages].sort((a, b) => depth(a.path) - depth(b.path))) {
            const planned = this._plannedNotes.get(page.id)!;
            try {
                const tracked = this._state.pages[page.id];
                if(!tracked) {
                    await this._pullNew(page, planned);
                    continue;
                }
                if(!this._files.has(tracked.notePath)) {

                    // deleted or moved locally: handled on the local side
                    continue;
                }
                if(tracked.pagePath !== page.path) {
                    await this._moveLocal(tracked, page, planned);
                }
                if(page.revision === tracked.revision) {
                    continue;
                }
                if(await this._localChanged(tracked)) {
                    await this._writeConflict(tracked, page);
                } else {
                    await this._pullInto(page, tracked.notePath, tracked);
                    this._report.pulled.push(tracked.notePath);
                }
            } catch(error) {
                this._fail(planned, error);
            }
        }
    }

    private async _pullNew(page: RemotePage, notePath: string): Promise<void> {
        if(this._files.has(notePath)) {

            // a note already sits there: adopt it when it is the same text (another device synced it)
            if(page.syncMeta && page.syncMeta.revision === page.revision) {
                const text = await this._vault.readText(notePath);
                if(await sha256(this._storedSource(text)) === page.syncMeta.hash) {
                    const state = await this._newPageState(page, notePath, text, {});
                    await this._pullFiles(page, state, page.syncMeta);
                    this._report.pulled.push(notePath);
                    return;
                }
            }
            const alternative = uniquePath(notePath, (candidate) => this._files.has(candidate), page.id);
            this._report.conflicts.push(`${notePath} (site page ${page.path} saved as ${alternative})`);
            notePath = alternative;
        }
        await this._pullInto(page, notePath, null);
        this._report.pulled.push(notePath);
    }

    private async _newPageState(page: RemotePage, notePath: string, text: string, files: Record<string, FileState>): Promise<PageState> {
        const stat = await this._vault.stat(notePath);
        const state: PageState = {
            id: page.id,
            pagePath: page.path,
            notePath,
            revision: page.revision,
            modified: page.modified,
            localHash: await sha256(text),
            mtime: stat?.mtime ?? 0,
            size: stat?.size ?? 0,
            dynamic: false,
            files,
        };
        this._state.pages[page.id] = state;
        return state;
    }

    // writes the site version of `page` into notePath (exact source when we have it)
    private async _pullInto(page: RemotePage, notePath: string, previous: PageState | null): Promise<void> {
        const meta = page.syncMeta && page.syncMeta.revision === page.revision ? page.syncMeta : null;
        let text: string | null = null;
        let dynamic = false;
        if(meta) {
            const source = await this._client.getProperty(page.id, SOURCE_PROPERTY);
            if(source !== null && await sha256(source) === meta.hash) {
                text = source;
            }
        }
        const remoteFiles = await this._client.listFiles(page.id);
        const fileTargets = this._fileTargets(page, notePath, previous, meta, remoteFiles);
        if(text === null) {
            const markdown = await this._client.getMarkdown(page.id);
            dynamic = markdown.meta.dynamic;
            const body = toLocalMarkdown(markdown.body, {
                siteUrl: this._client.siteUrl,
                localFile: (fileId) => fileTargets.get(fileId) ?? null,
                localNote: (pagePath) => {
                    const target = this._remoteByPath.get(pagePath);
                    const note = target && this._plannedNotes.get(target.id);
                    return note ? stripMd(note) : null;
                },
            });
            const articleTypes = markdown.meta.tags.filter((tag) => tag.startsWith(ARTICLE_PREFIX));
            const data: Record<string, unknown> = { title: markdown.meta.title || page.title };
            const tags = markdown.meta.tags.filter((tag) => !tag.startsWith(ARTICLE_PREFIX));
            if(tags.length) {
                data.tags = tags;
            }
            if(articleTypes.length) {
                data["article-type"] = articleTypes[0].slice(ARTICLE_PREFIX.length);
            }
            data[FLAG_KEY] = dynamic ? "dynamic" : "site-edited";
            text = joinFrontmatter(data, body.endsWith("\n") ? body : body + "\n");
        }
        await this._vault.writeText(notePath, text);
        this._files.add(notePath);
        const state = await this._newPageState(page, notePath, text, previous?.files ?? {});
        state.dynamic = dynamic;
        await this._pullFiles(page, state, meta, remoteFiles, fileTargets);
    }

    // file id -> vault path where that attachment lives locally
    private _fileTargets(page: RemotePage, notePath: string, previous: PageState | null, meta: SyncMeta | null, remoteFiles: RemoteFile[]): Map<string, string> {
        const targets = new Map<string, string>();
        for(const file of remoteFiles) {
            const known = previous?.files[file.name]?.localPath;
            const recorded = meta?.files[file.name];
            const path = recorded !== undefined
                ? joinPath(this._settings.localFolder, recorded)
                : known ?? joinPath(attachmentDir(notePath), file.name);
            targets.set(file.id, path);
        }
        return targets;
    }

    private async _pullFiles(page: RemotePage, state: PageState, meta: SyncMeta | null, remoteFiles?: RemoteFile[], targets?: Map<string, string>): Promise<void> {
        remoteFiles ??= await this._client.listFiles(page.id);
        targets ??= this._fileTargets(page, state.notePath, state, meta, remoteFiles);
        const seen = new Set<string>();
        for(const file of remoteFiles) {
            seen.add(file.name);
            const known = state.files[file.name];
            let path = targets.get(file.id)!;
            if(known && known.fileId === file.id && known.revision === file.revision && this._files.has(known.localPath)) {
                continue;
            }
            const data = await this._client.downloadFile(file.id);
            const hash = await sha256(data);
            if(this._files.has(path)) {
                const localHash = await sha256(await this._vault.readBinary(path));
                const locallyEdited = known ? localHash !== known.hash : localHash !== hash;
                if(locallyEdited && localHash !== hash) {
                    path = uniquePath(path, (candidate) => this._files.has(candidate), "expert conflict");
                    this._report.conflicts.push(path);
                }
            }
            if(!this._files.has(path) || (await sha256(await this._vault.readBinary(path))) !== hash) {
                await this._vault.writeBinary(path, data);
                this._files.add(path);
                this._report.downloaded.push(path);
            }
            const stat = await this._vault.stat(path);
            state.files[file.name] = { fileId: file.id, revision: file.revision, localPath: path, hash, mtime: stat?.mtime ?? 0, size: stat?.size ?? 0 };
        }
        for(const [name, file] of Object.entries(state.files)) {
            if(!seen.has(name) && this._files.has(file.localPath)) {
                this._addPending({ kind: "local-file", pageId: page.id, name, localPath: file.localPath });
            } else if(!seen.has(name)) {
                delete state.files[name];
            }
        }
    }

    private async _moveLocal(state: PageState, page: RemotePage, planned: string): Promise<void> {
        if(planned !== state.notePath && !this._files.has(planned)) {
            await this._vault.rename(state.notePath, planned);
            this._files.delete(state.notePath);
            this._files.add(planned);
            this._report.moved.push(`${state.notePath} -> ${planned}`);
            state.notePath = planned;
        }
        state.pagePath = page.path;
    }

    private async _writeConflict(state: PageState, page: RemotePage): Promise<void> {
        const target = uniquePath(conflictPath(state.notePath, this._now()), (candidate) => this._files.has(candidate), "2");
        const scratch: PageState = { ...state, files: { ...state.files } };
        await this._pullInto(page, target, scratch);

        // the conflict copy is not a tracked note; restore the real entry
        this._state.pages[page.id] = state;
        const local = await this._vault.readText(state.notePath);
        await this._vault.writeText(state.notePath, setFlag(local, "conflict"));
        state.revision = page.revision;
        state.modified = page.modified;
        this._report.conflicts.push(`${state.notePath} (site version in ${target})`);
    }

    private async _handleRemoteDeletes(): Promise<void> {
        for(const page of Object.values(this._state.pages)) {
            if(this._remoteById.has(page.id)) {
                continue;
            }
            if(this._files.has(page.notePath)) {
                this._addPending({ kind: "local-note", pageId: page.id, notePath: page.notePath });
            } else {
                delete this._state.pages[page.id];
            }
        }
    }

    // --- local -> remote ---

    private _localNotes(): string[] {
        return [...this._files].filter((path) => path.endsWith(".md") && isInside(path, this._settings.localFolder)
            && path !== this._settings.localFolder && !isIgnoredNote(relativeTo(path, this._settings.localFolder)));
    }

    private async _localChanged(state: PageState): Promise<boolean> {
        const stat = await this._vault.stat(state.notePath);
        if(sameStat(stat, state.mtime, state.size)) {
            return false;
        }
        return await sha256(await this._vault.readText(state.notePath)) !== state.localHash;
    }

    private async _pushLocalChanges(): Promise<void> {
        const trackedPaths = new Set(Object.values(this._state.pages).map((page) => page.notePath));
        const untracked = this._localNotes().filter((path) => !trackedPaths.has(path));
        const untrackedHashes = new Map<string, string>();
        for(const path of untracked) {
            untrackedHashes.set(path, await sha256(await this._vault.readText(path)));
        }

        // missing tracked notes: a renamed file (same text) is a move, anything else a pending delete
        for(const state of Object.values(this._state.pages)) {
            if(this._files.has(state.notePath) || !this._remoteById.has(state.id) || this._isPending("local-note", state.id)) {
                continue;
            }
            const movedTo = [...untrackedHashes.entries()].find(([, hash]) => hash === state.localHash)?.[0];
            if(movedTo) {
                untrackedHashes.delete(movedTo);
                try {
                    await this._movePage(state, movedTo);
                } catch(error) {
                    this._fail(movedTo, error);
                }
                continue;
            }
            this._addPending({ kind: "site-page", pageId: state.id, pagePath: state.pagePath, notePath: state.notePath });
        }

        for(const state of Object.values(this._state.pages)) {
            if(!this._files.has(state.notePath) || !this._remoteById.has(state.id)) {
                continue;
            }
            try {
                if(await this._localChanged(state)) {
                    await this._pushChanged(state);
                } else if(!state.dynamic) {
                    await this._pushFilesOnly(state);
                }
            } catch(error) {
                this._fail(state.notePath, error);
            }
        }

        const newNotes = [...untrackedHashes.keys()].sort((a, b) => depth(a) - depth(b));
        for(const path of newNotes) {
            try {
                await this._createPage(path);
            } catch(error) {
                this._fail(path, error);
            }
        }
    }

    private async _pushChanged(state: PageState): Promise<void> {
        const text = await this._vault.readText(state.notePath);
        if(state.dynamic) {
            this._report.blocked.push(`${state.notePath} (site page uses DekiScript; read-only)`);
            return;
        }
        const flag = readFlag(text);
        if(flag) {
            this._report.blocked.push(`${state.notePath} (${FLAG_KEY}: ${flag}; run "Accept note as source" after reviewing)`);
            return;
        }
        const editTime = await this._editTimeFor(state);
        if(!editTime) {
            this._report.skipped.push({ path: state.notePath, reason: "the site page changed during this sync; sync again" });
            return;
        }
        await this._push(state, text, editTime);
        if(this._report.conflicts.some((c) => c.startsWith(state.notePath))) {
            return;
        }
        this._report.pushed.push(state.notePath);
    }

    // The edit time of the revision this note was based on, so the server can refuse
    // a stale save. Never falls back to "now", which would skip that check.
    private async _editTimeFor(state: PageState): Promise<string | null> {
        const known = toEditTime(state.modified);
        if(known !== "now") {
            return known;
        }
        const info = await this._client.pageInfo(state.id);
        if(info.revision !== state.revision) {
            return null;
        }
        state.modified = info.modified;
        const fetched = toEditTime(info.modified);
        return fetched === "now" ? null : fetched;
    }

    // what gets stored on the site as the note's exact copy
    private _storedSource(text: string): string {
        if(this._settings.keepComments) {
            return text;
        }
        const { body } = splitFrontmatter(text);
        return text.slice(0, text.length - body.length) + stripComments(body);
    }

    private async _pushFilesOnly(state: PageState): Promise<void> {
        const text = await this._vault.readText(state.notePath);
        if(readFlag(text)) {
            return;
        }
        const before = this._report.uploaded.length;
        await this._uploadNoteFiles(state, text);
        if(this._report.uploaded.length > before) {
            await this._writeSyncMeta(state, text, this._storedSource(text));
        }
    }

    private async _push(state: PageState, text: string, editTime: string): Promise<void> {
        const { data, body } = splitFrontmatter(text);
        const files = await this._uploadNoteFiles(state, text);
        const markdown = toPublishMarkdown(body, {
            resolveNote: (link) => this._pageUrlForLink(link, state.notePath),
            resolveFile: (link) => {
                const path = this._vault.resolveLink(link, state.notePath);
                return path ? files.get(path) ?? null : null;
            },
        });
        const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : stripMd(basename(state.notePath));
        try {
            await this._client.postMarkdown(state.id, markdown, { title, editTime });
        } catch(error) {
            if(error instanceof ExpertError && error.status === 409) {
                const page = await this._client.pageInfo(state.id);
                const remote = this._remoteById.get(state.id);
                if(remote) {
                    await this._writeConflict(state, { ...remote, revision: page.revision, modified: page.modified, syncMeta: null });
                }
                return;
            }
            if(error instanceof ExpertError && error.is("PageHasDraftException")) {
                this._report.skipped.push({ path: state.notePath, reason: "page has an unpublished draft on the site" });
                return;
            }
            throw error;
        }
        await this._pushTags(state.id, data);
        if(typeof data.summary === "string") {
            await this._client.putProperty(state.id, OVERVIEW_PROPERTY, data.summary);
        }
        const stored = this._storedSource(text);
        await this._client.putProperty(state.id, SOURCE_PROPERTY, stored);
        await this._writeSyncMeta(state, text, stored);
    }

    // `stored` is what the site holds (its hash goes in the sync property);
    // `text` is the local file (its hash tells the next sync whether it changed)
    private async _writeSyncMeta(state: PageState, text: string, stored: string): Promise<void> {
        const info = await this._client.pageInfo(state.id);
        const hash = await sha256(stored);
        const files: Record<string, string> = {};
        for(const [name, file] of Object.entries(state.files)) {
            files[name] = relativeTo(file.localPath, this._settings.localFolder);
        }
        const meta: SyncMeta = { v: 1, revision: info.revision, hash, files };
        await this._client.putProperty(state.id, SYNC_PROPERTY, JSON.stringify(meta));
        const stat = await this._vault.stat(state.notePath);
        Object.assign(state, {
            revision: info.revision,
            modified: info.modified,
            localHash: await sha256(text),
            mtime: stat?.mtime ?? 0,
            size: stat?.size ?? 0,
        });
    }

    private async _pushTags(pageId: string, data: Record<string, unknown>): Promise<void> {
        const tags = (Array.isArray(data.tags) ? data.tags : typeof data.tags === "string" ? data.tags.split(/[,\s]+/) : [])
            .map((tag) => String(tag).replace(/^#/, "").trim())
            .filter(Boolean);
        let articleType = typeof data["article-type"] === "string" ? `${ARTICLE_PREFIX}${data["article-type"]}` : null;
        if(!articleType) {
            articleType = (await this._client.getTags(pageId)).find((tag) => tag.startsWith(ARTICLE_PREFIX)) ?? null;
        }
        const next = articleType ? [articleType, ...tags.filter((tag) => !tag.startsWith(ARTICLE_PREFIX))] : tags;
        await this._client.setTags(pageId, [...new Set(next)]);
    }

    // uploads new or changed attachments of a note; returns vault path -> published URL
    private async _uploadNoteFiles(state: PageState, text: string): Promise<Map<string, { url: string; name: string }>> {
        const paths = new Set<string>();
        for(const link of collectFileLinks(splitFrontmatter(text).body)) {
            const path = this._vault.resolveLink(link, state.notePath);
            if(path && !path.endsWith(".md")) {
                paths.add(path);
            }
        }
        const folder = attachmentDir(state.notePath) + "/";
        for(const path of this._files) {
            if(path.startsWith(folder) && !path.slice(folder.length).includes("/")) {
                paths.add(path);
            }
        }
        const urls = new Map<string, { url: string; name: string }>();
        for(const path of paths) {
            const name = basename(path);
            const stat = await this._vault.stat(path);
            if(!stat) {
                continue;
            }
            const known = state.files[name];
            if(known && known.localPath === path && sameStat(stat, known.mtime, known.size)) {
                urls.set(path, { url: this._client.fileUrl(known.fileId, name), name });
                continue;
            }
            const data = await this._vault.readBinary(path);
            const hash = await sha256(data);
            if(known && known.hash === hash) {
                Object.assign(known, { localPath: path, mtime: stat.mtime, size: stat.size });
                urls.set(path, { url: this._client.fileUrl(known.fileId, name), name });
                continue;
            }
            const uploaded = await this._client.uploadFile(state.id, name, data, mimeTypeFor(name));
            state.files[name] = { fileId: uploaded.id, revision: uploaded.revision, localPath: path, hash, mtime: stat.mtime, size: stat.size };
            urls.set(path, { url: this._client.fileUrl(uploaded.id, name), name });
            this._report.uploaded.push(path);
        }
        for(const [name, file] of Object.entries(state.files)) {
            if(!this._files.has(file.localPath) && !(await this._vault.stat(file.localPath))) {
                this._addPending({ kind: "site-file", pageId: state.id, fileId: file.fileId, name, localPath: file.localPath });
            }
        }
        return urls;
    }

    private _pageUrlForLink(link: string, fromPath: string): string | null {
        const path = this._vault.resolveLink(link, fromPath);
        if(!path || !path.endsWith(".md")) {
            return null;
        }
        const page = Object.values(this._state.pages).find((p) => p.notePath === path);
        return page ? this._client.pageUrl(page.pagePath) : null;
    }

    // site page path a note at `notePath` should live at; creates missing folder pages
    private async _pagePathFor(notePath: string, title: string): Promise<{ path: string; parentPath: string }> {
        const parentPath = await this._ensureFolderPage(dirname(notePath));
        return { path: parentPath ? `${parentPath}/${titleToSegment(title)}` : titleToSegment(title), parentPath };
    }

    private async _ensureFolderPage(folder: string): Promise<string> {
        if(folder === this._settings.localFolder || !isInside(folder, this._settings.localFolder)) {
            return this._rootPagePath;
        }
        const folderNote = Object.values(this._state.pages).find((page) => page.notePath === `${folder}.md`);
        if(folderNote) {
            return folderNote.pagePath;
        }
        const parentPath = await this._ensureFolderPage(dirname(folder));
        const title = basename(folder);
        const path = parentPath ? `${parentPath}/${titleToSegment(title)}` : titleToSegment(title);
        if(!this._remoteByPath.has(path)) {
            const created = await this._client.postMarkdown(path, "", { title, create: true });
            await this._applyArticleType(created.id, path, parentPath, null);
            const page: RemotePage = { id: created.id, path, title, revision: created.revision, modified: "", parentId: null, draftState: "inactive", syncMeta: null };
            this._remoteByPath.set(path, page);
            this._report.created.push(`${folder}/ (folder page ${path})`);
        }
        return path;
    }

    private async _applyArticleType(pageId: string, pagePath: string, parentPath: string, requested: string | null): Promise<void> {
        this._usesArticleTypes ??= await this._client.siteUsesArticleTypes();
        if(!this._usesArticleTypes) {
            return;
        }
        let type = requested;
        if(!type) {
            if(!this._articleTypes.has(parentPath)) {
                const tags = await this._client.getTags(parentPath === "" ? "home" : parentPath);
                const found = tags.find((tag) => tag.startsWith(ARTICLE_PREFIX));
                this._articleTypes.set(parentPath, found ? found.slice(ARTICLE_PREFIX.length) : null);
            }
            const parentType = this._articleTypes.get(parentPath);
            type = parentType ? CHILD_ARTICLE_TYPE[parentType] ?? "topic" : "topic";
        }
        const existing = (await this._client.getTags(pageId)).filter((tag) => !tag.startsWith(ARTICLE_PREFIX));
        await this._client.setTags(pageId, [`${ARTICLE_PREFIX}${type}`, ...existing]);
        this._articleTypes.set(pagePath, type);
    }

    private async _createPage(notePath: string): Promise<void> {
        const text = await this._vault.readText(notePath);
        const { data } = splitFrontmatter(text);
        if(readFlag(text)) {
            this._report.skipped.push({ path: notePath, reason: `has ${FLAG_KEY} flag but no site page; remove the flag to publish it` });
            return;
        }
        const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : stripMd(basename(notePath));
        const { path, parentPath } = await this._pagePathFor(notePath, title);
        if(this._remoteByPath.has(path)) {
            this._report.skipped.push({ path: notePath, reason: `a site page already exists at ${path}` });
            return;
        }
        const created = await this._client.postMarkdown(path, "", { title, create: true });
        const requested = typeof data["article-type"] === "string" ? data["article-type"] : null;
        await this._applyArticleType(created.id, path, parentPath, requested);
        const stat = await this._vault.stat(notePath);
        const state: PageState = {
            id: created.id, pagePath: path, notePath, revision: created.revision, modified: "", localHash: "",
            mtime: stat?.mtime ?? 0, size: stat?.size ?? 0, dynamic: false, files: {},
        };
        this._state.pages[created.id] = state;
        this._remoteByPath.set(path, { id: created.id, path, title, revision: created.revision, modified: "", parentId: null, draftState: "inactive", syncMeta: null });
        this._remoteById.set(created.id, this._remoteByPath.get(path)!);
        await this._push(state, text, "now");
        this._report.created.push(`${notePath} -> ${path}`);
    }

    private async _movePage(state: PageState, newNotePath: string): Promise<void> {
        const text = await this._vault.readText(newNotePath);
        const { data } = splitFrontmatter(text);
        const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : stripMd(basename(newNotePath));
        const { path } = await this._pagePathFor(newNotePath, title);
        const pageMove = path !== state.pagePath ? ` (site page ${state.pagePath} -> ${path})` : "";
        if(pageMove) {
            await this._client.movePage(state.id, path, title);
        }
        this._report.moved.push(`${state.notePath} -> ${newNotePath}${pageMove}`);
        state.notePath = newNotePath;
        state.pagePath = path;
        const info = await this._client.pageInfo(state.id);
        state.revision = info.revision;
        state.modified = info.modified;
        await this._writeSyncMeta(state, text, this._storedSource(text));
    }

    // --- misc ---

    private async _removeIfExists(path: string): Promise<void> {
        if(await this._vault.stat(path)) {
            await this._vault.remove(path);
        }
    }

    private _fail(path: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this._report.errors.push({ path, message });
        this._log.warn(`${path}: ${message}`);
    }
}
