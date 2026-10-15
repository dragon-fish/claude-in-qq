/**
 * Group message history: every group message the bridge receives, from people
 * and other bots alike, and every one it sends. A group session only wakes
 * when an op @'s this bot, so this is how its agent learns what was said in
 * between.
 *
 * `node:sqlite`, not `bun:sqlite`: the latter is a runtime-private API, the
 * former is the one shared with Node and supported by bun ≥ 1.4.
 *
 * Knows nothing about QQ events or Claude; the bridge maps both onto rows.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type HistoryMention = { openid: string; name: string; is_you?: boolean }

export type HistoryMessage = {
  group_openid: string
  message_id: string
  author_openid: string
  author_name: string
  is_bot: boolean
  /** Sent by this bot. Its own group messages carry no author id of their own. */
  is_self: boolean
  /** As QQ carried it: mentions appear as `<@member_openid>`. */
  content: string
  mentions: HistoryMention[]
  /** `msg_idx` of an inbound message, `ext_info.ref_idx` of one this bot sent: what a quote of it carries. */
  ref_idx: string | null
  /** Milliseconds. */
  created_at: number
}

export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export const HISTORY_DEFAULT_LIMIT = 20
export const HISTORY_MAX_LIMIT = 100

type Row = Omit<HistoryMessage, 'is_bot' | 'is_self' | 'mentions'> & {
  is_bot: number
  is_self: number
  mentions_json: string
}

function fromRow(r: Row): HistoryMessage {
  let mentions: HistoryMention[] = []
  try {
    mentions = JSON.parse(r.mentions_json)
  } catch {
    // A row is still worth returning without its mention names.
  }
  return {
    group_openid: r.group_openid,
    message_id: r.message_id,
    author_openid: r.author_openid,
    author_name: r.author_name,
    is_bot: r.is_bot === 1,
    is_self: r.is_self === 1,
    content: r.content,
    mentions,
    ref_idx: r.ref_idx,
    created_at: r.created_at,
  }
}

const COLUMNS =
  'group_openid, message_id, author_openid, author_name, is_bot, is_self, content, mentions_json, ref_idx, created_at'

export class History {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    // Ordered by rowid, which is arrival order. QQ timestamps are whole
    // seconds, so several messages share one and cannot order themselves.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        group_openid  TEXT    NOT NULL,
        message_id    TEXT    NOT NULL,
        author_openid TEXT    NOT NULL,
        author_name   TEXT    NOT NULL,
        is_bot        INTEGER NOT NULL,
        is_self       INTEGER NOT NULL,
        content       TEXT    NOT NULL,
        mentions_json TEXT    NOT NULL,
        ref_idx       TEXT,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (group_openid, message_id)
      );
      CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at);
    `)
  }

  /**
   * Store a message. Returns false when it was already there: QQ documents
   * that one msg_id may be pushed more than once, and the caller must not act
   * on it twice.
   */
  record(m: HistoryMessage): boolean {
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO messages (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        m.group_openid,
        m.message_id,
        m.author_openid,
        m.author_name,
        m.is_bot ? 1 : 0,
        m.is_self ? 1 : 0,
        m.content,
        JSON.stringify(m.mentions),
        m.ref_idx,
        m.created_at,
      )
    return Number(res.changes) > 0
  }

  get(group: string, messageId: string): HistoryMessage | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE group_openid = ? AND message_id = ?`)
      .get(group, messageId) as Row | undefined
    return row ? fromRow(row) : null
  }

  /**
   * The latest messages of a group, oldest first. `beforeMessageId` pages
   * backwards from (and excluding) that message; an id not on record returns
   * nothing rather than silently starting from the newest. `query` matches
   * content or author name as a plain substring.
   */
  query(opts: { group: string; limit?: number; beforeMessageId?: string; query?: string }): HistoryMessage[] {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? HISTORY_DEFAULT_LIMIT)), HISTORY_MAX_LIMIT)
    const where = ['group_openid = ?']
    const args: (string | number)[] = [opts.group]

    if (opts.beforeMessageId) {
      const anchor = this.db
        .prepare('SELECT rowid AS r FROM messages WHERE group_openid = ? AND message_id = ?')
        .get(opts.group, opts.beforeMessageId) as { r: number } | undefined
      if (!anchor) return []
      where.push('rowid < ?')
      args.push(anchor.r)
    }
    if (opts.query) {
      const like = `%${opts.query.replace(/[\\%_]/g, c => `\\${c}`)}%`
      where.push(`(content LIKE ? ESCAPE '\\' OR author_name LIKE ? ESCAPE '\\')`)
      args.push(like, like)
    }

    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...args, limit) as Row[]
    return rows.reverse().map(fromRow)
  }

  /** This bot's own messages in a group, newest first. */
  ownRecent(group: string, limit: number): HistoryMessage[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE group_openid = ? AND is_self = 1 ORDER BY rowid DESC LIMIT ?`)
      .all(group, limit) as Row[]
    return rows.map(fromRow)
  }

  /** Forget a message, so history matches a group a recall changed. */
  remove(group: string, messageId: string): void {
    this.db.prepare('DELETE FROM messages WHERE group_openid = ? AND message_id = ?').run(group, messageId)
  }

  /** The most recent display name seen for a member, in any group. */
  nameOf(openid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT author_name FROM messages WHERE author_openid = ? AND author_name != '' ORDER BY rowid DESC LIMIT 1`,
      )
      .get(openid) as { author_name: string } | undefined
    return row?.author_name ?? null
  }

  /** Groups on record, most recently active first. */
  groups(): { group_openid: string; messages: number; last_at: number }[] {
    return this.db
      .prepare(
        'SELECT group_openid, COUNT(*) AS messages, MAX(created_at) AS last_at FROM messages GROUP BY group_openid ORDER BY last_at DESC',
      )
      .all() as { group_openid: string; messages: number; last_at: number }[]
  }

  /** Drop everything older than the retention window. Returns how many rows went. */
  prune(now = Date.now()): number {
    const res = this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(now - HISTORY_RETENTION_MS)
    return Number(res.changes)
  }

  close(): void {
    this.db.close()
  }
}
