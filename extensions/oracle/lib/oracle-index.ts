// Purpose: Index ChatGPT conversation metadata and selectively read an indexed visible transcript.
// Scope: Read-only account API requests in a new owned browser tab; never sends chat messages.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getOracleConfigLoadDetails, loadOracleConfig, resolveOracleConfigForProvider, type OracleConfig, type OracleConfigLoadOptions } from "./config.js";
import { getOracleStateDir, withLock } from "./locks.js";
import { acquireManagedBrowser, canonicalManagedProfileDir, managedBrowserReplaced, releaseManagedBrowser, type ManagedBrowserAttachment } from "../shared/managed-browser-helpers.mjs";
import { RelayCdpClient } from "../shared/relay-cdp-client.mjs";
import { sleep } from "../shared/time-helpers.mjs";
import { collectConversationIndex, readConversationIndex, searchConversationIndex, writeConversationIndex, type ConversationIndexEntry, type ConversationIndexSnapshot } from "../shared/conversation-index.mjs";
import { readConversationPage, type ConversationReadPage } from "../shared/conversation-read.mjs";

export interface OracleIndexParams {
  action: "refresh" | "search" | "status" | "read";
  query?: string;
  limit?: number;
  conversationId?: string;
  offset?: number;
  maxChars?: number;
}

export interface OracleIndexResult {
  action: OracleIndexParams["action"];
  indexPath: string;
  indexed: number;
  refreshedAt: string | null;
  userId: string | null;
  accountId: string | null;
  total: number;
  conversations: ConversationIndexEntry[];
  notice: string;
  conversation?: ConversationReadPage;
}

/** Only these intentionally sanitized messages may be displayed by the tool/command surface. */
export class OracleIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleIndexError";
  }
}

type AccountIdentity = { userId: string; accountId: string };
type BrowserReply = {
  error?: string;
  identity?: AccountIdentity;
  page?: unknown;
  conversation?: unknown;
};

type BrowserRequest = { kind: "list"; offset: number; limit: number; isArchived: boolean }
  | { kind: "conversation"; id: string };
type IndexBrowserRequest = (request?: BrowserRequest) => Promise<BrowserReply>;

const INDEX_NOTICE = "Metadata only: search matches titles, IDs, and project IDs, not transcript contents. This is a snapshot of the chats returned by ChatGPT's private listing API, not a guarantee of exhaustive history. Refresh is explicit; continuing a selected chat sends a new message, while indexing/search do not.";

function indexLocation(cwd: string, config: OracleConfig, options?: OracleConfigLoadOptions): string {
  const source = config.browser.chatGptManagedProfileDir
    ? `managed:${canonicalManagedProfileDir(config.browser.chatGptManagedProfileDir)}`
    : config.browser.chatGptRelayEndpoint ? `relay:${config.browser.chatGptRelayEndpoint}` : undefined;
  if (!source) {
    throw new OracleIndexError("oracle_index requires the configured ChatGPT managed browser or relay. Seed-profile-only transport is not supported by the index; configure a signed-in managed browser or relay first.");
  }
  const key = createHash("sha256").update(source).digest("hex");
  return join(getOracleConfigLoadDetails(cwd, options).agentDir, "oracle-index", `${key}.json`);
}

function resultFor(params: OracleIndexParams, indexPath: string, snapshot: ConversationIndexSnapshot | undefined): OracleIndexResult {
  const found = snapshot && params.action === "search"
    ? searchConversationIndex(snapshot, { query: params.query, limit: params.limit })
    : { total: 0, conversations: [] };
  return {
    action: params.action,
    indexPath,
    indexed: snapshot?.conversations.length ?? 0,
    refreshedAt: snapshot?.refreshedAt ?? null,
    userId: snapshot?.userId ?? null,
    accountId: snapshot?.accountId ?? null,
    total: found.total,
    conversations: found.conversations,
    notice: INDEX_NOTICE,
  };
}

