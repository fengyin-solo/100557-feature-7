import {
  dutyMonitorAt,
  expectedMediaBatch,
  isoWeekNumber,
  zoneCodeOfPoint,
} from './cleanroom-domain'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pharma-cleanroom:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asDate(value: unknown): Date {
  const date = new Date(String(value ?? ''))
  return Number.isNaN(date.getTime()) ? new Date() : date
}

// 迁移存量环境监测记录：按旧记录回填归属区、本周轮值监测人、对应培养基批号。
// 悬浮粒子数双份录入中的复核份与原读数保持一致，保证旧数据本身仍是“同一份”。
function migrateCleanroomRow(row: EntryRow): EntryRow {
  if (typeof row['归属区'] === 'string' && row['归属区'] !== '') {
    return row
  }
  const point = String(row['监测点位'] ?? '')
  const zoneCode = zoneCodeOfPoint(point)
  const monitoredAt = asDate(row['监测日期'])
  const isPending = String(row.status) === '待监测'
  const particles = String(row['悬浮粒子数'] ?? '')
  return {
    ...row,
    归属区: zoneCode,
    培养基批号: expectedMediaBatch(point),
    轮值周次: isoWeekNumber(monitoredAt),
    监测人: isPending ? '' : dutyMonitorAt(zoneCode, monitoredAt),
    悬浮粒子数_复核: particles,
  }
}

function migrate(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (!Array.isArray(data.cleanroom)) {
    return data
  }
  return { ...data, cleanroom: data.cleanroom.map(migrateCleanroomRow) }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = migrate(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    const migrated = migrate(merged)
    // 只有真的补了字段才回写，避免每次打开都触发存储写入。
    if (JSON.stringify(migrated) !== raw) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    }
    return migrated
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
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
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  // cleanroom 的种子是旧结构，重置后立即走一遍迁移补齐归属字段。
  const finalRows = key === 'cleanroom' ? rows.map(migrateCleanroomRow) : rows
  saveRows(key, finalRows)
  return finalRows
}

export function storageKey(): string {
  return STORAGE_KEY
}
