# Upgrade Guide — Web Terminal + Knowledge Base Search

This guide brings an **older claude-chat-bridge instance** up to date with two feature sets
added across mid‑2026:

1. **Web Terminal (Sessions view)** — an in‑browser terminal (xterm.js + node‑pty over a
   WebSocket, backed by **tmux** for reboot/reconnect survival), with a session sidebar,
   lifecycle actions, diff panel, and a one‑click Claude launcher.
2. **Knowledge Base search** — full‑text (brute‑force scan) **and** semantic search
   (on‑device embeddings) over your Obsidian vaults.

It is written so a Claude assistant can execute it top‑to‑bottom with verification gates.
Run the steps in order; **do not skip the prerequisite checks** — most failures trace back
to a missing `tmux`, a hardcoded path mismatch, or `npm install --ignore-scripts`.

---

## 0. Which repo holds which feature (read this first)

These features span three repos, but they are **not** evenly split. Know what each one
contributes so you only do the work that applies:

| Repo | What it provides | Required for… |
|------|------------------|---------------|
| **claude-chat-bridge** | The Web Terminal **and** the KB search UI (both Text + Sem scopes). This is the app you run. | Everything. **Always upgrade this.** |
| **obsidian-mcp-server** | The embedding cache (`.embedding-cache/embeddings.json`) that the bridge's **Sem** scope reads. Also the `search_vault` MCP tool. | **Semantic** KB search returning results. Text scope works without it. |
| **obsidian-claude-plugin** | Vault skills (`/vault:work`, etc.) loaded into terminal Claude sessions via `--plugin-dir`. | Vault skills *inside* terminal Claude sessions. The terminal itself works without it. |

> **Heads‑up on "unpushed commits":** the semantic‑search engine in `obsidian-mcp-server`
> is **already on its `origin/main`** — it is not an unpushed change. The unpushed commits
> in `obsidian-mcp-server` (memory/close hardening) and `obsidian-claude-plugin` (skill
> slimming, model pinning) are useful but **tangential to these two features**. The actual
> terminal + KB‑UI work all lives in **claude-chat-bridge** (~25 commits). For an old
> instance, "get current" means a plain `git pull` per repo — you do not need to wait on any
> single commit.

---

## 1. System prerequisites

Verify each before touching the repos. Commands assume **macOS on Apple Silicon** (see the
Intel caveat in §6 if `which tmux` returns `/usr/local/bin/tmux`).

```bash
# Node ≥ 20 (reference instance runs v26). node-pty ships N-API prebuilds, so any 20+ works.
node --version

# tmux — REQUIRED for the terminal. The bridge calls tmux by an ABSOLUTE hardcoded path.
which tmux && tmux -V          # must print /opt/homebrew/bin/tmux  (Apple Silicon)
# If missing:  brew install tmux

# claude CLI — must be on the LOGIN shell's PATH (terminal launches `zsh -lc … claude …`).
which claude                   # e.g. ~/.local/bin/claude

# Used by the plugin's hooks/monitors (only if you install the plugin in §4):
which gh jq                    # brew install gh jq   if missing
```

**Gate:** Do not proceed until `tmux` resolves to `/opt/homebrew/bin/tmux` (or you've applied
the Intel fix in §6) and `node --version` is ≥ 20.

---

## 2. Upgrade claude-chat-bridge  *(required — this is the core)*

```bash
cd ~/Projects/claude-chat-bridge      # adjust if your checkout lives elsewhere

# 1. Get current. (Stash local changes first if `git status` is dirty.)
git fetch origin
git status                            # confirm clean / nothing you want to keep
git pull --ff-only origin main

# 2. Install deps. DO NOT pass --ignore-scripts (see why below).
npm install

# 3. Build the TypeScript.
npm run build                         # → dist/

# 4. Restart the bridge (pick the line that matches how you run it):
#    a) launchd-managed (recommended; survives reboot):
#       launchctl kickstart -k "gui/$(id -u)/com.$(whoami).claude-chat-bridge"
#    b) foreground:
#       npm start          # HTTPS (default) — needed for wss:// terminal sockets
```

### New dependencies this pulls in
`npm install` adds these to `package.json` (nothing is removed or version‑bumped on existing
deps):

| Package | Version | Purpose |
|---------|---------|---------|
| `node-pty` | `^1.1.0` | PTY backend for the web terminal |
| `ws` | `^8.21.0` | WebSocket server the terminal attaches to |
| `@types/ws` | `^8.18.1` | (types; authored into `dependencies`) |
| `@xenova/transformers` | `^2.17.2` | On‑device embeddings for the KB **Sem** scope |

`xterm.js` and its addons load from a CDN in `public/index.html` (not npm), so the browser
just needs internet access — no extra install step.

