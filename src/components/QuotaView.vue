<template>
  <div class="quota">
    <div v-if="!store.current" class="lock-banner">🔒 浏览模式：加入家庭后可处理定额告警（家庭成员及以上），定额配置需管理权限。</div>
    <div v-else-if="!canAlert && !canManage" class="lock-banner">🔒 当前角色没有定额相关操作权限，仅可查看定额执行与告警。</div>
    <div v-else-if="!store.scopeAll" class="lock-banner scope">🎯 你的定额操作已限定授权房间/设备：范围外定额与告警仅可查看，配置/处理按钮由后端统一拦截；设备换房后自动重算。</div>
    <!-- KPI -->
    <div class="kpis">
      <div class="kpi"><b>{{ store.quotas.length }}</b><em>已配置定额</em></div>
      <div class="kpi"><b class="amber">{{ openCount }}</b><em>待处理告警</em></div>
      <div class="kpi"><b class="orange">{{ warnCount }}</b><em>接近超标(≥80%)</em></div>
      <div class="kpi"><b class="red">{{ overCount }}</b><em>已超标(≥100%)</em></div>
    </div>

    <!-- 定额配置 -->
    <div class="card">
      <div class="card-head">
        <h4>📏 周期能耗定额 · 按房间 / 设备配置</h4>
        <div class="head-ops">
          <button class="add" :disabled="!canManage" :title="canManage?'':'无定额配置管理权限'" @click="canManage && openCreate()">＋ 新建定额</button>
          <button class="add batch" :disabled="!canManage" :title="canManage?'一次为多个房间/设备应用同一定额策略':'无定额配置管理权限'" @click="canManage && openBatchCreate()">🗂 批量新建</button>
        </div>
      </div>

      <!-- 批量新建：同一周期+额度应用到多个房间/设备，逐项校验、逐项留痕 -->
      <form v-if="batchCreateShow" class="form column" @submit.prevent="submitBatchCreate">
        <div class="row">
          <select v-model="batchCreate.scope" @change="batchCreate.ids=[]">
            <option value="room">按房间</option>
            <option value="device">按设备</option>
          </select>
          <select v-model="batchCreate.period">
            <option value="daily">每日</option>
            <option value="weekly">每周（周一起）</option>
            <option value="monthly">每月</option>
          </select>
          <label class="limit-in">额度
            <input v-model.number="batchCreate.limit_kwh" type="number" min="0.1" step="0.1" required placeholder="kWh" />
            kWh
          </label>
          <input v-model="batchCreate.reason" class="reason" placeholder="批量创建备注（可选，逐项留痕）" />
        </div>
        <div class="pick-list">
          <label v-for="t in batchTargets" :key="t.id" class="pick" :class="{dup: t.dup}">
            <input type="checkbox" :value="t.id" v-model="batchCreate.ids" :disabled="t.dup" />
            {{ t.label }}
            <i v-if="t.dup" class="tag dup">已有该周期定额</i>
          </label>
          <span v-if="!batchTargets.length" class="dim">暂无可选对象</span>
        </div>
        <div class="row">
          <button type="submit" class="save" :disabled="!batchCreate.ids.length">批量创建（已选 {{ batchCreate.ids.length }} 个对象）</button>
          <button type="button" class="ghost" @click="batchCreateShow=false">取消</button>
          <span class="dim">同一事务落库后统一重算用量与告警，单项冲突仅跳过该项</span>
        </div>
      </form>

      <!-- 新建/编辑表单 -->
      <form v-if="formShow" class="form" @submit.prevent="submit">
        <select v-model="form.scope" :disabled="!!form.id" @change="onScopeChange">
          <option value="room">按房间</option>
          <option value="device">按设备</option>
        </select>
        <select v-if="form.scope==='room'" v-model.number="form.room_id" required :disabled="!!form.id">
          <option :value="''" disabled>选择房间</option>
          <option v-for="r in allowedRooms" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
        <select v-else v-model.number="form.device_id" required :disabled="!!form.id">
          <option :value="''" disabled>选择设备</option>
          <option v-for="d in allowedDevices" :key="d.id" :value="d.id">{{ d.type_icon }} {{ d.name }}（{{ d.room }}）</option>
        </select>
        <select v-model="form.period">
          <option value="daily">每日</option>
          <option value="weekly">每周（周一起）</option>
          <option value="monthly">每月</option>
        </select>
        <label class="limit-in">额度
          <input v-model.number="form.limit_kwh" type="number" min="0.1" step="0.1" required placeholder="kWh" />
          kWh
        </label>
        <input v-model="form.reason" class="reason" placeholder="调整/创建备注（可选，将留痕）" />
        <button type="submit" class="save">{{ form.id ? '保存调整' : '创建' }}</button>
        <button type="button" class="ghost" @click="formShow=false">取消</button>
      </form>

      <!-- 批量操作栏：勾选多条定额后统一 调整/启停/删除 -->
      <div v-if="canManage && selected.length" class="batch-bar">
        <b>已选 {{ selected.length }} 条定额</b>
        <button @click="openBatchEdit">调整额度/周期</button>
        <button @click="batchApply('enable')">启用</button>
        <button @click="batchApply('disable')">停用</button>
        <button class="danger" @click="batchRemove">删除</button>
        <button class="ghost" @click="selected=[]">清除选择</button>
      </div>
      <form v-if="batchEditShow" class="form" @submit.prevent="submitBatchEdit">
        <span class="dim">批量调整 {{ selected.length }} 条：</span>
        <select v-model="batchForm.period">
          <option value="">周期保持不变</option>
          <option value="daily">改为每日</option>
          <option value="weekly">改为每周（周一起）</option>
          <option value="monthly">改为每月</option>
        </select>
        <label class="limit-in">额度
          <input v-model="batchForm.limit" type="number" min="0.1" step="0.1" placeholder="留空不变" />
          kWh
        </label>
        <input v-model="batchForm.reason" class="reason" placeholder="批量调整备注（可选，逐项留痕）" />
        <button type="submit" class="save">应用到所选</button>
        <button type="button" class="ghost" @click="batchEditShow=false">取消</button>
      </form>

      <table v-if="store.quotas.length">
        <thead><tr>
          <th v-if="canManage" class="sel-col"><input type="checkbox" :checked="allSelected" @change="toggleSelectAll" title="全选" /></th>
          <th>对象</th><th>周期</th><th>额度</th><th style="width:26%">周期内用量</th>
          <th>状态</th><th>启用</th><th>操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="q in store.quotas" :key="q.id" :class="{disabled:!q.enabled, noscope:store.current && !q.in_scope}">
            <td v-if="canManage" class="sel-col"><input type="checkbox" :checked="selected.includes(q.id)" :disabled="!q.in_scope" @change="toggleSelect(q.id)" /></td>
            <td>
              <i class="tag" :class="q.scope">{{ q.scope==='room'?'房间':'设备' }}</i>
              {{ q.target_name }}
              <i v-if="q.device_deleted" class="tag del">设备已删除</i>
              <i v-if="store.current && !q.in_scope" class="tag scope">🎯 范围外</i>
            </td>
            <td>{{ q.period_label }}</td>
            <td>{{ fmt(q.limit_kwh) }} kWh</td>
            <td>
              <div class="prog" :class="progClass(q)">
                <i :style="{width: barWidth(q)+'%'}"></i>
                <span>{{ q.used_kwh.toFixed(2) }} / {{ fmt(q.limit_kwh) }} kWh（{{ q.ratio }}%）</span>
              </div>
            </td>
            <td>
              <span v-if="!q.alert" class="ok">正常</span>
              <span v-else class="al" :class="q.alert.level">
                {{ q.alert.level==='error'?'🚨 已超标':'⚠️ 接近超标' }}
                <em>· {{ q.alert.status_label }}</em>
              </span>
            </td>
            <td>
              <label class="switch" :class="{locked:!canManage || !q.in_scope}">
                <input type="checkbox" :checked="q.enabled" :disabled="!canManage || !q.in_scope" @change="store.toggleQuota(q)"/>
                <span></span>
              </label>
            </td>
            <td class="ops">
              <button v-if="canManage && q.in_scope" @click="openEdit(q)">编辑</button>
              <button @click="showHistory(q.id)">历史</button>
              <button v-if="canManage && q.in_scope" class="danger" @click="remove(q)">删除</button>
              <span v-if="canManage && !q.in_scope" class="dim">范围外</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">尚未配置能耗定额，点击「新建定额」按房间或设备设置日/周/月用电额度。</div>
      <p class="sub">用量持续聚合「已结分段用电 + 运行中设备实时折算（功率×时长）」；达额度 80% 预警、100% 超标告警，同一周期只通知一次并可升级。</p>
    </div>

    <!-- 批量执行结果：逐项审计明细（配置类同步写入调整记录，告警类同步写入家庭日志） -->
    <div v-if="batchResults" class="card batch-results">
      <div class="card-head">
        <h4>🧾 批量执行结果 · 逐项审计</h4>
        <span class="chip">
          {{ resultStats.applied }} 生效 / {{ resultStats.skipped }} 无变化 / {{ resultStats.failed }} 失败
          <button @click="batchResults=null">✕ 关闭</button>
        </span>
      </div>
      <ul class="result-list">
        <li v-for="(r,i) in batchResults" :key="i" :class="{fail:!r.ok, skip:r.ok&&r.skipped}">
          <b>{{ !r.ok ? '❌' : r.skipped ? '➖' : '✅' }}</b>
          <span class="rl">{{ r.label }}</span>
          <span class="rm">{{ r.message }}</span>
        </li>
      </ul>
      <p class="sub">配置类变更逐项写入「定额历史调整记录」（含对象快照，删除后仍可追溯）；告警处理逐项写入家庭日志时间线。</p>
    </div>

    <!-- 超标预警闭环 -->
    <div class="card">
      <div class="card-head">
        <h4>🚨 超标预警与处理闭环</h4>
        <div class="filters">
          <button v-for="f in alertFilters" :key="f.v" :class="{active: alertFilter===f.v}" @click="alertFilter=f.v">{{ f.t }}</button>
        </div>
      </div>
      <!-- 批量处理栏：勾选多条活动告警后统一流转 -->
      <div v-if="canAlert && selectedAlerts.length" class="batch-bar">
        <b>已选 {{ selectedAlerts.length }} 条告警</b>
        <button class="go" @click="batchAlertAct('handling')">开始处理</button>
        <button class="ok-btn" @click="batchAlertAct('resolved')">已处理</button>
        <button @click="batchAlertAct('ignored')">忽略</button>
        <button class="ghost" @click="selectedAlerts=[]">清除选择</button>
      </div>
      <table v-if="filteredAlerts.length">
        <thead><tr>
          <th v-if="canAlert" class="sel-col"><input type="checkbox" :checked="allAlertsSelected" @change="toggleSelectAllAlerts" title="全选活动告警" /></th>
          <th>级别</th><th>对象</th><th>周期</th><th>用量/额度</th><th>状态</th><th>处理备注</th><th>时间</th><th>操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="a in filteredAlerts" :key="a.id" :class="{noscope:store.current && a.in_scope===false}">
            <td v-if="canAlert" class="sel-col">
              <input v-if="(a.status==='open'||a.status==='handling') && a.in_scope!==false" type="checkbox"
                     :checked="selectedAlerts.includes(a.id)" @change="toggleSelectAlert(a.id)" />
            </td>
            <td><span class="lv" :class="a.level">{{ a.level==='error'?'超标':'预警' }}</span>
              <i v-if="woOf(a)" class="wtag" @click="store.tab='workorder'">🎫 已生成工单 →</i>
              <i v-if="store.current && a.in_scope===false" class="tag scope">🎯 范围外</i>
            </td>
            <td>{{ a.scope==='room'?'房间':'设备' }} · {{ a.target_name }}</td>
            <td>{{ a.period_label }}<br><span class="dim">{{ periodText(a) }}</span></td>
            <td>
              <b :class="a.level">{{ a.used_kwh.toFixed(2) }}</b> / {{ fmt(a.limit_kwh) }} kWh
              <span class="dim">（{{ Math.round(a.used_kwh/a.limit_kwh*100) }}%）</span>
            </td>
            <td><span class="st" :class="a.status">{{ a.status_label }}</span></td>
            <td class="note-cell">
              <span v-if="a.note">{{ a.note }}</span>
              <span v-else class="dim">—</span>
            </td>
            <td class="dim">{{ fmtTime(a.created_at) }}</td>
            <td class="ops">
              <template v-if="canAlert && a.in_scope===false"><span class="dim">范围外·仅查看</span></template>
              <template v-else-if="canAlert">
                <template v-if="a.status==='open'">
                  <button class="go" @click="act(a,'handling')">开始处理</button>
                  <button class="ok-btn" @click="act(a,'resolved')">已处理</button>
                  <button @click="act(a,'ignored')">忽略</button>
                </template>
                <template v-else-if="a.status==='handling'">
                  <button class="ok-btn" @click="act(a,'resolved')">完成处理</button>
                  <button @click="act(a,'open')">退回</button>
                  <button @click="act(a,'ignored')">忽略</button>
                </template>
                <template v-else>
                  <button @click="act(a,'open')">重新打开</button>
                </template>
              </template>
              <span v-else class="dim">无处理权限</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">当前筛选下没有告警。用量达到定额 80% / 100% 时将自动出现在这里。</div>
    </div>

    <!-- 调整历史 -->
    <div class="card">
      <div class="card-head">
        <h4>🗂 定额历史调整记录</h4>
        <span v-if="historyQuota" class="chip">
          仅显示：定额 #{{ historyQuota }}
          <button @click="historyQuota=null">✕ 清除</button>
        </span>
      </div>
      <table v-if="history.length">
        <thead><tr><th>时间</th><th>对象</th><th>操作</th><th>变化</th><th>备注</th></tr></thead>
        <tbody>
          <tr v-for="h in history" :key="h.id">
            <td class="dim">{{ fmtTime(h.created_at) }}</td>
            <td>
              {{ h.scope==='room'?'房间':h.scope==='device'?'设备':'—' }}
              {{ h.target_name ? '· ' + h.target_name : '' }}
              <span class="dim">#{{ h.quota_id }}</span>
            </td>
            <td><span class="act" :class="h.action">{{ actionText(h.action) }}</span></td>
            <td class="change">{{ changeText(h) }}</td>
            <td>{{ h.reason || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无调整记录。</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()
const canAlert = computed(() => store.can('quota_alert_handle'))
const canManage = computed(() => store.can('quota_manage'))

const formShow = ref(false)
const form = ref(emptyForm())
const alertFilter = ref('active')
const alertFilters = [
  { v: 'active', t: '处理中/待处理' },
  { v: 'open', t: '待处理' },
  { v: 'resolved', t: '已处理' },
  { v: 'ignored', t: '已忽略' },
  { v: 'all', t: '全部' }
]
const history = ref([])
const historyQuota = ref(null)

// ===== 批量策略：定额勾选 / 批量新建 / 批量调整 / 批量告警处理 =====
const selected = ref([])          // 勾选的定额 id
const selectedAlerts = ref([])    // 勾选的告警 id（仅活动告警可勾选）
const batchCreateShow = ref(false)
const batchCreate = ref({ scope: 'room', period: 'daily', limit_kwh: 5, ids: [], reason: '' })
const batchEditShow = ref(false)
const batchForm = ref({ period: '', limit: '', reason: '' })
const batchResults = ref(null)    // 最近一次批量执行的逐项结果

// 当前身份可操作的房间/设备（细粒度授权；全屋不限为全部）
const allowedRooms = computed(() => store.scopeAll ? store.rooms : store.rooms.filter((r) => scopeRoomIds.value.includes(r.id)))
const allowedDevices = computed(() => store.scopeAll ? store.devices : store.devices.filter((d) => d.in_scope !== false))
const scopeRoomIds = computed(() => {
  const m = store.family.members.find((x) => x.id === store.current?.id)
  return m?.scope?.room_ids || []
})

// 批量新建的可选对象（已存在同周期定额的置灰，避免必然失败的项；范围外对象不列出）
const batchTargets = computed(() => {
  if (batchCreate.value.scope === 'room') {
    return allowedRooms.value.map((r) => ({
      id: r.id, label: r.name,
      dup: store.quotas.some((q) => q.scope === 'room' && q.room_id === r.id && q.period === batchCreate.value.period)
    }))
  }
  return allowedDevices.value.map((d) => ({
    id: d.id, label: `${d.type_icon} ${d.name}（${d.room}）`,
    dup: store.quotas.some((q) => q.scope === 'device' && q.device_id === d.id && q.period === batchCreate.value.period)
  }))
})
// 批量勾选只覆盖「在范围内」的对象，全选框不会把范围外项带进请求（后端也会整批拒绝兜底）
const selectableQuotas = computed(() => store.quotas.filter((q) => q.in_scope !== false))
const allSelected = computed(() => selectableQuotas.value.length > 0 && selectableQuotas.value.every((q) => selected.value.includes(q.id)))
const activeAlertIds = computed(() => filteredAlerts.value
  .filter((a) => (a.status === 'open' || a.status === 'handling') && a.in_scope !== false).map((a) => a.id))
const allAlertsSelected = computed(() => activeAlertIds.value.length > 0 && activeAlertIds.value.every((id) => selectedAlerts.value.includes(id)))
const resultStats = computed(() => ({
  applied: (batchResults.value || []).filter((r) => r.ok && !r.skipped).length,
  skipped: (batchResults.value || []).filter((r) => r.ok && r.skipped).length,
  failed: (batchResults.value || []).filter((r) => !r.ok).length
}))

function toggleSelect(id) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id]
}
function toggleSelectAll() {
  selected.value = allSelected.value ? [] : selectableQuotas.value.map((q) => q.id)
}
function toggleSelectAlert(id) {
  selectedAlerts.value = selectedAlerts.value.includes(id)
    ? selectedAlerts.value.filter((x) => x !== id)
    : [...selectedAlerts.value, id]
}
function toggleSelectAllAlerts() {
  selectedAlerts.value = allAlertsSelected.value ? [] : [...activeAlertIds.value]
}
function openBatchCreate() {
  batchCreate.value = { scope: 'room', period: 'daily', limit_kwh: 5, ids: [], reason: '' }
  batchCreateShow.value = true
  formShow.value = false
}
function openBatchEdit() {
  batchForm.value = { period: '', limit: '', reason: '' }
  batchEditShow.value = true
}
async function submitBatchCreate() {
  const c = batchCreate.value
  const targets = c.ids.map((id) => c.scope === 'room'
    ? { scope: 'room', room_id: id }
    : { scope: 'device', device_id: id })
  const r = await store.batchQuota({
    action: 'create', targets,
    period: c.period, limit_kwh: Number(c.limit_kwh), reason: c.reason || ''
  })
  if (r) {
    batchResults.value = r.results
    batchCreateShow.value = false
    batchCreate.value.ids = []
    await loadHistory()
  }
}
async function submitBatchEdit() {
  const f = batchForm.value
  if (!f.period && (f.limit === '' || f.limit == null)) {
    store.toastMsg('请至少填写一项要修改的内容（周期或额度）', 'warn')
    return
  }
  const payload = { action: 'update', quota_ids: [...selected.value], reason: f.reason || '' }
  if (f.period) payload.period = f.period
  if (f.limit !== '' && f.limit != null) payload.limit_kwh = Number(f.limit)
  const r = await store.batchQuota(payload)
  if (r) {
    batchResults.value = r.results
    batchEditShow.value = false
    selected.value = []
    await loadHistory()
  }
}
async function batchApply(action) {
  const r = await store.batchQuota({ action, quota_ids: [...selected.value] })
  if (r) {
    batchResults.value = r.results
    selected.value = []
    await loadHistory()
  }
}
async function batchRemove() {
  if (!confirm(`批量删除已选的 ${selected.value.length} 条定额？\n未关闭的超标告警将自动解除，历史记录与逐项留痕保留。`)) return
  await batchApply('delete')
}
async function batchAlertAct(status) {
  let note = ''
  if (status === 'resolved' || status === 'ignored') {
    const input = prompt(`批量处理备注（${status === 'resolved' ? '已处理' : '忽略'}，可留空，将应用到所选 ${selectedAlerts.value.length} 条告警）：`)
    if (input === null) return
    note = input
  }
  const r = await store.batchHandleQuotaAlerts([...selectedAlerts.value], { status, note })
  if (r) {
    batchResults.value = r.results
    selectedAlerts.value = []
  }
}

