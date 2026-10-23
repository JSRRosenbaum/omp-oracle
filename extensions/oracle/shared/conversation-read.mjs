// Purpose: Render a bounded, read-only view of the selected visible conversation branch.
// Scope: This module never fetches content, follows sibling branches, or interprets transcript text.

const ID = /^[A-Za-z0-9_-]+$/;
const DEFAULT_MAX_CHARS = 16_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 60_000;
const NOTICE = "Read-only transcript of the selected visible branch only; media, tool messages/logs, and reasoning are omitted. No new message is sent.";

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} field */
function validString(value, field) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid conversation ${field}`);
  return value;
}

/** @param {unknown} value @returns {string | null} */
function visibleTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** @param {unknown} part @returns {string} */
function mediaPlaceholder(part) {
  const type = isObject(part) && typeof part.content_type === "string" ? part.content_type.toLowerCase() : "";
  if (/image|photo|picture/.test(type)) return "[Image omitted]";
  if (/audio|voice|speech/.test(type)) return "[Audio omitted]";
  if (/video|clip/.test(type)) return "[Video omitted]";
  if (/file|document|attachment/.test(type)) return "[Attachment omitted]";
  return "[Unsupported content omitted]";
}

/** @param {unknown} message @returns {string} */
function visibleContent(message) {
  const content = isObject(message.content) ? message.content : null;
  if (!content) return "[Message content omitted]";
  const contentType = typeof content.content_type === "string" ? content.content_type.toLowerCase() : "";
  const isText = contentType === "text" || contentType === "multimodal_text" || contentType === "audio_transcription";
  const parts = [];
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === "string") parts.push(isText ? part : mediaPlaceholder({ content_type: contentType }));
      else if (isObject(part) && part.content_type === "audio_transcription" && typeof part.text === "string") parts.push(part.text);
      else parts.push(mediaPlaceholder(part));
    }
  }
  if (contentType === "audio_transcription" && typeof content.text === "string") parts.push(content.text);
  if (Array.isArray(message.metadata?.attachments) && message.metadata.attachments.length > 0) parts.push("[Attachment omitted]");
  if (parts.length === 0) return /^(text|multimodal_text)$/.test(contentType) ? "" : mediaPlaceholder({ content_type: contentType });
  return parts.join("\n");
}

/** @param {unknown} message @returns {boolean} */
function isVisibleMessage(message) {
  if (!isObject(message) || !isObject(message.author)) return false;
  const role = message.author.role;
  if (role !== "user" && role !== "assistant") return false;
  const metadata = isObject(message.metadata) ? message.metadata : {};
  if (metadata.is_visually_hidden_from_conversation === true) return false;
  if (role === "assistant" && message.recipient !== undefined && message.recipient !== null && message.recipient !== "" && message.recipient !== "all") return false;
  const channel = typeof message.channel === "string" ? message.channel : metadata.channel;
  if (typeof channel === "string" && /^(analysis|reasoning|justify|confidence|thoughts|reasoning_recap)(?:$|[_-])/i.test(channel)) return false;
  const type = metadata.message_type;
  if (typeof type === "string" && /^(analysis|reasoning|justify|confidence|thoughts|reasoning_recap)(?:$|[_-])/i.test(type)) return false;
  const contentType = isObject(message.content) ? message.content.content_type : null;
  if (typeof contentType === "string" && /^(analysis|reasoning|thoughts|reasoning_recap|justify|confidence)(?:$|[_-])/i.test(contentType)) return false;
  return true;
}

/** @param {Record<string, unknown>} mapping @param {unknown} currentNode */
function selectedBranch(mapping, currentNode) {
  if (Object.keys(mapping).length === 0) {
    if (currentNode !== null && currentNode !== undefined) throw new Error("Invalid conversation current node for empty mapping");
    return [];
  }
  if (typeof currentNode !== "string" || currentNode.length === 0 || !Object.hasOwn(mapping, currentNode)) {
    throw new Error("Invalid conversation current node");
  }
  const reversed = [];
  const visited = new Set();
  let nodeId = currentNode;
  while (nodeId !== null) {
    if (visited.has(nodeId)) throw new Error("Invalid conversation graph cycle");
    visited.add(nodeId);
    const node = mapping[nodeId];
    if (!isObject(node) || (node.id !== undefined && node.id !== nodeId)
      || !Object.hasOwn(node, "parent") || !Object.hasOwn(node, "message")) throw new Error("Invalid conversation graph node");
    if (node.children !== undefined && (!Array.isArray(node.children) || node.children.some((child) => typeof child !== "string"))) {
      throw new Error("Invalid conversation graph node children");
    }
    const parent = node.parent;
    if (parent !== null && (typeof parent !== "string" || !Object.hasOwn(mapping, parent))) throw new Error("Invalid conversation graph parent");
    if (node.message !== null && (!isObject(node.message) || typeof node.message.id !== "string"
      || !ID.test(node.message.id) || node.message.id !== nodeId)) throw new Error("Invalid conversation graph message ID");
    reversed.push(node);
    nodeId = parent;
  }
  reversed.reverse();
  return reversed;
}

/** @param {string} text @param {number} index */
function isLowSurrogateAt(text, index) {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** @param {string} text @param {number} index */
function isHighSurrogateAt(text, index) {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

/** @param {string} text @param {number} offset */
function safeStart(text, offset) {
  return offset > 0 && offset < text.length && isLowSurrogateAt(text, offset) ? offset - 1 : offset;
}

/** @param {string} text @param {number} end */
function safeEnd(text, end) {
  return end > 0 && end < text.length && isHighSurrogateAt(text, end - 1) ? end - 1 : end;
}

/** Render one indexed conversation page without retaining or mutating the source object.
 * @param {unknown} raw
 * @param {{conversationId: string, offset?: number, maxChars?: number}} options
 * @returns {import("./conversation-read.mjs").ConversationReadPage}
 */
export function readConversationPage(raw, options) {
  if (!isObject(raw) || !isObject(options)) throw new Error("Invalid conversation read input");
  const requestedId = validString(options.conversationId, "requested ID");
  const rawId = raw.conversation_id ?? raw.id;
  const id = validString(rawId, "ID");
  if ((raw.conversation_id !== undefined && raw.conversation_id !== null && raw.id !== undefined && raw.id !== null && raw.conversation_id !== raw.id)
    || id !== requestedId) throw new Error("Conversation ID mismatch");
  const mapping = raw.mapping;
  if (!isObject(mapping)) throw new Error("Invalid conversation mapping");
  const currentNode = raw.current_node === undefined || raw.current_node === null ? null : raw.current_node;
  const branch = selectedBranch(mapping, currentNode);
  const rendered = [];
  for (const node of branch) {
    const message = node.message;
    if (!isVisibleMessage(message)) continue;
    const role = message.author.role.toUpperCase();
    const messageId = typeof message.id === "string" && ID.test(message.id) ? ` ${message.id}` : "";
    const timestamp = visibleTimestamp(message.create_time);
    const timeHeader = timestamp === null ? "" : ` ${timestamp}`;
    rendered.push(`--- ${role}${messageId}${timeHeader} ---\n${visibleContent(message)}`);
  }
  const transcript = rendered.join("\n\n");
  const maxChars = options.maxChars === undefined ? DEFAULT_MAX_CHARS : options.maxChars;
  if (!Number.isInteger(maxChars) || maxChars < MIN_MAX_CHARS || maxChars > MAX_MAX_CHARS) throw new Error("Invalid conversation maxChars");
  const requestedOffset = options.offset === undefined ? 0 : options.offset;
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) throw new Error("Invalid conversation offset");
  const offset = safeStart(transcript, Math.min(requestedOffset, transcript.length));
  const end = safeEnd(transcript, Math.min(offset + maxChars, transcript.length));
  const text = transcript.slice(offset, end);
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    url: `https://chatgpt.com/c/${id}`,
    currentNode,
    messageCount: rendered.length,
    totalChars: transcript.length,
    offset,
    nextOffset: end < transcript.length ? end : null,
    text,
    notice: NOTICE,
  };
}
