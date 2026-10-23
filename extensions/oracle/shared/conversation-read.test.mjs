import assert from "node:assert/strict";
import test from "node:test";

import { readConversationPage } from "./conversation-read.mjs";

const message = (id, role, text, extra = {}) => ({
  id,
  author: { role, name: role === "tool" ? "secret-tool" : null },
  recipient: "all",
  create_time: 1_736_000_000,
  content: { content_type: "text", parts: [text] },
  metadata: {},
  ...extra,
});
const node = (id, parent, msg, children = []) => ({ id, parent, children, message: msg });
const chat = (mapping, current_node = Object.keys(mapping).at(-1) ?? null, extra = {}) => ({
  conversation_id: "chat-1", title: "Example chat", mapping, current_node, ...extra,
});
const read = (raw, options = {}) => readConversationPage(raw, { conversationId: "chat-1", ...options });

function linearChat(messages, extra = {}) {
  const mapping = {};
  let parent = null;
  for (const [id, role, text, messageExtra] of messages) {
    const child = node(id, parent, message(id, role, text, messageExtra));
    if (parent !== null) mapping[parent].children = [id];
    mapping[id] = child;
    parent = id;
  }
  return chat(mapping, parent, extra);
}

test("reads only the selected regenerated branch, in root-to-current order", () => {
  const mapping = {
    root: node("root", null, message("root", "user", "Question"), ["old", "new"]),
    old: node("old", "root", message("old", "assistant", "Obsolete answer")),
    new: node("new", "root", message("new", "assistant", "Current answer")),
  };
  const page = read(chat(mapping, "new"));
  assert.match(page.text, /Question/);
  assert.match(page.text, /Current answer/);
  assert.doesNotMatch(page.text, /Obsolete answer/);
  assert.equal(page.id, "chat-1");
  assert.equal(page.title, "Example chat");
  assert.equal(page.currentNode, "new");
  assert.equal(page.messageCount, 2);
});

