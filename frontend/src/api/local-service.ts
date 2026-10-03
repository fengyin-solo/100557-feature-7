import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  CLEANROOM_KEY,
  CHANGECONTROL_KEY,
  CLEANROOM_STATUSES,
  FORWARD_TARGETS,
  mediaBatchExample,
  mediaBatchMatchesPoint,
  monitorOfZone,
  parseParticleCount,
  PARTICLE_FIELD,
  particleCountOf,
  pointGuide,
  toISODate,
  weeklyRoster,
} from '@/data/cleanroom-policy'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

type CleanroomReadings = {
  particle: string
  settle: string
  temperature: string
  humidity: string
  media: string
}

export type { CleanroomReadings }

// 本周监测值班表：页面渲染归属提示与当值名单时都用这一份。
export function cleanroomRoster(when: Date = new Date()) {
  return weeklyRoster(when)
}

function cleanroomRow(id: number): { rows: EntryRow[]; index: number; row: EntryRow } | null {
  const rows = listRows(CLEANROOM_KEY)
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return null
  }
  return { rows, index, row: rows[index] }
}

// 归属守卫：点位落在哪个区，只有该区本周当值的监测人能提交监测、判定与标记超标。
function ownershipDenied(row: EntryRow, operator: string): string | null {
  const point = String(row['监测点位'] ?? '')
  const guide = pointGuide(point)
  if (!guide) {
    return `监测点位「${point}」未划入任何生产区，无法提交，请先在点位清册登记划片`
  }
  const expected = monitorOfZone(guide.zone)
  if (operator.trim() !== expected) {
    return `越权操作已拒绝：点位「${point}」归属${guide.zone}，本周（第${weeklyRoster().week}周）当值监测人为${expected}，当前操作人${operator.trim() || '（空）'}不属该区监测人`
  }
  return null
}

// 达标记录转只读：别的区动不了，自己区也不能再动。
function readonlyDenied(row: EntryRow): string | null {
  if (String(row.status) === '已达标') {
    return `点位「${String(row['监测点位'] ?? '')}」已判定达标，记录转为只读，任何区与任何动作都不能再修改`
  }
  return null
}

// 状态顺次往下推进：只允许走到登记过的后继状态，倒序、跳步一律挡回。
function forwardDenied(current: string, target: string, action: string): string | null {
  const allowed = FORWARD_TARGETS[current]
  if (!allowed || !allowed.includes(target)) {
    const order = CLEANROOM_STATUSES.join(' → ')
    return `状态不能${action}：当前「${current}」，目标「${target}」不属于顺次后继（状态只许沿 ${order} 推进，倒序已挡回）`
  }
  return null
}

const ACTION_CODES: Record<string, string> = {
  提交监测: 'SUBMIT',
  判定达标: 'PASS',
  标记超标: 'OOS',
}

// 动作回写到变更控制清单：一条监测记录、一个动作只回写一次，重复标记不再追加。
function appendChangeControl(
  crId: number,
  row: EntryRow,
  action: string,
  operator: string,
  target: string,
  readings?: CleanroomReadings,
): boolean {
  const code = ACTION_CODES[action]
  const changeNo = `CHAN-CR-${crId}-${code}`
  const changes = listRows(CHANGECONTROL_KEY)
  if (changes.some((item) => String(item['变更编号']) === changeNo)) {
    return false
  }
  const point = String(row['监测点位'] ?? '')
  const zone = String(row['所属生产区'] ?? '')
  const particle = readings ? readings.particle.trim() : particleCountOf(row)
  const settle = readings ? readings.settle.trim() : String(row['沉降菌数'] ?? '')
  const media = String(row['培养基批号'] ?? '')
  const contentByAction: Record<string, string> = {
    提交监测: `环境监测点位「${point}」（${zone}）提交监测，悬浮粒子数 ${particle}、沉降菌数 ${settle || '—'}，培养基批号 ${media}，监测人 ${operator}`,
    判定达标: `环境监测点位「${point}」（${zone}）判定达标，悬浮粒子数 ${particle}、沉降菌数 ${settle || '—'}，监测人 ${operator}`,
    标记超标: `环境监测点位「${point}」（${zone}）标记超标，悬浮粒子数 ${particle}、沉降菌数 ${settle || '—'}，转超标预警并启动调查，监测人 ${operator}`,
  }
  const nextId = changes.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const record: EntryRow = {
    id: nextId,
    status: target === '超标预警' ? '待评估' : '已批准',
    pending: target === '超标预警',
    abnormal: target === '超标预警',
    变更编号: changeNo,
    变更类别: '环境监测回写',
    涉及工序: `${zone}·${point}`,
    变更内容: contentByAction[action] ?? `环境监测点位「${point}」执行${action}`,
    风险评估:
      target === '超标预警'
        ? '监测结果超标，待评估对产品质量与洁净区维持的影响'
        : '按规程监测/判定，无新增质量风险',
    审批人: operator,
    生效日期: toISODate(),
    变更状态: target === '超标预警' ? '待评估' : '已批准',
  }
  saveRows(CHANGECONTROL_KEY, [...changes, record])
  return true
}

