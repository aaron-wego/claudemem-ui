import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "./server.js";

const SCHEMA = `
  CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL DEFAULT 'test-session',
    project TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'discovery',
    title TEXT,
    subtitle TEXT,
    text TEXT,
    facts TEXT,
    narrative TEXT,
    concepts TEXT,
    files_read TEXT,
    files_modified TEXT,
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    content_hash TEXT
  );
`;

function makeDb() {
  const db = new Database(":memory:");
  db.run(SCHEMA);
  return db;
}

function seed(db, rows) {
  const stmt = db.prepare(
    `INSERT INTO observations (project, type, title, subtitle, created_at, created_at_epoch)
     VALUES ($project, $type, $title, $subtitle, $created_at, $created_at_epoch)`
  );
  for (const row of rows) stmt.run(row);
}

test("server stub loads", () => {
  expect(createApp).toBeDefined();
});

test("GET /api/observations returns paginated items with total", async () => {
  const db = makeDb();
  seed(db, [
    { $project: "proj-a", $type: "discovery", $title: "Alpha", $subtitle: "sub1", $created_at: "2026-03-20T00:00:00Z", $created_at_epoch: 1000 },
    { $project: "proj-a", $type: "feature",   $title: "Beta",  $subtitle: "sub2", $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 2000 },
    { $project: "proj-b", $type: "discovery", $title: "Gamma", $subtitle: null,   $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 3000 },
  ]);
  const app = createApp(db);
  const res = await app.fetch(new Request("http://localhost/api/observations"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.total).toBe(3);
  expect(body.items.length).toBe(3);
  expect(body.offset).toBe(0);
  expect(body.limit).toBe(50);
  expect(body.hasMore).toBe(false);
});

test("GET /api/observations filters by project", async () => {
  const db = makeDb();
  seed(db, [
    { $project: "proj-a", $type: "discovery", $title: "A1", $subtitle: null, $created_at: "2026-03-20T00:00:00Z", $created_at_epoch: 1000 },
    { $project: "proj-b", $type: "feature",   $title: "B1", $subtitle: null, $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 2000 },
  ]);
  const app = createApp(db);
  const res = await app.fetch(new Request("http://localhost/api/observations?project=proj-a"));
  const body = await res.json();
  expect(body.total).toBe(1);
  expect(body.items[0].title).toBe("A1");
});

test("GET /api/observations filters by date range", async () => {
  const db = makeDb();
  seed(db, [
    { $project: "p", $type: "discovery", $title: "Old",     $subtitle: null, $created_at: "2026-03-10T00:00:00Z", $created_at_epoch: 1000 },
    { $project: "p", $type: "discovery", $title: "InRange", $subtitle: null, $created_at: "2026-03-15T00:00:00Z", $created_at_epoch: 2000 },
    { $project: "p", $type: "discovery", $title: "New",     $subtitle: null, $created_at: "2026-03-20T00:00:00Z", $created_at_epoch: 3000 },
  ]);
  const app = createApp(db);
  const res = await app.fetch(new Request("http://localhost/api/observations?from=2026-03-14&to=2026-03-16"));
  const body = await res.json();
  expect(body.total).toBe(1);
  expect(body.items[0].title).toBe("InRange");
});

test("GET /api/observations respects limit and offset", async () => {
  const db = makeDb();
  seed(db, [
    { $project: "p", $type: "discovery", $title: "First",  $subtitle: null, $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 1000 },
    { $project: "p", $type: "discovery", $title: "Second", $subtitle: null, $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 2000 },
    { $project: "p", $type: "discovery", $title: "Third",  $subtitle: null, $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 3000 },
  ]);
  const app = createApp(db);
  const res = await app.fetch(new Request("http://localhost/api/observations?limit=2&offset=0"));
  const body = await res.json();
  expect(body.total).toBe(3);
  expect(body.items.length).toBe(2);
  expect(body.hasMore).toBe(true);
});

test("GET /api/projects returns projects with counts", async () => {
  const db = makeDb();
  seed(db, [
    { $project: "wego-fares", $type: "discovery", $title: "T1", $subtitle: null, $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 1000 },
    { $project: "wego-fares", $type: "feature",   $title: "T2", $subtitle: null, $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 1001 },
    { $project: "hyperloop",  $type: "discovery", $title: "T3", $subtitle: null, $created_at: "2026-03-21T00:00:00Z", $created_at_epoch: 1002 },
  ]);
  const app = createApp(db);
  const res = await app.fetch(new Request("http://localhost/api/projects"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual([
    { project: "wego-fares", count: 2 },
    { project: "hyperloop",  count: 1 },
  ]);
});