### Why `--ignore-scripts` breaks the terminal
`package.json` defines a `postinstall` that makes node‑pty's macOS spawn‑helper executable:

```
"postinstall": "chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true"
```

If install ran with `--ignore-scripts`, the terminal fails at `posix_spawnp`. Fix after the
fact with either:

```bash
chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper
# or
npm rebuild node-pty
```

### No new env vars, no migrations
- The terminal/KB commits introduce **no required env vars**.
- Two runtime data files self‑initialize in the repo root (both gitignored — nothing to
  provision): `terminal-sessions.json` (tmux snapshot for reboot survival; a `.bak` sibling
  is normal) and `usage-ledger.jsonl` (billing/usage log).
- Existing `chat-sessions.json`, `bridge-config.json`, `push-subscriptions.json`, and
  `certs/` carry forward unchanged.
- The bridge still requires a resolvable `mcpConfigPath` at startup (it throws otherwise) —
  if your instance already boots, you already have this.

### Verify the bridge upgrade
1. Hard‑refresh the browser (**Cmd+Shift+R**).
2. The view switcher should show **Sessions** (the terminal view) and **Metered Sessions**.
3. Open **Sessions → + New Terminal** → a live xterm should appear. Type `echo ok` — you
   should see `ok`. (Confirms node‑pty + tmux + spawn‑helper.)