function emptyForm() {
  return { id: null, scope: 'room', room_id: '', device_id: '', period: 'daily', limit_kwh: 1, reason: '', enabled: true }
}
function openCreate() { form.value = emptyForm(); formShow.value = true; batchCreateShow.value = false }
function onScopeChange() { form.value.room_id = ''; form.value.device_id = '' }
function openEdit(q) {
  form.value = {
    id: q.id, scope: q.scope,
    room_id: q.room_id || '', device_id: q.device_id || '',
    period: q.period, limit_kwh: q.limit_kwh, reason: '', enabled: q.enabled
  }
  formShow.value = true
}
async function submit() {
  const ok = await store.saveQuota(form.value)
  if (ok) { formShow.value = false; await loadHistory() }
}
async function remove(q) {
  if (confirm(`删除定额「${q.target_name} · ${q.period_label}」？\n未关闭的超标告警将自动解除，历史记录保留。`)) {
    await store.removeQuota(q.id)
    await loadHistory()
  }
}
async function act(a, status) {
  let note = a.note || ''
  if (status === 'resolved' || status === 'ignored') {
    const input = prompt(`处理备注（${status === 'resolved' ? '已处理' : '忽略'}，可留空）：`, note)
    if (input === null) return
    note = input
  }
  await store.handleQuotaAlert(a.id, { status, note })
}
async function showHistory(id) {
  historyQuota.value = id
  await loadHistory()
  document.querySelector('.quota')?.scrollIntoView({ behavior: 'smooth' })
}
async function loadHistory() {
  history.value = await store.fetchAdjustments(historyQuota.value)
}
onMounted(loadHistory)
// 每次 store 轮询刷新后同步全局历史（处于某额度过滤视图时不覆盖）
watch(() => store.quotaAlerts, () => { if (!historyQuota.value) loadHistory() })
// 轮询刷新后清理已消失的勾选项（定额被删、告警被解除/闭环），避免对已失效对象执行批量操作
watch(() => store.quotas, (qs) => {
  const ids = new Set(qs.map((q) => q.id))
  selected.value = selected.value.filter((id) => ids.has(id))
})
watch(() => store.quotaAlerts, (as) => {
  const ids = new Set(as.filter((a) => a.status === 'open' || a.status === 'handling').map((a) => a.id))
  selectedAlerts.value = selectedAlerts.value.filter((id) => ids.has(id))
})

