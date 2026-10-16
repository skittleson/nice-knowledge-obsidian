// Command-line harness for the sync engine (testing without Obsidian).
//
//   node src/node/cli.ts sync    --vault ./vault [--site URL] [--root Board_Games] (--folder Sub | --whole-vault) [--state ./state.json]
//   node src/node/cli.ts pending ...same options
//   node src/node/cli.ts accept  ...same options --note "Board Games/Catan.md"
//
// --site and --root default to EXPERT_SITE / EXPERT_ROOT. The token comes from
// EXPERT_TOKEN, EXPERT_TOKEN_FILE or --token-file. A ./.env file is loaded if present.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExpertClient } from "../core/expertApi.ts";
import { type SyncState, SyncEngine } from "../core/sync.ts";
import { expertToken, loadDotEnv } from "./env.ts";
import { JsonFileStore, NodeVault, nodeHttp } from "./nodeVault.ts";

loadDotEnv();

function option(name: string, fallback?: string): string {
    const index = process.argv.indexOf(`--${name}`);
    const value = index >= 0 ? process.argv[index + 1] : fallback;
    if(value === undefined) {
        throw new Error(`missing --${name}`);
    }
    return value;
}

export function engineFromArgs(): { engine: SyncEngine; vault: NodeVault } {
    const tokenFile = process.argv.includes("--token-file") ? option("token-file") : null;
    const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : expertToken();
    if(!token) {
        throw new Error("set EXPERT_TOKEN or EXPERT_TOKEN_FILE (or put it in .env), or pass --token-file");
    }
    const site = option("site", process.env.EXPERT_SITE);
    const vaultDir = option("vault");
    const vault = new NodeVault(vaultDir);
    const client = new ExpertClient(site, token, nodeHttp);
    const store = new JsonFileStore<SyncState>(option("state", join(vaultDir, ".expert-sync-state.json")));
    const engine = new SyncEngine(client, vault, store, {
        siteUrl: site,
        rootPath: option("root", process.env.EXPERT_ROOT ?? ""),
        localFolder: option("folder", ""),
        allowWholeVault: process.argv.includes("--whole-vault"),
        keepComments: process.argv.includes("--keep-comments"),
    }, { info: (m) => console.log(m), warn: (m) => console.warn(`warn: ${m}`) });
    return { engine, vault };
}

async function main(): Promise<void> {
    const command = process.argv[2];
    const { engine } = engineFromArgs();
    if(command === "sync") {
        const report = await engine.sync();
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = report.errors.length ? 1 : 0;
    } else if(command === "pending") {
        console.log(JSON.stringify(await engine.pending(), null, 2));
    } else if(command === "accept") {
        console.log(await engine.acceptNote(option("note")));
    } else {
        console.error("usage: cli.ts sync|pending|accept --vault DIR [--site URL] [--root PATH] [--folder F | --whole-vault] [--keep-comments] [--state FILE] [--note PATH]");
        process.exitCode = 2;
    }
}

if(import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
