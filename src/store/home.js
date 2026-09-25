import { defineStore } from 'pinia'

// 演示环境身份：成员令牌持久化在 localStorage，所有写请求带 X-Home-Token；
// 无令牌=浏览模式（只读），写操作由后端 401 拦截。
const TOKEN_KEY = 'home_member_token'

async function api(path, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  const tok = localStorage.getItem(TOKEN_KEY)
  if (tok) opt.headers['X-Home-Token'] = tok
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch('/api' + path, opt)
  const data = await r.json()
  if (!r.ok) {
    const e = new Error(data.error || '请求失败')
    e.status = r.status
    e.noPerm = !!data.no_perm
    e.perm = data.perm
    throw e
  }
  return data
}

export const useHomeStore = defineStore('home', {
  state: () => ({
    loaded: false,
    tab: 'family',
    // 当前登录成员（null=未选择身份的浏览模式）
    current: null,
    // 家庭共享：角色定义/权限字典/成员列表/邀请列表
    family: { roles: {}, permissions: {}, members: [], invites: [] },
    rooms: [],
    types: [],
    devices: [],
    scenes: [],
    logs: [],
    energy: { total: 0, trend: [], rooms: [], devices: [] },
    alerts: [],
    quotas: [],
    quotaAlerts: [],
    workOrders: [],
    toast: null,
    timer: null,
    // 已通知过的定额告警身份签名（id → level:status）：
    // 新建、warn→error 升级、系统自动解除后重开各通知一次；普通读数刷新/降级不重复通知
    alertSig: null,
    // 已通知过的工单 id（系统自动生成时弹一次；流转不弹 toast）
    workOrderSig: null
  }),
  getters: {
    onlineCount: (s) => s.devices.filter((d) => d.status === 'online').length,
    errorCount: (s) => s.devices.filter((d) => d.status === 'error').length,
    onCount: (s) => s.devices.filter((d) => d.power_on).length,
    totalWatts: (s) => s.devices.reduce((sum, d) => sum + (d.power_on ? d.watts : 0), 0),
    // 待处理/处理中的定额告警，用于 Tab 角标
    pendingQuotaAlerts: (s) => s.quotaAlerts.filter((a) => a.status === 'open' || a.status === 'handling'),
    // 未完成工单（待分派/已分派/已接单/处理中/已挂起/已复开），用于 Tab 角标与看板
    activeWorkOrders: (s) => s.workOrders.filter((w) => w.status !== 'completed'),
    openWorkOrders: (s) => s.workOrders.filter((w) => w.status === 'open' || w.status === 'reopened'),
    activeMembers: (s) => s.family.members.filter((m) => m.status === 'active'),
    pendingInvites: (s) => s.family.invites.filter((i) => i.status === 'pending'),
    // 当前身份是否具备某权限（后端会再次强制校验，前端仅用于按钮置灰等交互）
    can: (s) => (perm) => !!s.current && (s.current.effective_perms || []).includes(perm),
    isManager: (s) => !!s.current && (s.current.effective_perms || []).includes('member_manage')
  },
  actions: {
    async load() {
      const d = await api('/state')
      const firstLoad = !this.loaded
      this.current = d.current
        ? { ...d.current, effective_perms: (d.family.members.find((m) => m.id === d.current.id) || {}).effective_perms || [] }
        : null
      this.family = d.family || { roles: {}, permissions: {}, members: [], invites: [] }
      this.rooms = d.rooms
      this.types = d.types
      this.devices = d.devices
      this.scenes = d.scenes
      this.logs = d.logs
      this.energy = d.energy
      this.alerts = d.alerts
      this.quotas = d.quotas || []
      this.quotaAlerts = d.quota_alerts || []
      this.workOrders = d.work_orders || []
      this.loaded = true
      this.notifyNewQuotaAlerts(firstLoad)
      this.notifyNewWorkOrders(firstLoad)
    },
    // 系统自动生成工单时给一次桌面内通知；首次加载不打扰；人工流转不通知
    notifyNewWorkOrders(firstLoad) {
      if (firstLoad || this.workOrderSig == null) {
        this.workOrderSig = new Set(this.workOrders.map((w) => w.id))
        if (firstLoad) return
      }
      for (const w of this.workOrders) {
        if (!this.workOrderSig.has(w.id)) {
          this.workOrderSig.add(w.id)
          this.toastMsg(
            `🎫 新工单 ${w.code}：${w.title}${w.level === 'error' ? '（紧急）' : ''}，待分派`,
            w.level === 'error' ? 'warn' : 'info')
        }
      }
    },
    // 新触发、预警升级超标、自动解除后重开的定额告警各给一次桌面内通知；
    // 首次加载不打扰；普通用量刷新、级别下调不通知，同一身份不重复弹
    notifyNewQuotaAlerts(firstLoad) {
      const sigOf = (a) => `${a.level}:${a.status}`
      const active = this.quotaAlerts.filter((a) => a.status === 'open' || a.status === 'handling')
      const activeIds = new Set(active.map((a) => a.id))
      if (firstLoad || this.alertSig == null) {
        this.alertSig = new Map(active.map((a) => [a.id, sigOf(a)]))
        if (firstLoad) return
      }
      // 已从活动列表消失（系统自动解除/人工闭环）的告警清除签名，
      // 之后重开才能被识别为「重新进入活动态」
      for (const id of [...this.alertSig.keys()]) {
        if (!activeIds.has(id)) this.alertSig.delete(id)
      }
      for (const a of active) {
        const prev = this.alertSig.get(a.id)
        const cur = sigOf(a)
        if (!prev || prev !== cur) {
          if (!prev) {
            // 新出现的活动告警（含自动解除后同周期重开）
            this.pushQuotaToast(a)
          } else {
            const [prevLevel] = prev.split(':')
            // warn→error 升级才补通知；error→warn 降级与普通状态流转不打扰
            if (prevLevel === 'warn' && a.level === 'error') this.pushQuotaToast(a)
          }
          this.alertSig.set(a.id, cur)
        }
      }
    },
    pushQuotaToast(a) {
      const pct = Math.round((a.used_kwh / a.limit_kwh) * 100)
      this.toastMsg(
        `${a.level === 'error' ? '🚨 超标告警' : '⚠️ 超标预警'}：${a.scope === 'room' ? '房间' : '设备'}「${a.target_name}」${a.period_label}定额已用 ${pct}%`,
        a.level === 'error' ? 'warn' : 'info')
    },
    // 看板趋势/实时用电随模拟节拍轻量刷新；轮询失败静默（手动操作仍会立即拉取）
    startAutoRefresh() {
      if (this.timer) return
      this.timer = setInterval(() => { this.load().catch(() => {}) }, 20_000)
    },
    toastMsg(msg, type = 'info') {
      this.toast = { msg, type, id: Date.now() }
    },
    clearToast() { this.toast = null },

    async addDevice(p) {
      try { await api('/device', 'POST', p); await this.load(); this.toastMsg('已新增设备', 'success') }
      catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async removeDevice(id) {
      try { await api('/device/' + id, 'DELETE'); await this.load() }
      catch (e) { this.toastMsg(e.message, 'warn'); throw e }
    },
    async toggleDevice(id) {
      try {
        const r = await api(`/device/${id}/toggle`, 'POST'); await this.load()
        return r.power_on
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async updateDevice(id, patch) {
      try { await api(`/device/${id}/update`, 'POST', patch); await this.load() }
      catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async addScene(scene) {
      try {
        const r = await api('/scene', 'POST', scene); await this.load()
        this.toastMsg('场景已创建', 'success'); return r.id
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async deleteScene(id) {
      try { await api('/scene/' + id, 'DELETE'); await this.load() }
      catch (e) { this.toastMsg(e.message, 'warn'); throw e }
    },
    async toggleScene(id) {
      try { await api(`/scene/${id}/toggle`, 'POST'); await this.load() }
      catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async runScene(id) {
      try {
        const r = await api(`/scene/${id}/run`, 'POST')
        await this.load()
        if (r.failed?.length)
          this.toastMsg(`场景执行完成：成功 ${r.executed.length} 项，失败 ${r.failed.length} 项`, 'warn')
        else
          this.toastMsg(`场景已触发，成功执行 ${r.executed.length} 个动作`, 'success')
        return r
      } catch (e) {
        this.toastMsg(e.message, 'warn')
      }
    },

    // ===== 能耗定额闭环 =====
    async saveQuota(form) {
      try {
        if (form.id) {
          await api(`/quota/${form.id}/update`, 'POST', {
            limit_kwh: Number(form.limit_kwh), period: form.period,
            enabled: form.enabled, reason: form.reason || ''
          })
          this.toastMsg('定额已调整并记录留痕', 'success')
        } else {
          await api('/quota', 'POST', {
            scope: form.scope,
            room_id: form.scope === 'room' ? Number(form.room_id) : null,
            device_id: form.scope === 'device' ? Number(form.device_id) : null,
            period: form.period, limit_kwh: Number(form.limit_kwh),
            reason: form.reason || ''
          })
          this.toastMsg('定额已创建', 'success')
        }
        await this.load()
        return true
      } catch (e) { this.toastMsg(e.message, 'warn'); return false }
    },
    async toggleQuota(q) {
      try {
        await api(`/quota/${q.id}/update`, 'POST', { enabled: !q.enabled })
        await this.load()
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async removeQuota(id) {
      try {
        await api('/quota/' + id, 'DELETE')
        await this.load()
        this.toastMsg('定额已删除', 'success')
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async handleQuotaAlert(id, patch) {
      try {
        await api(`/quota-alert/${id}/handle`, 'POST', patch)
        await this.load()
        this.toastMsg('告警状态已更新', 'success')
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    // 批量定额策略：跨房间/设备统一 新建/调整/启停/删除。
    // 返回逐项结果（含失败原因）供页面展示审计明细；整批失败原因由 toast 汇总
    async batchQuota(payload) {
      try {
        const r = await api('/quota/batch', 'POST', payload)
        await this.load()
        this.toastMsg(
          `批量操作完成：生效 ${r.applied} 项` + (r.failed ? `，失败 ${r.failed} 项` : ''),
          r.failed ? 'warn' : 'success')
        return r
      } catch (e) { this.toastMsg(e.message, 'warn'); return null }
    },
    // 批量告警处理：同一状态流转 + 同一备注应用到多条告警，逐项返回成败
    async batchHandleQuotaAlerts(ids, patch) {
      try {
        const r = await api('/quota-alert/batch-handle', 'POST', { ids, ...patch })
        await this.load()
        this.toastMsg(
          `批量处理完成：成功 ${r.applied} 条` + (r.failed ? `，失败 ${r.failed} 条` : ''),
          r.failed ? 'warn' : 'success')
        return r
      } catch (e) { this.toastMsg(e.message, 'warn'); return null }
    },
    async fetchAdjustments(quotaId = null) {
      const qs = quotaId ? `?quota_id=${quotaId}` : ''
      return await api('/quota-adjustments' + qs)
    },

    // ===== 告警工单闭环：分派/接单/处理中/挂起/完成/复开 =====
    async fetchWorkOrder(id) {
      return await api('/work-order/' + id)
    },
    // 工单状态流转。action=dispatch 时 patch.assignee_id 必填；
    // suspend/complete/reopen 服务端强制要求 note
    async operateWorkOrder(id, action, patch = {}) {
      try {
        const r = await api(`/work-order/${id}/operate`, 'POST', { action, ...patch })
        await this.load()
        return r.work_order
      } catch (e) { this.toastMsg(e.message, 'warn'); return null }
    },

    // ===== 家庭共享：身份 / 邀请 / 角色 / 撤销 =====
    // 切换演示身份（选择在组成员的令牌）；传 null 回到只读浏览模式
    async switchIdentity(member) {
      if (member) {
        localStorage.setItem(TOKEN_KEY, member.token)
        await this.load()
        this.toastMsg(`已切换为${member.role_label}「${member.name}」`, 'success')
      } else {
        localStorage.removeItem(TOKEN_KEY)
        await this.load()
        this.toastMsg('已进入只读浏览模式', 'info')
      }
    },
    // 凭邀请码加入家庭，成功后自动以新成员身份登录
    async acceptInvite(code) {
      try {
        const r = await api('/family/invite/accept', 'POST', { code })
        localStorage.setItem(TOKEN_KEY, r.token)
        await this.load()
        this.toastMsg(`欢迎加入，${r.member.role_label}「${r.member.name}」`, 'success')
        return true
      } catch (e) { this.toastMsg(e.message, 'warn'); return false }
    },
    async previewInvite(code) {
      return await api('/family/invite-preview?code=' + encodeURIComponent(code))
    },
    async createInvite(form) {
      try {
        const r = await api('/family/invite', 'POST', form)
        await this.load()
        this.toastMsg(`邀请已发出，邀请码 ${r.invite.code}`, 'success')
        return r.invite
      } catch (e) { this.toastMsg(e.message, 'warn'); return null }
    },
    async cancelInvite(id, reason = '') {
      try { await api(`/family/invite/${id}/cancel`, 'POST', { reason }); await this.load() }
      catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async resendInvite(id) {
      try {
        const r = await api(`/family/invite/${id}/resend`, 'POST')
        await this.load()
        this.toastMsg(`新邀请码 ${r.code}`, 'success')
        return r.code
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async updateMember(id, patch) {
      try {
        await api(`/family/member/${id}/update`, 'POST', patch)
        await this.load()
        this.toastMsg('成员角色/权限已更新并即时生效', 'success')
        return true
      } catch (e) { this.toastMsg(e.message, 'warn'); return false }
    },
    async revokeMember(id, reason = '') {
      try {
        await api(`/family/member/${id}/revoke`, 'POST', { reason })
        // 撤销的若是当前身份，令牌已失效，回到浏览模式
        if (this.current && this.current.id === id) {
          localStorage.removeItem(TOKEN_KEY)
          this.toastMsg('当前身份已被撤销，回到浏览模式', 'warn')
        }
        await this.load()
        return true
      } catch (e) { this.toastMsg(e.message, 'warn'); return false }
    },
    async restoreMember(id) {
      try { await api(`/family/member/${id}/restore`, 'POST'); await this.load(); this.toastMsg('成员已恢复并签发新令牌', 'success') }
      catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async reinviteMember(id) {
      try {
        const r = await api(`/family/member/${id}/reinvite`, 'POST')
        await this.load()
        if (r) this.toastMsg(`已重新邀请，邀请码 ${r.invite.code}`, 'success')
      } catch (e) { this.toastMsg(e.message, 'warn') }
    }
  }
})
