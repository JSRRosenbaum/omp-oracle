export interface ConversationIndexEntry {
  id: string;
  title: string;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  projectId: string | null;
}

export interface ConversationIndexSnapshot {
  schemaVersion: 1;
  userId: string;
  accountId: string | null;
  refreshedAt: string;
  conversations: ConversationIndexEntry[];
}

export interface ConversationIndexPage {
  offset: number;
  limit: number;
  isArchived: boolean;
}

export declare function collectConversationIndex(options: {
  fetchPage: (page: ConversationIndexPage) => Promise<unknown>;
  userId: string;
  accountId: string | null;
  signal?: AbortSignal;
}): Promise<ConversationIndexSnapshot>;

export declare function readConversationIndex(path: string): Promise<ConversationIndexSnapshot | undefined>;
export declare function writeConversationIndex(path: string, snapshot: ConversationIndexSnapshot): Promise<void>;
export declare function searchConversationIndex(
  snapshot: ConversationIndexSnapshot,
  options?: { query?: string; limit?: number },
): { total: number; conversations: ConversationIndexEntry[] };
