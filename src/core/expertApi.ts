import type { HttpFn, HttpResponse } from "./io.ts";

export const SOURCE_PROPERTY = "obsidian#source";
export const SYNC_PROPERTY = "obsidian#sync";
export const OVERVIEW_PROPERTY = "mindtouch.page#overview";

export interface SyncMeta {
    v: 1;

    // page revision the stored source was written against
    revision: number;
    hash: string;

    // attachment filename -> vault path relative to the local sync folder
    files: Record<string, string>;
}

export interface RemotePage {
    id: string;
    path: string;
    title: string;
    revision: number;
    modified: string;
    parentId: string | null;
    draftState: string;
    syncMeta: SyncMeta | null;
}

export interface RemoteFile {
    id: string;
    name: string;
    revision: number;
    size: number;
    mimeType: string;
}

export interface MarkdownPage {
    meta: {
        id: string;
        title: string;
        path: string;
        revision: number;
        modified: string;
        dynamic: boolean;
        tags: string[];
    };
    body: string;
}

// throttled or briefly unavailable; every request the client makes is safe to repeat
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export class ExpertError extends Error {
    readonly status: number;
    readonly exception: string;

    constructor(status: number, method: string, url: string, body: string) {
        const exception = /<exception>([^<]+)<\/exception>/.exec(body)?.[1]
            ?? /"exception"\s*:\s*"([^"]+)"/.exec(body)?.[1]
            ?? "";
        const message = /<message>([^<]+)<\/message>/.exec(body)?.[1]
            ?? /"message"\s*:\s*"([^"]+)"/.exec(body)?.[1]
            ?? body.slice(0, 200);
        super(`${method} ${url.replace(/\?.*$/, "")} -> ${status} ${exception} ${message}`.trim());
        this.status = status;
        this.exception = exception;
    }

    is(exceptionSuffix: string): boolean {
        return this.exception.endsWith(exceptionSuffix);
    }
}

