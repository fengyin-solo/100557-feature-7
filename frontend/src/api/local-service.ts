import {
  currentDutyMonitor,
  dutyWeekLabel,
  expectedMediaBatch,
  isoWeekNumber,
  zoneCodeOfPoint,
  zoneOfPoint,
} from '@/data/cleanroom-domain'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type {
  ActionContext,
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 洁净区状态只许往下走：达标即终态只读，倒序一律挡回。
// 监测中的实测结论是「达标 / 超标」二选一，超标预警是监测中向前的判定分支（不是倒序）。
const CLEANROOM_READONLY = '已达标'
// 达标与超标都是监测的终态，到达后都不再挂待处理。
const CLEANROOM_TERMINAL = ['已达标', '超标预警']
const CLEANROOM_FORWARD: Record<string, string[]> = {
  待监测: ['监测中'],
  监测中: ['已达标', '超标预警'],
}

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

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// 悬浮粒子数必须是非负整数；负数、小数、文字、空值一律算非法值。
function parseParticleCount(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

type Actor = { zoneCode: string; monitor: string }

function currentActor(): Actor | null {
  try {
    const store = useSessionStore()
    if (!store.monitor) {
      return null
    }
    return { zoneCode: store.zoneCode, monitor: store.monitor }
  } catch {
    return null
  }
}

// 洁净区动作的统一闸门：越权、只读、倒序都在这里挡住并写明原因。
// 页面只拿它判断按钮置灰，真正提交时 runAction 会再校验一遍，绕开页面也拦得住。
export function checkCleanroomAction(row: EntryRow, action: string): ActionResult {
  const target = MODULE_BY_KEY.get('cleanroom')?.actionTargets[action]
  if (!target) {
    return { ok: false, message: `环境监测记录没有登记「${action}」这个动作` }
  }
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `点位已经是「${target}」，${action}只算一次，无需重复操作` }
  }
  if (current === CLEANROOM_READONLY) {
    return {
      ok: false,
      message: '该记录已判定达标并转为只读，任何生产区（含归属区）都不能再改动',
    }
  }
  // 归属优先：不是自己片区的点位，直接按越权拒绝，不暴露状态层面的原因。
  const point = String(row['监测点位'] ?? '')
  const ownerCode = zoneCodeOfPoint(point)
  const owner = zoneOfPoint(point)
  const actor = currentActor()
  if (!actor) {
    return { ok: false, message: '当前没有选择监测人身份，无法提交任何监测动作' }
  }
  if (actor.zoneCode !== ownerCode) {
    return {
      ok: false,
      message: `越权拒绝：点位「${point}」按划片归属${owner.name}，您当前是${actor.zoneCode}生产区监测人，只有归属区监测人能${action}`,
    }
  }
  const duty = currentDutyMonitor(ownerCode)
  if (actor.monitor !== duty) {
    return {
      ok: false,
      message: `越权拒绝：${owner.name}${dutyWeekLabel()}轮值监测人为「${duty}」，「${actor.monitor}」本周不具备该点位的${action}权限`,
    }
  }
  // 归属无误后再判状态：只许顺次往下推进，倒序与往回走一律挡回。
  const allowed = CLEANROOM_FORWARD[current] ?? []
  if (!allowed.includes(target)) {
    return {
      ok: false,
      message: `状态只能顺次往下推进，当前「${current}」不能${action}到「${target}」，倒序一律挡回`,
    }
  }
  return { ok: true, message: '' }
}

// 提交监测时的录入校验：培养基批号必须与点位对应；悬浮粒子数两处独立录入且必须为同一份合法值。
function validateMonitoringPayload(row: EntryRow, payload: Record<string, string>): ActionResult {
  const point = String(row['监测点位'] ?? '')
  const expected = expectedMediaBatch(point)
  const media = String(payload['培养基批号'] ?? '').trim()
  if (media !== expected) {
    return {
      ok: false,
      message: `培养基批号与点位不对应：点位「${point}」应使用「${expected}」，本次填的是「${media || '空'}」，请核对后重新提交`,
    }
  }
  const firstRaw = String(payload['悬浮粒子数'] ?? '')
  const secondRaw = String(payload['悬浮粒子数_复核'] ?? '')
  const first = parseParticleCount(firstRaw)
  const second = parseParticleCount(secondRaw)
  if (first === null) {
    return {
      ok: false,
      message: `悬浮粒子数第一处录入为非法值「${firstRaw}」，必须是大于等于 0 的整数，请修改后重新提交`,
    }
  }
  if (second === null) {
    return {
      ok: false,
      message: `悬浮粒子数第二处录入为非法值「${secondRaw}」，必须是大于等于 0 的整数，请修改后重新提交`,
    }
  }
  if (first !== second) {
    return {
      ok: false,
      message: `两处录入的悬浮粒子数不是同一份：${first} ≠ ${second}，请按同一份读数重新录入`,
    }
  }
  return { ok: true, message: '' }
}

