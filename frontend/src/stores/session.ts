import { defineStore } from 'pinia'

import {
  PRODUCTION_ZONES,
  currentDutyMonitor,
  dutyWeekLabel,
  isoWeekNumber,
} from '@/data/cleanroom-domain'

// 当前操作人就是“某生产区本周轮值的监测人”。名单与轮换规则在 cleanroom-domain.ts 里，
// 这里只记住登录时选了谁；选择持久化在 localStorage，刷新还在。
const SESSION_KEY = 'pharma-cleanroom:session'

type SessionState = {
  zoneCode: string
  monitor: string
}

function persist(state: SessionState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(state))
  }
}

function restore(): SessionState {
  const fallback: SessionState = {
    zoneCode: PRODUCTION_ZONES[0].code,
    monitor: currentDutyMonitor(PRODUCTION_ZONES[0].code),
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(SESSION_KEY)
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionState>
    const zone = PRODUCTION_ZONES.find((item) => item.code === parsed.zoneCode)
    if (!zone || typeof parsed.monitor !== 'string' || !zone.monitors.includes(parsed.monitor)) {
      return fallback
    }
    return { zoneCode: zone.code, monitor: parsed.monitor }
  } catch {
    return fallback
  }
}

export const useSessionStore = defineStore('session', {
  state: () => {
    const initial = restore()
    return {
      zoneCode: initial.zoneCode,
      monitor: initial.monitor,
    }
  },
  getters: {
    zoneName(state): string {
      return PRODUCTION_ZONES.find((item) => item.code === state.zoneCode)?.name ?? ''
    },
    operator(state): string {
      return state.monitor
    },
    zones() {
      return PRODUCTION_ZONES
    },
    // 各区本周当班监测人，用于页头轮换提示。
    weekLabel(): string {
      return dutyWeekLabel()
    },
    weekNumber(): number {
      return isoWeekNumber()
    },
    dutyOf: (state) => (zoneCode: string) => currentDutyMonitor(zoneCode),
    canOperate: (state) => state.monitor.length > 0,
  },
  actions: {
    switchMonitor(zoneCode: string, monitor: string) {
      this.zoneCode = zoneCode
      this.monitor = monitor
      persist({ zoneCode, monitor })
    },
  },
})
