import { type App, normalizePath, requestUrl, TFile, TFolder } from "obsidian";
import type { HttpFn, StateStore, VaultIO } from "../core/io.ts";
import { dirname } from "../core/paths.ts";

// requestUrl bypasses CORS; throw:false so the client sees Deki's error bodies
export const obsidianHttp: HttpFn = async (request) => {
    const response = await requestUrl({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        contentType: request.headers?.["Content-Type"],
        throw: false,
    });
    return { status: response.status, headers: response.headers, body: response.arrayBuffer };
};

export class ObsidianVault implements VaultIO {
    private readonly _app: App;

    constructor(app: App) {
        this._app = app;
    }

    private _file(path: string): TFile | null {
        const file = this._app.vault.getAbstractFileByPath(normalizePath(path));
        return file instanceof TFile ? file : null;
    }

    private async _ensureFolder(path: string): Promise<void> {
        const folder = dirname(normalizePath(path));
        if(folder && !(this._app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
            await this._app.vault.createFolder(folder).catch(() => {

                // NOTE: createFolder throws if a concurrent write already made it
            });
        }
    }

    async listFiles(): Promise<string[]> {
        return this._app.vault.getFiles().map((file) => file.path);
    }

    async stat(path: string) {
        const file = this._file(path);
        return file ? { mtime: file.stat.mtime, size: file.stat.size } : null;
    }

    async readText(path: string): Promise<string> {
        const file = this._file(path);
        if(!file) {
            throw new Error(`not found: ${path}`);
        }
        return this._app.vault.read(file);
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const file = this._file(path);
        if(!file) {
            throw new Error(`not found: ${path}`);
        }
        return this._app.vault.readBinary(file);
    }

    async writeText(path: string, text: string): Promise<void> {
        const file = this._file(path);
        if(file) {
            await this._app.vault.modify(file, text);
            return;
        }
        await this._ensureFolder(path);
        await this._app.vault.create(normalizePath(path), text);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        const file = this._file(path);
        if(file) {
            await this._app.vault.modifyBinary(file, data);
            return;
        }
        await this._ensureFolder(path);
        await this._app.vault.createBinary(normalizePath(path), data);
    }

    // plain vault rename: the site already has the new location, links in other notes are left alone
    async rename(from: string, to: string): Promise<void> {
        const file = this._file(from);
        if(!file) {
            throw new Error(`not found: ${from}`);
        }
        await this._ensureFolder(to);
        await this._app.vault.rename(file, normalizePath(to));
    }

    async remove(path: string): Promise<void> {
        const file = this._file(path);
        if(file) {
            await this._app.fileManager.trashFile(file);
        }
    }

    resolveLink(link: string, fromPath: string): string | null {
        return this._app.metadataCache.getFirstLinkpathDest(link, fromPath)?.path ?? null;
    }
}

// Sync state is per device: Obsidian's local storage is scoped to this vault on
// this machine and is not part of the vault folder, so it never syncs anywhere.
export class LocalStorageStore<T> implements StateStore<T> {
    private readonly _app: App;
    private readonly _key: string;

    constructor(app: App, key: string) {
        this._app = app;
        this._key = key;
    }

    async load(): Promise<T | null> {
        return (this._app.loadLocalStorage(this._key) as T | null) ?? null;
    }

    async save(state: T): Promise<void> {
        this._app.saveLocalStorage(this._key, state);
    }
}
