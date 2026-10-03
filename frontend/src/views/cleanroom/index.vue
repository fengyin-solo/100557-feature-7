<template>
  <section class="page" data-module="cleanroom">
    <header class="page-head">
      <div>
        <h2>洁净区环境监测管理</h2>
        <p class="page-desc">生产区按监测点位划片，只有点位归属区本周当值监测人能提交监测与标记超标；达标记录只读；状态只许顺次推进。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记环境监测记录</button>
        <button class="btn" type="button" @click="exportRows">导出洁净区环境监测清单</button>
      </div>
    </header>

    <article class="roster-panel">
      <header class="roster-head">
        <strong>第 {{ roster.week }} 周监测值班表（{{ roster.date }}，监测人每周轮换）</strong>
        <label class="operator-pick">
          当前操作人
          <select :value="store.operator" @change="onOperatorChange">
            <option v-for="name in operatorOptions" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
      </header>
      <div class="roster-zones">
        <div v-for="zone in roster.zones" :key="zone.zone" class="roster-zone">
          <span class="roster-zone-name">{{ zone.zone }} · 当值：{{ zone.monitor }}</span>
          <span class="roster-points">{{ zone.points.map((p) => `${p.point}(${p.grade})`).join('、') }}</span>
        </div>
      </div>
      <p class="roster-note">
        悬浮粒子数两处取来的为同一份，只录入、显示、回写「悬浮粒子数」一个字段，必须是非负整数，非法值打回重填；
        培养基批号必须与点位对应（前缀-年周-点位流水，如 {{ mediaExampleHint }}）。
      </p>
    </article>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr :class="{ 'readonly-row': isReadonly(row) }">
            <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
            <td>
              {{ row.status }}
              <span v-if="isReadonly(row)" class="readonly-tag">只读</span>
            </td>
            <td class="row-actions">
              <template v-if="String(row.status) === '待监测'">
                <button class="link" type="button" @click="toggleEditor(row)">
                  {{ editingId === Number(row.id) ? '收起录入' : '录入读数并提交' }}
                </button>
              </template>
              <template v-else-if="String(row.status) === '监测中'">
                <button class="link" type="button" @click="runAction('判定达标', row)">判定达标</button>
                <button class="link danger" type="button" @click="runAction('标记超标', row)">标记超标</button>
              </template>
              <template v-else-if="String(row.status) === '超标预警'">
                <button class="link" type="button" @click="runAction('标记超标', row)">重复标记（只算一次）</button>
              </template>
              <span v-else class="muted-text">已锁定，不可操作</span>
            </td>
          </tr>
          <tr v-if="editingId === Number(row.id)" class="editor-row">
            <td :colspan="columns.length + 2">
              <form class="reading-form" @submit.prevent="submitReadings(row)">
                <label>
                  <span>悬浮粒子数（两处同一份）</span>
                  <input v-model="drafts[row.id].particle" placeholder="非负整数" />
                </label>
                <label>
                  <span>沉降菌数</span>
                  <input v-model="drafts[row.id].settle" placeholder="如 0" />
                </label>
                <label>
                  <span>温度读数</span>
                  <input v-model="drafts[row.id].temperature" placeholder="如 21.0" />
                </label>
                <label>
                  <span>相对湿度(%)</span>
                  <input v-model="drafts[row.id].humidity" placeholder="如 48" />
                </label>
                <label class="media-cell">
                  <span>培养基批号（须对应该点位）</span>
                  <input v-model="drafts[row.id].media" :placeholder="mediaBatchExample(String(row['监测点位']))" />
                </label>
                <span class="form-hint">
                  归属：{{ String(row['所属生产区'] ?? '') }} · 本周当值：{{ zoneMonitor(row) }}
                </span>
                <button class="btn primary" type="submit">提交监测</button>
                <button class="btn ghost" type="button" @click="editingId = null">取消</button>
              </form>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无洁净区环境监测数据，可先登记环境监测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条洁净区环境监测记录</span>
      <span v-if="feedbackMessage" :class="feedbackOk ? 'success-text' : 'error-text'">{{ feedbackMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  cleanroomRoster,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitCleanroomReadings,
} from '@/api/local-service'
import {
  allMonitors,
  allPointGuides,
  mediaBatchExample,
  monitorOfZone,
  particleCountOf,
  pointGuide,
} from '@/data/cleanroom-policy'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const meta = moduleMeta('cleanroom')
const columns = ["监测点位", "所属生产区", "洁净级别", "悬浮粒子数", "沉降菌数", "温度读数", "相对湿度", "培养基批号", "监测人", "监测日期"]
const stats = [{"label": "待监测点位", "value": 0}, {"label": "监测中点位", "value": 0}, {"label": "超标点位数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const feedbackMessage = ref('')
const feedbackOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const roster = computed(() => cleanroomRoster())
const operatorOptions = computed(() => ['值班管理员', ...allMonitors()])
const mediaExampleHint = computed(() => mediaBatchExample(allPointGuides()[0].point))

const editingId = ref<number | null>(null)
type ReadingDraft = { particle: string; settle: string; temperature: string; humidity: string; media: string }
const drafts = ref<Record<number, ReadingDraft>>({})

function draftFor(row: EntryRow): ReadingDraft {
  const id = Number(row.id)
  if (!drafts.value[id]) {
    drafts.value[id] = {
      particle: '',
      settle: String(row['沉降菌数'] ?? ''),
      temperature: String(row['温度读数'] ?? ''),
      humidity: String(row['相对湿度'] ?? ''),
      media: String(row['培养基批号'] ?? ''),
    }
  }
  return drafts.value[id]
}

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isReadonly(row: EntryRow): boolean {
  return String(row.status) === '已达标'
}

function displayCell(row: EntryRow, column: string): string {
  if (column === '悬浮粒子数') {
    // 单一数据源：任何展示都只从唯一字段取。
    const value = particleCountOf(row)
    return value === '' ? '待录入' : value
  }
  const value = row[column]
  return value === undefined || value === null || value === '' ? '—' : String(value)
}

function zoneMonitor(row: EntryRow): string {
  const guide = pointGuide(String(row['监测点位'] ?? ''))
  return guide ? monitorOfZone(guide.zone) : '未划片'
}

function onOperatorChange(event: Event) {
  store.setOperator((event.target as HTMLSelectElement).value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  showMessage('环境监测记录登记入口尚未接入审批流', false)
}

function showMessage(message: string, ok: boolean) {
  feedbackMessage.value = message
  feedbackOk.value = ok
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action, store.operator)
  showMessage(result.message, result.ok)
  if (result.ok) {
    reload()
  }
}

function toggleEditor(row: EntryRow) {
  const id = Number(row.id)
  if (editingId.value === id) {
    editingId.value = null
    return
  }
  draftFor(row)
  editingId.value = id
  showMessage('', false)
}

function submitReadings(row: EntryRow) {
  const id = Number(row.id)
  const draft = drafts.value[id]
  if (!draft) {
    return
  }
  // 培养基批号与读数一起进服务层，由服务层校验是否与点位对应。
  const result = submitCleanroomReadings(id, store.operator, {
    particle: draft.particle,
    settle: draft.settle,
    temperature: draft.temperature,
    humidity: draft.humidity,
    media: draft.media,
  })
  showMessage(result.message, result.ok)
  if (result.ok) {
    editingId.value = null
    reload()
  }
}

function reload() {
  feedbackMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    for (const row of rows.value) {
      draftFor(row)
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : '洁净区环境监测列表读取失败', false)
  }
}

onMounted(reload)
</script>

<style scoped>
.roster-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.roster-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  margin-bottom: 8px;
}
.operator-pick {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  gap: 6px;
  align-items: center;
}
.roster-zones {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.roster-zone {
  display: flex;
  gap: 10px;
  font-size: 12px;
}
.roster-zone-name {
  color: #1f2937;
  min-width: 150px;
}
.roster-points {
  color: var(--muted);
}
.roster-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.readonly-row {
  background: #f1f5f9;
  color: var(--muted);
}
.readonly-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #475569;
  font-size: 11px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.link.danger {
  color: #b42318;
}
.success-text {
  color: #067647;
}
.editor-row td {
  background: #f8fafc;
  padding: 10px;
}
.reading-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
}
.reading-form label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--muted);
}
.reading-form input {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.reading-form .media-cell {
  flex: 1;
  min-width: 260px;
}
.form-hint {
  font-size: 12px;
  color: var(--muted);
}
</style>
