import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const FLAG_KEY = "nice-knowledge-sync";

// flag key written by versions before the NiCE Knowledge rename; still read and cleared
const LEGACY_FLAG_KEYS = ["expert-sync"];
export type NoteFlag = "site-edited" | "conflict" | "dynamic";

export interface Frontmatter {
    data: Record<string, unknown>;
    body: string;
    hasFrontmatter: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text: string): Frontmatter {
    const match = FRONTMATTER.exec(text);
    if(!match) {
        return { data: {}, body: text, hasFrontmatter: false };
    }
    let data: Record<string, unknown> = {};
    try {
        const parsed = parseYaml(match[1]);
        if(parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            data = parsed as Record<string, unknown>;
        }
    } catch {
        // NOTE: invalid YAML is left in place; the note is still synced as text
    }
    return { data, body: text.slice(match[0].length), hasFrontmatter: true };
}

export function joinFrontmatter(data: Record<string, unknown>, body: string): string {
    const keys = Object.keys(data).filter((key) => data[key] !== undefined);
    if(keys.length === 0) {
        return body;
    }
    const clean: Record<string, unknown> = {};
    for(const key of keys) {
        clean[key] = data[key];
    }
    return `---\n${stringifyYaml(clean, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

export function readFlag(text: string): NoteFlag | null {
    const data = splitFrontmatter(text).data;
    for(const key of [FLAG_KEY, ...LEGACY_FLAG_KEYS]) {
        const value = data[key];
        if(value === "site-edited" || value === "conflict" || value === "dynamic") {
            return value;
        }
    }
    return null;
}

// Sets or clears the flag line textually so the rest of the user's YAML keeps its formatting.
export function setFlag(text: string, flag: NoteFlag | null): string {
    const match = FRONTMATTER.exec(text);
    const line = flag ? `${FLAG_KEY}: ${flag}` : null;
    if(!match) {
        return line ? `---\n${line}\n---\n${text}` : text;
    }
    const lines = match[1].split(/\r?\n/).filter((l) => ![FLAG_KEY, ...LEGACY_FLAG_KEYS].some((key) => new RegExp(`^${key}\\s*:`).test(l)));
    if(line) {
        lines.push(line);
    }
    const rest = text.slice(match[0].length);
    const yaml = lines.filter((l) => l.trim() !== "").join("\n");
    return yaml ? `---\n${yaml}\n---\n${rest}` : rest;
}

// --- Obsidian markdown -> CommonMark for the published page ---

export interface PublishContext {

    // [[Note]] target -> site-relative page URL, or null when it isn't a synced page
    resolveNote(link: string): string | null;

    // ![[file.png]] / ![](file.png) target -> uploaded file URL, or null
    resolveFile(link: string): { url: string; name: string } | null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;

// Runs `transform` on everything outside fenced code blocks and inline code spans.
function outsideCode(markdown: string, transform: (text: string) => string): string {
    const out: string[] = [];
    let prose: string[] = [];
    let fence: string | null = null;
    const flush = () => {
        if(prose.length) {
            out.push(transformInline(prose.join("\n"), transform));
            prose = [];
        }
    };
    const lines = markdown.split("\n");
    for(const line of lines) {
        const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if(fence) {
            out.push(line);
            if(fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) {
                fence = null;
            }
            continue;
        }
        if(fenceMatch) {
            flush();
            fence = fenceMatch[1];
            out.push(line);
            continue;
        }
        prose.push(line);
    }
    flush();
    return out.join("\n");
}

function transformInline(text: string, transform: (text: string) => string): string {
    const parts = text.split(/(`+[^`\n]*?`+)/g);
    return parts.map((part, index) => (index % 2 === 1 ? part : transform(part))).join("");
}

function splitTarget(raw: string): { target: string; alias: string | null } {
    const pipe = raw.indexOf("|");
    return pipe < 0
        ? { target: raw.trim(), alias: null }
        : { target: raw.slice(0, pipe).trim(), alias: raw.slice(pipe + 1).trim() };
}

function displayName(target: string): string {
    const withoutHeading = target.split("#")[0];
    const base = withoutHeading.split("/").pop() ?? withoutHeading;
    return base.replace(/\.md$/i, "") || target;
}

function anchorFor(target: string): string {
    const hash = target.indexOf("#");
    if(hash < 0) {
        return "";
    }
    const heading = target.slice(hash + 1).replace(/^\^/, "");
    return "#" + heading.trim().replace(/\s+/g, "_");
}

function convertCallouts(text: string): string {
    return text.replace(/^(\s*>\s*)\[!([\w-]+)\][+-]?[ \t]*(.*)$/gm, (_all, prefix: string, kind: string, title: string) => {
        const label = title.trim() || kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
        return `${prefix}**${label}**`;
    });
}

