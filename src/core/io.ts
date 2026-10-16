// Platform seams: the sync engine only talks to these, so it runs the same
// inside Obsidian and under the Node test harness.

export interface HttpRequest {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
}

export interface HttpResponse {
    status: number;
    headers: Record<string, string>;
    body: ArrayBuffer;
}

export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;

export interface FileStat {
    mtime: number;
    size: number;
}

export interface VaultIO {

    // all files in the vault, vault-relative, "/" separated
    listFiles(): Promise<string[]>;
    stat(path: string): Promise<FileStat | null>;
    readText(path: string): Promise<string>;
    readBinary(path: string): Promise<ArrayBuffer>;

    // create or overwrite; parent folders are created as needed
    writeText(path: string, text: string): Promise<void>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    rename(from: string, to: string): Promise<void>;

    // moves to trash where the platform has one
    remove(path: string): Promise<void>;

    // resolve an Obsidian link target ("Note", "folder/img.png") from a note
    resolveLink(link: string, fromPath: string): string | null;
}

export interface StateStore<T> {
    load(): Promise<T | null>;
    save(state: T): Promise<void>;
}

export interface Logger {
    info(message: string): void;
    warn(message: string): void;
}
