#!/usr/bin/env node
// Creates a new Obsidian vault wired to an Expert site, with the plugin installed and enabled.
//
//   node scripts/create-vault.mjs --vault ~/Vaults/BoardGames --site https://your-site.example.com --root Board_Games [--folder "Board Games"] [--open]
//
// --site and --root default to EXPERT_SITE / EXPERT_ROOT (./.env is read when present).
//
// The API token is not written to disk: on first open the plugin shows its
// "Connect" screen with the site and root filled in, and asks for the token there.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if(existsSync(join(process.cwd(), ".env"))) {
    process.loadEnvFile(join(process.cwd(), ".env"));
}
const vaultArg = option("vault");
const site = option("site", process.env.EXPERT_SITE);
if(!vaultArg || !site) {
    console.error("usage: create-vault.mjs --vault DIR --site URL [--root PAGE_PATH] [--folder VAULT_FOLDER] [--open]");
    process.exit(2);
}
const vault = resolve(vaultArg.replace(/^~(?=\/|$)/, homedir()));
const rootPath = (option("root", process.env.EXPERT_ROOT ?? "") ?? "").replace(/^\/+|\/+$/g, "").replace(/ /g, "_");
const folder = option("folder", rootPath ? rootPath.split("/").pop().replace(/_/g, " ") : "");

if(!/^https?:\/\//.test(site)) {
    console.error("--site must be a full URL, e.g. https://your-site.example.com");
    process.exit(2);
}
if(existsSync(vault) && readdirSync(vault).length) {
    console.error(`${vault} already exists and is not empty. Pick a new folder.`);
    process.exit(1);
}
if(!existsSync(join(repo, "main.js"))) {
    console.log("main.js not built yet; running npm run build");
    execFileSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit" });
}

const pluginDir = join(vault, ".obsidian", "plugins", "expert-sync");
mkdirSync(pluginDir, { recursive: true });
copyFileSync(join(repo, "main.js"), join(pluginDir, "main.js"));
copyFileSync(join(repo, "manifest.json"), join(pluginDir, "manifest.json"));
writeFileSync(join(pluginDir, "data.json"), JSON.stringify({
    siteUrl: site.replace(/\/+$/, ""),
    rootPath,
    localFolder: folder,
    tokenSecret: "",
    autoSyncMinutes: 0,
}, null, 2));
writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["expert-sync"]));
writeFileSync(join(vault, ".obsidian", "app.json"), JSON.stringify({ attachmentFolderPath: "./_attachments" }, null, 2));

const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));
const uri = `obsidian://open?path=${encodeURIComponent(vault)}`;
console.log(`Created vault ${vault}`);
console.log(`  plugin  ${manifest.name} ${manifest.version}`);
console.log(`  site    ${site}  root: ${rootPath || "(whole site)"}  folder: ${folder || "(vault root)"}`);
console.log(`Open it in Obsidian (${uri}); paste your API token in the Connect screen and the first sync runs.`);
if(process.argv.includes("--open")) {
    execFileSync("xdg-open", [uri], { stdio: "ignore" });
}
