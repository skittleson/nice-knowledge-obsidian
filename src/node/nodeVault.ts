import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { HttpFn, StateStore, VaultIO } from "../core/io.ts";
import { basename, stripMd } from "../core/paths.ts";

export const nodeHttp: HttpFn = async (request) => {
    const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body as BodyInit | undefined,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    return { status: response.status, headers, body: await response.arrayBuffer() };
};

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

// A plain folder treated as a vault. Link resolution mimics Obsidian closely
// enough for tests: exact path, path relative to the note, then shortest match by name.
export class NodeVault implements VaultIO {
    private readonly _root: string;
    private _index: string[] = [];

    constructor(root: string) {
        this._root = root;
    }

    private _abs(path: string): string {
        return join(this._root, ...path.split("/"));
    }

    async listFiles(): Promise<string[]> {
        const files: string[] = [];
        const walk = async (dir: string, prefix: string) => {
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for(const entry of entries) {
                if(entry.name.startsWith(".")) {
                    continue;
                }
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if(entry.isDirectory()) {
                    await walk(join(dir, entry.name), rel);
                } else {
                    files.push(rel);
                }
            }
        };
        await walk(this._root, "");
        this._index = files;
        return files;
    }

    async stat(path: string) {
        try {
            const info = await stat(this._abs(path));
            return info.isFile() ? { mtime: Math.floor(info.mtimeMs), size: info.size } : null;
        } catch {
            return null;
        }
    }

    async readText(path: string): Promise<string> {
        return readFile(this._abs(path), "utf8");
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        return toArrayBuffer(await readFile(this._abs(path)));
    }

    async writeText(path: string, text: string): Promise<void> {
        await mkdir(dirname(this._abs(path)), { recursive: true });
        await writeFile(this._abs(path), text, "utf8");
        this._track(path);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        await mkdir(dirname(this._abs(path)), { recursive: true });
        await writeFile(this._abs(path), new Uint8Array(data));
        this._track(path);
    }

    async rename(from: string, to: string): Promise<void> {
        await mkdir(dirname(this._abs(to)), { recursive: true });
        await rename(this._abs(from), this._abs(to));
        this._index = this._index.filter((p) => p !== from);
        this._track(to);
    }

    async remove(path: string): Promise<void> {
        await rm(this._abs(path), { force: true });
        this._index = this._index.filter((p) => p !== path);
    }

    resolveLink(link: string, fromPath: string): string | null {
        const clean = link.replace(/^\.\//, "");
        const candidates = [clean, `${clean}.md`];
        for(const candidate of candidates) {
            if(this._index.includes(candidate)) {
                return candidate;
            }
            const relative = posix.normalize(posix.join(posix.dirname(fromPath), candidate));
            if(this._index.includes(relative)) {
                return relative;
            }
        }
        const name = basename(clean).toLowerCase();
        const matches = this._index.filter((p) => basename(p).toLowerCase() === name || stripMd(basename(p)).toLowerCase() === name);
        matches.sort((a, b) => a.length - b.length);
        return matches[0] ?? null;
    }

    private _track(path: string): void {
        if(!this._index.includes(path)) {
            this._index.push(path);
        }
    }
}

export class JsonFileStore<T> implements StateStore<T> {
    private readonly _path: string;

    constructor(path: string) {
        this._path = path;
    }

    async load(): Promise<T | null> {
        try {
            return JSON.parse(await readFile(this._path, "utf8")) as T;
        } catch {
            return null;
        }
    }

    async save(state: T): Promise<void> {
        await mkdir(dirname(this._path), { recursive: true });
        await writeFile(this._path, JSON.stringify(state, null, 2));
    }
}
