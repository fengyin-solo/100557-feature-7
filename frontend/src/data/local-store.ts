import { SEED_ROWS } from './seed'
import {
  backfillMediaBatch,
  CLEANROOM_KEY,
  LEGACY_POINT_ALIASES,
  PARTICLE_ALIASES,
  PARTICLE_FIELD,
  pointGuide,
  toISODate,
} from './cleanroom-policy'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pharma-cleanroom:entries'
const SCHEMA_KEY = 'pharma-cleanroom:schema'
// v2：点位划片归属、监测人按周轮换、培养基批号与点位对应、悬浮粒子数单一字段。
const CURRENT_SCHEMA = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function recordDate(row: EntryRow, fallback: Date): Date {
  const raw = String(row['监测日期'] ?? '')
  const parsed = new Date(`${raw}T00:00:00`)
  return raw && !Number.isNaN(parsed.getTime()) ? parsed : fallback
}

// 迁移存量环境监测记录：按旧记录回填归属、监测人、培养基批号，
// 两处取来的悬浮粒子数合并为同一份，非法值清空等待重填。
function migrateCleanroomRows(rows: EntryRow[]): EntryRow[] {
  const today = new Date()
  return rows.map((row) => {
    const next: EntryRow = { ...row }
    const rawPoint = String(next['监测点位'] ?? '').trim()
    const point = LEGACY_POINT_ALIASES[rawPoint] ?? rawPoint
    next['监测点位'] = point

    const guide = pointGuide(point)
    const when = recordDate(next, today)

    if (guide) {
      next['所属生产区'] = guide.zone
      if (!String(next['洁净级别'] ?? '').trim() || LEGACY_POINT_ALIASES[rawPoint]) {
        next['洁净级别'] = guide.grade
      }
    }

    // 悬浮粒子数两处取来的为同一份：只保留唯一字段，别名合并后删除。
    const canonical = next[PARTICLE_FIELD]
    let particleRaw: unknown = canonical
    if (canonical === undefined || canonical === null || String(canonical).trim() === '') {
      for (const alias of PARTICLE_ALIASES) {
        const aliasValue = next[alias]
        if (aliasValue !== undefined && aliasValue !== null && String(aliasValue).trim() !== '') {
          particleRaw = aliasValue
          break
        }
      }
    }
    for (const alias of PARTICLE_ALIASES) {
      delete next[alias]
    }
    const text = particleRaw === undefined || particleRaw === null ? '' : String(particleRaw).trim()
    next[PARTICLE_FIELD] = /^\d+$/.test(text) ? Number(text) : ''
    if (text && !/^\d+$/.test(text)) {
      next['粒子回填说明'] = '旧记录悬浮粒子数为非法值，已清空待重填'
    }

    if (guide) {
      const batch = String(next['培养基批号'] ?? '').trim()
      next['培养基批号'] = batch || backfillMediaBatch(point, when)
      const monitor = String(next['监测人'] ?? '').trim()
      if (!monitor || LEGACY_POINT_ALIASES[rawPoint]) {
        next['监测人'] = '存量回填'
      }
    }

    if (!String(next['监测日期'] ?? '').trim()) {
      next['监测日期'] = toISODate(when)
    }
    delete next['监测状态']
    return next
  })
}

function migrate(
  data: Record<string, EntryRow[]>,
  schemaVersion: number,
): Record<string, EntryRow[]> {
  if (schemaVersion >= CURRENT_SCHEMA) {
    return data
  }
  return {
    ...data,
    [CLEANROOM_KEY]: migrateCleanroomRows(data[CLEANROOM_KEY] ?? []),
  }
}

function persist(data: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    window.localStorage.setItem(SCHEMA_KEY, String(CURRENT_SCHEMA))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  const schemaVersion = Number(window.localStorage.getItem(SCHEMA_KEY) ?? '1')
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    const migrated = migrate(merged, Number.isFinite(schemaVersion) ? schemaVersion : 1)
    persist(migrated)
    return migrated
  } catch {
    persist(fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
