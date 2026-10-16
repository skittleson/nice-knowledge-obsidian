import { describe, expect, it } from "vitest";
import { parseServerMarkdown, parseSyncMeta, pageRef, toEditTime } from "../src/core/expertApi.ts";
import { collectFileLinks, readFlag, setFlag, splitFrontmatter, toLocalMarkdown, toPublishMarkdown } from "../src/core/markdown.ts";
import { attachmentDir, conflictPath, isIgnoredNote, noteForAttachment, titleToFileName, titleToSegment, uniquePath } from "../src/core/paths.ts";

const publish = (body: string) => toPublishMarkdown(body, {
    resolveNote: (link) => ({ Azul: "/Board_Games/Azul", "Games/Root": "/Board_Games/Root" } as Record<string, string>)[link] ?? null,
    resolveFile: (link) => (link.endsWith("board.png") ? { url: "/@api/deki/files/7/board.png", name: "board.png" }
        : link === "rules.pdf" ? { url: "/@api/deki/files/8/rules.pdf", name: "rules.pdf" } : null),
});

describe("toPublishMarkdown", () => {
    it("turns wiki links into site links, keeping aliases and headings", () => {
        expect(publish("See [[Azul]], [[Azul|the tile game]] and [[Azul#How to play]]."))
            .toBe("See [Azul](/Board_Games/Azul), [the tile game](/Board_Games/Azul) and [Azul](/Board_Games/Azul#How_to_play).");
    });

    it("leaves the label for links to notes that aren't synced", () => {
        expect(publish("[[Nowhere]] and [[Nowhere|alias]]")).toBe("Nowhere and alias");
    });

    it("turns embeds into uploaded file URLs; non-images become links", () => {
        expect(publish("![[img/board.png]] ![[rules.pdf]] ![[board.png|300]]"))
            .toBe("![board.png](/@api/deki/files/7/board.png) [rules.pdf](/@api/deki/files/8/rules.pdf) ![board.png](/@api/deki/files/7/board.png)");
    });

    it("rewrites local markdown images and note links but not URLs", () => {
        expect(publish("![b](img/board.png) [n](Azul.md) [web](https://x.org/a.png) [abs](/x)"))
            .toBe("![b](/@api/deki/files/7/board.png) [n](/Board_Games/Azul) [web](https://x.org/a.png) [abs](/x)");
    });

    it("converts highlights, drops comments, flattens callouts", () => {
        expect(publish("==hi== there %%secret%%\n%%\nblock\n%%\n> [!warning] Careful\n> text\n> [!note]\n> x"))
            .toBe("<mark>hi</mark> there \n\n> **Careful**\n> text\n> **Note**\n> x");
    });

    it("never touches code", () => {
        const body = "```\n[[Azul]] ==x== %%c%%\n```\nand `[[Azul]]` but [[Azul]]";
        expect(publish(body)).toBe("```\n[[Azul]] ==x== %%c%%\n```\nand `[[Azul]]` but [Azul](/Board_Games/Azul)");
    });
});

describe("toLocalMarkdown", () => {
    const localize = (body: string) => toLocalMarkdown(body, {
        siteUrl: "https://s.example",
        localFile: (id) => (id === "1" ? "Games/_attachments/Catan/dot pixel.png" : null),
        localNote: (path) => (path === "Board_Games/Catan" ? "Games/Catan" : null),
    });

    it("maps page attachments to embeds and synced pages to wiki links", () => {
        expect(localize("![a](https://s.example/@api/deki/files/1/dot_pixel.png?revision=1) [the island](https://s.example/Board_Games/Catan#How_to_play)"))
            .toBe("![[Games/_attachments/Catan/dot pixel.png]] [[Games/Catan#How to play|the island]]");
    });

    it("keeps links it can't map", () => {
        const body = "![x](https://s.example/@api/deki/files/9/x.png) [o](https://other.example/Board_Games/Catan) [u](https://s.example/Elsewhere)";
        expect(localize(body)).toBe(body);
    });
});

describe("frontmatter and flags", () => {
    it("splits frontmatter", () => {
        const { data, body } = splitFrontmatter("---\ntitle: A\ntags: [x, y]\n---\nbody\n");
        expect(data).toEqual({ title: "A", tags: ["x", "y"] });
        expect(body).toBe("body\n");
    });

    it("sets and clears the flag without reformatting other YAML", () => {
        const text = "---\ntitle:   'Odd  spacing'\n---\nbody";
        const flagged = setFlag(text, "site-edited");
        expect(flagged).toBe("---\ntitle:   'Odd  spacing'\nexpert-sync: site-edited\n---\nbody");
        expect(readFlag(flagged)).toBe("site-edited");
        expect(setFlag(flagged, null)).toBe(text);
        expect(setFlag("plain", "conflict")).toBe("---\nexpert-sync: conflict\n---\nplain");
        expect(setFlag(setFlag("plain", "conflict"), null)).toBe("plain");
    });

    it("collects embedded file links outside code", () => {
        expect(collectFileLinks("![[a.png]] ![x](b%20c.png) [doc](d.pdf) [n](Note.md) [w](https://x/y.png) `![[no.png]]`").sort())
            .toEqual(["a.png", "b c.png", "d.pdf"]);
    });
});