// 环境监测动作成功后，向变更控制清单回写一条联动记录。
function appendChangeControlEntry(args: {
  row: EntryRow
  action: string
  target: string
  actor: Actor
}): void {
  const { row, action, target, actor } = args
  const rows = listRows('changecontrol')
  const serial =
    rows.reduce((max, item) => {
      const code = String(item['变更编号'] ?? '')
      const matched = /^CHAN-EM-(\d+)$/.exec(code)
      return matched ? Math.max(max, Number(matched[1])) : max
    }, 0) + 1
  const zone = zoneOfPoint(String(row['监测点位'] ?? ''))
  const isOut = target === '超标预警'
  const entry: EntryRow = {
    id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
    status: '评估中',
    pending: true,
    abnormal: isOut,
    变更编号: `CHAN-EM-${String(serial).padStart(4, '0')}`,
    变更类别: '环境监测联动',
    涉及工序: '洁净区环境监测',
    变更内容: `${action}：点位「${row['监测点位']}」（${zone.name}）由「${row.status}」流转为「${target}」`,
    风险评估: isOut
      ? '悬浮粒子/微生物超标预警联动登记，需评估调查与处置措施'
      : '常规环境监测状态流转，按变更清单留痕评估',
    审批人: `${actor.monitor}（${zone.name}·${dutyWeekLabel()}）提交，待质量部评估`,
    生效日期: todayText(),
    变更状态: `环境监测记录#${row.id}已${action}`,
  }
  saveRows('changecontrol', [...rows, entry])
}

function runCleanroomAction(
  row: EntryRow,
  index: number,
  action: string,
  target: string,
  context: ActionContext,
): ActionResult {
  const gate = checkCleanroomAction(row, action)
  if (!gate.ok) {
    return gate
  }
  const actor = currentActor() as Actor
  const payload = context.payload ?? {}
  if (action === '提交监测') {
    const invalid = validateMonitoringPayload(row, payload)
    if (!invalid.ok) {
      return invalid
    }
  }
  const rows = listRows('cleanroom')
  const point = String(row['监测点位'] ?? '')
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: !CLEANROOM_TERMINAL.includes(target),
    abnormal: target === '超标预警',
    归属区: zoneCodeOfPoint(point),
  }
  if (action === '提交监测') {
    updated['培养基批号'] = String(payload['培养基批号']).trim()
    updated['悬浮粒子数'] = String(parseParticleCount(payload['悬浮粒子数']))
    updated['悬浮粒子数_复核'] = String(parseParticleCount(payload['悬浮粒子数_复核']))
    updated['沉降菌数'] = String(payload['沉降菌数'] ?? row['沉降菌数'] ?? '').trim()
    updated['温度读数'] = String(payload['温度读数'] ?? row['温度读数'] ?? '').trim()
    updated['相对湿度'] = String(payload['相对湿度'] ?? row['相对湿度'] ?? '').trim()
    updated['监测日期'] = todayText()
    updated['监测人'] = actor.monitor
    updated['轮值周次'] = isoWeekNumber()
  }
  const next = [...rows]
  next[index] = updated
  saveRows('cleanroom', next)
  appendChangeControlEntry({ row: updated, action, target, actor })
  return { ok: true, message: `已${action}，点位「${point}」当前状态「${target}」，并已回写变更控制清单` }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  context: ActionContext = {},
): ActionResult {
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
  if (key === 'cleanroom') {
    // 重复状态口径交给洁净区闸门，用它的「只算一次」话术。
    return runCleanroomAction(rows[index], index, action, target, context)
  }
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
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
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