/** This expression runs only in the index-owned ChatGPT tab. Credentials never leave that page. */
function requestExpression(request?: BrowserRequest): string {
  return `(async () => {
    if (location.origin !== "https://chatgpt.com") return { error: "wrong_origin" };
    const sessionResponse = await fetch("/api/auth/session", {
      method: "GET", credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000)
    });
    if (!sessionResponse.ok) return { error: "signed_out" };
    const session = await sessionResponse.json();
    if (typeof session.accessToken !== "string" || !session.accessToken ||
        typeof session.user?.id !== "string" || !session.user.id || session.user.id.startsWith("ua-") ||
        typeof session.account?.id !== "string" || !session.account.id) return { error: "signed_out" };
    const identity = { userId: session.user.id, accountId: session.account.id };
    const request = ${JSON.stringify(request ?? null)};
    if (!request) return { identity };
    const query = request.kind === "list" ? new URLSearchParams({offset: String(request.offset), limit: String(request.limit),
      order: "updated", is_archived: String(request.isArchived), hide_snorlax: "false"}) : null;
    const path = request.kind === "conversation"
      ? "/backend-api/conversation/" + encodeURIComponent(request.id) : "/backend-api/conversations?" + query;
    const response = await fetch(path, {
      method: "GET", credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + session.accessToken, "ChatGPT-Account-Id": identity.accountId }
    });
    if (!response.ok) return { error: response.status === 429 ? "rate_limit" :
      response.status === 404 && request.kind === "conversation" ? "conversation_missing" :
      response.status === 401 || response.status === 403 ? "access_denied" : "listing_failed" };
    const data = await response.json();
    if (request.kind === "conversation") {
      if (!data?.mapping || typeof data.mapping !== "object" || Array.isArray(data.mapping)) return { error: "invalid_conversation" };
      if (Object.values(data.mapping).some(node => !node || typeof node !== "object" || Array.isArray(node) ||
          !Object.hasOwn(node, "parent") || !Object.hasOwn(node, "message") ||
          (node.message !== null && (typeof node.message !== "object" || Array.isArray(node.message))))) {
        return { error: "invalid_conversation" };
      }
      // Retain graph links, but project only visible conversational fields before crossing CDP.
      const mapping = Object.fromEntries(Object.entries(data.mapping).map(([id, node]) => {
        const message = node?.message;
        const role = message?.author?.role;
        const content = message?.content;
        const restricted = value => typeof value === "string" &&
          /^(analysis|reasoning|justify|confidence|thoughts|reasoning_recap)(?:$|[_-])/i.test(value);
        const visible = (role === "user" || role === "assistant") &&
          !message.metadata?.is_visually_hidden_from_conversation &&
          !restricted(message.channel ?? message.metadata?.channel) &&
          !restricted(message.metadata?.message_type) && !restricted(content?.content_type) &&
          (role !== "assistant" || !message.recipient || message.recipient === "all");
        return [id, { id: node.id, parent: node.parent, message: visible ? {
          id: message.id, author: { role }, create_time: message.create_time, channel: message.channel,
          recipient: message.recipient, metadata: {
            attachments: Array.isArray(message.metadata?.attachments)
              ? message.metadata.attachments.map(file => ({ name: file?.name, mime_type: file?.mime_type })) : []
          }, content: {
            content_type: content?.content_type,
            text: content?.content_type === "audio_transcription" ? content.text : undefined,
            parts: Array.isArray(content?.parts) ? content.parts.map(part => typeof part === "string" ? part :
              part && typeof part === "object" ? { content_type: part.content_type,
                text: part.content_type === "audio_transcription" ? part.text : undefined } : null) : []
          }
        } : null }];
      }));
      return { identity, conversation: { id: data.id, conversation_id: data.conversation_id,
        title: data.title, current_node: data.current_node, mapping } };
    }
    if (!Array.isArray(data?.items)) return { error: "invalid_listing" };
    // The listing can include snippets/mapping. Project only directory metadata before crossing CDP.
    return { identity, page: { items: data.items.map(item => ({
      id: item?.id, title: item?.title, create_time: item?.create_time, update_time: item?.update_time,
      is_archived: item?.is_archived, gizmo_id: item?.gizmo_id, project_id: item?.project_id
    })) } };
  })()`;
}

function checkedReply(value: unknown): BrowserReply {
  if (!value || typeof value !== "object") throw new OracleIndexError("ChatGPT did not return readable index metadata. The private API may have changed; the previous index was kept.");
  const reply = value as BrowserReply;
  if (reply.error) {
    const messages: Record<string, string> = {
      wrong_origin: "The index-owned tab left ChatGPT. Finish sign-in or any browser challenge, then refresh again; the previous index was kept.",
      signed_out: "The Oracle browser is not signed in to an identifiable ChatGPT account. Finish sign-in in the configured browser, then refresh again.",
      rate_limit: "ChatGPT rate-limited the directory refresh. Wait before requesting another refresh; the previous index was kept.",
      access_denied: "ChatGPT refused the directory request. Check the signed-in account and any browser challenge; the previous index was kept.",
      listing_failed: "ChatGPT could not list conversations. The private API may be unavailable; the previous index was kept.",
      invalid_listing: "ChatGPT returned an unrecognized conversation list. The private API may have changed; the previous index was kept.",
      conversation_missing: "The selected ChatGPT conversation is unavailable or no longer accessible to this account. The index may be stale; refresh it before selecting another chat.",
      invalid_conversation: "ChatGPT returned an unrecognized conversation body. The private API may have changed; no chat message was sent.",
    };
    throw new OracleIndexError(messages[reply.error] ?? "ChatGPT could not refresh the directory; the previous index was kept.");
  }
  if (typeof reply.identity?.userId !== "string" || !reply.identity.userId ||
      typeof reply.identity.accountId !== "string" || !reply.identity.accountId) {
    throw new OracleIndexError("ChatGPT did not identify the current user and workspace; the previous index was kept.");
  }
  return reply;
}

