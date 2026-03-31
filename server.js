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

// ── Chroma sync helpers ──────────────────────────────────────────────────────

const CHROMA_COLLECTION = "cm__claude-mem";

async function runChromaPy(script) {
  const proc = Bun.spawn(
    ["uv", "run", "--no-project", "--with", "chromadb", "python3", "-c", script],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(stderr.trim().split("\n").pop() || `python exited ${code}`);
  }
  return JSON.parse(stdout);
}

function getValidIds(db) {
  const validObsIds    = new Set(db.query("SELECT id FROM observations").all().map(r => r.id));
  const validPromptIds = new Set(db.query("SELECT id FROM user_prompts").all().map(r => r.id));
  return { validObsIds, validPromptIds };
}

async function getAllChromaIds() {
  const chromaDir = join(process.env.HOME, ".claude-mem", "chroma");
  return runChromaPy(`
import json, sys
try:
    import chromadb
    c = chromadb.PersistentClient(path=${JSON.stringify(chromaDir)})
    col = c.get_collection(${JSON.stringify(CHROMA_COLLECTION)})
    print(json.dumps(col.get(include=[])["ids"]))
except Exception as e:
    if "does not exist" in str(e).lower():
        print("[]")
    else:
        print(str(e), file=sys.stderr); sys.exit(1)
`);
}

async function deleteChromaIds(ids) {
  if (ids.length === 0) return;
  const chromaDir = join(process.env.HOME, ".claude-mem", "chroma");
  return runChromaPy(`
import json, sys
try:
    import chromadb
    ids = ${JSON.stringify(ids)}
    c = chromadb.PersistentClient(path=${JSON.stringify(chromaDir)})
    col = c.get_collection(${JSON.stringify(CHROMA_COLLECTION)})
    for i in range(0, len(ids), 100):
        col.delete(ids=ids[i:i+100])
    print(json.dumps({"removed": len(ids)}))
except Exception as e:
    print(str(e), file=sys.stderr); sys.exit(1)
`);
}

function findStaleIds(allIds, validObsIds, validPromptIds) {
  const stale = [];
  for (const id of allIds) {
    const obs    = id.match(/^obs_(\d+)_/);
    const prompt = id.match(/^prompt_(\d+)$/);
    if (obs    && !validObsIds.has(parseInt(obs[1])))       stale.push(id);
    else if (prompt && !validPromptIds.has(parseInt(prompt[1]))) stale.push(id);
  }
  return stale;
}

// ── End Chroma helpers ────────────────────────────────────────────────────────