describe("server markdown", () => {
    it("parses the server front matter", () => {
        const page = parseServerMarkdown("---\nid: 145\ntitle: \"Brass: Birmingham\"\npath: \"Board_Games/Brass\"\nrevision: 3\ndynamic: false\ntags: [\"article:topic\", \"economic\"]\n---\n\nBody\n");
        expect(page.meta).toMatchObject({ id: "145", title: "Brass: Birmingham", revision: 3, dynamic: false, tags: ["article:topic", "economic"] });
        expect(page.body).toBe("Body\n");
    });

    it("parses sync metadata defensively", () => {
        expect(parseSyncMeta("{\"v\":1,\"revision\":4,\"hash\":\"ab\"}")).toEqual({ v: 1, revision: 4, hash: "ab", files: {} });
        expect(parseSyncMeta("nope")).toBeNull();
        expect(parseSyncMeta("{\"v\":2}")).toBeNull();
    });

    it("formats edit times and page refs", () => {
        expect(toEditTime("Fri, 16 Oct 2026 15:47:10 GMT")).toBe("20261016154710");
        expect(toEditTime("")).toBe("now");
        expect(pageRef("Board_Games/Catan")).toBe("=Board_Games%252FCatan");
        expect(pageRef("145")).toBe("145");
        expect(pageRef("")).toBe("home");
    });
});

describe("paths", () => {
    it("makes safe file names and page segments", () => {
        expect(titleToFileName("Brass: Birmingham")).toBe("Brass Birmingham");
        expect(titleToFileName("a/b#c")).toBe("a b c");
        expect(titleToSegment("Clank! A Deck-Building Adventure")).toBe("Clank_A_Deck-Building_Adventure");
        expect(titleToSegment("Brass: Birmingham")).toBe("Brass_Birmingham");
    });

    it("maps attachment folders to notes", () => {
        expect(attachmentDir("Games/Catan.md")).toBe("Games/_attachments/Catan");
        expect(noteForAttachment("Games/_attachments/Catan/x.png")).toBe("Games/Catan.md");
        expect(isIgnoredNote("Games/_attachments/Catan/notes.md")).toBe(true);
        expect(isIgnoredNote(conflictPath("Catan.md", new Date("2026-10-16T15:00:00Z")))).toBe(true);
        expect(conflictPath("Catan.md", new Date("2026-10-16T15:04:00Z"))).toBe("Catan (expert conflict 2026-10-16 15-04).md");
        expect(uniquePath("a.md", (p) => p === "a.md", "7")).toBe("a (7).md");
    });
});

describe("ExpertClient", () => {
    it("retries throttled requests with backoff, then surfaces the error", async () => {
        const { ExpertClient, ExpertError } = await import("../src/core/expertApi.ts");
        const statuses = [429, 503, 200];
        const waits: number[] = [];
        const calls: string[] = [];
        const http = async (request: { url: string }) => {
            calls.push(request.url);
            const status = statuses.shift() ?? 503;
            const body = new TextEncoder().encode(status === 200 ? "{\"@id\":\"1\",\"nick\":\"me\",\"@anonymous\":\"false\"}" : "<error><exception>Busy</exception></error>");
            const headers: Record<string, string> = status === 429 ? { "retry-after": "2" } : {};
            return { status, headers, body: body.buffer as ArrayBuffer };
        };
        const client = new ExpertClient("https://s.example/", "Bearer abc", http, { sleep: async (ms) => { waits.push(ms); } });
        expect(await client.currentUser()).toEqual({ id: "1", name: "me", anonymous: false });
        expect(waits).toEqual([2000, 1000]);
        expect(calls[0]).toBe("https://s.example/@api/deki/users/current?dream.out.format=json");

        const failing = new ExpertClient("https://s.example", "abc", async () => ({ status: 503, headers: {}, body: new TextEncoder().encode("<error><exception>Busy</exception></error>").buffer as ArrayBuffer }), { retries: 2, sleep: async () => {} });
        await expect(failing.currentUser()).rejects.toBeInstanceOf(ExpertError);
    });
});