function requireSameAccount(expected: AccountIdentity, actual: AccountIdentity | undefined): void {
  if (expected.userId !== actual?.userId || expected.accountId !== actual.accountId) {
    throw new OracleIndexError("The signed-in ChatGPT user/workspace differs from the selected index or changed during this operation. Refresh the index after selecting the intended account; no chat message was sent.");
  }
}

async function withIndexBrowser<T>(config: OracleConfig, run: (request: IndexBrowserRequest) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const stateDir = getOracleStateDir();
  let managed: ManagedBrowserAttachment | undefined;
  let cdp: RelayCdpClient | undefined;
  let targetId: string | undefined;
  let sessionId: string | undefined;
  try {
    let endpoint = config.browser.chatGptRelayEndpoint;
    if (config.browser.chatGptManagedProfileDir) {
      if (!config.browser.executablePath) throw new OracleIndexError("The managed Oracle browser needs browser.executablePath before an index refresh.");
      managed = await acquireManagedBrowser({ stateDir, profileDir: config.browser.chatGptManagedProfileDir,
        executablePath: config.browser.executablePath, args: config.browser.args, owner: "oracle-index" });
      endpoint = managed.endpoint;
    }
    if (!endpoint) throw new OracleIndexError("Configure a ChatGPT managed browser or relay before refreshing the index.");
    cdp = await RelayCdpClient.connect(endpoint);
    const created = await cdp.send("Target.createTarget", { url: "https://chatgpt.com/", background: true }) as { targetId?: string };
    targetId = created.targetId;
    if (!targetId) throw new OracleIndexError("The Oracle browser did not create an index-owned tab.");
    ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const state = await cdp.send("Runtime.evaluate", {
        expression: 'location.origin === "https://chatgpt.com" && document.readyState !== "loading"', returnByValue: true,
      }, sessionId).catch(() => undefined);
      if (state?.result.value === true) { ready = true; break; }
      await sleep(250);
    }
    if (!ready) throw new OracleIndexError("The index-owned ChatGPT tab did not become ready. Finish sign-in or any browser challenge before refreshing again.");
    const request: IndexBrowserRequest = async (request) => {
      signal?.throwIfAborted();
      if (managed && await managedBrowserReplaced(managed)) throw new OracleIndexError("The configured Oracle browser changed during indexing; the previous index was kept.");
      const evaluated = await cdp!.send("Runtime.evaluate", {
        expression: requestExpression(request), awaitPromise: true, returnByValue: true,
      }, sessionId, 35_000);
      signal?.throwIfAborted();
      if (evaluated.exceptionDetails) throw new OracleIndexError("ChatGPT's authenticated directory request failed. Check browser sign-in and connectivity; the previous index was kept.");
      return checkedReply(evaluated.result.value);
    };
    return await run(request);
  } finally {
    try {
      if (targetId && cdp) {
        const closed = await cdp.send("Target.closeTarget", { targetId }) as { success?: boolean };
        if (closed.success === false && sessionId) {
          await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
        }
        const deadline = Date.now() + 2_000;
        let released = false;
        while (Date.now() < deadline) {
          const targets = await cdp.send("Target.getTargets") as { targetInfos: Array<{ targetId: string; url: string }> };
          const owned = targets.targetInfos.find((target) => target.targetId === targetId);
          if (!owned || owned.url === "about:blank") { released = true; break; }
          await sleep(100);
        }
        if (!released) throw new OracleIndexError("The index-owned browser tab could not be released. Close that tab before trying another refresh; the previous index was kept.");
      }
    } finally {
      cdp?.close();
      await releaseManagedBrowser(stateDir, managed?.leaseKey);
    }
  }
}

async function refreshIndex(config: OracleConfig, signal?: AbortSignal): Promise<ConversationIndexSnapshot> {
  return withIndexBrowser(config, async (request) => {
    const identity = (await request()).identity!;
    const snapshot = await collectConversationIndex({
      userId: identity.userId, accountId: identity.accountId, signal,
      fetchPage: async (page) => {
        const reply = await request({ kind: "list", ...page });
        requireSameAccount(identity, reply.identity);
        return reply.page;
      },
    });
    requireSameAccount(identity, (await request()).identity);
    return snapshot;
  }, signal);
}

