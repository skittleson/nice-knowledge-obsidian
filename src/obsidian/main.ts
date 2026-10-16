import { type App, type DropdownComponent, Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TFile } from "obsidian";
import { ExpertClient } from "../core/expertApi.ts";
import { type PendingDelete, type SyncReport, type SyncState, SyncEngine } from "../core/sync.ts";
import { LocalStorageStore, ObsidianVault, obsidianHttp } from "./obsidianVault.ts";

interface ExpertSyncSettings {
    siteUrl: string;
    rootPath: string;
    localFolder: string;

    // id of the token in Obsidian's secret storage, never the token itself
    tokenSecret: string;
    autoSyncMinutes: number;
}

const DEFAULT_SETTINGS: ExpertSyncSettings = {
    siteUrl: "",
    rootPath: "",
    localFolder: "",
    tokenSecret: "",
    autoSyncMinutes: 0,
};

const STATE_KEY = "expert-sync-state";
const DEFAULT_SECRET_ID = "expert-sync-token";

function summarize(report: SyncReport): string {
    const parts: string[] = [];
    const add = (count: number, label: string) => count && parts.push(`${count} ${label}`);
    add(report.pulled.length, "pulled");
    add(report.pushed.length, "pushed");
    add(report.created.length, "created");
    add(report.moved.length, "moved");
    add(report.uploaded.length, "uploaded");
    add(report.downloaded.length, "downloaded");
    add(report.conflicts.length, "conflicts");
    add(report.blocked.length, "blocked");
    add(report.skipped.length, "skipped");
    add(report.pending.length, "pending deletes");
    add(report.errors.length, "errors");
    return parts.length ? parts.join(", ") : "Up to date";
}

export default class ExpertSyncPlugin extends Plugin {
    settings: ExpertSyncSettings = { ...DEFAULT_SETTINGS };
    lastReport: SyncReport | null = null;
    private _syncing = false;
    private _status!: HTMLElement;
    private _interval: number | null = null;