const openCount = computed(() => store.pendingQuotaAlerts.length)
const warnCount = computed(() => store.pendingQuotaAlerts.filter((a) => a.level === 'warn').length)
const overCount = computed(() => store.pendingQuotaAlerts.filter((a) => a.level === 'error').length)
const filteredAlerts = computed(() => {
  const list = store.quotaAlerts
  if (alertFilter.value === 'all') return list
  if (alertFilter.value === 'active') return list.filter((a) => a.status === 'open' || a.status === 'handling')
  return list.filter((a) => a.status === alertFilter.value)
})
// 超标告警自动生成的未完成工单（预警不生成）
function woOf(a) {
  if (a.level !== 'error') return null
  return store.workOrders.find((w) => w.quota_alert_id === a.id && w.status !== 'completed') || null
}

function progClass(q) {
  // 已闭环（已处理/已忽略/自动解除）的历史告警不再染色，进度条按当前真实占比着色
  const active = q.alert && (q.alert.status === 'open' || q.alert.status === 'handling')
  if (active && q.alert.level === 'error') return 'over'
  if (active && q.alert.level === 'warn') return 'near'
  if (q.ratio >= 100) return 'over'
  if (q.ratio >= 80) return 'near'
  if (q.ratio >= 50) return 'half'
  return ''
}
function barWidth(q) { return Math.min(100, Math.max(2, q.ratio)) }
function fmt(v) { return (+v).toFixed(2) }
function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function periodText(a) {
  return `${fmtTime(a.period_start).slice(5)} ~ ${fmtTime(a.period_end).slice(5)}`
}
function actionText(a) {
  return { create: '新建', update: '调整', enable: '启用', disable: '停用', delete: '删除' }[a] || a
}
function changeText(h) {
  const parts = []
  if (h.old_limit != null || h.new_limit != null) {
    parts.push(`${h.old_limit != null ? fmt(h.old_limit) : '—'} → ${h.new_limit != null ? fmt(h.new_limit) : '—'} kWh`)
  }
  if (h.old_period && h.new_period && h.old_period !== h.new_period) {
    const lb = { daily: '每日', weekly: '每周', monthly: '每月' }
    parts.push(`${lb[h.old_period]} → ${lb[h.new_period]}`)
  }
  return parts.join('；') || '—'
}
</script>