function indexedConversationId(snapshot: ConversationIndexSnapshot, reference: string): string {
  let id = reference.trim();
  if (/^https?:/i.test(id)) {
    let url: URL;
    try { url = new URL(id); } catch { throw new OracleIndexError("Select a full indexed conversation ID or its ChatGPT /c/ URL."); }
    const match = url.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/);
    if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname) || url.username || url.password || !match) {
      throw new OracleIndexError("Select a full indexed conversation ID or its ChatGPT /c/ URL, not a shared link or another site's URL.");
    }
    id = match[1];
  }
  if (!snapshot.conversations.some((entry) => entry.id === id)) {
    throw new OracleIndexError("That full conversation ID is not in this browser source's index. Search or refresh the index and select an exact result before reading.");
  }
  return id;
}

async function readIndexedConversation(config: OracleConfig, snapshot: ConversationIndexSnapshot, id: string, params: OracleIndexParams, signal?: AbortSignal): Promise<ConversationReadPage> {
  if (!snapshot.accountId) throw new OracleIndexError("Refresh the index to bind it to a ChatGPT workspace before reading a conversation.");
  const identity: AccountIdentity = { userId: snapshot.userId, accountId: snapshot.accountId };
  return withIndexBrowser(config, async (request) => {
    requireSameAccount(identity, (await request()).identity);
    const reply = await request({ kind: "conversation", id });
    requireSameAccount(identity, reply.identity);
    requireSameAccount(identity, (await request()).identity);
    try {
      return readConversationPage(reply.conversation, { conversationId: id, offset: params.offset, maxChars: params.maxChars });
    } catch {
      throw new OracleIndexError("The selected conversation could not be read as a valid visible branch. Its returned ID or message graph may not match the selected chat; no message was sent.");
    }
  }, signal);
}

export async function runOracleIndex(cwd: string, params: OracleIndexParams, options?: OracleConfigLoadOptions, signal?: AbortSignal): Promise<OracleIndexResult> {
  if (!["refresh", "search", "status", "read"].includes(params.action)) throw new OracleIndexError("Choose oracle_index action refresh, search, status, or read.");
  if (params.query !== undefined && typeof params.query !== "string") throw new OracleIndexError("The index query must be text.");
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200)) throw new OracleIndexError("The index result limit must be an integer from 1 to 200.");
  if (params.action === "read" && (typeof params.conversationId !== "string" || !params.conversationId.trim())) {
    throw new OracleIndexError("Reading requires an explicit full indexed conversationId or ChatGPT conversation URL.");
  }
  if (params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 0)) throw new OracleIndexError("The transcript offset must be a non-negative integer.");
  if (params.maxChars !== undefined && (!Number.isInteger(params.maxChars) || params.maxChars < 1000 || params.maxChars > 60000)) throw new OracleIndexError("The transcript character budget must be an integer from 1000 to 60000.");
  if (params.action !== "read" && (params.conversationId !== undefined || params.offset !== undefined || params.maxChars !== undefined)) {
    throw new OracleIndexError("conversationId, offset, and maxChars apply only to oracle_index read.");
  }
  signal?.throwIfAborted();
  try {
    const config = resolveOracleConfigForProvider(loadOracleConfig(cwd, options), "chatgpt");
    const indexPath = indexLocation(cwd, config, options);
    if (params.action !== "refresh") {
      const snapshot = await readConversationIndex(indexPath);
      if (!snapshot && params.action !== "status") throw new OracleIndexError('No oracle index exists for this browser source. Run oracle_index with action="refresh" or /oracle-index refresh first.');
      if (params.action === "read") {
        const id = indexedConversationId(snapshot!, params.conversationId!);
        const conversation = await readIndexedConversation(config, snapshot!, id, params, signal);
        return { ...resultFor(params, indexPath, snapshot), conversation,
          notice: "Read-only retrieval of one explicitly selected conversation. The metadata index is unchanged; returned transcript text is part of the normal caller session, not a new transcript cache." };
      }
      return resultFor(params, indexPath, snapshot);
    }
    return await withLock("oracle-index", indexPath, { processPid: process.pid, action: "refresh" }, async () => {
      const snapshot = await refreshIndex(config, signal);
      signal?.throwIfAborted();
      await writeConversationIndex(indexPath, snapshot);
      return resultFor(params, indexPath, snapshot);
    });
  } catch (error) {
    if (error instanceof OracleIndexError) throw error;
    if (signal?.aborted) throw new OracleIndexError("Oracle index operation was cancelled; the metadata index is unchanged and no chat message was sent.");
    throw new OracleIndexError(params.action === "refresh"
      ? "Oracle index refresh failed; the previous index was kept. Check the configured browser, sign-in, and private index file permissions before trying again."
      : params.action === "read" ? "The selected conversation could not be retrieved. Check browser sign-in, the indexed account, and the selected ID; no chat message was sent."
      : "The local oracle index could not be read. Check its file permissions or run /oracle-index refresh to replace an invalid snapshot.");
  }
}
