// Live end-to-end test against a real Expert site, using two folders as two "devices".
//
//   node test-e2e/e2e.ts [SITE_URL] [ROOT_PAGE]
//
// Site, root and token come from the arguments or EXPERT_SITE / EXPERT_ROOT /
// EXPERT_TOKEN (or EXPERT_TOKEN_FILE), read from ./.env when present.
//
// Creates pages under the root with a unique run id and deletes them at the end.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExpertClient, SOURCE_PROPERTY } from "../src/core/expertApi.ts";
import { readFlag } from "../src/core/markdown.ts";
import { type SyncReport, type SyncState, SyncEngine } from "../src/core/sync.ts";
import { expertToken, loadDotEnv } from "../src/node/env.ts";
import { JsonFileStore, NodeVault, nodeHttp } from "../src/node/nodeVault.ts";

loadDotEnv();
const site = process.argv[2] ?? process.env.EXPERT_SITE ?? "";
const root = process.argv[3] ?? process.env.EXPERT_ROOT ?? "Board_Games";
const token = expertToken();
if(!site || !token) {
    throw new Error("set EXPERT_SITE and EXPERT_TOKEN (or EXPERT_TOKEN_FILE), e.g. in .env");
}
const run = Date.now().toString(36);
const base = join(".e2e", `run-${run}`);
const client = new ExpertClient(site, token, nodeHttp);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function device(name: string) {
    const dir = join(base, name);
    const vault = new NodeVault(dir);
    const engine = new SyncEngine(client, vault, new JsonFileStore<SyncState>(join(base, `${name}.state.json`)),
        { siteUrl: site, rootPath: root, localFolder: "" }, { info: () => {}, warn: (m) => console.warn(`  warn[${name}]: ${m}`) });
    const file = (path: string) => join(dir, ...path.split("/"));
    return {
        dir, vault, engine,
        read: (path: string) => readFile(file(path), "utf8"),
        write: async (path: string, text: string | Buffer) => {
            await mkdir(join(file(path), ".."), { recursive: true });
            await writeFile(file(path), text);
        },
        remove: (path: string) => rm(file(path)),
        async sync(label: string): Promise<SyncReport> {
            const report = await engine.sync();
            const summary = Object.entries(report).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${k}=${(v as unknown[]).length}`).join(" ");
            console.log(`  [${name}] ${label}: ${summary || "no changes"}`);
            assert.deepEqual(report.errors, [], `${label} errors`);
            return report;
        },
    };
}

const pagesToDelete: string[] = [];
let step = 0;
const check = (message: string) => console.log(`ok ${++step} - ${message}`);

try {
    const a = device("A");
    const b = device("B");

    // start from "edited in the Expert editor" for the pages the test drives
    for(const page of (await client.tree(root)).filter((p) => p.title === "Catan" || p.title === "Codenames")) {
        await client.postMarkdown(page.id, (await client.getMarkdown(page.id)).body.replace(/\n## Obsidian bits[\s\S]*$/, "\n") + `\n## Obsidian bits reset ${run}\n`, {});
    }

    let report = await a.sync("initial pull");
    assert.ok(report.pulled.includes("Catan.md"));
    assert.equal(readFlag(await a.read("Catan.md")), "site-edited");
    check("initial pull brings site pages in, flagged site-edited");

    report = await a.sync("no-op");
    assert.equal(report.pulled.length + report.pushed.length + report.created.length, 0);
    check("second sync with no changes does nothing");

    // edit a flagged note: push is blocked
    await a.write("Catan.md", (await a.read("Catan.md")) + "\nblocked edit\n");
    report = await a.sync("edit flagged");
    assert.ok(report.blocked.some((b) => b.startsWith("Catan.md")));
    check("edits to a site-edited note are blocked until accepted");

    // accept, add Obsidian syntax and an attachment
    await a.engine.acceptNote("Catan.md");
    const catanBody = (await a.read("Catan.md")).replace("\nblocked edit\n", "\n")
        + `\n## Obsidian bits ${run}\n\nCompare with [[Azul|the tile game]] and [[Pandemic#How to play]].\n\n![[_attachments/Catan/board-${run}.png]]\n\n==highlighted== %%hidden comment%%\n\n> [!tip] Strategy\n> Build on 6s and 8s.\n\n\`\`\`\n[[not a link]] ==not a highlight==\n\`\`\`\n`;
    await a.write("Catan.md", catanBody);
    await a.write(`_attachments/Catan/board-${run}.png`, PNG);
    report = await a.sync("accept + push Catan");
    assert.ok(report.pushed.includes("Catan.md"));
    assert.ok(report.uploaded.some((p) => p.endsWith(`board-${run}.png`)));
    const catan = (await client.tree(root)).find((p) => p.path === `${root}/Catan`)!;
    const published = await client.getMarkdown(catan.id);
    assert.match(published.body, /\[the tile game\]\(https:\/\/[^)]+\/Board_Games\/Azul\)/);
    assert.match(published.body, /\/@api\/deki\/files\/\d+\//);
    assert.ok(!published.body.includes("hidden comment"));
    assert.ok(!published.body.includes("[!tip]"));
    assert.match(published.body, /<mark>highlighted<\/mark>/);
    assert.equal(await client.getProperty(catan.id, SOURCE_PROPERTY), catanBody);
    check("accepted note pushes: wiki links, embeds, highlights, comments, callouts converted; exact source stored");

    const catanState = Object.values((await new JsonFileStore<SyncState>(join(base, "A.state.json")).load())!.pages).find((p) => p.notePath === "Catan.md")!;
    assert.ok(catanState.modified, "modified timestamp recorded for concurrent-edit check");
    await assert.rejects(client.postMarkdown(catan.id, "stale", { editTime: "20200101000000" }), (error: any) => error.status === 409);
    check("server rejects a push based on a stale edit time (abort=modified)");

    report = await a.sync("no-op after push");
    assert.equal(report.pulled.length + report.pushed.length + report.uploaded.length, 0);
    check("sync after push is a no-op (revision bookkeeping is right)");

    // second device gets byte-exact note and the attachment at the same path
    report = await b.sync("device B initial");
    assert.equal(await b.read("Catan.md"), catanBody);
    assert.deepEqual(await readFile(join(b.dir, "_attachments", "Catan", `board-${run}.png`)), PNG);
    assert.equal(readFlag(await b.read("Catan.md")), null);
    check("second device pulls the pushed note byte-exact and its attachment");

    // new note in a new folder on device B
    const folder = `Party ${run}`;
    const wavelength = `${folder}/Wavelength ${run}.md`;
    await b.write(wavelength, `---\ntags: [party, ${run}]\n---\nA team guessing game. See [[Codenames]].\n`);
    report = await b.sync("create note in new folder");
    assert.ok(report.created.some((c) => c.startsWith(wavelength)));
    const created = (await client.tree(root)).filter((p) => p.path.includes(run));
    pagesToDelete.push(...created.map((p) => p.id).reverse());
    const wavePage = created.find((p) => p.title === `Wavelength ${run}`)!;
    assert.ok(wavePage, "page created");
    const waveTags = await client.getTags(wavePage.id);
    assert.ok(waveTags.includes(run) && waveTags.some((t) => t.startsWith("article:")), `tags ${waveTags}`);
    check(`new local note creates folder page + page with tags and IDF type (${waveTags.find((t) => t.startsWith("article:"))})`);

    report = await a.sync("device A pulls new pages");
    assert.equal(await a.read(wavelength), await b.read(wavelength));
    check("other device pulls the created note byte-exact into the same folder");

    // site edit (as if in the Expert editor) on a source-backed page, local unchanged -> pulled as site-edited
    await client.postMarkdown(wavePage.id, "Edited **on the site**.\n", {});
    report = await a.sync("site edit");
    assert.ok(report.pulled.includes(wavelength));
    assert.equal(readFlag(await a.read(wavelength)), "site-edited");
    assert.match(await a.read(wavelength), /Edited \*\*on the site\*\*/);
    check("a site-side edit is pulled and flagged site-edited");

    // conflict: B edits locally while the site changed
    await b.write(wavelength, (await b.read(wavelength)) + "\nB's local edit\n");
    await client.postMarkdown(wavePage.id, "Second site edit.\n", {});
    report = await b.sync("conflict");
    assert.ok(report.conflicts.length === 1, JSON.stringify(report.conflicts));
    assert.equal(readFlag(await b.read(wavelength)), "conflict");
    assert.match(await b.read(wavelength), /B's local edit/);
    check("simultaneous edits keep both: local flagged conflict, site version saved alongside");

    await b.engine.acceptNote(wavelength);
    report = await b.sync("resolve conflict");
    assert.ok(report.pushed.includes(wavelength));
    assert.match((await client.getMarkdown(wavePage.id)).body, /B's local edit/);
    check("accepting the conflicted note pushes it");

    // local move into another folder moves the page
    report = await a.sync("A catches up");
    console.log("  catch-up pushed:", report.pushed, "pulled:", report.pulled);
    const moved = `${folder}/Wavelength ${run}.md`;
    const notePath = `Codenames.md`;
    await a.engine.acceptNote(notePath);
    report = await a.sync("accept Codenames");
    assert.ok(report.pushed.includes(notePath));
    const codenamesText = await a.read(notePath);
    await a.write(`${folder}/Codenames.md`, codenamesText);
    await a.remove(notePath);
    report = await a.sync("move Codenames into folder");
    assert.ok(report.moved.some((m) => m.includes("Codenames")), JSON.stringify(report));
    const codenames = (await client.tree(root)).find((p) => p.title === "Codenames")!;
    assert.equal(codenames.path, `${root}/Party_${run}/Codenames`);
    check("moving a note into a folder moves the site page");
    await a.write(notePath, codenamesText);
    await a.remove(`${folder}/Codenames.md`);
    report = await a.sync("move Codenames back");
    assert.equal((await client.pageInfo(codenames.id)).path, `${root}/Codenames`);
    check("and moving it back restores the page path");

    // local delete is never automatic
    await b.sync("B catches up");
    await b.remove(moved);
    report = await b.sync("local delete");
    assert.ok(report.pending.some((p) => p.kind === "site-page" && p.pageId === wavePage.id));
    assert.ok((await client.pageInfo(wavePage.id)).id);
    check("deleting a note locally only queues a pending delete; the site page stays");

    await b.engine.resolvePending(report.pending.find((p) => p.kind === "site-page")!, "keep");
    report = await b.sync("keep -> restore");
    assert.ok(report.pulled.includes(moved));
    check("choosing keep restores the note from the site");

    console.log(`\nall ${step} checks passed`);
} finally {
    for(const id of pagesToDelete) {
        if(await client.hasChildPages(id).catch(() => true)) {
            console.warn(`  cleanup: left page ${id} in place, it has child pages`);
            continue;
        }
        await client.deletePage(id).catch(() => {});
    }
}
