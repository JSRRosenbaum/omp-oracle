// Purpose: Collect, persist, and search listed ChatGPT conversation metadata without retaining chat content.
// Scope: Read-only pagination is supplied by the caller; browser access and account selection live outside this module.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** @typedef {import("./conversation-index.mjs").ConversationIndexEntry} ConversationIndexEntry */
/** @typedef {import("./conversation-index.mjs").ConversationIndexSnapshot} ConversationIndexSnapshot */

const PAGE_SIZE = 100;
const ID = /^[A-Za-z0-9_-]+$/;

/** @param {unknown} value */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} field */
function identifier(value, field) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid conversation index ${field}`);
  return value;
}

/** @param {unknown} value @param {string} field @returns {string | null} */
function timestamp(value, field) {
  if (value === undefined || value === null) return null;
  let input = value;
  if (typeof input === "string" && /^-?\d+(?:\.\d+)?$/.test(input)) input = Number(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Invalid conversation index ${field}`);
    input = Math.abs(input) < 100_000_000_000 ? input * 1000 : input;
  } else if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(input)) {
    throw new Error(`Invalid conversation index ${field}`);
  }
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid conversation index ${field}`);
  return date.toISOString();
}

/** @param {unknown} value @param {boolean} isArchived @returns {ConversationIndexEntry} */
function normalizeEntry(value, isArchived) {
  if (!object(value)) throw new Error("Invalid conversation index item");
  const id = identifier(value.id, "conversation ID");
  if (value.title != null && typeof value.title !== "string") throw new Error("Invalid conversation index title");
  if (value.is_archived != null && typeof value.is_archived !== "boolean") throw new Error("Invalid conversation index archived flag");
  const projectId = value.project_id ?? value.gizmo_id ?? null;
  return {
    id,
    title: value.title ?? "",
    url: `https://chatgpt.com/c/${id}`,
    createdAt: timestamp(value.create_time, "creation timestamp"),
    updatedAt: timestamp(value.update_time, "update timestamp"),
    archived: isArchived || value.is_archived === true,
    projectId: projectId === null ? null : identifier(projectId, "project ID"),
  };
}

/** @param {AbortSignal | undefined} signal */
function checkAbort(signal) {
  signal?.throwIfAborted();
}

/** Reject promptly even when the supplied fetcher does not observe the caller's signal.
 * @template T
 * @param {() => Promise<T>} fetch
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
async function fetchWithAbort(fetch, signal) {
  checkAbort(signal);
  if (!signal) return fetch();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { checkAbort(signal); return fetch(); }), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Enumerate listed active and archived metadata. Totals are advisory and never control pagination.
 * @param {{fetchPage: (page: {offset: number, limit: number, isArchived: boolean}) => Promise<unknown>, userId: string, accountId: string | null, signal?: AbortSignal}} options
 * @returns {Promise<ConversationIndexSnapshot>}
 */
export async function collectConversationIndex({ fetchPage, userId, accountId, signal }) {
  identifier(userId, "user ID");
  if (accountId !== null) identifier(accountId, "account ID");
  /** @type {Map<string, ConversationIndexEntry>} */
  const entries = new Map();
  for (const isArchived of [false, true]) {
    const seen = new Set();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await fetchWithAbort(() => fetchPage({ offset, limit: PAGE_SIZE, isArchived }), signal);
      checkAbort(signal);
      if (!object(page) || !Array.isArray(page.items) || page.items.length > PAGE_SIZE) {
        throw new Error("Invalid conversation index page");
      }
      let progress = false;
      for (const item of page.items) {
        checkAbort(signal);
        const entry = normalizeEntry(item, isArchived);
        if (!seen.has(entry.id)) progress = true;
        seen.add(entry.id);
        const previous = entries.get(entry.id);
        if (!previous) entries.set(entry.id, entry);
        else {
          const newer = (entry.updatedAt ?? entry.createdAt ?? "") > (previous.updatedAt ?? previous.createdAt ?? "") ? entry : previous;
          entries.set(entry.id, { ...newer, archived: previous.archived || entry.archived, projectId: newer.projectId ?? previous.projectId ?? entry.projectId });
        }
      }
      if (page.items.length > 0 && !progress) throw new Error("Conversation index pagination did not progress");
      if (page.items.length < PAGE_SIZE) break;
    }
  }
  checkAbort(signal);
  return { schemaVersion: 1, userId, accountId, refreshedAt: new Date().toISOString(), conversations: [...entries.values()].sort(compareEntries) };
}

