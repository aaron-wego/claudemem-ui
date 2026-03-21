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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createApp(db) {
  return {
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // GET /api/projects
      if (req.method === "GET" && path === "/api/projects") {
        const rows = db.query(
          `SELECT project, COUNT(*) as count FROM observations GROUP BY project ORDER BY count DESC`
        ).all();
        return json(rows);
      }

      // Serve index.html
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return new Response(Bun.file(import.meta.dir + "/index.html"));
      }

      return json({ error: "Not found" }, 404);
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