    async onload(): Promise<void> {
        this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
        this._status = this.addStatusBarItem();
        this._setStatus("Expert: idle");
        this.addRibbonIcon("refresh-cw", "Sync with Expert", () => this.sync());
        this.addSettingTab(new ExpertSyncSettingTab(this.app, this));

        this.addCommand({ id: "sync", name: "Sync now", callback: () => this.sync() });
        this.addCommand({ id: "connect", name: "Connect this vault to an Expert site", callback: () => this.openSetup() });
        this.addCommand({ id: "test-connection", name: "Test connection", callback: () => this.testConnection() });
        this.addCommand({ id: "show-report", name: "Show last sync report", callback: () => new ReportModal(this.app, this.lastReport).open() });
        this.addCommand({ id: "review-pending", name: "Review pending deletes", callback: () => this.reviewPending() });
        this.addCommand({
            id: "accept-note",
            name: "Accept this note as the source",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if(!(file instanceof TFile) || file.extension !== "md") {
                    return false;
                }
                if(!checking) {
                    void this.acceptNote(file.path);
                }
                return true;
            },
        });
        this.addCommand({ id: "reset-state", name: "Reset sync state on this device", callback: () => this.resetState() });
        this.restartAutoSync();
        if(!this.isConfigured()) {
            this.app.workspace.onLayoutReady(() => this.openSetup());
        }
    }

    isConfigured(): boolean {
        return !!this.settings.siteUrl && !!this._token();
    }

    openSetup(): void {
        new SetupModal(this.app, this).open();
    }

    // stores the token in secret storage and saves the connection settings
    async connect(siteUrl: string, token: string, rootPath: string, localFolder: string): Promise<void> {
        const secretId = this.settings.tokenSecret || DEFAULT_SECRET_ID;
        if(token) {
            this.app.secretStorage.setSecret(secretId, token.trim());
        }
        if(this.settings.siteUrl !== siteUrl || this.settings.rootPath !== rootPath || this.settings.localFolder !== localFolder) {
            this.app.saveLocalStorage(STATE_KEY, null);
        }
        Object.assign(this.settings, { siteUrl, rootPath, localFolder, tokenSecret: secretId });
        await this.saveSettings();
    }

    onunload(): void {
        this._clearInterval();
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.restartAutoSync();
    }

    restartAutoSync(): void {
        this._clearInterval();
        if(this.settings.autoSyncMinutes > 0) {
            this._interval = this.registerInterval(window.setInterval(() => void this.sync(true), this.settings.autoSyncMinutes * 60_000));
        }
    }

    private _clearInterval(): void {
        if(this._interval !== null) {
            window.clearInterval(this._interval);
            this._interval = null;
        }
    }

    private _setStatus(text: string): void {
        this._status.setText(text);
    }

    private _token(): string | null {
        return this.settings.tokenSecret ? this.app.secretStorage.getSecret(this.settings.tokenSecret) : null;
    }

    private _engine(): SyncEngine | null {
        const token = this._token();
        if(!this.settings.siteUrl || !token) {
            new Notice("Expert Sync: set the site URL and API token in settings first.");
            return null;
        }
        const client = new ExpertClient(this.settings.siteUrl, token, obsidianHttp);
        return new SyncEngine(client, new ObsidianVault(this.app), new LocalStorageStore<SyncState>(this.app, STATE_KEY), {
            siteUrl: this.settings.siteUrl.replace(/\/+$/, ""),
            rootPath: this.settings.rootPath.trim().replace(/^\/+|\/+$/g, "").replace(/ /g, "_"),
            localFolder: this.settings.localFolder.trim(),
        }, { info: (m) => console.log(`[expert-sync] ${m}`), warn: (m) => console.warn(`[expert-sync] ${m}`) });
    }

    async sync(quiet = false): Promise<void> {
        if(this._syncing) {
            if(!quiet) {
                new Notice("Expert Sync: a sync is already running.");
            }
            return;
        }
        const engine = this._engine();
        if(!engine) {
            return;
        }
        this._syncing = true;
        this._setStatus("Expert: syncing…");
        try {
            const report = await engine.sync();
            this.lastReport = report;
            const summary = summarize(report);
            console.log("[expert-sync] report", report);
            this._setStatus(`Expert: ${summary.toLowerCase()}`);
            const needsAttention = report.conflicts.length || report.errors.length || report.pending.length || report.blocked.length;
            if(!quiet || needsAttention) {
                const notice = new Notice(`Expert Sync: ${summary}${needsAttention ? " (click for details)" : ""}`, needsAttention ? 10_000 : 4_000);
                notice.messageEl.addEventListener("click", () => new ReportModal(this.app, report).open());
            }
        } catch(error) {
            const message = error instanceof Error ? error.message : String(error);
            this._setStatus("Expert: sync failed");
            new Notice(`Expert Sync failed: ${message}`, 10_000);
            console.error("[expert-sync]", error);
        } finally {
            this._syncing = false;
        }
    }

    async testConnection(): Promise<void> {
        const token = this._token();
        if(!this.settings.siteUrl || !token) {
            new Notice("Expert Sync: set the site URL and API token first.");
            return;
        }
        try {
            const client = new ExpertClient(this.settings.siteUrl, token, obsidianHttp);
            const user = await client.currentUser();
            if(user.anonymous) {
                new Notice("Expert Sync: the token signs in as an anonymous user. Check the token.", 8_000);
                return;
            }
            const markdown = await client.markdownEnabled();
            const tree = await client.tree(this.settings.rootPath.trim().replace(/ /g, "_"));
            new Notice(`Expert Sync: signed in as ${user.name}. Markdown ${markdown ? "enabled" : "NOT enabled (turn on site/markdown-contents-enabled)"}. `
                + `Root "${tree[0].title}" has ${tree.length - 1} pages.`, 10_000);
        } catch(error) {
            new Notice(`Expert Sync: connection failed: ${error instanceof Error ? error.message : error}`, 10_000);
        }
    }

    async acceptNote(path: string): Promise<void> {
        const engine = this._engine();
        if(!engine) {
            return;
        }
        try {
            new Notice(`Expert Sync: ${await engine.acceptNote(path)}`);
        } catch(error) {
            new Notice(`Expert Sync: ${error instanceof Error ? error.message : error}`, 8_000);
        }
    }

    async reviewPending(): Promise<void> {
        const engine = this._engine();
        if(engine) {
            new PendingModal(this.app, engine, await engine.pending()).open();
        }
    }

    resetState(): void {
        new ConfirmModal(this.app, "Reset sync state on this device?",
            "The next sync treats every note as new and compares it with the site. Nothing is deleted on either side.",
            () => {
                this.app.saveLocalStorage(STATE_KEY, null);
                new Notice("Expert Sync: sync state cleared.");
            }).open();
    }
}

