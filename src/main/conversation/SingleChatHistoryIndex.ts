import { normalizeHistoryQuery, searchableHistoryText } from '../../shared/historySearchText';
import { DatabaseSync } from 'node:sqlite';
import { isAsteriumUser } from '../../shared/identity';
import type { Message } from '../../renderer/types/domain';
import {
  SINGLE_CHAT_PAGE_SIZE, SINGLE_CHAT_SEARCH_SIZE,
  type SingleChatHistoryPage, type SingleChatMetadata, type SingleChatPageRequest, type SingleChatSearchRequest, type SingleChatSearchResult,
} from '../../shared/singleChatHistory';

export interface IndexMarker {
  metadata: SingleChatMetadata;
  pending: boolean;
  revision: number;
  length: number;
  fingerprint: string;
}

const PAGE_PAYLOAD_BUDGET = 4 * 1024 * 1024;

const schema = [
  'CREATE TABLE IF NOT EXISTS index_generation (generation TEXT NOT NULL PRIMARY KEY)',
  'CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, pending INTEGER NOT NULL, revision INTEGER NOT NULL, length INTEGER NOT NULL, fingerprint TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS messages (rowid INTEGER PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, body TEXT NOT NULL, quotes TEXT NOT NULL, is_user INTEGER NOT NULL, UNIQUE(chat_id, id))',
  'CREATE INDEX IF NOT EXISTS messages_position ON messages(chat_id, position)',
  'CREATE INDEX IF NOT EXISTS user_turn_position ON messages(chat_id, is_user, position)',
].join(';\n');

const fullText = [
  "CREATE VIRTUAL TABLE message_terms USING fts5(body, quotes, content='messages', content_rowid='rowid', tokenize='trigram')",
  "CREATE TRIGGER terms_insert AFTER INSERT ON messages BEGIN INSERT INTO message_terms(rowid, body, quotes) VALUES (new.rowid, new.body, new.quotes); END",
  "CREATE TRIGGER terms_delete AFTER DELETE ON messages BEGIN INSERT INTO message_terms(message_terms, rowid, body, quotes) VALUES ('delete', old.rowid, old.body, old.quotes); END",
  "CREATE TRIGGER terms_update AFTER UPDATE OF body, quotes ON messages WHEN old.body <> new.body OR old.quotes <> new.quotes BEGIN INSERT INTO message_terms(message_terms, rowid, body, quotes) VALUES ('delete', old.rowid, old.body, old.quotes); INSERT INTO message_terms(rowid, body, quotes) VALUES (new.rowid, new.body, new.quotes); END",
  "INSERT INTO message_terms(message_terms) VALUES ('rebuild')",
].join(';\n');

export class SingleChatHistoryIndex {
  private readonly db: DatabaseSync;
  private readonly fts: boolean;

  constructor(file: string, generation: string) {
    const db = this.db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version !== 0 && version !== 1) throw new Error('SINGLE_CHAT_INDEX_SCHEMA_UNSUPPORTED');
      if (version === 0) this.transaction(() => {
        db.exec(schema);
        try { db.exec(fullText); }
        catch (error) {
          if (!(error instanceof Error) || !/no such module: fts5|no such tokenizer/i.test(error.message)) throw error;
        }
        db.exec('PRAGMA user_version = 1');
      });
      const current = db.prepare('SELECT generation FROM index_generation LIMIT 1').get();
      if (current?.generation !== generation) this.transaction(() => {
        db.exec('DELETE FROM chats; DELETE FROM index_generation;');
        db.prepare('INSERT INTO index_generation VALUES (?)').run(generation);
      });
      this.fts = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name = 'message_terms'").get());
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  marker(id: string): IndexMarker | undefined {
    const row = this.db.prepare('SELECT metadata, pending, revision, length, fingerprint FROM chats WHERE id = ?').get(id);
    if (!row) return undefined;
    return {
      metadata: decodeIndexJson(String(row.metadata)), pending: Boolean(row.pending),
      revision: Number(row.revision), length: Number(row.length), fingerprint: String(row.fingerprint),
    };
  }

