import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "oracle-index-service-"));
const agentDir = join(root, "agent");
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(join(root, ".git"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldStateDir = process.env.PI_ORACLE_STATE_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ORACLE_STATE_DIR = join(root, "state");
const { runOracleIndex, OracleIndexError } = await import("../extensions/oracle/lib/oracle-index.ts");
const { writeConversationIndex } = await import("../extensions/oracle/shared/conversation-index.mjs");
const originalFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = originalFetch;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldStateDir === undefined) delete process.env.PI_ORACLE_STATE_DIR;
  else process.env.PI_ORACLE_STATE_DIR = oldStateDir;
  await rm(root, { recursive: true, force: true });
});

async function selectSource(port) {
  await writeFile(join(agentDir, "extensions", "oracle.json"), JSON.stringify({
    browser: { chatGptRelayEndpoint: `http://127.0.0.1:${port}` },
  }));
}

function snapshot() {
  return {
    schemaVersion: 1, userId: "user-a", accountId: "account-a", refreshedAt: "2026-09-28T22:25:04.000Z",
    conversations: [{ id: "chat-ears-tail", title: "Auri ears and tail", url: "https://chatgpt.com/c/chat-ears-tail",
      createdAt: "2026-09-28T22:25:04.000Z", updatedAt: null, archived: true, projectId: null }],
  };
}

test("local search needs no browser login and never reuses a different browser source's directory", async () => {
  globalThis.fetch = async () => { throw new Error("Local index operations must not access the network"); };
  await selectSource(49231);
  const first = await runOracleIndex(root, { action: "status" });
  assert.equal(first.refreshedAt, null);
  await assert.rejects(runOracleIndex(root, { action: "search", query: "Auri" }), OracleIndexError);
  await writeConversationIndex(first.indexPath, snapshot());
  const found = await runOracleIndex(root, { action: "search", query: "Auri tail" });
  assert.deepEqual(found.conversations.map(({ id, url, archived }) => ({ id, url, archived })), [
    { id: "chat-ears-tail", url: "https://chatgpt.com/c/chat-ears-tail", archived: true },
  ]);
  await selectSource(49232);
  const second = await runOracleIndex(root, { action: "status" });
  assert.notEqual(second.indexPath, first.indexPath);
  assert.equal(second.refreshedAt, null);
  await assert.rejects(runOracleIndex(root, { action: "search", query: "Auri" }), OracleIndexError);
  globalThis.fetch = originalFetch;
});

test("an unavailable browser cannot replace the last directory; corruption is not reported as an empty index", async () => {
  await selectSource(49233);
  const { indexPath } = await runOracleIndex(root, { action: "status" });
  await writeConversationIndex(indexPath, snapshot());
  const priorBytes = await readFile(indexPath);
  globalThis.fetch = async () => { throw new Error("Simulated disconnected browser"); };
  await assert.rejects(runOracleIndex(root, { action: "refresh" }), OracleIndexError);
  await assert.rejects(runOracleIndex(root, { action: "read", conversationId: "chat-ears-tail" }), OracleIndexError);
  assert.deepEqual(await readFile(indexPath), priorBytes);
  assert.equal((await runOracleIndex(root, { action: "search", query: "Auri" })).conversations[0].id, "chat-ears-tail");
  await writeFile(indexPath, "{invalid");
  await assert.rejects(runOracleIndex(root, { action: "status" }), OracleIndexError);
  globalThis.fetch = originalFetch;
});

test("selective reads reject missing, unindexed, ambiguous, and off-site references before browser access", async () => {
  await selectSource(49234);
  const { indexPath } = await runOracleIndex(root, { action: "status" });
  await writeConversationIndex(indexPath, snapshot());
  let networkAccessed = false;
  globalThis.fetch = async () => { networkAccessed = true; throw new Error("Rejected selections must not access the browser"); };
  for (const request of [
    { action: "read" },
    { action: "read", conversationId: "not-indexed" },
    { action: "read", conversationId: "chat-ears" },
    { action: "read", conversationId: "https://example.com/c/chat-ears-tail" },
    { action: "read", conversationId: "https://chatgpt.com/share/chat-ears-tail" },
    { action: "read", conversationId: "chat-ears-tail", offset: -1 },
    { action: "read", conversationId: "chat-ears-tail", maxChars: 100000 },
  ]) {
    await assert.rejects(runOracleIndex(root, request), OracleIndexError);
  }
  assert.equal(networkAccessed, false);
  globalThis.fetch = originalFetch;
});
