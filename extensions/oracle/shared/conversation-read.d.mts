export interface ConversationReadPage {
  id: string;
  title: string;
  url: string;
  currentNode: string | null;
  /** Number of rendered visible user/assistant messages on the selected branch. */
  messageCount: number;
  /** UTF-16 code units in the complete rendered transcript, including headers. */
  totalChars: number;
  /** Actual page start, clamped to the transcript and moved back out of a surrogate pair. */
  offset: number;
  nextOffset: number | null;
  text: string;
  notice: string;
}

/** Read a selected visible branch without fetching media, writing state, or sending a message. */
export declare function readConversationPage(
  raw: unknown,
  options: {
    conversationId: string;
    /** Nonnegative safe integer UTF-16 offset; defaults to zero. */
    offset?: number;
    /** Integer character budget from 1000 through 60000; defaults to 16000. */
    maxChars?: number;
  },
): ConversationReadPage;