class ExpertSyncSettingTab extends PluginSettingTab {
    private readonly _plugin: ExpertSyncPlugin;

    constructor(app: App, plugin: ExpertSyncPlugin) {
        super(app, plugin);
        this._plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const settings = this._plugin.settings;

        new Setting(containerEl)
            .setName("Connect to a site")
            .setDesc("Step-by-step setup: site, token, which part of the site to sync, then a first sync.")
            .addButton((button) => button.setButtonText("Set up…").setCta().onClick(() => this._plugin.openSetup()));

        new Setting(containerEl)
            .setName("Site URL")
            .setDesc("Your Expert site, for example https://your-site.example.com. The site needs the site/markdown-contents-enabled config key.")
            .addText((text) => text.setPlaceholder("https://your-site.example.com").setValue(settings.siteUrl).onChange(async (value) => {
                settings.siteUrl = value.trim();
                await this._plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("API token")
            .setDesc("A JWT that signs in as you. It is kept in Obsidian's secret storage, not in the vault.")
            .addComponent((el) => new SecretComponent(this.app, el).setValue(settings.tokenSecret).onChange(async (value) => {
                settings.tokenSecret = value ?? "";
                await this._plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("Site root page")
            .setDesc("Path of the page whose subpages are synced, for example Board_Games. Leave empty for the whole site.")
            .addText((text) => text.setPlaceholder("Board_Games").setValue(settings.rootPath).onChange(async (value) => {
                settings.rootPath = value.trim();
                await this._plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("Vault folder")
            .setDesc("Folder in this vault that mirrors the root page. Leave empty to use the whole vault.")
            .addText((text) => text.setPlaceholder("(vault root)").setValue(settings.localFolder).onChange(async (value) => {
                settings.localFolder = value.trim().replace(/^\/+|\/+$/g, "");
                await this._plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("Sync every (minutes)")
            .setDesc("0 turns automatic sync off.")
            .addText((text) => text.setValue(String(settings.autoSyncMinutes)).onChange(async (value) => {
                const minutes = Number(value);
                settings.autoSyncMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
                await this._plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("Check connection")
            .addButton((button) => button.setButtonText("Test").onClick(() => this._plugin.testConnection()));
    }
}

class ReportModal extends Modal {
    private readonly _report: SyncReport | null;

    constructor(app: App, report: SyncReport | null) {
        super(app);
        this._report = report;
    }

    onOpen(): void {
        this.setTitle("Expert Sync report");
        const report = this._report;
        if(!report) {
            this.contentEl.createEl("p", { text: "No sync has run yet in this session." });
            return;
        }
        this.contentEl.createEl("p", { text: summarize(report) });
        const section = (label: string, items: string[]) => {
            if(!items.length) {
                return;
            }
            this.contentEl.createEl("h4", { text: `${label} (${items.length})` });
            const list = this.contentEl.createEl("ul");
            for(const item of items) {
                list.createEl("li", { text: item });
            }
        };
        section("Errors", report.errors.map((e) => `${e.path}: ${e.message}`));
        section("Conflicts", report.conflicts);
        section("Blocked", report.blocked);
        section("Pending deletes (run “Review pending deletes”)", report.pending.map(describePending));
        section("Skipped", report.skipped.map((s) => `${s.path}: ${s.reason}`));
        section("Created", report.created);
        section("Pushed", report.pushed);
        section("Pulled", report.pulled);
        section("Moved", report.moved);
        section("Uploaded", report.uploaded);
        section("Downloaded", report.downloaded);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

function describePending(item: PendingDelete): string {
    switch(item.kind) {
    case "site-page": return `Note ${item.notePath} was deleted here. Delete site page ${item.pagePath}?`;
    case "local-note": return `Site page for ${item.notePath} was deleted. Delete the note here?`;
    case "site-file": return `Attachment ${item.localPath} was deleted here. Delete ${item.name} on the site?`;
    case "local-file": return `Attachment ${item.name} was deleted on the site. Delete ${item.localPath} here?`;
    }
}

class PendingModal extends Modal {
    private readonly _engine: SyncEngine;
    private _items: PendingDelete[];

    constructor(app: App, engine: SyncEngine, items: PendingDelete[]) {
        super(app);
        this._engine = engine;
        this._items = items;
    }

    onOpen(): void {
        this.setTitle("Pending deletes");
        this._render();
    }

    private _render(): void {
        this.contentEl.empty();
        if(!this._items.length) {
            this.contentEl.createEl("p", { text: "Nothing waiting. Deletes on either side always stop here for your OK." });
            return;
        }
        for(const item of this._items) {
            new Setting(this.contentEl)
                .setDesc(describePending(item))
                .addButton((button) => button.setButtonText("Keep").setTooltip("Restore it from the other side on the next sync").onClick(() => this._resolve(item, "keep")))
                .addButton((button) => button.setButtonText("Delete").setWarning().onClick(() => this._resolve(item, "delete")));
        }
    }

    private async _resolve(item: PendingDelete, action: "delete" | "keep"): Promise<void> {
        try {
            await this._engine.resolvePending(item, action);
            this._items = this._items.filter((other) => other !== item);
            this._render();
        } catch(error) {
            new Notice(`Expert Sync: ${error instanceof Error ? error.message : error}`, 8_000);
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

class ConfirmModal extends Modal {
    private readonly _message: string;
    private readonly _detail: string;
    private readonly _onConfirm: () => void;

    constructor(app: App, message: string, detail: string, onConfirm: () => void) {
        super(app);
        this._message = message;
        this._detail = detail;
        this._onConfirm = onConfirm;
    }

    onOpen(): void {
        this.setTitle(this._message);
        this.contentEl.createEl("p", { text: this._detail });
        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
            .addButton((button) => button.setButtonText("Reset").setWarning().onClick(() => {
                this._onConfirm();
                this.close();
            }));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

// First-run screen: checks the site, the token and the markdown config key,
// lets the user pick the root page, then runs the first sync.
class SetupModal extends Modal {
    private readonly _plugin: ExpertSyncPlugin;
    private _siteUrl: string;
    private _token = "";
    private _rootPath: string;
    private _localFolder: string;
    private _folderEdited = false;
    private _status!: HTMLElement;
    private _rootDropdown: DropdownComponent | null = null;

    constructor(app: App, plugin: ExpertSyncPlugin) {
        super(app);
        this._plugin = plugin;
        this._siteUrl = plugin.settings.siteUrl;
        this._rootPath = plugin.settings.rootPath;
        this._localFolder = plugin.settings.localFolder;
        this._folderEdited = !!plugin.settings.localFolder;
    }

    onOpen(): void {
        this.setTitle("Connect this vault to an Expert site");
        const { contentEl } = this;
        contentEl.createEl("p", { text: "Notes in this vault will be synced with pages on the site: pages as markdown, attachments as files. The site needs the site/markdown-contents-enabled config key." });

        new Setting(contentEl).setName("Site URL").addText((text) => text
            .setPlaceholder("https://your-site.example.com")
            .setValue(this._siteUrl)
            .onChange((value) => {
                this._siteUrl = value.trim().replace(/\/+$/, "");
            }));

        new Setting(contentEl)
            .setName("API token")
            .setDesc(this._plugin.isConfigured() ? "A token is already saved. Leave empty to keep it." : "A JWT that signs in as you. Kept in Obsidian's secret storage.")
            .addText((text) => {
                text.inputEl.type = "password";
                text.setPlaceholder("eyJ…").onChange((value) => {
                    this._token = value.trim();
                });
            });

        const root = new Setting(contentEl)
            .setName("Site root page")
            .setDesc("Its subpages become notes. Click Find pages to choose, or type a path. Empty means the whole site.");
        root.addText((text) => text.setPlaceholder("Board_Games").setValue(this._rootPath).onChange((value) => {
            this._setRoot(value.trim());
        }));
        root.addButton((button) => button.setButtonText("Find pages").onClick(() => this._findPages(root)));

        new Setting(contentEl)
            .setName("Vault folder")
            .setDesc("Where the pages go in this vault. Empty means the vault root.")
            .addText((text) => {
                text.setValue(this._localFolder).onChange((value) => {
                    this._localFolder = value.trim().replace(/^\/+|\/+$/g, "");
                    this._folderEdited = true;
                });
                this._folderInput = text.inputEl;
            });

        this._status = contentEl.createEl("p", { cls: "expert-sync-setup-status" });
        new Setting(contentEl)
            .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
            .addButton((button) => button.setButtonText("Connect and sync").setCta().onClick(async () => {
                button.setDisabled(true);
                try {
                    await this._connect();
                } finally {
                    button.setDisabled(false);
                }
            }));
    }

    private _folderInput: HTMLInputElement | null = null;

    private _setRoot(path: string, title?: string): void {
        this._rootPath = path;
        if(!this._folderEdited && this._folderInput) {
            this._localFolder = title ?? (path.split("/").pop() ?? "").replace(/_/g, " ");
            this._folderInput.value = this._localFolder;
        }
    }

    private _client(): ExpertClient | null {
        const token = this._token || (this._plugin.settings.tokenSecret ? this.app.secretStorage.getSecret(this._plugin.settings.tokenSecret) : null);
        if(!this._siteUrl || !token) {
            this._say("Enter the site URL and a token first.", true);
            return null;
        }
        return new ExpertClient(this._siteUrl, token, obsidianHttp);
    }

    private async _findPages(setting: Setting): Promise<void> {
        const client = this._client();
        if(!client) {
            return;
        }
        try {
            this._say("Loading pages…");
            const pages = await client.childPages("home");
            if(!this._rootDropdown) {
                setting.addDropdown((dropdown) => {
                    this._rootDropdown = dropdown;
                });
            }
            const dropdown = this._rootDropdown!;
            dropdown.selectEl.empty();
            dropdown.addOption("", "(whole site)");
            for(const page of pages) {
                dropdown.addOption(page.path, page.title);
            }
            dropdown.setValue(this._rootPath).onChange((value) => {
                const title = pages.find((page) => page.path === value)?.title;
                this._setRoot(value, title);
                const input = setting.controlEl.querySelector("input");
                if(input) {
                    input.value = value;
                }
            });
            this._say(`${pages.length} top-level pages found.`);
        } catch(error) {
            this._say(`Couldn't load pages: ${error instanceof Error ? error.message : error}`, true);
        }
    }

    private async _connect(): Promise<void> {
        const client = this._client();
        if(!client) {
            return;
        }
        try {
            this._say("Checking the site…");
            const user = await client.currentUser();
            if(user.anonymous) {
                this._say("The token signs in as an anonymous user. Check the token.", true);
                return;
            }
            if(!(await client.markdownEnabled())) {
                this._say("Markdown is not enabled on this site. Ask an admin to turn on site/markdown-contents-enabled.", true);
                return;
            }
            const tree = await client.tree(this._rootPath.replace(/ /g, "_"));
            this._say(`Signed in as ${user.name}. "${tree[0].title || "Home"}" has ${tree.length - 1} pages. Syncing…`);
            await this._plugin.connect(this._siteUrl, this._token, this._rootPath.replace(/ /g, "_"), this._localFolder);
            this._plugin.lastReport = null;
            await this._plugin.sync();
            const report = this._plugin.lastReport as SyncReport | null;
            if(report && !report.errors.length) {
                this.close();
            } else {
                this._say(report ? `Sync finished with ${report.errors.length} errors. Run “Show last sync report”.` : "Sync failed; see the notice.", true);
            }
        } catch(error) {
            this._say(`Couldn't connect: ${error instanceof Error ? error.message : error}`, true);
        }
    }

    private _say(message: string, isError = false): void {
        this._status.setText(message);
        this._status.style.color = isError ? "var(--text-error)" : "";
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