test("excludes hidden, non-user/assistant, reasoning, and assistant tool-directed messages", () => {
  const mapping = {};
  const records = [
    ["u", "user", "Visible question", {}],
    ["hidden", "assistant", "HIDDEN_SECRET", { metadata: { is_visually_hidden_from_conversation: true } }],
    ["analysis", "assistant", "REASONING_SECRET", { metadata: { message_type: "analysis" }, channel: "analysis" }],
    ["metadata-channel", "assistant", "METADATA_CHANNEL_SECRET", { metadata: { channel: "analysis" } }],
    ["metadata-type", "assistant", "METADATA_TYPE_SECRET", { metadata: { message_type: "reasoning" } }],
    ["toolcall", "assistant", "TOOL_CALL_SECRET", { recipient: "browser.search", channel: "commentary" }],
    ["system", "system", "SYSTEM_SECRET", {}],
    ["developer", "developer", "DEVELOPER_SECRET", {}],
    ["tool", "tool", "TOOL_OUTPUT_SECRET", {}],
    ["answer", "assistant", "Visible answer", {}],
  ];
  let parent = null;
  records.forEach(([id, role, text, extra]) => {
    mapping[id] = node(id, parent, message(id, role, text, extra), []);
    if (parent) mapping[parent].children.push(id);
    parent = id;
  });
  const page = read(chat(mapping, parent));
  assert.match(page.text, /Visible question/);
  assert.match(page.text, /Visible answer/);
  for (const secret of ["HIDDEN_SECRET", "REASONING_SECRET", "METADATA_CHANNEL_SECRET", "METADATA_TYPE_SECRET", "TOOL_CALL_SECRET", "SYSTEM_SECRET", "DEVELOPER_SECRET", "TOOL_OUTPUT_SECRET", "secret-tool"]) {
    assert.equal(page.text.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(page.messageCount, 2);
});

test("rejects mismatched identity and malformed selected history instead of returning partial transcript", () => {
  assert.throws(() => read(chat({}), { conversationId: "other" }), /ID/);
  assert.throws(() => read({ id: "chat-1", conversation_id: "other", mapping: {}, current_node: null }, { conversationId: "chat-1" }), /ID/);
  assert.throws(() => read({ conversation_id: "chat-1", mapping: [], current_node: null }), /mapping/);
  assert.throws(() => read(chat({ broken: node("broken", null, message("broken", "user", "x")) }, "missing")), /node|current/i);
  assert.throws(() => read(chat({ a: node("a", "b", message("a", "user", "partial")), b: node("b", "a", message("b", "assistant", "partial")) }, "a")), /cycle/i);
  assert.throws(() => read(chat({ a: node("a", "missing", message("a", "user", "partial")) }, "a")), /parent/i);
  assert.throws(() => read(chat({ a: node("a", null, message("wrong-message-id", "user", "partial")) }, "a")), /message ID/i);
  const missingId = message("a", "user", "partial");
  delete missingId.id;
  assert.throws(() => read(chat({ a: node("a", null, missingId) }, "a")), /message ID/i);
});

test("accepts the parent's projected {parent, message} graph and top-level voice transcription text", () => {
  const raw = {
    conversation_id: "chat-1", current_node: "answer",
    mapping: {
      question: { parent: null, message: { id: "question", author: { role: "user" }, create_time: 1_736_000_000, channel: "message", recipient: null, metadata: { attachments: [] }, content: { content_type: "audio_transcription", text: "exact voice transcription", parts: [] } } },
      answer: { parent: "question", message: { id: "answer", author: { role: "assistant" }, create_time: 1_736_000_001, channel: "final", recipient: "", metadata: { attachments: [] }, content: { content_type: "text", parts: ["Exact answer"] } } },
    },
  };
  const page = read(raw);
  assert.match(page.text, /exact voice transcription/);
  assert.match(page.text, /Exact answer/);
  assert.equal(page.messageCount, 2);
});

test("renders visible text faithfully with role, ID, timestamp, voice transcription, and safe media placeholders", () => {
  const mapping = {
    u: node("u", null, message("u", "user", "  Keep this wording.\nAnd spacing.  ", {
      create_time: 1_736_000_000,
      content: { content_type: "multimodal_text", parts: ["  Keep this wording.\nAnd spacing.  ", { content_type: "image_asset_pointer", text: "private-image-payload" }, { content_type: "audio", text: "private-audio-payload" }, { content_type: "audio_transcription", text: "voice transcript exactly" }] },
      metadata: { attachments: [{ name: "private-file-name", mime_type: "application/pdf" }] },
    }), ["a"]),
    a: node("a", "u", message("a", "assistant", "Verbatim answer — 🐈")),
  };
  const page = read(chat(mapping, "a", { title: "A title", extraPrivate: "RAW_METADATA_SECRET" }));
  assert.match(page.text, /USER/);
  assert.match(page.text, /u/);
  assert.match(page.text, /2025-/);
  assert.match(page.text, /  Keep this wording\.\nAnd spacing\.  /);
  assert.match(page.text, /voice transcript exactly/);
  assert.match(page.text, /\[Image omitted\]/);
  assert.match(page.text, /\[Audio omitted\]/);
  assert.match(page.text, /\[Attachment omitted\]/);
  assert.match(page.text, /ASSISTANT/);
  assert.match(page.text, /Verbatim answer — 🐈/);
  for (const privateValue of ["private-image-payload", "private-audio-payload", "private-file-name", "RAW_METADATA_SECRET"]) assert.equal(page.text.includes(privateValue), false);
});

test("allows an empty mapping only with null current node", () => {
  const page = read(chat({}, null));
  assert.equal(page.currentNode, null);
  assert.equal(page.messageCount, 0);
  assert.equal(page.totalChars, 0);
  assert.equal(page.text, "");
  assert.equal(page.nextOffset, null);
  assert.throws(() => read(chat({}, "missing")), /current/i);
});

test("pages the rendered transcript with UTF-16 offsets, exact totals, and surrogate-safe boundaries", () => {
  const raw = linearChat([
    ["u1", "user", "🐈".repeat(800)],
    ["a1", "assistant", "Done"],
  ]);
  const first = read(raw, { maxChars: 1000 });
  assert.equal(first.offset, 0);
  assert.equal(first.text.length <= 1000, true);
  assert.equal(first.totalChars, read(raw, { maxChars: 60000 }).totalChars);
  assert.notEqual(first.nextOffset, null);
  assert.equal(first.text.charCodeAt(first.text.length - 1) >= 0xd800 && first.text.charCodeAt(first.text.length - 1) <= 0xdbff, false);
  const second = read(raw, { offset: first.nextOffset, maxChars: 1000 });
  assert.equal(second.offset, first.nextOffset);
  assert.equal(first.nextOffset, first.text.length);
  assert.equal(second.text.charCodeAt(0) >= 0xdc00 && second.text.charCodeAt(0) <= 0xdfff, false);
  const all = read(raw, { maxChars: 1000 });
  let transcript = all.text;
  let next = all.nextOffset;
  while (next !== null) {
    const page = read(raw, { offset: next, maxChars: 1000 });
    transcript += page.text;
    next = page.nextOffset;
  }
  const full = read(raw, { maxChars: 60000 });
  assert.equal(transcript, full.text);
  const emojiIndex = full.text.indexOf("🐈");
  const fromLowSurrogate = read(raw, { offset: emojiIndex + 1, maxChars: 1000 });
  assert.equal(fromLowSurrogate.offset, emojiIndex);
  assert.equal(fromLowSurrogate.text.charCodeAt(0), full.text.charCodeAt(emojiIndex));
  assert.equal(fromLowSurrogate.text.charCodeAt(1), full.text.charCodeAt(emojiIndex + 1));
  assert.equal(full.totalChars, full.text.length);
  assert.equal(full.messageCount, 2);
  const beyond = read(raw, { offset: full.totalChars + 50, maxChars: 1000 });
  assert.equal(beyond.offset, full.totalChars);
  assert.equal(beyond.text, "");
  assert.equal(beyond.nextOffset, null);
});

test("rejects invalid page bounds", () => {
  const raw = linearChat([["u", "user", "Hello"]]);
  for (const maxChars of [999, 60001, 1.5, "1000"]) assert.throws(() => read(raw, { maxChars }), /maxChars/i);
  for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => read(raw, { offset }), /offset/i);
});