/** @param {Record<string, unknown>} value @param {string[]} keys */
function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Validate and reconstruct a metadata-only snapshot rather than forwarding arbitrary stored fields.
 * @param {unknown} value
 * @returns {ConversationIndexSnapshot}
 */
function validateSnapshot(value) {
  if (!object(value) || !exactKeys(value, ["schemaVersion", "userId", "accountId", "refreshedAt", "conversations"]) || value.schemaVersion !== 1 || !Array.isArray(value.conversations)) {
    throw new Error("Invalid conversation index snapshot or schema version");
  }
  const userId = identifier(value.userId, "user ID");
  const accountId = value.accountId === null ? null : identifier(value.accountId, "account ID");
  const refreshedAt = timestamp(value.refreshedAt, "refresh timestamp");
  if (refreshedAt === null || refreshedAt !== value.refreshedAt) throw new Error("Invalid conversation index refresh timestamp");
  const seen = new Set();
  const conversations = value.conversations.map((entry) => {
    if (!object(entry) || !exactKeys(entry, ["id", "title", "url", "createdAt", "updatedAt", "archived", "projectId"])) throw new Error("Invalid conversation index entry");
    const id = identifier(entry.id, "conversation ID");
    if (seen.has(id)) throw new Error("Duplicate conversation index ID");
    seen.add(id);
    if (typeof entry.title !== "string" || typeof entry.archived !== "boolean" || entry.url !== `https://chatgpt.com/c/${id}`) throw new Error("Invalid conversation index entry metadata");
    const createdAt = timestamp(entry.createdAt, "creation timestamp");
    const updatedAt = timestamp(entry.updatedAt, "update timestamp");
    if (createdAt !== entry.createdAt || updatedAt !== entry.updatedAt) throw new Error("Invalid conversation index stored timestamp");
    const projectId = entry.projectId === null ? null : identifier(entry.projectId, "project ID");
    return { id, title: entry.title, url: entry.url, createdAt, updatedAt, archived: entry.archived, projectId };
  });
  return { schemaVersion: 1, userId, accountId, refreshedAt, conversations };
}

/** @param {string} path @returns {Promise<ConversationIndexSnapshot | undefined>} */
export async function readConversationIndex(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  return validateSnapshot(JSON.parse(text));
}

/** Publish only complete, validated snapshots. A failed write never removes the previous snapshot.
 * @param {string} path
 * @param {ConversationIndexSnapshot} snapshot
 * @returns {Promise<void>}
 */
export async function writeConversationIndex(path, snapshot) {
  const text = `${JSON.stringify(validateSnapshot(snapshot), null, 2)}\n`;
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const temp = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let owned = false;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    owned = true;
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    owned = false;
  } finally {
    try {
      await handle?.close();
    } finally {
      if (owned) await unlink(temp);
    }
  }
}

/** @param {ConversationIndexEntry} a @param {ConversationIndexEntry} b */
function compareEntries(a, b) {
  const timeA = a.updatedAt ?? a.createdAt ?? "";
  const timeB = b.updatedAt ?? b.createdAt ?? "";
  return timeA === timeB ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : timeA > timeB ? -1 : 1;
}

/** @param {string} value */
function searchable(value) {
  return value.normalize("NFKC").toLowerCase();
}

/** @param {ConversationIndexSnapshot} snapshot
 * @param {{query?: string, limit?: number}} [options]
 * @returns {{total: number, conversations: ConversationIndexEntry[]}}
 */
export function searchConversationIndex(snapshot, { query = "", limit = 20 } = {}) {
  if (typeof query !== "string") throw new Error("Conversation index query must be a string");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Conversation index limit must be a positive integer");
  const words = searchable(query).split(/\s+/u).filter(Boolean);
  const matches = snapshot.conversations.filter((entry) => {
    const fields = [entry.title, entry.id, entry.projectId ?? ""].map(searchable);
    return words.every((word) => fields.some((field) => field.includes(word)));
  }).sort(compareEntries);
  return { total: matches.length, conversations: matches.slice(0, Math.min(limit, 200)) };
}
