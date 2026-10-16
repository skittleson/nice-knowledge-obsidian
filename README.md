# nice-knowledge-obsidian

**Expert Sync for Obsidian (experimental)**

Use a CXone Expert site as the backing store for an Obsidian vault. Each note is an
Expert page, attachments are page files, and frontmatter maps to page tags and article type.

Status: an experiment, desktop only. Tested against a CXone Expert test site with Obsidian 1.14.4.

## Requirements

- An Expert site with the **`site/markdown-contents-enabled`** config key turned on. The plugin
  sends `text/markdown` to the page content API and reads pages back with `format=markdown`.
- A JWT for your own user (sync runs with your permissions).
- Obsidian 1.11.4 or later (the token is kept in Obsidian's secret storage).

## Create a vault for a site

```sh
npm install
node scripts/create-vault.mjs --vault ~/Vaults/BoardGames --site https://your-site.example.com --root Board_Games --open
```

This makes a new vault with the plugin installed, enabled and pointed at the site (`--root` is the
page whose subpages become notes; `--folder` sets the vault folder, which defaults to the root's name).
When Obsidian opens it, the **Connect this vault to an Expert site** screen appears with the site
and root filled in. Paste your API token, click **Connect and sync**, and the pages and attachments
come down. The token goes into Obsidian's secret storage, not into the vault.

## Add it to an existing vault

```sh
npm run build
mkdir -p "<vault>/.obsidian/plugins/expert-sync"
cp main.js manifest.json "<vault>/.obsidian/plugins/expert-sync/"
```

Enable **Expert Sync (experimental)** under Settings → Community plugins. The Connect screen opens
on its own (or run the command **Connect this vault to an Expert site**). **Find pages** lists the
site's top-level pages to pick the root from. The same values live in the plugin settings:

| Setting | Example |
|---|---|
| Site URL | `https://your-site.example.com` |
| API token | your JWT (stored in secret storage, never in the vault) |
| Site root page | `Board_Games` (empty = whole site) |
| Vault folder | `Board Games` (empty = whole vault) |
| Sync every (minutes) | `0` (manual) |

After that, sync with the ribbon icon or **Sync now**.

## How it works

- **Pages ↔ notes.** The page `Root/A/B` is the note `<folder>/A/B.md`. Its child pages go in the
  folder next to it, `<folder>/A/B/`. A new folder you create becomes a parent page on the next sync.
- **Exact round-trip.** On push the plugin stores the whole note file in the page property
  `obsidian#source` and publishes a CommonMark version as the page body. Wiki links become site
  links, embeds become file links, `==highlights==` become `<mark>`, `%%comments%%` are dropped and
  callouts become a bold-title quote. A small `obsidian#sync` property records the revision the
  source was written at, so other devices get the note back byte for byte.
- **Pages edited on the site.** If a page has changed since the plugin last wrote it, or was never
  written by the plugin, the note is pulled from the server's markdown and flagged
  `expert-sync: site-edited`. Your edits to a flagged note are not pushed until you run
  **Accept this note as the source**, so the site author's work is never overwritten silently.
- **Pages with DekiScript** (`dynamic: true` in the server's front matter) are pulled as read-only
  snapshots (`expert-sync: dynamic`) and never pushed.
- **Conflicts.** If both sides changed, the site version is saved as `Note (expert conflict …).md`
  and your note is flagged `expert-sync: conflict` until you accept it. Pushes also send the last
  known edit time with `abort=modified`, so the server refuses a stale write.
- **Attachments.** Files embedded in a note, wherever they live in the vault, are uploaded to that
  note's page. Pulled files go to `<dir>/_attachments/<note>/`. Files in that folder are uploaded
  even if no note embeds them.
- **Frontmatter.** `tags` ↔ page tags, `article-type` ↔ the `article:*` tag (IDF sites; new pages get
  a type that fits their parent), `title` ↔ page title, `summary` → page overview.
- **Deletes are never automatic.** A note deleted here or a page deleted on the site is queued.
  **Review pending deletes** asks Keep or Delete for each item. A page that still has children on
  the site is never deleted.
- **Moves.** Renaming or moving a note moves the page (detected by identical content). Pages moved on
  the site are renamed locally.
- **Sync state** is per device, in Obsidian's local storage, not in the vault.

## Commands

Connect this vault to an Expert site · Sync now · Test connection · Show last sync report · Review pending deletes ·
Accept this note as the source · Reset sync state on this device

## Development

Local settings for the CLI, the live tests and `create-vault` go in a `.env` file, which git ignores:

```sh
cp .env.example .env    # then set EXPERT_SITE, EXPERT_ROOT and EXPERT_TOKEN (or EXPERT_TOKEN_FILE)
```

```sh
npm test                              # unit tests (transforms, paths, parsing, retries)
npm run typecheck
node test-e2e/e2e.ts                  # live test against EXPERT_SITE, two simulated devices; cleans up its pages
node src/node/cli.ts sync --vault ./some-folder
node test-e2e/obsidian-eval.mjs <cdp-port> '<js>'   # drive an Obsidian started with --remote-debugging-port
```

Never commit tokens. `.env`, `*.token`, sync state files, `.obsidian/` and plugin `data.json` are all
ignored. The plugin itself keeps the token in Obsidian's secret storage.

`src/core` is platform-free and holds the API client, transforms and sync engine. `src/obsidian`
holds the plugin and the vault adapter. `src/node` holds a filesystem adapter and CLI used by the
live tests.

## Known limits

- Only file changes are detected. Moving a note *and* editing it in the same sync looks like a
  delete plus a new note.
- Attachment names must be unique per page; two embeds with the same file name from different
  folders collide.
- The server's markdown output is lossy (HTML → markdown). This only matters for pages edited on
  the site, which come back flagged for review.
- A page's folder note is the note next to the folder (`A.md` beside `A/`), not a note inside it.
- Large trees: one `tree` call per sync, then one request per changed page. Throttled or
  briefly unavailable responses (429/502/503/504) are retried with backoff; there is no paging.
- The root page itself isn't synced; only its subpages are.

## What the experiment showed (test site, 2026-10-16)

Works well:
- `text/markdown` writes and `format=markdown` reads make Expert a workable backing store with no
  server changes. The server's front matter (`revision`, `tags`, `dynamic`) is enough to drive sync.
- `GET pages/{root}/tree?include=revision,properties` returns the whole subtree with revisions and
  small properties inline, so one request finds what changed.
- Page properties hold the exact note (240 KB tested) and don't bump the page revision, and neither
  do tag writes. Revision numbers are a reliable "edited on the site" signal.
- `edittime` + `abort=modified` gives a server-side guard against overwriting a newer edit.

Rough edges:
- Server markdown is lossy (HTML → markdown normalises tables, lists and spacing), so the exact copy
  has to live in a property.
- Absolute URLs come back for files (`…/files/{id}/{name}?revision=N`) and page links, and uploaded
  file names have spaces turned into `_` in their URLs.
- `pages/{id}/info` has no `date.modified`; the full `pages/{id}` response is needed for `edittime`.
- A move leaves a redirect behind, so moving back needs `allow=deleteredirects`.
- Deleting a page archives its child pages with it, and archived children can only be restored by
  restoring the parent.
- On IDF sites every page needs an article type that fits its parent, so new pages and folder pages
  get one picked from the parent's type.

## License

MIT, see [LICENSE](LICENSE).