  message(conversationId: string, messageId: string): Message | undefined {
    const row = this.db.prepare('SELECT payload FROM messages WHERE chat_id = ? AND id = ?').get(conversationId, messageId);
    return row ? decodeIndexJson(String(row.payload)) : undefined;
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  }

  replace(marker: IndexMarker, messages: Iterable<Message>) {
    const id = marker.metadata.id;
    this.transaction(() => {
      this.saveMarker(marker);
      this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
      const insert = this.db.prepare('INSERT INTO messages(chat_id, id, position, payload, body, quotes, is_user) VALUES (?, ?, ?, ?, ?, ?, ?)');
      let position = 0;
      for (const message of messages) insert.run(id, message.id, position++, JSON.stringify(message), searchableHistoryText(message.content), normalizeHistoryQuery(message.quote?.text ?? ''), Number(isAsteriumUser(message.authorId)));
    });
  }

  checkpoint(marker: IndexMarker, upsert: Message[], remove: string[], order?: string[]) {
    const id = marker.metadata.id;
    this.transaction(() => {
      this.saveMarker(marker);
      const deletion = this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND id = ?');
      for (const messageId of remove) deletion.run(id, messageId);
      let position = Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) AS n FROM messages WHERE chat_id = ?').get(id)?.n) + 1;
      const put = this.db.prepare([
        'INSERT INTO messages(chat_id, id, position, payload, body, quotes, is_user) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'ON CONFLICT(chat_id, id) DO UPDATE SET payload = excluded.payload, body = excluded.body, quotes = excluded.quotes, is_user = excluded.is_user',
      ].join(' '));
      for (const message of upsert) put.run(id, message.id, position++, JSON.stringify(message), searchableHistoryText(message.content), normalizeHistoryQuery(message.quote?.text ?? ''), Number(isAsteriumUser(message.authorId)));
      if (order) {
        const present = this.db.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY position').all(id).map(row => String(row.id));
        const requested = new Set(order);
        const update = this.db.prepare('UPDATE messages SET position = ? WHERE chat_id = ? AND id = ?');
        [...order, ...present.filter(messageId => !requested.has(messageId))].forEach((messageId, index) => update.run(index, id, messageId));
      }
    });
  }

  page(request: SingleChatPageRequest): SingleChatHistoryPage {
    const { conversationId: id, before, after, around } = request;
    const anchor = before ?? after ?? around;
    const position = anchor ? this.position(id, anchor) : undefined;
    if (anchor && position === undefined) return { messages: [], hasOlder: false, hasNewer: false };
    const columns = 'SELECT payload, position FROM messages WHERE chat_id = ?';
    const size = SINGLE_CHAT_PAGE_SIZE;
    const candidates = around && position !== undefined
      ? [
        ...this.db.prepare(columns + ' AND position < ? ORDER BY position DESC LIMIT ?').all(id, position, size / 2).reverse(),
        ...this.db.prepare(columns + ' AND position >= ? ORDER BY position LIMIT ?').all(id, position, size / 2),
      ]
      : after && position !== undefined
        ? this.db.prepare(columns + ' AND position > ? ORDER BY position LIMIT ?').all(id, position, size)
        : before && position !== undefined
          ? this.db.prepare(columns + ' AND position < ? ORDER BY position DESC LIMIT ?').all(id, position, size).reverse()
          : this.db.prepare(columns + ' ORDER BY position DESC LIMIT ?').all(id, size).reverse();
    const center = around ? candidates.findIndex(row => row.position === position) : after ? 0 : candidates.length - 1;
    const rows = fitPage(candidates, center);
    return {
      messages: rows.map(row => decodeIndexJson(String(row.payload))),
      turnOffset: rows.length ? Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND is_user = 1 AND position < ?').get(id, Number(rows[0].position))?.n) : 0,
      hasOlder: Boolean(rows.length && this.db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND position < ? LIMIT 1').get(id, Number(rows[0].position))),
      hasNewer: Boolean(rows.length && this.db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND position > ? LIMIT 1').get(id, Number(rows.at(-1)?.position))),
    };
  }

  search(request: SingleChatSearchRequest): SingleChatSearchResult {
    const query = normalizeHistoryQuery(request.query.trim());
    if (!query) return { conversationIds: [], messageIds: [], hasMore: false };
    const id = request.conversationId;
    const anchored = id && request.after ? this.position(id, request.after) : undefined;
    if (request.after && anchored === undefined) return { conversationIds: [], messageIds: [], hasMore: false };
    const useFts = this.fts && Array.from(query).length >= 3 && !query.includes('\0');
    const phrase = '"' + query.replaceAll('"', '""') + '"';
    if (!id) {
      const matches = this.db.prepare(useFts
        ? 'SELECT DISTINCT m.chat_id FROM message_terms JOIN messages m ON m.rowid = message_terms.rowid WHERE message_terms MATCH ?'
        : 'SELECT DISTINCT chat_id FROM messages WHERE instr(body, ?) > 0 OR instr(quotes, ?) > 0')
        .all(...(useFts ? [phrase] : [query, query]));
      return { conversationIds: matches.map(row => String(row.chat_id)), messageIds: [], hasMore: false };
    }
    const size = SINGLE_CHAT_SEARCH_SIZE;
    const rows = this.db.prepare(useFts
      ? 'SELECT m.id FROM message_terms JOIN messages m ON m.rowid = message_terms.rowid WHERE message_terms MATCH ? AND m.chat_id = ? AND m.position > ? ORDER BY m.position LIMIT ?'
      : 'SELECT id FROM messages WHERE instr(body, ?) > 0 AND chat_id = ? AND position > ? ORDER BY position LIMIT ?')
      .all(useFts ? 'body : ' + phrase : query, id, anchored ?? -1, size + 1);
    return { conversationIds: rows.length ? [id] : [], messageIds: rows.slice(0, size).map(row => String(row.id)), hasMore: rows.length > size };
  }

  // Main readers need the projection fields, without transferring rich tool timelines into their queries.
  projection(id: string): Message[] {
    return this.db.prepare("SELECT json_remove(payload, '$.timeline', '$.toolEvents', '$.attachments', '$.quote') AS data FROM messages WHERE chat_id = ? ORDER BY position")
      .all(id).map(row => decodeIndexJson(String(row.data)));
  }

  private position(chatId: string, id: string) {
    const row = this.db.prepare('SELECT position FROM messages WHERE chat_id = ? AND id = ?').get(chatId, id);
    return row ? Number(row.position) : undefined;
  }

  private saveMarker(marker: IndexMarker) {
    this.db.prepare([
      'INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?)',
      'ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata, pending = excluded.pending, revision = excluded.revision, length = excluded.length, fingerprint = excluded.fingerprint',
    ].join(' ')).run(marker.metadata.id, JSON.stringify(marker.metadata), Number(marker.pending), marker.revision, marker.length, marker.fingerprint);
  }

  private transaction<T>(action: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function fitPage<T extends { payload?: unknown }>(rows: T[], center: number) {
  if (!rows.length || center < 0) return rows;
  let first = center;
  let last = center;
  let bytes = Buffer.byteLength(String(rows[center].payload));
  while (first > 0 || last < rows.length - 1) {
    const left = first > 0 ? Buffer.byteLength(String(rows[first - 1].payload)) : Infinity;
    const right = last < rows.length - 1 ? Buffer.byteLength(String(rows[last + 1].payload)) : Infinity;
    const chooseLeft = left <= right;
    const next = chooseLeft ? left : right;
    if (bytes + next > PAGE_PAYLOAD_BUDGET) break;
    bytes += next;
    if (chooseLeft) first--;
    else last++;
  }
  return rows.slice(first, last + 1);
}

function decodeIndexJson<T>(value: string): T {
  try { return JSON.parse(value) as T; }
  catch (error) { throw new Error('SINGLE_CHAT_INDEX_INVALID_ROW', { cause: error }); }
}