// Deki returns a bare object for a single element and an array for several
export function asArray<T>(value: T | T[] | undefined | null | ""): T[] {
    if(value === undefined || value === null || value === "") {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

// "=" + double-encoded path, the form Deki expects for path-addressed pages
export function pageRef(pathOrId: string): string {
    if(pathOrId === "" || pathOrId === "home") {
        return "home";
    }
    if(/^\d+$/.test(pathOrId)) {
        return pathOrId;
    }
    return "=" + encodeURIComponent(encodeURIComponent(pathOrId));
}

function propertyRef(name: string): string {
    return encodeURIComponent(encodeURIComponent(name));
}

// tree/info dates look like "Fri, 16 Oct 2026 15:47:10 GMT"; edittime wants yyyyMMddHHmmss (UTC)
export function toEditTime(httpDate: string): string {
    const date = new Date(httpDate);
    if(Number.isNaN(date.getTime())) {
        return "now";
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
        + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export function parseSyncMeta(text: string | undefined | null): SyncMeta | null {
    if(!text) {
        return null;
    }
    try {
        const value = JSON.parse(text);
        if(value && value.v === 1 && typeof value.revision === "number" && typeof value.hash === "string") {
            return { v: 1, revision: value.revision, hash: value.hash, files: value.files ?? {} };
        }
    } catch {
        // NOTE: a hand-edited or foreign property is treated as absent
    }
    return null;
}

function unquoteYaml(value: string): string {
    const trimmed = value.trim();
    if(trimmed.startsWith("\"")) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}

// Parses the front matter the server writes for format=markdown. Its shape is
// fixed (YamlFrontMatterWriter): scalar lines plus a JSON-style tags array.
export function parseServerMarkdown(text: string): MarkdownPage {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const fields: Record<string, string> = {};
    let tags: string[] = [];
    if(match) {
        for(const line of match[1].split(/\r?\n/)) {
            const colon = line.indexOf(":");
            if(colon < 0) {
                continue;
            }
            const key = line.slice(0, colon).trim();
            const raw = line.slice(colon + 1).trim();
            if(key === "tags") {
                try {
                    tags = JSON.parse(raw);
                } catch {
                    tags = raw.replace(/^\[|\]$/g, "").split(",").map(unquoteYaml).filter(Boolean);
                }
            } else {
                fields[key] = unquoteYaml(raw);
            }
        }
    }
    const body = match ? text.slice(match[0].length).replace(/^\r?\n/, "") : text;
    return {
        meta: {
            id: fields.id ?? "",
            title: fields.title ?? "",
            path: fields.path ?? "",
            revision: Number(fields.revision ?? 0),
            modified: fields.modified ?? "",
            dynamic: fields.dynamic === "true",
            tags,
        },
        body,
    };
}

export class ExpertClient {
    readonly siteUrl: string;
    private readonly _apiBase: string;
    private readonly _token: string;
    private readonly _http: HttpFn;

    private readonly _retries: number;
    private readonly _sleep: (ms: number) => Promise<void>;

    constructor(siteUrl: string, token: string, http: HttpFn, options: { retries?: number; sleep?: (ms: number) => Promise<void> } = {}) {
        this._retries = options.retries ?? 3;
        this._sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.siteUrl = siteUrl.replace(/\/+$/, "");
        this._apiBase = `${this.siteUrl}/@api/deki`;
        this._token = token.trim().replace(/^Bearer\s+/i, "");
        this._http = http;
    }

    private async _request(method: string, path: string, options: {
        query?: Record<string, string>;
        body?: string | ArrayBuffer;
        contentType?: string;
        json?: boolean;
    } = {}): Promise<HttpResponse> {
        const query = new URLSearchParams(options.query ?? {});
        if(options.json !== false) {
            query.set("dream.out.format", "json");
        }
        const qs = query.toString();
        const url = `${this._apiBase}/${path}${qs ? `?${qs}` : ""}`;
        const headers: Record<string, string> = { Authorization: `Bearer ${this._token}` };
        if(options.contentType) {
            headers["Content-Type"] = options.contentType;
        }
        let response = await this._http({ url, method, headers, body: options.body });
        for(let attempt = 1; RETRY_STATUSES.has(response.status) && attempt <= this._retries; attempt++) {
            const retryAfter = Number(response.headers["retry-after"] ?? response.headers["Retry-After"]);
            await this._sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1));
            response = await this._http({ url, method, headers, body: options.body });
        }
        if(response.status < 200 || response.status >= 300) {
            throw new ExpertError(response.status, method, url, new TextDecoder().decode(response.body));
        }
        return response;
    }

    private async _json(method: string, path: string, options: Parameters<ExpertClient["_request"]>[2] = {}): Promise<any> {
        const response = await this._request(method, path, options);
        const text = new TextDecoder().decode(response.body);
        return text ? JSON.parse(text) : {};
    }

    private async _text(method: string, path: string, options: Parameters<ExpertClient["_request"]>[2] = {}): Promise<string> {
        const response = await this._request(method, path, { ...options, json: false });
        return new TextDecoder().decode(response.body);
    }

    async currentUser(): Promise<{ id: string; name: string; anonymous: boolean }> {
        const user = await this._json("GET", "users/current");
        return { id: user["@id"], name: user.nick ?? user.username ?? "", anonymous: user["@anonymous"] === "true" };
    }

    async markdownEnabled(): Promise<boolean> {
        try {
            await this._text("GET", "pages/home/contents", { query: { format: "markdown", mode: "view" } });
            return true;
        } catch(error) {
            if(error instanceof ExpertError && error.is("MarkdownFormatNotEnabledException")) {
                return false;
            }
            throw error;
        }
    }

    async siteUsesArticleTypes(): Promise<boolean> {
        const tags = await this._json("GET", "site/tags");
        return asArray<any>(tags.tag).some((tag) => String(tag["@value"]).startsWith("article:"));
    }

    // whole subtree in one call, root first, with revisions and small property values inline
    async tree(root: string): Promise<RemotePage[]> {
        const result = await this._json("GET", `pages/${pageRef(root)}/tree`, { query: { include: "revision,properties" } });
        const pages: RemotePage[] = [];
        const visit = (node: any, parentId: string | null) => {
            const properties = asArray<any>(node.properties?.property);
            const sync = properties.find((p) => p["@name"] === SYNC_PROPERTY);
            pages.push({
                id: node["@id"],
                path: typeof node.path === "string" ? node.path : (node.path?.["#text"] ?? ""),
                title: node.title ?? "",
                revision: Number(node["@revision"] ?? 0),
                modified: node["date.modified"] ?? "",
                parentId,
                draftState: node["@draft.state"] ?? "inactive",
                syncMeta: parseSyncMeta(sync?.contents?.["#text"]),
            });
            for(const child of asArray<any>(node.subpages?.page)) {
                visit(child, node["@id"]);
            }
        };
        visit(result.page ?? result, null);
        return pages;
    }

    async pageInfo(id: string): Promise<{ id: string; revision: number; modified: string; path: string }> {
        // pages/{id}/info has no date.modified, which the concurrent-edit check needs
        const info = await this._json("GET", `pages/${pageRef(id)}`, { query: { include: "" } });
        return {
            id: info["@id"],
            revision: Number(info["@revision"]),
            modified: info["date.modified"] ?? "",
            path: typeof info.path === "string" ? info.path : (info.path?.["#text"] ?? ""),
        };
    }

    async getMarkdown(id: string): Promise<MarkdownPage> {
        return parseServerMarkdown(await this._text("GET", `pages/${pageRef(id)}/contents`, { query: { format: "markdown", mode: "view" } }));
    }

    async getProperty(id: string, name: string): Promise<string | null> {
        try {
            return await this._text("GET", `pages/${pageRef(id)}/properties/${propertyRef(name)}`);
        } catch(error) {
            if(error instanceof ExpertError && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    async putProperty(id: string, name: string, value: string): Promise<void> {
        await this._request("PUT", `pages/${pageRef(id)}/properties/${propertyRef(name)}`, {
            query: { abort: "never" },
            body: value,
            contentType: "text/plain; charset=utf-8",
        });
    }

    async getTags(id: string): Promise<string[]> {
        const result = await this._json("GET", `pages/${pageRef(id)}/tags`);
        return asArray<any>(result.tag).map((tag) => String(tag["@value"]));
    }

    async setTags(id: string, tags: string[]): Promise<void> {
        const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const xml = `<tags>${tags.map((tag) => `<tag value="${escape(tag)}" />`).join("")}</tags>`;
        await this._request("PUT", `pages/${pageRef(id)}/tags`, { body: xml, contentType: "application/xml" });
    }

    // Creates or updates page content from markdown. When editTime is given the
    // server rejects the save if the page changed since (abort=modified).
    async postMarkdown(pathOrId: string, markdown: string, options: { title?: string; editTime?: string; create?: boolean } = {}): Promise<{ id: string; revision: number }> {
        const query: Record<string, string> = { edittime: options.editTime ?? "now" };
        if(options.title) {
            query.title = options.title;
        }
        if(options.create) {
            query.abort = "exists";
            query.allow = "idferrors";
        } else if(options.editTime && options.editTime !== "now") {
            query.abort = "modified";
        }
        const result = await this._json("POST", `pages/${pageRef(pathOrId)}/contents`, {
            query,
            body: markdown,
            contentType: "text/markdown; charset=utf-8",
        });
        return { id: result.page["@id"], revision: Number(result.page["@revision"]) };
    }

    async movePage(id: string, to: string, title?: string): Promise<void> {
        // a move leaves a redirect behind; deleteredirects lets a page move back onto its old path
        const query: Record<string, string> = { to, allow: "deleteredirects,idferrors" };
        if(title) {
            query.title = title;
        }
        await this._request("POST", `pages/${pageRef(id)}/move`, { query });
    }

    // Deki archives the page's descendants along with it, so callers must check for children first
    async deletePage(id: string): Promise<void> {
        await this._request("DELETE", `pages/${pageRef(id)}`);
    }

    async hasChildPages(id: string): Promise<boolean> {
        const result = await this._json("GET", `pages/${pageRef(id)}/subpages`);
        return Number(result["@totalcount"] ?? result["@count"] ?? 0) > 0;
    }

    async childPages(pathOrId: string): Promise<{ id: string; title: string; path: string }[]> {
        const result = await this._json("GET", `pages/${pageRef(pathOrId)}/subpages`);
        return asArray<any>(result["page.subpage"]).map((page) => ({
            id: page["@id"],
            title: page.title ?? "",
            path: typeof page.path === "string" ? page.path : (page.path?.["#text"] ?? ""),
        }));
    }

    async listFiles(id: string): Promise<RemoteFile[]> {
        const result = await this._json("GET", `pages/${pageRef(id)}/files`);
        return asArray<any>(result.file).map((file) => ({
            id: file["@id"],
            name: file.filename,
            revision: Number(file["@revision"]),
            size: Number(file.contents?.["@size"] ?? 0),
            mimeType: file.contents?.["@type"] ?? "application/octet-stream",
        }));
    }

    async downloadFile(fileId: string): Promise<ArrayBuffer> {
        const response = await this._request("GET", `files/${fileId}`, { json: false });
        return response.body;
    }

    async uploadFile(pageId: string, name: string, data: ArrayBuffer, mimeType: string): Promise<{ id: string; revision: number }> {
        const result = await this._json("PUT", `pages/${pageRef(pageId)}/files/${encodeURIComponent(name)}`, { body: data, contentType: mimeType });
        return { id: result["@id"], revision: Number(result["@revision"]) };
    }

    async deleteFile(fileId: string): Promise<void> {
        await this._request("DELETE", `files/${fileId}`);
    }

    fileUrl(fileId: string, name: string): string {
        return `/@api/deki/files/${fileId}/${encodeURIComponent(name)}`;
    }

    pageUrl(path: string): string {
        return "/" + path.split("/").map(encodeURIComponent).join("/");
    }
}