// Obsidian %%comments%% (which may span lines), outside code
export function stripComments(body: string): string {
    return outsideCode(body, (text) => text.replace(/%%[\s\S]*?%%/g, ""));
}

export function toPublishMarkdown(body: string, context: PublishContext): string {
    return outsideCode(stripComments(body), (text) => {
        let result = convertCallouts(text);

        result = result.replace(/!\[\[([^\]\n]+)\]\]/g, (all, raw: string) => {
            const { target, alias } = splitTarget(raw);
            const file = context.resolveFile(target.split("#")[0]);
            if(file) {
                const label = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : file.name;
                return IMAGE_EXT.test(file.name) ? `![${label}](${file.url})` : `[${label}](${file.url})`;
            }
            const page = context.resolveNote(target.split("#")[0]);
            if(page) {
                return `[${alias ?? displayName(target)}](${page}${anchorFor(target)})`;
            }
            return alias ?? displayName(target);
        });

        result = result.replace(/\[\[([^\]\n]+)\]\]/g, (all, raw: string) => {
            const { target, alias } = splitTarget(raw);
            const label = alias ?? displayName(target);
            const page = target.startsWith("#") ? "" : context.resolveNote(target.split("#")[0]);
            if(page === null) {
                return label;
            }
            return `[${label}](${page}${anchorFor(target)})`;
        });

        // local markdown links and images: [x](Some%20Note.md), ![x](img.png)
        result = result.replace(/(!?)\[([^\]\n]*)\]\(<?([^)\s>]+)>?\)/g, (all, bang: string, label: string, href: string) => {
            if(/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) {
                return all;
            }
            const decoded = safeDecode(href);
            const file = context.resolveFile(decoded.split("#")[0]);
            if(file && !/\.md$/i.test(decoded)) {
                return `${bang}[${label || file.name}](${file.url})`;
            }
            const page = context.resolveNote(decoded.split("#")[0].replace(/\.md$/i, ""));
            return page ? `[${label}](${page}${anchorFor(decoded)})` : label;
        });

        result = result.replace(/==(?=\S)([^=\n]+?)==/g, "<mark>$1</mark>");
        return result;
    });
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

// --- server markdown -> Obsidian markdown for pages without a stored source ---

export interface LocalizeContext {
    siteUrl: string;

    // attachment of this page (by file id) -> vault path to embed, or null to keep the URL
    localFile(fileId: string, name: string): string | null;

    // site page path ("Board_Games/Catan") -> wiki link target, or null to keep the URL
    localNote(pagePath: string): string | null;
}

export function toLocalMarkdown(body: string, context: LocalizeContext): string {
    const site = context.siteUrl.replace(/\/+$/, "");
    const origin = escapeRegExp(site);
    const fileUrl = new RegExp(`(!?)\\[([^\\]\\n]*)\\]\\((?:${origin})?/@api/deki/files/(\\d+)/([^)\\s?#]+)(?:[?#][^)\\s]*)?\\)`, "g");
    const pageUrl = new RegExp(`\\[([^\\]\\n]+)\\]\\((?:${origin})?/(?!@api/)([^)\\s?#]+)((?:#[^)\\s]*)?)\\)`, "g");
    return outsideCode(body, (text) => text
        .replace(fileUrl, (all, bang: string, label: string, fileId: string, name: string) => {
            const local = context.localFile(fileId, safeDecode(name));
            if(!local) {
                return all;
            }
            return bang ? `![[${local}]]` : `[[${local}|${label || safeDecode(name)}]]`;
        })
        .replace(pageUrl, (all, label: string, path: string, anchor: string) => {
            const target = context.localNote(safeDecode(path));
            if(!target) {
                return all;
            }
            const heading = anchor ? "#" + safeDecode(anchor.slice(1)).replace(/_/g, " ") : "";
            return `[[${target}${heading}|${label}]]`;
        }));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// all link targets a note embeds or links to as files (wiki embeds and local markdown images/links)
export function collectFileLinks(body: string): string[] {
    const found = new Set<string>();
    outsideCode(body, (text) => {
        for(const match of text.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
            found.add(splitTarget(match[1]).target.split("#")[0]);
        }
        for(const match of text.matchAll(/!?\[[^\]\n]*\]\(<?([^)\s>]+)>?\)/g)) {
            const href = match[1];
            if(!/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href) && !/\.md(#.*)?$/i.test(href)) {
                found.add(safeDecode(href).split("#")[0]);
            }
        }
        return text;
    });
    return [...found];
}
