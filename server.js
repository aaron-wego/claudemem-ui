// claudemem-ui — Bun server
// Usage: bun server.js
// PORT env var overrides default 37778
// CLAUDE_MEM_DIR env var overrides default ~/.claude-mem
import { Database } from "bun:sqlite";
import { existsSync, copyFileSync } from "fs";
import { join } from "path";

export function getDbPath() {
  const dir = process.env.CLAUDE_MEM_DIR ?? join(process.env.HOME, ".claude-mem");
  const primary = join(dir, "claude-mem.db");
  const fallback = join(dir, "db.sqlite");
  if (existsSync(primary)) return primary;
  if (existsSync(fallback)) return fallback;
  throw new Error(`No DB found in ${dir}. Set CLAUDE_MEM_DIR to override.`);
}

export function createApp(db) {
  return {
    async fetch(req) {
      return new Response("Not implemented", { status: 501 });
    },
  };
}

// Entry point — only runs when executed directly, not when imported by tests
if (import.meta.main) {
  const db = new Database(getDbPath(), { readonly: false });
  const port = parseInt(process.env.PORT ?? "37778");
  const server = Bun.serve({ port, ...createApp(db) });
  console.log(`claudemem-ui running at http://localhost:${server.port}`);
}
