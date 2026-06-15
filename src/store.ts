import fs from 'fs'
import path from 'path'
import { Pool } from 'pg'
import { config } from './config'
import type { Lang } from './i18n'

export type ClientStatus =
  | 'pending'
  | 'trial'
  | 'active'
  | 'suspended'
  | 'pending_payment'

export interface ClientRecord {
  chatId: number
  lang: Lang
  name: string
  email: string
  tenantId: string | null
  password: string | null
  status: ClientStatus
  trialStartDate: string | null
  paidUntil: string | null
  trialReminderSent: boolean
  createdAt: string
}

export type Step = 'lang' | 'name' | 'email' | 'persona' | 'payment' | 'done'

export interface UserState {
  step: Step
  lang?: Lang
  name?: string
  email?: string
  persona?: string
  personaMode?: 'pdf' | 'url' | 'text'
}

// ─── In-memory cache ─────────────────────────────────────────────

const cache = new Map<number, ClientRecord>()

// ─── PostgreSQL pool (only if DATABASE_URL is set) ───────────────

let pool: Pool | null = null

function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null
  if (!pool) pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 30_000,
  })
  return pool
}

async function ensureTable(p: Pool): Promise<void> {
  await p.query(`
    CREATE TABLE IF NOT EXISTS clients (
      chat_id BIGINT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `)
}

async function pgSave(record: ClientRecord): Promise<void> {
  const p = getPool()
  if (!p) return
  try {
    await p.query(
      `INSERT INTO clients (chat_id, data) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET data = EXCLUDED.data`,
      [record.chatId, JSON.stringify(record)],
    )
  } catch (err) {
    console.error('[store] pg write error', err)
  }
}

// ─── File fallback (only used when no DATABASE_URL) ──────────────

const dataDir = path.dirname(config.DATA_FILE)
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

function fileLoad(): Record<string, ClientRecord> {
  if (!fs.existsSync(config.DATA_FILE)) return {}
  try { return JSON.parse(fs.readFileSync(config.DATA_FILE, 'utf-8')).clients ?? {} } catch { return {} }
}

function fileSave(record: ClientRecord): void {
  const clients = fileLoad()
  clients[String(record.chatId)] = record
  fs.writeFileSync(config.DATA_FILE, JSON.stringify({ clients }, null, 2), 'utf-8')
}

function fileUpdate(chatId: number, updates: Partial<ClientRecord>): void {
  const clients = fileLoad()
  if (clients[String(chatId)]) {
    clients[String(chatId)] = { ...clients[String(chatId)], ...updates }
    fs.writeFileSync(config.DATA_FILE, JSON.stringify({ clients }, null, 2), 'utf-8')
  }
}

// ─── Init: load from PostgreSQL into cache on startup ────────────

export async function initStore(): Promise<void> {
  const p = getPool()
  if (!p) {
    // no DATABASE_URL — load from file into cache
    const clients = fileLoad()
    for (const rec of Object.values(clients)) cache.set(rec.chatId, rec)
    console.log(`[store] file mode — ${cache.size} clients loaded`)
    return
  }
  try {
    await ensureTable(p)
    const { rows } = await p.query('SELECT data FROM clients')
    for (const row of rows) {
      const rec: ClientRecord = row.data
      cache.set(rec.chatId, rec)
    }
    console.log(`[store] postgres mode — ${cache.size} clients loaded`)
  } catch (err) {
    console.error('[store] pg init error', err)
  }
}

// ─── Public API (synchronous reads from cache) ───────────────────

export function getClient(chatId: number): ClientRecord | null {
  return cache.get(chatId) ?? null
}

export function saveClient(record: ClientRecord): void {
  cache.set(record.chatId, record)
  if (getPool()) {
    pgSave(record)
  } else {
    fileSave(record)
  }
}

export function updateClient(chatId: number, updates: Partial<ClientRecord>): void {
  const existing = cache.get(chatId)
  if (!existing) return
  const updated = { ...existing, ...updates }
  cache.set(chatId, updated)
  if (getPool()) {
    pgSave(updated)
  } else {
    fileUpdate(chatId, updates)
  }
}

export function getAllClients(): ClientRecord[] {
  return Array.from(cache.values())
}

export function getClientByEmail(email: string): ClientRecord | null {
  for (const rec of cache.values()) {
    if (rec.email.toLowerCase() === email.toLowerCase()) return rec
  }
  return null
}
