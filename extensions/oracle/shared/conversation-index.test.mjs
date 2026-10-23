import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectConversationIndex, readConversationIndex, searchConversationIndex, writeConversationIndex } from "./conversation-index.mjs";

const instant = "2025-02-03T04:05:06.000Z";
const item = (id, extra = {}) => ({ id, title: id, create_time: Date.parse(instant) / 1000, ...extra });

async function tempDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), "oracle-conversation-index-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("collects active and archived pages through short pages despite total; normalizes, deduplicates, and preserves project metadata", async () => {
  const calls = [];
  const pages = new Map();
  const activeItems = Array.from({ length: 100 }, (_, n) => item(`active-${n}`));
  activeItems[4] = item("shared", { title: "active", update_time: Date.parse(instant) / 1000, gizmo_id: "project-a", snippet: "private chat text", mapping: { message: "transcript" }, accessToken: "secret" });
  pages.set("false:0", { items: activeItems, total: 1 });
  pages.set("false:100", { items: [item("active-end")], total: 1 });
  pages.set("true:0", { items: [item("shared", { title: "archived copy", update_time: Date.parse(instant) / 1000 + 100, project_id: "project-b" }), item("archived", { is_archived: true })], total: 0 });
  const snapshot = await collectConversationIndex({
    userId: "user-1", accountId: "account-1",
    fetchPage: async (page) => { calls.push(page); return pages.get(`${page.isArchived}:${page.offset}`) ?? { items: [] }; },
  });
  assert.deepEqual(calls, [
    { offset: 0, limit: 100, isArchived: false },
    { offset: 100, limit: 100, isArchived: false },
    { offset: 0, limit: 100, isArchived: true },
  ]);
  assert.deepEqual(snapshot.conversations.find((entry) => entry.id === "shared"), {
    id: "shared", title: "archived copy", url: "https://chatgpt.com/c/shared",
    createdAt: instant, updatedAt: "2025-02-03T04:06:46.000Z", archived: true, projectId: "project-b",
  });
  assert.equal(snapshot.conversations.find((entry) => entry.id === "archived").archived, true);
  assert.equal(snapshot.userId, "user-1");
  assert.equal(snapshot.accountId, "account-1");
});

test("rejects malformed pages, invalid IDs, and pages with no unseen progress", async () => {
  await assert.rejects(collectConversationIndex({ userId: "u", accountId: null, fetchPage: async () => [] }), /Invalid conversation index page/);
  await assert.rejects(collectConversationIndex({ userId: "u", accountId: null, fetchPage: async () => ({ items: [{ id: "bad/id" }] }) }), /Invalid conversation index conversation ID/);
  await assert.rejects(collectConversationIndex({ userId: "u", accountId: null, fetchPage: async () => ({ items: Array(100).fill(item("same")) }) }), /did not progress/);
});

test("cancels promptly while a page request is pending and returns no partial snapshot", async () => {
  const controller = new AbortController();
  const result = collectConversationIndex({ userId: "u", accountId: null, signal: controller.signal, fetchPage: () => new Promise(() => {}) });
  controller.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
});

test("publishes atomically with private directory and file permissions", async (t) => {
  const root = await tempDirectory(t);
  const path = join(root, "private", "index.json");
  const snapshot = await collectConversationIndex({ userId: "u", accountId: null, fetchPage: async () => ({ items: [item("one")] }) });
  await writeConversationIndex(path, snapshot);
  assert.deepEqual(await readConversationIndex(path), snapshot);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(join(root, "private")), ["index.json"]);
});

test("failed replacement preserves prior bytes and failed rename cleans its owned temporary file", async (t) => {
  const root = await tempDirectory(t);
  const target = join(root, "index.json");
  const old = await collectConversationIndex({ userId: "u", accountId: null, fetchPage: async () => ({ items: [item("old")] }) });
  await writeConversationIndex(target, old);
  const priorBytes = await readFile(target);
  await assert.rejects(writeConversationIndex(target, { ...old, schemaVersion: 2 }));
  assert.deepEqual(await readFile(target), priorBytes);
  const blockedTarget = join(root, "directory-target");
  await mkdir(blockedTarget);
  await assert.rejects(writeConversationIndex(blockedTarget, old));
  assert.deepEqual(await readdir(root), ["directory-target", "index.json"]);
});

test("missing snapshots are absent; malformed JSON and unsupported schemas are errors", async (t) => {
  const root = await tempDirectory(t);
  assert.equal(await readConversationIndex(join(root, "missing.json")), undefined);
  const corrupt = join(root, "corrupt.json");
  await writeFile(corrupt, "{");
  await assert.rejects(readConversationIndex(corrupt), SyntaxError);
  const wrongSchema = join(root, "schema.json");
  await writeFile(wrongSchema, JSON.stringify({ schemaVersion: 2 }));
  await assert.rejects(readConversationIndex(wrongSchema), /schema version/);
});

test("search uses case-insensitive AND words over title, ID, and project; orders newest first and caps results", async () => {
  const conversations = Array.from({ length: 205 }, (_, n) => ({
    id: `id-${String(n).padStart(3, "0")}`, title: n === 0 ? "Café Report" : "Café archive report",
    url: `https://chatgpt.com/c/id-${String(n).padStart(3, "0")}`, createdAt: instant,
    updatedAt: new Date(Date.parse(instant) + n * 1000).toISOString(), archived: false, projectId: n === 0 ? "project-X" : null,
  }));
  const snapshot = { schemaVersion: 1, userId: "u", accountId: null, refreshedAt: instant, conversations };
  const found = searchConversationIndex(snapshot, { query: "CAFÉ RePoRt", limit: 500 });
  assert.equal(found.total, 205);
  assert.equal(found.conversations.length, 200);
  assert.equal(found.conversations[0].id, "id-204");
  assert.equal(searchConversationIndex(snapshot, { query: "ID-00", limit: 10 }).total, 10);
  assert.equal(searchConversationIndex(snapshot, { query: "CAFÉ missing" }).total, 0);
  assert.equal(searchConversationIndex(snapshot, { query: "PROJECT-X" }).conversations[0].id, "id-000");
  assert.equal(searchConversationIndex(snapshot).conversations.length, 20);
  assert.throws(() => searchConversationIndex(snapshot, { limit: 0 }), /positive integer/);
});
