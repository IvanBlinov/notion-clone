# notion-clone

A Notion-style workspace with an **MCP server for AI agents**. The front end is a static site hosted on **GitHub Pages**; data, logins, live updates and the MCP endpoint run on **[Convex](https://convex.dev)**.

- Nested pages that also show up as blocks inside their parent, a block editor with a `/` menu, Markdown shortcuts, drag & drop, search, favorites and a Trash
- Accounts, multiple workspaces, **invite links**, members, live co-editing and "who's here" avatars
- An MCP endpoint (`https://<deployment>.convex.site/mcp`) so agents can list, read, create, edit, move and trash pages with personal agent tokens

## How it fits together

```
GitHub Pages (dist/)  ──websocket──▶  Convex: queries / mutations (convex/*.js)
   index.html, app.js                    tables: users, sessions, workspaces, members,
                                                 invites, agentTokens, pages, presence
AI agent ──HTTP──▶ https://<deployment>.convex.site/mcp  (convex/http.js)
```

The page logic (sub-pages as page blocks, moves, trash, save conflicts) lives in `src/shared/model.js` and runs inside Convex transactions. Every page is one row, and its content is a list of blocks.

## Deploy (GitHub Pages + Convex)

One-time setup:

1. **Convex project:** run `npx convex login`, then `npx convex dev` once and choose "create a new project". This creates your dev deployment and writes `.env.local`.
2. **Deploy key:** in the Convex dashboard → your project → *Settings* → *Deploy keys*, generate a **production** deploy key.
3. **GitHub secret:** in the repo → *Settings* → *Secrets and variables* → *Actions*, add `CONVEX_DEPLOY_KEY` with that key. Or from the terminal: `gh secret set CONVEX_DEPLOY_KEY`.
4. **GitHub Pages:** in the repo → *Settings* → *Pages* → *Source: GitHub Actions*.

From then on, every push to `main` runs `.github/workflows/deploy.yml`. It deploys the Convex functions to production, builds `dist/` against that deployment, and publishes it to `https://<user>.github.io/notion-clone/`.

The first person to sign up on the site owns the imported workspace, if there is one. After that, sign-up is invite-only (set `OPEN_SIGNUP=true` in the Convex dashboard's environment variables to allow anyone).

### Import data from the old local server

```bash
npx convex run --prod workspaces:importWorkspace ...   # done for you by:
node scripts/import-data.js --prod
```

This reads `data/` (v1 or v2 format) and creates ownerless workspaces. The first account to sign up claims them. If you already signed up, claim them with `npx convex run --prod workspaces:claimImported '{"email":"you@example.com"}'`.

## Local development

```bash
npm install
npx convex dev        # terminal 1: runs your dev deployment and pushes convex/ on save
npm run dev           # terminal 2: builds dist/ and serves it at http://localhost:3456
npm test              # end-to-end test (wipes the DEV deployment; needs: npx convex env set ALLOW_TEST_RESET true)
```

No Convex account yet? `CONVEX_AGENT_MODE=anonymous npx convex dev` runs a local backend.

## Collaboration

Use the workspace menu (top-left) → **Settings & members**, or **Invite members** in the sidebar:

- **Invite people:** create a link, optionally tied to one email address. It works once and expires in 7 days. The person signs up (or logs in) from the link and joins your workspace. Create links from the deployed site, so they point to it.
- **Members:** the owner removes people, and members can leave.
- **Live editing:** changes stream to everyone through Convex subscriptions. Concurrent edits are merged per block: two people typing in *different* blocks never clash, and the same block is last-write-wins.

## Connect an agent (MCP)

Open **Settings & members → AI agent → Create token**. The dialog shows ready-to-paste configs, e.g. for Claude Code:

```bash
claude mcp add --scope user --transport http notion-clone https://<deployment>.convex.site/mcp --header "Authorization: Bearer nca_…"
```

**ChatGPT, claude.ai and other apps that use OAuth:** add a custom connector with the URL `https://<deployment>.convex.site/mcp` and OAuth authentication (no client ID or secret needed: the app registers itself). The app opens this site, you log in, pick a workspace and click **Allow**. The app then shows up under **Settings & members → AI agent** as "<app> (connected)", where you can revoke it. OAuth needs the Convex environment variable `WEB_URL` (the site's address); the deploy workflow sets it.

For stdio-only clients (Claude Desktop) run the bridge from a checkout of this repo: `node src/mcp-stdio.js` with `NOTION_URL=https://<deployment>.convex.site` and `NOTION_TOKEN=nca_…`.

| Tool | What it does |
|---|---|
| `get_context` | The user, workspace, members (ids / emails for assigning) and permissions |
| `list_pages` / `search_pages` | Page tree (optionally below a page, limited depth) / full-text search scoped to a page or kind |
| `get_page` | Read as Markdown or blocks with ids; includes url, version and, for database items, their properties |
| `create_page` / `create_pages` | One page, or up to 100 in one call (build a whole tree with `key` / `parent_key`) |
| `convert_block_to_page` | Turn a block (e.g. a list item) into a sub-page |
| `update_page` | Rename, change the icon, move (`parent_id` / `"root"`), reorder (`index`) |
| `replace_page_content` / `append_content` | Write Markdown; `expected_version` refuses to overwrite newer edits |
| `update_block` / `delete_blocks` / `move_block` | Precise block edits (deleting a sub-page block trashes that page) |
| `archive_page` / `restore_page` | Trash and restore. Agents can't delete pages permanently |
| `create_database` / `get_database` / `update_database` | Databases with typed properties: text, number, checkbox, select / status, multi-select, date, person, URL, email |
| `create_database_items` | Up to 300 items per call, with `idempotency_key` so retries never duplicate; per-item results |
| `query_database` | Filters (AND / OR, `me`, relative dates like `+7d`), sorts, text search, pagination, saved views |
| `update_database_items` / `archive_database_items` | Bulk changes, reported per item |
| `save_database_view` | Saved table and board (Kanban) views with filters, sorts, grouping and visible columns |
| `create_linked_database_view` / `update_linked_database_view` | Show a database inside any page as a live, filtered table or board (e.g. each stage page shows only its tasks); same records, no copies |

Every result is structured JSON (`structuredContent`) with ids and a `url` that opens the page in the app.

In the app, type `/database` to add one, or `/linked` to show an existing database inside the current page (it starts with Status, Assignee and Due, and a board). Click a view tab for its options, a column header to rename, retype, sort or hide it, and **Filter** / **Sort** to change the view for everyone.

## Editor shortcuts

`/` block menu (`/page` creates a sub-page in place) · ⋮⋮ menu → **Turn into → Page** · `# ` `## ` `### ` `- ` `1. ` `[] ` `> ` ```` ``` ```` `---` · `Ctrl+B/I/E` · `Ctrl+Shift+S` strikethrough · `Ctrl+K` search or link · `Ctrl+D` duplicate · `Tab`/`Shift+Tab` indent · drag ⋮⋮ to reorder, or drop a page block on a sidebar page to move it.

## Layout

- `convex/`: backend: `schema.js`, `auth.js` + `authNode.js` (scrypt passwords, session tokens), `workspaces.js` (members, invites, agent tokens), `pages.js`, `presence.js`, `agent.js` + `http.js` (MCP endpoint), `crons.js`
- `src/shared/model.js`: page model (sub-page blocks, moves, trash, conflicts) · `src/shared/markdown.js`: Markdown ⇄ blocks
- `src/tools.js`: MCP tool definitions · `src/mcp-stdio.js`: stdio bridge
- `public/`: the UI (plain JS, no framework) · `scripts/build-web.js`: builds `dist/` · `scripts/serve.js`: local static server
- `test/smoke.js`: end-to-end test
