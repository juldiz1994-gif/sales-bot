import fs from 'fs'
import path from 'path'
import { config } from './config'
import type { Lang } from './i18n'

export type ClientStatus =
  | 'pending'        // тіркелу жіберілді, admin растамаған
  | 'trial'          // 7 күн тегін
  | 'active'         // төленген
  | 'suspended'      // тоқтатылған
  | 'pending_payment' // чек жіберді, admin растамаған

export interface ClientRecord {
  chatId: number
  lang: Lang
  name: string
  email: string
  tenantId: string | null
  password: string | null
  status: ClientStatus
  trialStartDate: string | null   // ISO string
  paidUntil: string | null        // ISO string
  trialReminderSent: boolean
  createdAt: string
}

// Боттағы қадам күйі (жады — сервер өшсе жоғалады, бірақ жеткілікті)
export type Step = 'lang' | 'name' | 'email' | 'done'

export interface UserState {
  step: Step
  lang?: Lang
  name?: string
  email?: string
}

// ─── Файл жүйесі ────────────────────────────────────────────────

const dataDir = path.dirname(config.DATA_FILE)
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

interface Store {
  clients: Record<string, ClientRecord>
}

function load(): Store {
  if (!fs.existsSync(config.DATA_FILE)) return { clients: {} }
  try {
    return JSON.parse(fs.readFileSync(config.DATA_FILE, 'utf-8'))
  } catch {
    return { clients: {} }
  }
}

function save(store: Store) {
  fs.writeFileSync(config.DATA_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

// ─── Public API ─────────────────────────────────────────────────

export function getClient(chatId: number): ClientRecord | null {
  return load().clients[String(chatId)] ?? null
}

export function saveClient(record: ClientRecord): void {
  const store = load()
  store.clients[String(record.chatId)] = record
  save(store)
}

export function updateClient(chatId: number, updates: Partial<ClientRecord>): void {
  const store = load()
  const existing = store.clients[String(chatId)]
  if (existing) {
    store.clients[String(chatId)] = { ...existing, ...updates }
    save(store)
  }
}

export function getAllClients(): ClientRecord[] {
  return Object.values(load().clients)
}
