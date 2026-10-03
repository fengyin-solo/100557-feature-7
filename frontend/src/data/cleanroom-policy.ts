// 洁净区环境监测的归属规则集中在这一份：生产区按监测点位划片、监测人按周轮换、
// 培养基批号与点位绑定、悬浮粒子数单一数据源、状态顺次推进。页面与本地服务都按此判定。

export const CLEANROOM_KEY = 'cleanroom'
export const CHANGECONTROL_KEY = 'changecontrol'

export const CLEANROOM_STATUSES = ['待监测', '监测中', '已达标', '超标预警'] as const

// 状态只允许沿登记过的边顺次往下走；倒序、跳步一律挡回。
// 「监测中」之后分两支：达标（已达标）或超标（超标预警），两者都在当前状态之后。
export const FORWARD_TARGETS: Record<string, string[]> = {
  待监测: ['监测中'],
  监测中: ['已达标', '超标预警'],
  已达标: [],
  超标预警: [],
}

export type PointGuide = {
  point: string
  zone: string
  grade: string
  mediaPrefix: string
  seq: string
}

// 生产区按监测点位划片：点位落在哪个区是归属的唯一依据，登记在案才算划入。
export const PRODUCTION_ZONES = ['一区', '二区'] as const

const POINT_REGISTRY: PointGuide[] = [
  { point: '灌封室-A1', zone: '一区', grade: 'A级', mediaPrefix: 'MCA', seq: '01' },
  { point: '灌封室-A2', zone: '一区', grade: 'A级', mediaPrefix: 'MCA', seq: '02' },
  { point: '配液室-B1', zone: '一区', grade: 'B级', mediaPrefix: 'MCB', seq: '03' },
  { point: '轧盖室-B2', zone: '二区', grade: 'B级', mediaPrefix: 'MCB', seq: '04' },
  { point: '二更间-C1', zone: '二区', grade: 'C级', mediaPrefix: 'MCC', seq: '05' },
  { point: '器具清洗间-C2', zone: '二区', grade: 'C级', mediaPrefix: 'MCC', seq: '06' },
]

// 旧版示例数据里点位是占位文字，迁移时按旧记录回填到真实划片点位。
export const LEGACY_POINT_ALIASES: Record<string, string> = {
  洁净区环境监测样例1: '灌封室-A1',
  洁净区环境监测样例2: '轧盖室-B2',
  洁净区环境监测样例3: '二更间-C1',
}

// 监测人每周轮换：奇数周取名单首位，偶数周取次位（按 ISO 周号计）。
const ZONE_MONITORS: Record<string, string[]> = {
  一区: ['王敏', '赵雷'],
  二区: ['陈洁', '刘洋'],
}

// 悬浮粒子数只有这一个正式字段：两处取来的读数本就是同一份，只存、只显、只回写这一处。
export const PARTICLE_FIELD = '悬浮粒子数'
// 旧版本里可能散落的重复字段，存量迁移时合并进唯一字段后即删除。
export const PARTICLE_ALIASES = ['悬浮粒子计数', '悬浮粒子两处读数', '悬浮粒子(两处)', '粒子数']

export function pointGuide(point: string): PointGuide | undefined {
  return POINT_REGISTRY.find((item) => item.point === point)
}

export function allPointGuides(): PointGuide[] {
  return POINT_REGISTRY
}

// ISO-8601 周号：周一为一周起点，用来决定本周哪个监测人当值。
export function isoWeekNumber(when: Date = new Date()): number {
  const utc = new Date(Date.UTC(when.getFullYear(), when.getMonth(), when.getDate()))
  const dayNum = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1))
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

function rotationSlot(when: Date): number {
  return (isoWeekNumber(when) - 1) % ZONE_MONITORS[PRODUCTION_ZONES[0]].length
}

export function monitorOfZone(zone: string, when: Date = new Date()): string {
  const roster = ZONE_MONITORS[zone]
  if (!roster) {
    return ''
  }
  return roster[rotationSlot(when)]
}

export function allMonitors(): string[] {
  return Object.values(ZONE_MONITORS).flat()
}

export type ZoneRoster = {
  zone: string
  monitor: string
  points: PointGuide[]
}

export type WeeklyRoster = {
  week: number
  date: string
  zones: ZoneRoster[]
}

export function toISODate(when: Date = new Date()): string {
  const month = String(when.getMonth() + 1).padStart(2, '0')
  const day = String(when.getDate()).padStart(2, '0')
  return `${when.getFullYear()}-${month}-${day}`
}

export function weeklyRoster(when: Date = new Date()): WeeklyRoster {
  return {
    week: isoWeekNumber(when),
    date: toISODate(when),
    zones: PRODUCTION_ZONES.map((zone) => ({
      zone,
      monitor: monitorOfZone(zone, when),
      points: POINT_REGISTRY.filter((guide) => guide.zone === zone),
    })),
  }
}

// 培养基批号形如 MCA-2640-01：前缀随点位走，中间是年份周号，尾号是点位流水。
function yearWeekTag(when: Date): string {
  return `${String(when.getFullYear()).slice(-2)}${String(isoWeekNumber(when)).padStart(2, '0')}`
}

export function mediaBatchExample(point: string, when: Date = new Date()): string {
  const guide = pointGuide(point)
  if (!guide) {
    return ''
  }
  return `${guide.mediaPrefix}-${yearWeekTag(when)}-${guide.seq}`
}

export function mediaBatchMatchesPoint(point: string, batch: string): boolean {
  const guide = pointGuide(point)
  if (!guide) {
    return false
  }
  return new RegExp(`^${guide.mediaPrefix}-\\d{4}-${guide.seq}$`).test(batch.trim())
}

// 存量记录缺培养基批号时，按点位与记录日期补一份对应的批号。
export function backfillMediaBatch(point: string, when: Date): string {
  return mediaBatchExample(point, when)
}

export type ParticleCheck = { ok: true; value: number } | { ok: false; reason: 'empty' | 'illegal' }

// 悬浮粒子数只接受非负整数；非法值打回重填。
export function parseParticleCount(raw: unknown): ParticleCheck {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: false, reason: 'empty' }
  }
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    return { ok: false, reason: 'illegal' }
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'illegal' }
  }
  return { ok: true, value }
}

// 统一的取数口：两处取来的为同一份，任何地方都只从唯一字段读，绝不到别名字段里兜底。
export function particleCountOf(row: Record<string, unknown>): string {
  const value = row[PARTICLE_FIELD]
  return value === null || value === undefined ? '' : String(value)
}