export function createApp(db, dbPath = null) {
  return {
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // GET /api/projects
      if (req.method === "GET" && path === "/api/projects") {
        const rows = db.query(
          `SELECT project, SUM(cnt) as count FROM (
             SELECT project, COUNT(*) as cnt FROM observations WHERE project IS NOT NULL AND project != '' GROUP BY project
             UNION ALL
             SELECT project, COUNT(*) as cnt FROM session_summaries WHERE project IS NOT NULL AND project != '' GROUP BY project
             UNION ALL
             SELECT project, COUNT(*) as cnt FROM sdk_sessions WHERE project IS NOT NULL AND project != '' GROUP BY project
           ) GROUP BY project ORDER BY count DESC`
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

      // DELETE /api/project — wipe all data for a project (no date range)
      if (req.method === "DELETE" && path === "/api/project") {
        const { project } = await req.json();
        if (!project) return json({ error: "project is required" }, 400);

        if (dbPath && existsSync(dbPath)) {
          const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
          copyFileSync(dbPath, `${dbPath}.bak.${ts}`);
        }

        db.run("PRAGMA foreign_keys = ON");
        db.run(
          `DELETE FROM user_prompts WHERE id IN (
            SELECT u.id FROM user_prompts u
            JOIN sdk_sessions s ON s.content_session_id = u.content_session_id
            WHERE s.project = $project)`,
          { $project: project }
        );
        db.run(
          `DELETE FROM pending_messages WHERE id IN (
            SELECT p.id FROM pending_messages p
            JOIN sdk_sessions s ON s.id = p.session_db_id
            WHERE s.project = $project)`,
          { $project: project }
        );
        const obsResult = db.run(`DELETE FROM observations WHERE project = $project`, { $project: project });
        db.run(`DELETE FROM session_summaries WHERE project = $project`, { $project: project });
        db.run(`DELETE FROM sdk_sessions WHERE project = $project`, { $project: project });
        return json({ deleted: obsResult.changes });
      }

      // DELETE /api/observations/range
      if (req.method === "DELETE" && path === "/api/observations/range") {
        const { project, from, to } = await req.json();
        if (!project || !from || !to) return json({ error: "project, from, and to are required" }, 400);

        if (dbPath && existsSync(dbPath)) {
          const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
          copyFileSync(dbPath, `${dbPath}.bak.${ts}`);
        }

        db.run("PRAGMA foreign_keys = ON");
        const obsResult = db.run(
          `DELETE FROM observations WHERE project = $project AND date(created_at) BETWEEN date($from) AND date($to)`,
          { $project: project, $from: from, $to: to }
        );
        db.run(
          `DELETE FROM session_summaries WHERE project = $project AND date(created_at) BETWEEN date($from) AND date($to)`,
          { $project: project, $from: from, $to: to }
        );
        // Delete sessions that now have no remaining observations or summaries.
        // FK cascades handle user_prompts and pending_messages automatically.
        db.run(
          `DELETE FROM sdk_sessions WHERE project = $project
           AND memory_session_id NOT IN (SELECT DISTINCT memory_session_id FROM observations WHERE project = $project)
           AND memory_session_id NOT IN (SELECT DISTINCT memory_session_id FROM session_summaries WHERE project = $project)`,
          { $project: project }
        );
        return json({ deleted: obsResult.changes });
      }

      // DELETE /api/observations/bulk
      if (req.method === "DELETE" && path === "/api/observations/bulk") {
        const { ids } = await req.json();
        if (!Array.isArray(ids) || ids.length === 0) return json({ error: "ids must be a non-empty array" }, 400);
        const placeholders = ids.map(() => "?").join(", ");
        db.run("PRAGMA foreign_keys = ON");
        const affected = db.query(`SELECT DISTINCT project FROM observations WHERE id IN (${placeholders})`).all(ids);
        const result = db.run(`DELETE FROM observations WHERE id IN (${placeholders})`, ids);
        for (const { project } of affected) {
          db.run(
            `DELETE FROM sdk_sessions WHERE project = ?
             AND memory_session_id NOT IN (SELECT DISTINCT memory_session_id FROM observations WHERE project = ?)
             AND memory_session_id NOT IN (SELECT DISTINCT memory_session_id FROM session_summaries WHERE project = ?)`,
            [project, project, project]
          );
        }
        return json({ deleted: result.changes });
      }

      // DELETE /api/observations/:id  (numeric IDs only)
      const singleDeleteMatch = path.match(/^\/api\/observations\/(\d+)$/);
      if (req.method === "DELETE" && singleDeleteMatch) {
        const id = parseInt(singleDeleteMatch[1], 10);
        const existing = db.query("SELECT id, project FROM observations WHERE id = $id").get({ $id: id });
        if (!existing) return json({ error: "Not found" }, 404);
        db.run("PRAGMA foreign_keys = ON");
        db.run("DELETE FROM observations WHERE id = $id", { $id: id });
        db.run(
          `DELETE FROM sdk_sessions WHERE project = ?
           AND memory_session_id NOT IN (SELECT DISTINCT memory_session_id FROM observations WHERE project = ?)
           AND memory_session_id NOT IN (SELECT DISTINCT memory_session_id FROM session_summaries WHERE project = ?)`,
          [existing.project, existing.project, existing.project]
        );
        return json({ deleted: id });
      }

      // GET /api/chroma/status — count stale embeddings (read-only)
      if (req.method === "GET" && path === "/api/chroma/status") {
        try {
          const { validObsIds, validPromptIds } = getValidIds(db);
          const allIds = await getAllChromaIds();
          const staleIds = findStaleIds(allIds, validObsIds, validPromptIds);
          return json({ total: allIds.length, stale: staleIds.length });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      // POST /api/chroma/sync — delete stale embeddings
      if (req.method === "POST" && path === "/api/chroma/sync") {
        try {
          const res = await fetch("http://localhost:37777/api/processing-status",
            { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            const status = await res.json();
            const active = status === true || status?.active === true
              || (typeof status?.count === "number" && status.count > 0)
              || (Array.isArray(status) && status.length > 0);
            if (active) return json({ error: "Active sessions in progress — try again shortly" }, 409);
          }
        } catch { /* worker unavailable, proceed */ }

        try {
          const { validObsIds, validPromptIds } = getValidIds(db);
          const allIds   = await getAllChromaIds();
          const staleIds = findStaleIds(allIds, validObsIds, validPromptIds);
          await deleteChromaIds(staleIds);
          return json({ removed: staleIds.length });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
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
  const dbPath = getDbPath();
  const db = new Database(dbPath, { readwrite: true });
  const port = parseInt(process.env.PORT ?? "37778", 10);
  const server = Bun.serve({ port, idleTimeout: 0, ...createApp(db, dbPath) });
  console.log(`claudemem-ui running at http://localhost:${server.port}`);
}