function applyCleanroomAction(
  id: number,
  action: string,
  operator: string,
  readings?: CleanroomReadings,
): ActionResult {
  const target = moduleMeta(CLEANROOM_KEY).actionTargets[action]
  if (!target) {
    return { ok: false, message: `环境监测记录没有登记「${action}」这个动作` }
  }
  const found = cleanroomRow(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的环境监测记录` }
  }
  const { row } = found
  const current = String(row.status)

  const locked = readonlyDenied(row)
  if (locked) {
    return { ok: false, message: locked }
  }

  const deniedByOwner = ownershipDenied(row, operator)
  if (deniedByOwner) {
    return { ok: false, message: deniedByOwner }
  }

  // 这个点位重复标记超标只算一次：已是超标预警时不再重复回写、也不改数。
  if (current === '超标预警' && action === '标记超标') {
    return { ok: true, message: `点位「${String(row['监测点位'] ?? '')}」已是超标预警，重复标记只算一次，未再回写变更控制清单` }
  }

  const deniedByOrder = forwardDenied(current, target, action)
  if (deniedByOrder) {
    return { ok: false, message: deniedByOrder }
  }

  const next: EntryRow = { ...row }

  if (action === '提交监测') {
    if (!readings) {
      return { ok: false, message: '提交监测必须填写监测读数，请在录入行内补齐后重填' }
    }
    const particle = parseParticleCount(readings.particle)
    if (!particle.ok) {
      return {
        ok: false,
        message:
          particle.reason === 'empty'
            ? '悬浮粒子数未填写，不能提交监测，请补填非负整数后重填'
            : `悬浮粒子数「${readings.particle.trim()}」是非法值，只接受非负整数，请打回重填`,
      }
    }
    const point = String(row['监测点位'] ?? '')
    const mediaBatch = readings.media.trim()
    if (!mediaBatchMatchesPoint(point, mediaBatch)) {
      return {
        ok: false,
        message: `培养基批号「${mediaBatch || '（空）'}」与点位「${point}」不对应，正确形式如 ${mediaBatchExample(point)}，请核对后重填`,
      }
    }
    // 悬浮粒子数只落到唯一字段；两处取来的为同一份，不另存第二处。
    next[PARTICLE_FIELD] = particle.value
    next['沉降菌数'] = readings.settle.trim()
    next['温度读数'] = readings.temperature.trim()
    next['相对湿度'] = readings.humidity.trim()
    next['培养基批号'] = mediaBatch
    next['监测人'] = operator.trim()
  }

  next.status = target
  next.pending = target !== CLEANROOM_STATUSES[CLEANROOM_STATUSES.length - 1]
  next.abnormal = target === '超标预警'

  // 先回写变更控制清单，再落监测记录，保证动作业已登记。
  const written = appendChangeControl(id, next, action, operator.trim(), target, readings)
  const rowsAfter = listRows(CLEANROOM_KEY)
  const updatedRows = rowsAfter.map((item) => (Number(item.id) === id ? next : item))
  saveRows(CLEANROOM_KEY, updatedRows)

  const suffix = written
    ? '，已回写变更控制清单'
    : '，变更控制清单已有同动作记录，未重复回写'
  return { ok: true, message: `点位「${String(next['监测点位'] ?? '')}」已${action}，当前状态「${target}」${suffix}` }
}

// 待监测点位先把读数录进来：录数即提交监测，归属、合法性、培养基批号在同一道关里校验。
export function submitCleanroomReadings(
  id: number,
  operator: string,
  readings: CleanroomReadings,
): ActionResult {
  return applyCleanroomAction(id, '提交监测', operator, readings)
}

export function runAction(
  key: string,
  id: number,
  action: string,
  operator = '值班管理员',
): ActionResult {
  if (key === CLEANROOM_KEY) {
    return applyCleanroomAction(id, action, operator)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(key, nextRows)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
