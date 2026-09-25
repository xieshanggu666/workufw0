<template>
  <div class="wo">
    <div v-if="!store.current" class="lock-banner">🔒 浏览模式：加入家庭后可处理工单；家庭成员默认可接单/处理/完成，分派与改派需管理权限。</div>
    <div v-else-if="!canDispatch && !canHandle" class="lock-banner">🔒 当前角色没有工单相关操作权限，仅可查看工单。</div>

    <!-- KPI -->
    <div class="kpis">
      <div class="kpi"><b class="red">{{ counts.open }}</b><em>待分派/待复分派</em></div>
      <div class="kpi"><b class="blue">{{ counts.flow }}</b><em>流转中</em></div>
      <div class="kpi"><b class="amber">{{ counts.suspended }}</b><em>已挂起</em></div>
      <div class="kpi"><b class="orange">{{ counts.sourceCleared }}</b><em>源告警已消除</em></div>
      <div class="kpi"><b class="green">{{ counts.completed }}</b><em>已完成</em></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h4>🎫 告警工单闭环 · 离线 / 低电量 / 信号弱 / 能耗超标 自动生成</h4>
        <div class="filters">
          <button v-for="f in statusFilters" :key="f.v" :class="{active: statusFilter===f.v}" @click="statusFilter=f.v">{{ f.t }}</button>
        </div>
      </div>
      <div class="sub-filters">
        <div class="filters">
          <button v-for="f in sourceFilters" :key="f.v" :class="{active: sourceFilter===f.v}" @click="sourceFilter=f.v">{{ f.t }}</button>
        </div>
        <label v-if="store.current" class="mine"><input type="checkbox" v-model="onlyMine" /> 只看分派给我的</label>
      </div>

      <table v-if="filtered.length">
        <thead><tr>
          <th>工单</th><th>源告警 / 对象</th><th>级别</th><th>状态</th><th>处理人</th><th>源告警</th><th>创建时间</th><th>操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="w in filtered" :key="w.id" :class="{done:w.status==='completed',clickable:true}" @click="openDetail(w)">
            <td>
              <b class="code">{{ w.code }}</b>
              <span v-if="w.status==='open'" class="st open">待分派</span>
            </td>
            <td>
              <span class="src">{{ w.source_icon }} {{ w.source_label }}</span>
              <span class="target">{{ w.target_name }}</span>
              <i v-if="w.device_deleted" class="tag del">设备已删除</i>
            </td>
            <td><span class="lv" :class="w.level">{{ w.level==='error'?'紧急':'一般' }}</span></td>
            <td><span class="st" :class="w.status">{{ w.status_label }}</span></td>
            <td>
              <span v-if="w.assignee_name">{{ w.assignee_name }}</span>
              <span v-else class="dim">未分派</span>
              <i v-if="w.assignee_revoked" class="tag del">成员已撤销</i>
            </td>
            <td>
              <span v-if="w.status!=='completed'">
                <i v-if="w.source_active" class="dot-live"></i><span v-if="w.source_active" class="dim">仍存在</span>
                <i v-if="!w.source_active" class="dot-clear"></i><span v-if="!w.source_active" class="cleared">已消除 · 待核实</span>
              </span>
              <span v-else class="dim">{{ w.source_active ? '复发' : '已消除' }}</span>
            </td>
            <td class="dim">{{ fmtTime(w.created_at) }}</td>
            <td class="ops" @click.stop>
              <template v-if="canDispatch && ['open','reopened','dispatched','accepted','processing','suspended'].includes(w.status)">
                <button class="go" @click="openDispatch(w)">
                  {{ ['dispatched','accepted','processing','suspended'].includes(w.status) ? '改派' : '分派' }}
                </button>
              </template>
              <template v-if="canHandle && w.status==='dispatched' && isMine(w)">
                <button class="ok-btn" @click="act(w,'accept')">接单</button>
              </template>
              <template v-if="canHandle && w.status==='accepted' && isMine(w)">
                <button class="go" @click="act(w,'start')">开始处理</button>
              </template>
              <template v-if="canHandle && w.status==='processing' && isMine(w)">
                <button class="susp" @click="act(w,'suspend')">挂起</button>
                <button class="ok-btn" @click="act(w,'complete')">完成</button>
              </template>
              <template v-if="canHandle && w.status==='suspended' && isMine(w)">
                <button class="go" @click="act(w,'resume')">继续</button>
                <button class="ok-btn" @click="act(w,'complete')">完成</button>
              </template>
              <template v-if="canHandle && w.status==='completed' && w.source_active">
                <button class="reopen" @click="act(w,'reopen')">复开</button>
              </template>
              <span v-if="!hasAnyAction(w)" class="dim">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">当前筛选下没有工单。离线 / 低电量(&lt;40%) / 信号弱(&lt;60) / 能耗定额超标告警出现时会自动生成工单。</div>
      <p class="sub">
        状态机：待分派 → 已分派 → 已接单 → 处理中 ⇄ 已挂起 → 已完成（可复开 → 重新分派）。
        源告警消除不会自动关单，仅标记「源已消除」，由处理人核实后完成；同一问题持续存在不重复建工单，
        已完成工单必须经历「告警消除→再次出现」才会另开新单，仍存在时可直接「复开」。
      </p>
    </div>

    <!-- 分派弹窗 -->
    <div v-if="dispatchShow" class="modal-mask" @click.self="dispatchShow=false">
      <div class="modal">
        <h4>📋 {{ dispatchForm.reassign ? '改派工单' : '分派工单' }}</h4>
        <div class="wo-head">
          <b>{{ dispatchForm.code }}</b> {{ dispatchForm.title }}
        </div>
        <div class="field">
          <label>处理人（在组且有工单处理权限）</label>
          <select v-model="dispatchForm.assignee_id">
            <option :value="''" disabled>选择成员</option>
            <option v-for="m in assignableMembers" :key="m.id" :value="m.id">
              {{ m.role_label }} · {{ m.name }}{{ m.relation ? '（' + m.relation + '）' : '' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>分派备注（可选）</label>
          <textarea v-model="dispatchForm.note" rows="2" placeholder="如：请上门检查设备网络 / 更换电池"></textarea>
        </div>
        <div class="modal-ops">
          <button class="save" :disabled="!dispatchForm.assignee_id" @click="submitDispatch">确认{{ dispatchForm.reassign ? '改派' : '分派' }}</button>
          <button class="ghost" @click="dispatchShow=false">取消</button>
        </div>
      </div>
    </div>

    <!-- 工单详情抽屉：完整处理时间线 -->
    <transition name="slide">
      <div v-if="detail" class="drawer-mask" @click.self="detail=null">
        <div class="drawer">
          <div class="drawer-head">
            <div>
              <h4>{{ detail.source_icon }} {{ detail.code }}</h4>
              <span class="st" :class="detail.status">{{ detail.status_label }}</span>
            </div>
            <button class="ghost" @click="detail=null">✕</button>
          </div>
          <div class="drawer-body">
            <div class="d-title">{{ detail.title }}</div>
            <div class="d-grid">
              <div><em>源告警</em><b>{{ detail.source_label }}</b></div>
              <div><em>级别</em><b :class="detail.level">{{ detail.level==='error'?'紧急':'一般' }}</b></div>
              <div><em>处理人</em><b>{{ detail.assignee_name || '未分派' }}</b></div>
              <div><em>源告警状态</em><b>{{ detail.source_active ? '仍存在' : '已消除' }}</b></div>
            </div>
            <div class="d-detail">{{ detail.detail }}</div>
            <div v-if="detail.note" class="d-notes"><em>处理备注</em><div>{{ detail.note }}</div></div>

            <h5>处理时间线</h5>
            <div class="tl">
              <div v-for="e in detail.events" :key="e.id" class="tl-item">
                <span class="tl-dot" :class="dotClass(e.action)"></span>
                <div class="tl-body">
                  <div class="tl-line">
                    <b>{{ e.action_label }}</b>
                    <span class="who">{{ e.operator }}<i v-if="e.operator_role"> · {{ e.operator_role }}</i></span>
                    <span class="time">{{ fmtTime(e.time) }}</span>
                  </div>
                  <div v-if="e.from_status && e.to_status && e.from_status!==e.to_status" class="tl-flow">
                    {{ e.from_label }} → {{ e.to_label }}
                  </div>
                  <div v-if="e.detail" class="tl-detail">{{ e.detail }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()
const canDispatch = computed(() => store.can('workorder_dispatch'))
const canHandle = computed(() => store.can('workorder_handle'))

const statusFilter = ref('active')
const sourceFilter = ref('all')
const onlyMine = ref(false)
const statusFilters = [
  { v: 'active', t: '进行中' },
  { v: 'open', t: '待分派' },
  { v: 'processing', t: '处理中' },
  { v: 'suspended', t: '已挂起' },
  { v: 'completed', t: '已完成' },
  { v: 'all', t: '全部' }
]
const sourceFilters = [
  { v: 'all', t: '全部来源' },
  { v: 'device_offline', t: '🔴 离线' },
  { v: 'device_battery', t: '🪫 低电量' },
  { v: 'device_signal', t: '📶 信号弱' },
  { v: 'quota_over', t: '🚨 能耗超标' }
]

// 可作为处理人的在组成员：持有 workorder_handle 权限（户主/管理员/家庭成员）
const assignableMembers = computed(() =>
  store.family.members.filter((m) => m.status === 'active' && (m.effective_perms || []).includes('workorder_handle')))

function isMine(w) {
  return store.current && w.assignee_id === store.current.id
}
function hasAnyAction(w) {
  if (canDispatch.value && ['open', 'reopened', 'dispatched', 'accepted', 'processing', 'suspended'].includes(w.status)) return true
  if (!canHandle.value) return false
  if (['dispatched', 'accepted', 'processing', 'suspended'].includes(w.status) && isMine(w)) return true
  if (w.status === 'completed' && w.source_active) return true
  return false
}

const filtered = computed(() => {
  return store.workOrders.filter((w) => {
    if (sourceFilter.value !== 'all' && w.source_type !== sourceFilter.value) return false
    if (onlyMine.value && w.assignee_id !== store.current?.id) return false
    const f = statusFilter.value
    if (f === 'all') return true
    if (f === 'active') return w.status !== 'completed'
    if (f === 'open') return w.status === 'open' || w.status === 'reopened'
    if (f === 'processing') return ['dispatched', 'accepted', 'processing'].includes(w.status)
    return w.status === f
  })
})

const counts = computed(() => {
  const active = store.workOrders.filter((w) => w.status !== 'completed')
  return {
    open: active.filter((w) => w.status === 'open' || w.status === 'reopened').length,
    flow: active.filter((w) => ['dispatched', 'accepted', 'processing'].includes(w.status)).length,
    suspended: active.filter((w) => w.status === 'suspended').length,
    sourceCleared: active.filter((w) => !w.source_active).length,
    completed: store.workOrders.filter((w) => w.status === 'completed').length
  }
})

// ===== 操作 =====
async function act(w, action) {
  let patch = {}
  if (action === 'suspend') {
    const note = prompt(`挂起工单 ${w.code} 的原因（必填，如：等待配件/等待用户在场）：`)
    if (note === null) return
    if (!note.trim()) { store.toastMsg('挂起必须填写原因', 'warn'); return }
    patch.note = note.trim()
  } else if (action === 'complete') {
    const note = prompt(`完成工单 ${w.code} 的处理结果说明（必填）：`)
    if (note === null) return
    if (!note.trim()) { store.toastMsg('完成必须填写处理结果', 'warn'); return }
    patch.note = note.trim()
  } else if (action === 'reopen') {
    const note = prompt(`复开工单 ${w.code} 的原因（必填）：`)
    if (note === null) return
    if (!note.trim()) { store.toastMsg('复开必须填写原因', 'warn'); return }
    patch.note = note.trim()
  }
  const r = await store.operateWorkOrder(w.id, action, patch)
  if (r) {
    store.toastMsg(`工单已${labelOf(action)}`, 'success')
    if (detail.value && detail.value.id === w.id) await refreshDetail(w.id)
  }
}
function labelOf(a) {
  return { accept: '接单', start: '开始处理', suspend: '挂起', resume: '继续处理', complete: '完成', reopen: '复开' }[a] || '更新'
}

// ===== 分派弹窗 =====
const dispatchShow = ref(false)
const dispatchForm = reactive({ id: null, code: '', title: '', assignee_id: '', note: '', reassign: false })
function openDispatch(w) {
  dispatchForm.id = w.id
  dispatchForm.code = w.code
  dispatchForm.title = w.title
  const inFlight = ['dispatched', 'accepted', 'processing', 'suspended'].includes(w.status)
  dispatchForm.assignee_id = inFlight ? w.assignee_id : ''
  dispatchForm.note = ''
  dispatchForm.reassign = inFlight
  dispatchShow.value = true
}
async function submitDispatch() {
  const r = await store.operateWorkOrder(dispatchForm.id, 'dispatch', {
    assignee_id: Number(dispatchForm.assignee_id), note: dispatchForm.note.trim()
  })
  if (r) {
    store.toastMsg(dispatchForm.reassign ? '工单已改派' : '工单已分派', 'success')
    dispatchShow.value = false
    if (detail.value && detail.value.id === dispatchForm.id) await refreshDetail(dispatchForm.id)
  }
}

// ===== 详情抽屉（含处理时间线） =====
const detail = ref(null)
async function openDetail(w) {
  detail.value = await store.fetchWorkOrder(w.id)
}
async function refreshDetail(id) {
  detail.value = await store.fetchWorkOrder(id)
}
function dotClass(action) {
  if (action === 'created') return 'created'
  if (action === 'completed') return 'ok'
  if (action === 'suspended') return 'susp'
  if (action === 'source_cleared') return 'clear'
  if (action === 'reopened' || action === 'source_restored') return 'reopen'
  return 'flow'
}
function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<style scoped>
.wo{display:flex;flex-direction:column;gap:16px;}
.lock-banner{background:#3a2f12;border:1px solid rgba(255,213,79,.35);color:#ffd54f;font-size:12px;border-radius:10px;padding:9px 14px;}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.kpi{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;text-align:center;}
.kpi b{display:block;font-size:28px;color:#dbe4f3;}
.kpi b.red{color:#ef5350;}.kpi b.blue{color:#42a5f5;}.kpi b.amber{color:#ffb300;}
.kpi b.orange{color:#ffa726;}.kpi b.green{color:#66bb6a;}
.kpi em{font-size:12px;color:#8ba2c8;font-style:normal;}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap;}
h4{margin:0;color:#fff;font-size:14px;}
.sub-filters{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;}
.filters{display:flex;gap:6px;flex-wrap:wrap;}
.filters button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;}
.filters button.active{background:#2962ff;border-color:#2962ff;color:#fff;}
.mine{font-size:12px;color:#8ba2c8;display:flex;align-items:center;gap:5px;cursor:pointer;}
.mine input{width:auto;}
table{width:100%;border-collapse:collapse;font-size:12px;}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid rgba(120,160,220,0.1);vertical-align:middle;}
th{color:#8ba2c8;font-weight:600;font-size:11px;}
td{color:#dbe4f3;}
tr.clickable{cursor:pointer;}
tr.clickable:hover td{background:#13233f;}
tr.done{opacity:.7;}
.code{color:#90caf9;font-size:12px;display:block;margin-bottom:2px;}
.src{display:block;color:#dbe4f3;font-size:12px;}
.target{font-size:11px;color:#8ba2c8;}
.tag{font-style:normal;font-size:10px;padding:1px 6px;border-radius:5px;margin-left:6px;}
.tag.del{background:#4a2020;color:#ffab91;}
.lv{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:600;}
.lv.error{background:#4a1818;color:#ff8a80;}.lv.warn{background:#4e3410;color:#ffcc80;}
.st{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;white-space:nowrap;}
.st.open{background:#4a1818;color:#ff8a80;}
.st.dispatched{background:#2f2648;color:#ce93d8;}
.st.accepted{background:#13315c;color:#90caf9;}
.st.processing{background:#0d3b3f;color:#80deea;}
.st.suspended{background:#3d3416;color:#ffd54f;}
.st.completed{background:#1b3a1f;color:#a5d6a7;}
.st.reopened{background:#4a2a12;color:#ffab91;}
.dim{color:#5b6f94;font-size:11px;}
.cleared{color:#ffd54f;font-size:11px;}
.dot-live,.dot-clear{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;}
.dot-live{background:#ef5350;box-shadow:0 0 6px rgba(239,83,80,.7);}
.dot-clear{background:#66bb6a;}
.ops{white-space:nowrap;}
.ops button{padding:4px 9px;margin-right:4px;cursor:pointer;font-size:11px;font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:7px;}
.ops .go{color:#90caf9;border-color:rgba(66,165,245,.4);}
.ops .ok-btn{color:#a5d6a7;border-color:rgba(102,187,106,.4);}
.ops .susp{color:#ffd54f;border-color:rgba(255,213,79,.4);}
.ops .reopen{color:#ffab91;border-color:rgba(255,171,145,.4);}
.sub{margin:10px 0 0;font-size:11px;color:#5b6f94;line-height:1.7;}
.empty{color:#5b6f94;text-align:center;padding:22px;font-size:12px;}
/* 弹窗 */
.modal-mask{position:fixed;inset:0;background:rgba(4,10,22,.65);z-index:60;display:flex;align-items:center;justify-content:center;}
.modal{background:#0f1b38;border:1px solid rgba(120,160,220,0.25);border-radius:14px;padding:20px;width:440px;max-width:92vw;}
.modal h4{margin-bottom:12px;}
.wo-head{background:#0c1730;border-radius:9px;padding:10px 12px;font-size:12px;color:#8ba2c8;margin-bottom:14px;}
.wo-head b{color:#90caf9;margin-right:6px;}
.field{margin-bottom:12px;}
.field label{display:block;font-size:11px;color:#8ba2c8;margin-bottom:5px;}
.field select,.field textarea{width:100%;box-sizing:border-box;font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:9px 10px;font-size:12px;}
.modal-ops{display:flex;gap:8px;margin-top:6px;}
.save{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;border-radius:8px;padding:9px 18px;font-size:12px;font-family:inherit;}
.save:disabled{opacity:.45;cursor:not-allowed;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:9px 16px;font-size:12px;font-family:inherit;}
/* 抽屉 */
.drawer-mask{position:fixed;inset:0;background:rgba(4,10,22,.5);z-index:55;display:flex;justify-content:flex-end;}
.drawer{width:480px;max-width:94vw;height:100%;background:#0f1b38;border-left:1px solid rgba(120,160,220,0.25);display:flex;flex-direction:column;}
.drawer-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid rgba(120,160,220,0.15);}
.drawer-head h4{display:inline;margin-right:8px;}
.drawer-body{padding:16px 18px;overflow-y:auto;flex:1;}
.d-title{font-size:15px;color:#fff;font-weight:600;margin-bottom:14px;}
.d-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;}
.d-grid>div{background:#0c1730;border-radius:9px;padding:9px 11px;}
.d-grid em{display:block;font-size:10px;color:#5b6f94;font-style:normal;margin-bottom:3px;}
.d-grid b{font-size:12px;color:#dbe4f3;font-weight:600;}
.d-grid b.error{color:#ff8a80;}
.d-detail{font-size:12px;color:#8ba2c8;background:#13233f;border-radius:9px;padding:10px 12px;margin-bottom:12px;line-height:1.6;}
.d-notes{background:#1a2410;border:1px solid rgba(165,214,167,.2);border-radius:9px;padding:10px 12px;margin-bottom:16px;}
.d-notes em{font-size:10px;color:#8ba2c8;font-style:normal;}
.d-notes div{font-size:12px;color:#c8e6c9;margin-top:4px;white-space:pre-wrap;line-height:1.6;}
h5{margin:8px 0 12px;color:#fff;font-size:13px;}
.tl{border-left:2px solid #1a2a4a;padding-left:18px;display:flex;flex-direction:column;gap:14px;}
.tl-item{position:relative;}
.tl-dot{position:absolute;left:-24px;top:4px;width:11px;height:11px;border-radius:50%;background:#546e7a;border:2px solid #0f1b38;}
.tl-dot.created{background:#42a5f5;}.tl-dot.flow{background:#90caf9;}.tl-dot.ok{background:#66bb6a;}
.tl-dot.susp{background:#ffd54f;}.tl-dot.clear{background:#a5d6a7;}.tl-dot.reopen{background:#ffab91;}
.tl-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.tl-line b{color:#fff;font-size:12px;}
.who{font-size:10px;padding:2px 8px;border-radius:10px;background:#13233f;color:#8ba2c8;border:1px solid rgba(120,160,220,0.15);}
.who i{font-style:normal;color:#6f84ab;}
.time{margin-left:auto;color:#5b6f94;font-size:10px;}
.tl-flow{font-size:10px;color:#90caf9;margin-top:3px;}
.tl-detail{color:#8ba2c8;font-size:11px;margin-top:3px;line-height:1.6;}
.slide-enter-active,.slide-leave-active{transition:opacity .25s;}
.slide-enter-from,.slide-leave-to{opacity:0;}
</style>