4. **Knowledge Base** view → search a term → toggle the **Text** chip (always works) and the
   **Sem** chip (works after §3; otherwise returns nothing — that's expected, not a bug).

---

## 3. Upgrade obsidian-mcp-server  *(needed for semantic KB results)*

The bridge's **Sem** scope is a **read‑only consumer** of the *document* embedding cache that
this server writes per vault. (The bridge still embeds *your search query* itself at query
time via its own `@xenova/transformers` — same package/model as here — then cosine‑compares
it against these cached document vectors. So both repos depend on `@xenova/transformers`: the
mcp‑server to build the cache, the bridge to embed queries against it.) Without this server,
semantic search silently returns nothing for that vault (Text scope is unaffected). Skip this
section if you only need full‑text search.

```bash
cd ~/Projects/obsidian-mcp-server     # the bridge & plugin expect it at this path
git fetch origin
git pull --ff-only origin main
npm install                           # pulls @xenova/transformers ^2.17.2 (pure JS/WASM)
npm run build                         # → dist/  (a postbuild stamps a build id)
```

Then **restart Claude Code** (or whatever registers this MCP server) so the new `dist/` is
loaded. The server is registered in your Claude config's `mcpServers` block pointing at
`…/obsidian-mcp-server/dist/index.js`.

### Semantic‑search facts that matter for setup
- **Engine:** local `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` (transformers.js).
  Runs entirely on‑device as WASM/ONNX — **no API key, no native compilation, no
  `node-gyp`.** (The "better_sqlite3 / Node rebuild" issue you may have seen is a *different*
  MCP server; it does not apply here.)
- **First‑query model download:** ~25 MB (quantized ONNX) fetched once from the HuggingFace
  CDN on the first semantic search (~3–30 s). **Needs network access that first time.**
- **Per‑vault caches** (auto‑created at the vault root; safe to `rm -rf` to force a rebuild):
  - `.embedding-cache/embeddings.json` — cached vectors (this is what the bridge reads)
  - `.search-index/` — BM25 full‑text index
  - `.embedding-toggle.json` — persisted enable/disable state
- **Optional env toggles** (all default ON): `ENABLE_EMBEDDINGS=false` disables semantic
  reranking; keyword search still works. (`ENABLE_SMART_SEARCH`, `EMBEDDING_PRECOMPUTE`,
  `EMBEDDING_CONFIDENCE_THRESHOLD=0.75`, `EMBEDDING_CANDIDATES_LIMIT=100` also exist.)

> **For the bridge to show Sem results:** the embedding cache must already exist for each
> vault. Run at least one `search_vault` through the MCP server against each vault first
> (e.g. ask Claude to search your vault), which generates `.embedding-cache/embeddings.json`.
> The bridge will then read those vectors.

---

## 4. (Optional) obsidian-claude-plugin — vault skills inside terminal Claude

Only needed if you want vault slash‑commands (`/vault:work`, etc.) and the vault MCP **inside
the terminal's Claude sessions**. The terminal works without it.

```bash
cd ~/Projects/obsidian-claude-plugin
git fetch origin
git pull --ff-only origin main
```

### How the terminal picks it up
The terminal's Claude launcher **hardcodes** the path (see `public/app.js`):

```
claude --dangerously-skip-permissions --plugin-dir "$HOME/Projects/obsidian-claude-plugin" …
```

So for the terminal to load the plugin, the repo **must live at
`$HOME/Projects/obsidian-claude-plugin`**. If yours is elsewhere, symlink it there or edit
that launch line. (The *metered chat* runner uses the configurable `pluginDir` setting in
Settings → it defaults to the same path.)

### Registering it for your *own* interactive Claude Code (not the bridge)
The plugin ships a `.claude-plugin/plugin.json` but **no `marketplace.json`**, so it cannot be
`/plugin install`‑ed directly — a bare plugin dir must be wrapped in a marketplace. Two
options:

- **Simplest (settings.json):** add to `~/.claude/settings.json`:
  ```json
  {
    "enabledPlugins": { "vault@vault-marketplace": true },
    "extraKnownMarketplaces": {
      "vault-marketplace": { "source": "/absolute/path/to/vault-marketplace" }
    }
  }
  ```
- **Or CLI** after creating a one‑plugin marketplace wrapper:
  ```bash
  # wrapper/.claude-plugin/marketplace.json lists { name:"vault", source:"./obsidian-claude-plugin" }
  /plugin marketplace add /absolute/path/to/wrapper
  /plugin install vault@vault-marketplace
  /plugin list --enabled        # verify
  ```

### ⚠️ This plugin is tuned to the original author's environment
It is the least portable of the three. Before relying on it, adapt:
- **Hard dependency:** `.mcp.json` points at `$HOME/Projects/obsidian-mcp-server/dist/index.js`
  — that sibling repo must be built at that exact path (§3).
- **MCP config:** scripts read the vault path from `$MCP_CONFIG_PATH`, then
  `~/.obsidian-mcp.json`, then `~/.config/.obsidian-mcp.json` — one must exist with a
  `primaryVaults[]` array keyed by `mode` (`work`/`personal`).
- **git‑commit watcher:** `bin/git-commit-watch.list` is gitignored; create your own (the
  committed `.example` lists the author's repos) or set `$GIT_COMMIT_WATCH_REPOS`.
- **bridge‑restart watcher:** `bin/bridge-restart-watch.sh` targets a launchd service
  `com.$USER.claude-chat-bridge` and `https://localhost:${CHAT_BRIDGE_PORT:-3456}/api/health`
  — harmless if those differ, but it won't do anything useful until pointed at your setup.
- **macOS‑only:** hooks/scripts use `launchctl` and BSD `date -j -f`.

---

## 5. End‑to‑end verification checklist

- [ ] `tmux -V` resolves to `/opt/homebrew/bin/tmux` (or Intel fix applied).
- [ ] Bridge rebuilt (`npm run build`) and restarted; browser hard‑refreshed.
- [ ] **Sessions** view opens a live terminal; `echo ok` echoes; a `▶ Start` launches Claude.
- [ ] Terminal survives a bridge restart (session reattaches, not a fresh shell).
- [ ] KB **Text** search returns results.
- [ ] KB **Sem** search returns results *after* the MCP server has searched each vault once.
- [ ] (If plugin installed) inside a terminal Claude session, `/vault:work` is available.

---

## 6. Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| Terminal won't open; `posix_spawnp` / spawn‑helper error | `npm install` ran with `--ignore-scripts`. Run `npm rebuild node-pty` or `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`. |
| Terminal won't open; `tmux` not found | tmux missing, or on **Intel Mac** it's at `/usr/local/bin/tmux` while the code hardcodes `/opt/homebrew/bin/tmux`. Fix: `sudo ln -s /usr/local/bin/tmux /opt/homebrew/bin/tmux`, or edit the `TMUX` constant in `src/services/terminal.ts` **and** `src/services/terminal-snapshot.ts`, then rebuild. |
| Terminal Claude says "command not found: claude" | `claude` isn't on the **login** shell's PATH (terminal uses `zsh -lc`). Ensure it's in `~/.zprofile`/`~/.zshrc` PATH (e.g. `~/.local/bin`). |
| Terminal opens but `/vault:*` skills missing | Plugin not at `$HOME/Projects/obsidian-claude-plugin` (the launch line hardcodes it). Symlink or edit `public/app.js`. |
| KB **Sem** returns nothing | The vault has no `.embedding-cache/embeddings.json` yet. Run a `search_vault` through the MCP server against that vault first (§3). Confirm the bridge can read the cache path. |
| KB **Sem** crashes after a rebuild | `@xenova/transformers` is ESM‑only; the bridge loads it via dynamic `import()`. If you rebuilt with a TS config that down‑levels `import()` to `require()`, it breaks. Build with the repo's own `tsconfig` (don't change module/target). |
| First semantic search hangs ~30 s then works | One‑time model download (~25 MB). Needs network. Subsequent searches are fast. |
| `wss://` terminal socket won't connect from a non‑localhost client | The bridge must run over **HTTPS** (default `npm start`) so the socket upgrades to `wss://`. Confirm `certs/` exists and HTTPS is up. |
