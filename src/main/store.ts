import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppSettings, HistoryEntry, Persona, ChatSession } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

/**
 * 本地存储 —— 人设、记忆、转换历史、设置全部留在本机。
 * 方案书原则二「文档不出本机」的落地点：这里只存元数据与文本，不存文档本体。
 */

let storeDir = ''
let cache: StoreShape | null = null

interface StoreShape {
  settings: AppSettings
  history: HistoryEntry[]
  persona: Persona
  sessions: ChatSession[]
  /** 每日转换计数：date → count */
  quota: Record<string, number>
}

const DEFAULT_PERSONA: Persona = {
  name: '小围',
  description: '一个安静趴在窗边的小人，语气温和、简洁，不说客套话。',
  tone: '温和、直接、偶尔有点俏皮'
}

function filePath(): string {
  return path.join(storeDir, 'store.json')
}

export function initStore(): void {
  storeDir = app.getPath('userData')
  cache = null
}

async function load(): Promise<StoreShape> {
  if (cache) return cache
  const defaults: StoreShape = {
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    persona: { ...DEFAULT_PERSONA },
    sessions: [],
    quota: {}
  }
  try {
    const raw = await fs.readFile(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    cache = {
      settings: { ...defaults.settings, ...(parsed.settings ?? {}) },
      history: parsed.history ?? [],
      persona: { ...defaults.persona, ...(parsed.persona ?? {}) },
      sessions: parsed.sessions ?? [],
      quota: parsed.quota ?? {}
    }
  } catch {
    cache = defaults
  }
  return cache
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.mkdir(storeDir, { recursive: true })
  const tmp = filePath() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8')
  await fs.rename(tmp, filePath()) // 原子写，避免半截文件
}

// ==== 设置 ====

export async function getSettings(): Promise<AppSettings> {
  const s = await load()
  return { ...DEFAULT_SETTINGS, ...s.settings }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const s = await load()
  s.settings = { ...s.settings, ...patch }
  await persist()
  return { ...DEFAULT_SETTINGS, ...s.settings }
}

// ==== 转换历史 ====

export async function getHistory(limit = 100): Promise<HistoryEntry[]> {
  const s = await load()
  return [...s.history].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export async function addHistory(entry: HistoryEntry): Promise<void> {
  const s = await load()
  s.history.unshift(entry)
  s.history = s.history.slice(0, 500) // 只留最近 500 条
  await persist()
}

export async function clearHistory(): Promise<void> {
  const s = await load()
  s.history = []
  await persist()
}

// ==== 人设与记忆 ====

export async function getPersona(): Promise<Persona> {
  const s = await load()
  return s.persona
}

export async function savePersona(p: Persona): Promise<Persona> {
  const s = await load()
  s.persona = p
  await persist()
  return p
}

export async function getSessions(): Promise<ChatSession[]> {
  const s = await load()
  return [...s.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveSession(session: ChatSession): Promise<void> {
  const s = await load()
  const i = s.sessions.findIndex((x) => x.id === session.id)
  if (i >= 0) s.sessions[i] = session
  else s.sessions.push(session)
  await persist()
}

export async function deleteSession(id: string): Promise<void> {
  const s = await load()
  s.sessions = s.sessions.filter((x) => x.id !== id)
  await persist()
}

/** 导出全部本地数据（备份与迁移，方案书「可以备份、迁移、删除」） */
export async function exportAll(): Promise<string> {
  const s = await load()
  const out = path.join(app.getPath('desktop'), `uninvited-backup-${Date.now()}.json`)
  await fs.writeFile(out, JSON.stringify(s, null, 2), 'utf-8')
  return out
}

/** 清空全部本地数据 */
export async function wipeAll(): Promise<void> {
  cache = {
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    persona: { ...DEFAULT_PERSONA },
    sessions: [],
    quota: {}
  }
  await persist()
}

// ==== 每日额度（表 5：免费档每日 5 次转换）====

export async function todayKey(): Promise<string> {
  return new Date().toISOString().slice(0, 10)
}

export async function getQuotaUsed(): Promise<number> {
  const s = await load()
  return s.quota[(await todayKey())] ?? 0
}

export async function consumeQuota(): Promise<number> {
  const s = await load()
  const k = await todayKey()
  s.quota[k] = (s.quota[k] ?? 0) + 1
  await persist()
  return s.quota[k]
}