<style scoped>
.quota{display:flex;flex-direction:column;gap:16px;}
.lock-banner{background:#3a2f12;border:1px solid rgba(255,213,79,.35);color:#ffd54f;font-size:12px;border-radius:10px;padding:9px 14px;}
.lock-banner.scope{background:#12291a;border-color:rgba(102,187,106,.35);color:#a5d6a7;}
tr.noscope{opacity:.75;}
.tag.scope{background:#2a1518;color:#ef9a9a;margin-left:6px;}
.switch.locked{opacity:.45;pointer-events:none;}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.kpi{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;text-align:center;}
.kpi b{display:block;font-size:28px;color:#ffd54f;}
.kpi b.amber{color:#ffb300;}.kpi b.orange{color:#ffa726;}.kpi b.red{color:#ef5350;}
.kpi em{font-size:12px;color:#8ba2c8;font-style:normal;}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
h4{margin:0;color:#fff;font-size:14px;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;cursor:pointer;border-radius:8px;padding:7px 14px;font-size:12px;}
.add:disabled{opacity:.45;cursor:not-allowed;}
.add.batch{background:linear-gradient(135deg,#2962ff,#1e4fd6);margin-left:8px;}
.head-ops{display:flex;align-items:center;}
.form.column{flex-direction:column;align-items:stretch;}
.form .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.pick-list{display:flex;flex-wrap:wrap;gap:6px;max-height:132px;overflow:auto;padding:4px 2px;}
.pick{display:flex;align-items:center;gap:5px;font-size:12px;color:#dbe4f3;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:5px 9px;cursor:pointer;}
.pick.dup{opacity:.5;cursor:not-allowed;}
.tag.dup{background:#3a2f12;color:#ffd54f;margin-left:4px;}
.sel-col{width:28px;text-align:center;}
.sel-col input{cursor:pointer;}
.batch-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#10224a;border:1px solid rgba(66,165,245,.35);border-radius:10px;padding:9px 12px;margin-bottom:12px;font-size:12px;color:#90caf9;}
.batch-bar b{margin-right:4px;}
.batch-bar button{cursor:pointer;font-size:11px;padding:5px 11px;}
.batch-bar .danger{color:#ef5350;border-color:rgba(239,83,80,.4);}
.batch-bar .go{color:#90caf9;border-color:rgba(66,165,245,.4);}
.batch-bar .ok-btn{color:#a5d6a7;border-color:rgba(102,187,106,.4);}
.batch-bar .ghost{background:#16263f;color:#8ba2c8;}
.batch-results .result-list{list-style:none;margin:0;padding:0;max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:4px;}
.result-list li{display:flex;align-items:center;gap:8px;font-size:12px;color:#dbe4f3;background:#0c1730;border-radius:8px;padding:6px 10px;}
.result-list li.fail{color:#ffab91;}
.result-list li.skip{color:#8ba2c8;}
.result-list .rl{font-weight:600;white-space:nowrap;}
.result-list .rm{color:#8ba2c8;}
.result-list li.fail .rm{color:#ef9a9a;}
.form{display:flex;gap:8px;flex-wrap:wrap;background:#0c1730;border:1px solid rgba(120,160,220,0.18);border-radius:10px;padding:12px;margin-bottom:12px;align-items:center;}
select,input,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.limit-in{display:flex;align-items:center;gap:6px;font-size:12px;color:#8ba2c8;}
.limit-in input{width:90px;}
.reason{flex:1;min-width:180px;}
.form .save{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;}
.form .ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
table{width:100%;border-collapse:collapse;font-size:12px;}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid rgba(120,160,220,0.1);vertical-align:middle;}
th{color:#8ba2c8;font-weight:600;font-size:11px;}
td{color:#dbe4f3;}
tr.disabled{opacity:.55;}
.tag{font-style:normal;font-size:10px;padding:1px 6px;border-radius:5px;margin-right:6px;}
.tag.room{background:#163a2a;color:#80cbc4;}
.tag.device{background:#1b2f4a;color:#90caf9;}
.tag.del{background:#4a2020;color:#ffab91;margin-left:6px;}
.prog{position:relative;height:22px;background:#0c1730;border-radius:6px;overflow:hidden;display:flex;align-items:center;min-width:210px;}
.prog i{position:absolute;inset:0 auto 0 0;background:#42a5f5;opacity:.55;transition:width .4s;}
.prog span{position:relative;padding-left:8px;font-size:11px;color:#dbe4f3;white-space:nowrap;}
.prog.half i{background:#ffca28;}
.prog.near i{background:#ffa726;}
.prog.over i{background:#ef5350;}
.ok{color:#66bb6a;font-size:11px;}
.al{font-size:11px;font-weight:600;}
.al.warn{color:#ffa726;}.al.error{color:#ef5350;}
.al em{color:#8ba2c8;font-weight:400;font-style:normal;}
.switch{position:relative;width:40px;height:22px;display:inline-block;}
.switch input{opacity:0;width:0;height:0;}
.switch span{position:absolute;inset:0;background:#243357;border-radius:22px;transition:.2s;cursor:pointer;}
.switch span:before{content:'';position:absolute;width:18px;height:18px;left:2px;top:2px;background:#7b8db3;border-radius:50%;transition:.2s;}
.switch input:checked+span{background:#2962ff;}
.switch input:checked+span:before{transform:translateX(18px);background:#fff;}
.ops{white-space:nowrap;}
.ops button{padding:4px 9px;margin-right:4px;cursor:pointer;font-size:11px;}
.ops .danger{color:#ef5350;border-color:rgba(239,83,80,.4);}
.ops .go{color:#90caf9;border-color:rgba(66,165,245,.4);}
.ops .ok-btn{color:#a5d6a7;border-color:rgba(102,187,106,.4);}
.sub{margin:10px 0 0;font-size:11px;color:#5b6f94;}
.empty{color:#5b6f94;text-align:center;padding:14px;font-size:12px;}
.filters{display:flex;gap:6px;}
.filters button{cursor:pointer;font-size:11px;padding:5px 10px;}
.filters button.active{background:#2962ff;border-color:#2962ff;color:#fff;}
.lv{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:600;}
.lv.warn{background:#4e3410;color:#ffcc80;}
.lv.error{background:#4a1818;color:#ff8a80;}
.wtag{font-style:normal;font-size:10px;background:#2f2648;color:#ce93d8;border-radius:6px;padding:2px 7px;margin-left:8px;cursor:pointer;white-space:nowrap;}
.wtag:hover{background:#3d3160;}
.st{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;}
.st.open{background:#4a1818;color:#ff8a80;}
.st.handling{background:#13315c;color:#90caf9;}
.st.resolved{background:#1b3a1f;color:#a5d6a7;}
.st.ignored{background:#263238;color:#90a4ae;}
.dim{color:#5b6f94;font-size:11px;}
.note-cell{max-width:180px;font-size:11px;color:#8ba2c8;}
.chip{font-size:11px;color:#90caf9;background:#13315c;border-radius:20px;padding:3px 10px;}
.chip button{background:none;border:none;color:#90caf9;cursor:pointer;padding:0 0 0 6px;}
.act{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;}
.act.create{background:#1b3a1f;color:#a5d6a7;}
.act.update{background:#13315c;color:#90caf9;}
.act.enable{background:#1b3a1f;color:#a5d6a7;}
.act.disable{background:#3a2f12;color:#ffd54f;}
.act.delete{background:#4a1818;color:#ff8a80;}
.change{font-size:11px;color:#8ba2c8;}
</style>
