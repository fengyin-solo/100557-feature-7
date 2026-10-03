// 洁净区环境监测的归属与轮值规则，集中在一处：
// - 生产区按监测点位划片，点位落在哪个生产区就归哪个区；
// - 每个生产区的监测人按 ISO 周次在固定名单里轮换，本周谁当班谁才能动手；
// - 培养基批号与点位一一对应，提交时填的批号必须和点位要求的一致。

export type ProductionZone = {
  code: string
  name: string
  monitors: string[]
  points: string[]
}

export const PRODUCTION_ZONES: ProductionZone[] = [
  {
    code: 'A',
    name: 'A生产区',
    monitors: ['张岚', '李越', '周衡'],
    points: ['A区-灌装线1尘埃采样点', 'A区-灌装线2尘埃采样点', 'A区-胶塞加料口采样点'],
  },
  {
    code: 'B',
    name: 'B生产区',
    monitors: ['王澈', '赵屿', '孙芃'],
    points: ['B区-配液罐R201采样点', 'B区-除菌过滤前采样点', 'B区-层流罩LB-03采样点'],
  },
  {
    code: 'C',
    name: 'C生产区',
    monitors: ['陈砚', '林涛', '何汀'],
    points: ['C区-轧盖机CG-12采样点', 'C区-冻干机FD-02采样点', 'C区-外包暂存间采样点'],
  },
]

export const ZONE_BY_CODE = new Map(PRODUCTION_ZONES.map((zone) => [zone.code, zone]))

const POINT_ZONE_INDEX = new Map<string, ProductionZone>(
  PRODUCTION_ZONES.flatMap((zone) => zone.points.map((point) => [point, zone])),
)

const POINT_ORDER = new Map<string, number>(
  PRODUCTION_ZONES.flatMap((zone) => zone.points.map((point, index) => [point, index + 1])),
)

// 旧记录的点位名可能不认识（如“洁净区环境监测样例1”），按点位首字字符码稳定落到某个生产区，
// 保证迁移结果确定、同一点位永远回填到同一个区。
export function zoneCodeOfPoint(point: string): string {
  const known = POINT_ZONE_INDEX.get(point)
  if (known) {
    return known.code
  }
  let hash = 0
  for (const ch of point) {
    hash += ch.codePointAt(0) ?? 0
  }
  return PRODUCTION_ZONES[hash % PRODUCTION_ZONES.length].code
}

export function zoneOfPoint(point: string): ProductionZone {
  return ZONE_BY_CODE.get(zoneCodeOfPoint(point)) ?? PRODUCTION_ZONES[0]
}

export function allKnownPoints(): string[] {
  return PRODUCTION_ZONES.flatMap((zone) => zone.points)
}

// 培养基批号与点位一一对应：按“点位所属区 + 点区内序号”分配固定批号。
export function expectedMediaBatch(point: string): string {
  const zone = zoneOfPoint(point)
  const order = POINT_ORDER.get(point) ?? (pointCode(point) % zone.points.length) + 1
  return `MED-${zone.code}-${String(order).padStart(2, '0')}`
}

function pointCode(point: string): number {
  let hash = 0
  for (const ch of point) {
    hash += ch.codePointAt(0) ?? 0
  }
  return hash
}

// ISO-8601 周序号：跨年以含周四的那一周为准。
export function isoWeekNumber(date: Date = new Date()): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
}

export function currentDutyMonitor(zoneCode: string, date: Date = new Date()): string {
  const zone = ZONE_BY_CODE.get(zoneCode)
  if (!zone) {
    return ''
  }
  return zone.monitors[(isoWeekNumber(date) - 1) % zone.monitors.length]
}

export function dutyMonitorAt(zoneCode: string, date: Date): string {
  return currentDutyMonitor(zoneCode, date)
}

export function dutyWeekLabel(date: Date = new Date()): string {
  return `第${isoWeekNumber(date)}周轮值`
}
