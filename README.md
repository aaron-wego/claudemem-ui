# claudemem-ui

A local web UI for managing [claude-mem](https://github.com/thedotmack/claude-mem) observation data.

View, filter, and delete observations from your `~/.claude-mem/` database — things the built-in viewer at `:37777` doesn't support.

## Requirements

- [Bun](https://bun.sh) installed
- claude-mem running (database at `~/.claude-mem/claude-mem.db`)

## Start

```bash
bun server.js
```

Then open **http://localhost:37778** in your browser.

## Options

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `37778` | Port to listen on |
| `CLAUDE_MEM_DIR` | `~/.claude-mem` | Path to claude-mem data directory |

```bash
# Custom port
PORT=37779 bun server.js

# Custom DB location
CLAUDE_MEM_DIR=/path/to/data bun server.js
```

## Features

- **Filter** by project and date range (defaults to today)
- **Select all** loaded cards
- **Delete single** observation (trash icon with inline confirm)
- **Delete selected** observations (checkboxes + bulk delete modal)
- **Delete by date range** (creates a DB backup first)
- **Delete all project data** — shown when a project has no observations but still has session/summary data; wipes all related tables so the project disappears from the `:37777` viewer too

All delete operations cascade across `observations`, `session_summaries`, `sdk_sessions`, `user_prompts`, and `pending_messages`, keeping the `:37777` viewer in sync.

## Sharing with the team

Copy this folder to any machine with Bun installed and run `bun server.js`. No `npm install` needed — zero dependencies.

## Tests

```bash
bun test server.test.js
```
