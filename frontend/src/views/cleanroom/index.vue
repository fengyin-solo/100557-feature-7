<template>
  <section class="page" data-module="cleanroom">
    <header class="page-head">
      <div>
        <h2>洁净区环境监测管理</h2>
        <p class="page-desc">点位按生产区划片归属；仅归属区本周轮值监测人可提交监测、判定达标、标记超标；达标记录转只读，状态只许顺次推进。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出洁净区环境监测清单</button>
      </div>
    </header>

    <div class="duty-board">
      <div class="duty-current">
        <span class="duty-tag">{{ session.weekLabel }}</span>
        <span>当前身份：<strong>{{ session.zoneName }} · {{ session.monitor }}</strong></span>
        <span class="duty-hint">只能操作本区划片内的点位</span>
      </div>
      <ul class="duty-list">
        <li v-for="zone in session.zones" :key="zone.code">
          <span class="zone-name">{{ zone.name }}</span>
          <span class="duty-person">{{ session.dutyOf(zone.code) }}</span>
        </li>
      </ul>
    </div>

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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!checkAction(row, action).ok"
              :title="checkAction(row, action).message"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无洁净区环境监测数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="modal.open" class="modal-mask" @click.self="closeModal">
      <div class="modal-card">
        <h3>提交监测 · {{ modal.row?.['监测点位'] }}</h3>
        <p class="modal-hint">
          归属{{ zoneNameOfPoint(String(modal.row?.['监测点位'] ?? '')) }}，
          培养基批号须与点位对应；悬浮粒子数两处独立录入，取来的须为同一份合法读数。
        </p>
        <div class="form-grid">
          <label>
            <span>培养基批号 *</span>
            <input v-model="modal.form['培养基批号']" placeholder="如 MED-A-01" />
          </label>
          <label>
            <span>悬浮粒子数（第一处录入，粒/m³）*</span>
            <input v-model="modal.form['悬浮粒子数']" placeholder="非负整数" />
          </label>
          <label>
            <span>悬浮粒子数（第二处录入，粒/m³）*</span>
            <input v-model="modal.form['悬浮粒子数_复核']" placeholder="与第一处一致" />
          </label>
          <label>
            <span>沉降菌数（皿）</span>
            <input v-model="modal.form['沉降菌数']" placeholder="非负整数" />
          </label>
          <label>
            <span>温度读数（℃）</span>
            <input v-model="modal.form['温度读数']" />
          </label>
          <label>
            <span>相对湿度（%）</span>
            <input v-model="modal.form['相对湿度']" />
          </label>
        </div>
        <p v-if="modal.error" class="error-text">{{ modal.error }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="button" @click="confirmSubmit">确认提交监测</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条洁净区环境监测记录；动作成功后会自动回写变更控制清单</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  checkCleanroomAction,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { expectedMediaBatch, zoneOfPoint } from '@/data/cleanroom-domain'
import type { ActionResult, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const meta = moduleMeta('cleanroom')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['归属区', '监测点位', '洁净级别']

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待监测点位', value: rows.value.filter((row) => row.status === '待监测').length },
  { label: '监测中点位', value: rows.value.filter((row) => row.status === '监测中').length },
  { label: '超标点位数', value: rows.value.filter((row) => row.status === '超标预警').length },
])

const modal = reactive<{
  open: boolean
  row: EntryRow | null
  form: Record<string, string>
  error: string
}>({
  open: false,
  row: null,
  form: {},
  error: '',
})

function zoneNameOfPoint(point: string): string {
  return zoneOfPoint(point).name
}

function checkAction(row: EntryRow, action: string): ActionResult {
  return checkCleanroomAction(row, action)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openSubmit(row: EntryRow) {
  const prefill: Record<string, string> = {
    培养基批号: expectedMediaBatch(String(row['监测点位'] ?? '')),
    悬浮粒子数: '',
    悬浮粒子数_复核: '',
    沉降菌数: '',
    温度读数: '',
    相对湿度: '',
  }
  modal.open = true
  modal.row = row
  modal.form = prefill
  modal.error = ''
}

function closeModal() {
  modal.open = false
  modal.row = null
  modal.form = {}
  modal.error = ''
}

function confirmSubmit() {
  if (!modal.row) {
    return
  }
  const result = applyAction(meta.key, Number(modal.row.id), '提交监测', { payload: modal.form })
  if (!result.ok) {
    modal.error = result.message
    return
  }
  closeModal()
  errorMessage.value = ''
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '提交监测') {
    const gate = checkCleanroomAction(row, action)
    if (!gate.ok) {
      errorMessage.value = gate.message
      return
    }
    openSubmit(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '洁净区环境监测列表读取失败'
  }
}

onMounted(reload)
</script>
