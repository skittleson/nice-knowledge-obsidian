// Mapping between site page paths and vault note paths.
//
// A page at  Root/A/B  lives at  <local>/A-title/B-title.md ; its child pages
// live in the folder next to it,  <local>/A-title/B-title/ . Attachments of a
// note go in  <dir>/_attachments/<note-name>/ .

export const ATTACHMENTS_DIR = "_attachments";
export const CONFLICT_MARKER = " (knowledge conflict ";

// conflict copies named by versions before the NiCE Knowledge rename
const LEGACY_CONFLICT_MARKERS = [" (expert conflict "];

export function joinPath(...parts: string[]): string {
    return parts.filter((part) => part !== "").join("/").replace(/\/+/g, "/");
}

export function dirname(path: string): string {
    const index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index);
}

export function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

export function stripMd(path: string): string {
    return path.replace(/\.md$/i, "");
}

// characters Obsidian or common filesystems reject in file names, plus link syntax
export function titleToFileName(title: string): string {
    const cleaned = title
        .replace(/[\\/:*?"<>|#^[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\.+/, "");
    return cleaned || "Untitled";
}

// one page-path segment from a title: Deki-style, spaces as underscores
export function titleToSegment(title: string): string {
    const cleaned = title
        .replace(/[\\/?#%"<>|:*'!&+;=[\]{}^`]/g, "")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return cleaned || "Untitled";
}

export function isInside(path: string, folder: string): boolean {
    return folder === "" || path === folder || path.startsWith(folder + "/");
}

export function relativeTo(path: string, folder: string): string {
    return folder === "" ? path : path.slice(folder.length + 1);
}

// true for files the engine must never treat as notes
export function isIgnoredNote(path: string): boolean {
    const name = basename(path);
    return path.split("/").includes(ATTACHMENTS_DIR) || [CONFLICT_MARKER, ...LEGACY_CONFLICT_MARKERS].some((marker) => name.includes(marker));
}

export function attachmentDir(notePath: string): string {
    return joinPath(dirname(notePath), ATTACHMENTS_DIR, stripMd(basename(notePath)));
}

// the note an attachment-folder file belongs to:  a/_attachments/Note/x.png -> a/Note.md
export function noteForAttachment(path: string): string | null {
    const parts = path.split("/");
    const index = parts.lastIndexOf(ATTACHMENTS_DIR);
    if(index < 0 || index + 2 >= parts.length) {
        return null;
    }
    return joinPath(...parts.slice(0, index), `${parts[index + 1]}.md`);
}

export function conflictPath(notePath: string, date: Date): string {
    const stamp = date.toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
    return `${stripMd(notePath)}${CONFLICT_MARKER}${stamp}).md`;
}

export function uniquePath(path: string, taken: (candidate: string) => boolean, suffix: string): string {
    if(!taken(path)) {
        return path;
    }
    const ext = /\.[^./]+$/.exec(path)?.[0] ?? "";
    const stem = ext ? path.slice(0, -ext.length) : path;
    let candidate = `${stem} (${suffix})${ext}`;
    for(let n = 2; taken(candidate); n++) {
        candidate = `${stem} (${suffix}-${n})${ext}`;
    }
    return candidate;
}

const MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
    webp: "image/webp", bmp: "image/bmp", avif: "image/avif", pdf: "application/pdf", txt: "text/plain",
    csv: "text/csv", json: "application/json", zip: "application/zip", mp3: "audio/mpeg", mp4: "video/mp4",
    webm: "video/webm", wav: "audio/wav", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mimeTypeFor(name: string): string {
    return MIME[(/\.([^.]+)$/.exec(name)?.[1] ?? "").toLowerCase()] ?? "application/octet-stream";
}
