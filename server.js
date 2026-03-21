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

      // GET /api/observations
      if (req.method === "GET" && path === "/api/observations") {
        const project = url.searchParams.get("project");
        const from    = url.searchParams.get("from");
        const to      = url.searchParams.get("to");
        const offset  = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;
        const limit   = parseInt(url.searchParams.get("limit")  ?? "50", 10) || 50;

        const conditions = [];
        const params = {};
        if (project) { conditions.push("project = $project"); params.$project = project; }
        if (from)    { conditions.push("date(created_at) >= date($from)"); params.$from = from; }
        if (to)      { conditions.push("date(created_at) <= date($to)");   params.$to   = to;   }

        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const total = db.query(`SELECT COUNT(*) as n FROM observations ${where}`)
                        .get(params).n;

        const items = db.query(
          `SELECT id, project, type, title, subtitle, created_at, created_at_epoch
           FROM observations ${where}
           ORDER BY created_at_epoch DESC
           LIMIT $limit OFFSET $offset`
        ).all({ ...params, $limit: limit, $offset: offset });

        return json({ items, total, offset, limit, hasMore: offset + items.length < total });
      }

      // DELETE /api/observations/:id  (numeric IDs only)
      const singleDeleteMatch = path.match(/^\/api\/observations\/(\d+)$/);
      if (req.method === "DELETE" && singleDeleteMatch) {
        const id = parseInt(singleDeleteMatch[1], 10);
        const existing = db.query("SELECT id FROM observations WHERE id = $id").get({ $id: id });
        if (!existing) return json({ error: "Not found" }, 404);
        db.run("DELETE FROM observations WHERE id = $id", { $id: id });
        return json({ deleted: id });
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
