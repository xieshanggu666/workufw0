<template>
  <div class="family">
    <!-- 当前身份 + 加入家庭 -->
    <div class="id-bar">
      <div class="me">
        <span class="avatar">{{ avatarText }}</span>
        <div class="me-info">
          <template v-if="store.current">
            <b>{{ store.current.name }}</b>
            <span class="role-tag" :class="store.current.role">
              {{ store.current.role_label }}<em v-if="currentMember?.relation"> · {{ currentMember.relation }}</em>
            </span>
          </template>
          <template v-else>
            <b>浏览模式</b>
            <span class="role-tag none">未选择身份 · 仅可查看，写操作需加入家庭</span>
          </template>
        </div>
        <div class="perm-chips">
          <i v-for="p in (currentMember?.effective_perms || [])" :key="p" class="perm">{{ shortPerm(p) }}</i>
          <i v-if="currentMember" class="perm scope" :class="{house: currentMember.unscoped}">
            🧭 {{ store.scopeLabel(currentMember) }}
          </i>
        </div>
      </div>
      <div class="id-ops">
        <button class="join" @click="joinShow = true">🎟️ 凭邀请码加入</button>
        <select :value="store.current?.id || ''" @change="onSwitchId">
          <option value="">切换演示身份…</option>
          <option v-for="m in store.activeMembers" :key="m.id" :value="m.id">{{ m.role_label }} · {{ m.name }}</option>
        </select>
        <button v-if="store.current" class="ghost" @click="store.switchIdentity(null)">退出身份</button>
      </div>
    </div>

    <!-- KPI -->
    <div class="kpis">
      <div class="kpi"><b>{{ store.activeMembers.length }}</b><em>在组成员</em></div>
      <div class="kpi"><b class="blue">{{ store.pendingInvites.length }}</b><em>待接受邀请</em></div>
      <div class="kpi"><b class="grey">{{ revokedCount }}</b><em>已撤销（可回收）</em></div>
      <div class="kpi"><b class="green">{{ (currentMember?.effective_perms || []).length }}</b><em>我的授权项</em></div>
    </div>

    <!-- 角色权限矩阵 -->
    <div class="card">
      <div class="card-head">
        <h4>🛡️ 角色与授权范围（设备控制 · 场景执行 · 定额告警处理等贯穿全屋）</h4>
      </div>
      <div class="roles">
        <div v-for="(meta, key) in store.family.roles" :key="key" class="role-card"
             :class="[key, {cur: store.current?.role === key}]">
          <div class="rc-head">
            <b>{{ roleIcon[key] }} {{ meta.label }}</b>
            <i v-if="store.current?.role === key" class="cur-tag">当前</i>
          </div>
          <div class="rc-perms">
            <span v-for="p in allPermKeys" :key="p" class="rp" :class="{ on: meta.default_perms.includes(p) }">
              {{ meta.default_perms.includes(p) ? '✓' : '—' }} {{ shortPerm(p) }}
            </span>
          </div>
        </div>
      </div>
      <p class="sub">角色默认权限之外可在「编辑成员 / 创建邀请」时逐项追加自定义授权，并可按<b>房间 / 设备</b>限定操作范围（设备授权换房自动跟随、房间授权按设备当前房间判定，邀请/续邀/撤销同步生效）；户主拥有全部权限且不可撤销，管理员只能管理成员与访客。</p>
    </div>

    <!-- 邀请与成员管理（需 member_manage 权限；无权时只读展示） -->
    <template v-if="store.can('member_manage')">
      <!-- 邀请管理 -->
      <div class="card">
        <div class="card-head">
          <h4>✉️ 邀请管理（7 天有效 · 待接受 / 已接受 / 已取消 / 已过期）</h4>
          <button class="add" @click="openInviteForm">＋ 发出邀请</button>
        </div>

        <form v-if="inviteForm.show" class="form" @submit.prevent="submitInvite">
          <input v-model="inviteForm.name" placeholder="受邀人名称，如 保洁张姐" required />
          <input v-model="inviteForm.relation" placeholder="关系/称呼（可选）" />
          <select v-model="inviteForm.role">
            <option v-for="r in invitableRoles" :key="r.key" :value="r.key">{{ r.label }}</option>
          </select>
          <div class="scope-pick">
            <span class="pp-title">
              操作范围（不勾选=全屋；勾选后设备控制 / 场景执行 / 定额 / 工单仅对授权房间与设备生效）：
            </span>
            <div v-if="inviteForm.role === 'owner'" class="dim">户主拥有全屋权限，不可限定。</div>
            <div v-else class="scope-grid">
              <div v-for="r in store.rooms" :key="'r'+r.id" class="scope-group">
                <label class="room-pick">
                  <input type="checkbox" :value="r.id" v-model="inviteForm.scope_rooms" />
                  🚪 {{ r.name }}
                </label>
                <label v-for="d in devicesByRoom(r.id)" :key="d.id" class="dev-pick">
                  <input type="checkbox" :value="d.id" v-model="inviteForm.scope_devices" />
                  {{ d.type_icon }} {{ d.name }}
                </label>
              </div>
            </div>
          </div>
          <div class="perm-pick">
            <span class="pp-title">在角色默认之外追加授权：</span>
            <label v-for="p in allPermKeys" :key="p" :class="{off: isDefaultPerm(inviteForm.role, p)}">
              <input type="checkbox" :value="p" v-model="inviteForm.perms" :disabled="isDefaultPerm(inviteForm.role, p)" />
              {{ shortPerm(p) }}
            </label>
          </div>
          <button type="submit" class="save">生成邀请码</button>
          <button type="button" class="ghost" @click="inviteForm.show = false">取消</button>
        </form>

        <table v-if="store.family.invites.length">
          <thead><tr>
            <th>受邀人</th><th>角色</th><th>追加授权</th><th>操作范围</th><th>邀请码</th><th>状态</th><th>有效期/时间</th><th>操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="i in store.family.invites" :key="i.id" :class="{dead: i.status !== 'pending'}">
              <td>{{ i.name }}<span v-if="i.relation" class="dim"> · {{ i.relation }}</span></td>
              <td><i class="role-mini" :class="i.role">{{ i.role_label }}</i></td>
              <td>
                <span v-if="i.perms.length" class="perm-list">{{ i.perms.map(shortPerm).join('、') }}</span>
                <span v-else class="dim">默认</span>
              </td>
              <td><span class="scope-text" :class="{house: i.unscoped}">{{ inviteScopeText(i) }}</span></td>
              <td><code :class="{soon: i.expired}">{{ i.code }}</code></td>
              <td>
                <span class="inv-st" :class="i.status">{{ i.status_label }}</span>
                <span v-if="i.status==='pending' && i.expired" class="inv-st expired">即将/已到期</span>
              </td>
              <td class="dim">{{ fmtTime(i.expires_at) }}</td>
              <td class="ops">
                <template v-if="i.status === 'pending'">
                  <button class="copy" @click="copyCode(i.code)">复制码</button>
                  <button class="go" @click="store.resendInvite(i.id)">重新发码</button>
                  <button class="danger" @click="cancel(i)">取消</button>
                </template>
                <span v-else-if="i.cancel_reason" class="dim">{{ i.cancel_reason }}</span>
                <span v-else class="dim">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">暂无邀请。点击「发出邀请」为家人或访客生成邀请码，对方凭码加入后获得对应角色授权。</div>
      </div>

      <!-- 成员列表 -->
      <div class="card">
        <div class="card-head"><h4>👨‍👩‍👧‍👦 成员与访客（编辑角色/权限即时生效 · 撤销即回收全部授权与令牌）</h4></div>
        <div class="members">
          <div v-for="m in store.family.members" :key="m.id" class="member" :class="[m.role, {revoked: m.status === 'revoked', editing: editId === m.id}]">
            <div class="m-main">
              <span class="m-avatar">{{ m.name.slice(0, 1) }}</span>
              <div class="m-info">
                <b>{{ m.name }}
                  <i v-if="m.relation" class="rel">{{ m.relation }}</i>
                  <i v-if="m.id === store.current?.id" class="me-tag">我</i>
                </b>
                <span class="m-meta">
                  <i class="role-mini" :class="m.role">{{ m.role_label }}</i>
                  <span class="st" :class="m.status">{{ m.status_label }}</span>
                  <span v-if="m.status === 'revoked'" class="dim"> · {{ m.revoke_reason || '授权已回收' }}</span>
                </span>
                <div class="perm-chips">
                  <i v-for="p in m.effective_perms" :key="p" class="perm">{{ shortPerm(p) }}</i>
                  <i v-if="!m.effective_perms.length" class="perm none">仅浏览</i>
                </div>
                <div class="scope-line" :class="{house: m.unscoped}">
                  <b>操作范围</b> {{ store.scopeLabel(m) }}
                </div>
              </div>
              <div class="m-ops">
                <template v-if="m.role !== 'owner' && canEdit(m)">
                  <button v-if="m.status === 'active'" class="go" @click="toggleEdit(m)">✏️ 权限</button>
                  <button v-if="m.status === 'active'" class="danger" @click="revoke(m)">⛔ 撤销</button>
                  <button v-if="m.status === 'revoked'" class="ok-btn" @click="store.restoreMember(m.id)">♻️ 恢复</button>
                  <button v-if="m.status === 'revoked'" class="go" @click="store.reinviteMember(m.id)">✉️ 重新邀请</button>
                </template>
                <span v-else-if="m.role === 'owner'" class="dim">户主 · 全部权限 · 不可撤销</span>
                <span v-else class="dim">无权管理（同级或更高级）</span>
              </div>
            </div>
            <!-- 编辑面板 -->
            <form v-if="editId === m.id" class="edit-panel" @submit.prevent="submitEdit(m)">
              <input v-model="editForm.name" placeholder="名称" />
              <input v-model="editForm.relation" placeholder="关系/称呼" />
              <select v-model="editForm.role" @change="onEditRoleChange">
                <option v-for="r in editableRoles(m)" :key="r.key" :value="r.key">{{ r.label }}</option>
              </select>
              <div class="scope-pick">
                <span class="pp-title">
                  操作范围（不勾选=全屋；房间授权按设备当前所在房间生效，设备授权换房自动跟随）：
                </span>
                <div class="scope-grid">
                  <div v-for="r in store.rooms" :key="'er'+r.id" class="scope-group">
                    <label class="room-pick">
                      <input type="checkbox" :value="r.id" v-model="editForm.scope_rooms" />
                      🚪 {{ r.name }}
                    </label>
                    <label v-for="d in devicesByRoom(r.id)" :key="'ed'+d.id" class="dev-pick">
                      <input type="checkbox" :value="d.id" v-model="editForm.scope_devices" />
                      {{ d.type_icon }} {{ d.name }}
                    </label>
                  </div>
                </div>
              </div>
              <div class="perm-pick">
                <label v-for="p in allPermKeys" :key="p" :class="{off: isDefaultPerm(editForm.role, p)}">
                  <input type="checkbox" :checked="isDefaultPerm(editForm.role, p) || editForm.perms.includes(p)"
                         :disabled="isDefaultPerm(editForm.role, p)"
                         @change="toggleEditPerm(p, $event.target.checked)" />
                  {{ shortPerm(p) }}
                </label>
              </div>
              <button type="submit" class="save">保存</button>
              <button type="button" class="ghost" @click="editId = null">取消</button>
            </form>
          </div>
        </div>
      </div>
    </template>

    <!-- 无管理权限：只读成员名册 -->
    <div v-else class="card">
      <div class="card-head"><h4>👨‍👩‍👧‍👦 家庭成员名册</h4></div>
      <p class="sub lock-tip">🔒 当前角色为「{{ store.current?.role_label || '浏览模式' }}」，成员邀请、角色调整与撤销需「成员与邀请管理」权限，此处仅可查看名册。</p>
      <div class="members">
        <div v-for="m in store.family.members" :key="m.id" class="member" :class="[m.role, {revoked: m.status === 'revoked'}]">
          <div class="m-main">
            <span class="m-avatar">{{ m.name.slice(0, 1) }}</span>
            <div class="m-info">
              <b>{{ m.name }}<i v-if="m.relation" class="rel">{{ m.relation }}</i></b>
              <span class="m-meta">
                <i class="role-mini" :class="m.role">{{ m.role_label }}</i>
                <span class="st" :class="m.status">{{ m.status_label }}</span>
              </span>
              <div class="perm-chips"><i v-for="p in m.effective_perms" :key="p" class="perm">{{ shortPerm(p) }}</i></div>
              <div class="scope-line" :class="{house: m.unscoped}">
                <b>操作范围</b> {{ store.scopeLabel(m) }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 凭邀请码加入 弹窗 -->
    <div v-if="joinShow" class="modal-mask" @click.self="joinShow = false">
      <div class="modal">
        <h4>🎟️ 凭邀请码加入家庭</h4>
        <div class="join-step">
          <input v-model="joinCode" placeholder="输入 8 位邀请码" maxlength="12" class="code-input"
                 @input="joinCode = joinCode.toUpperCase()" />
          <button class="go" @click="doPreview" :disabled="joinCode.trim().length < 6">查询邀请</button>
        </div>
        <div v-if="joinPreview" class="preview">
          <p>你将以 <b class="role-mini" :class="joinPreview.role">{{ joinPreview.role_label }}</b> 身份加入：</p>
          <p class="pv-name">👤 {{ joinPreview.name }}<span v-if="joinPreview.relation"> · {{ joinPreview.relation }}</span></p>
          <div class="perm-chips">
            <i v-for="p in joinEffectivePerms" :key="p" class="perm">{{ shortPerm(p) }}</i>
          </div>
          <p class="pv-scope"><b>操作范围：</b>{{ joinScopeText }}</p>
          <p class="dim">有效期至 {{ fmtTime(joinPreview.expires_at) }}</p>
        </div>
        <p v-if="joinError" class="err">{{ joinError }}</p>
        <div class="modal-ops">
          <button class="save" :disabled="!joinPreview" @click="doAccept">接受邀请并加入</button>
          <button class="ghost" @click="joinShow = false">关闭</button>
        </div>
        <p class="sub">演示提示：在「邀请管理」中可复制待接受邀请码（如示例 <code>GUEST2026</code>）。</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()

const roleIcon = { owner: '👑', admin: '🛠️', member: '👤', guest: '🧳' }
const allPermKeys = ['device_control', 'scene_execute', 'scene_manage', 'quota_alert_handle', 'quota_manage', 'workorder_dispatch', 'workorder_handle', 'member_manage']
function shortPerm(key) {
  // 取中文括号前的短语，空间有限
  return (store.family.permissions[key] || key).split('（')[0]
}

const revokedCount = computed(() => store.family.members.filter((m) => m.status === 'revoked').length)
const currentMember = computed(() => store.family.members.find((m) => m.id === store.current?.id) || null)
const avatarText = computed(() => store.current ? store.current.name.slice(0, 1) : '👁')

// 管理员只能邀请 member/guest；户主可邀 admin/member/guest
const invitableRoles = computed(() => {
  const cur = store.current?.role
  const items = [
    { key: 'admin', label: '家庭管理员（设备/场景/定额/成员管理，不能管管理员）' },
    { key: 'member', label: '家庭成员（设备控制、场景执行、定额告警/工单处理）' },
    { key: 'guest', label: '访客（默认仅场景执行）' }
  ]
  return cur === 'owner' ? items : items.filter((r) => r.key !== 'admin')
})
function isDefaultPerm(role, p) {
  return (store.family.roles[role]?.default_perms || []).includes(p)
}
// 层级：当前人能否编辑目标成员（与后端 canManage 一致）
const rank = { owner: 3, admin: 2, member: 1, guest: 0 }
function canEdit(m) {
  const cur = store.current
  if (!cur) return false
  if (cur.role === 'owner') return m.role !== 'owner'
  if (cur.role === 'admin') return rank[cur.role] > rank[m.role]
  return false
}
function editableRoles(m) {
  const cur = store.current?.role
  const below = cur === 'owner' ? ['admin', 'member', 'guest'] : ['member', 'guest']
  return below.map((key) => ({ key, label: store.family.roles[key].label }))
}

// ===== 身份切换 =====
function onSwitchId(e) {
  const id = Number(e.target.value)
  e.target.value = ''
  if (!id) return
  const m = store.activeMembers.find((x) => x.id === id)
  if (m) store.switchIdentity(m)
}

// ===== 创建邀请 =====
const emptyInviteForm = () => ({ show: false, name: '', relation: '', role: 'guest', perms: [], scope_rooms: [], scope_devices: [] })
const inviteForm = ref(emptyInviteForm())
function openInviteForm() {
  inviteForm.value = { ...emptyInviteForm(), show: true, role: 'member' }
}
// 按房间分组设备（范围选择器）
function devicesByRoom(roomId) {
  return store.devices.filter((d) => d.room_id === roomId)
}
// 邀请表格中的范围摘要
function inviteScopeText(i) {
  return store.scopeLabel(i)
}
async function submitInvite() {
  const inv = await store.createInvite({
    name: inviteForm.value.name, relation: inviteForm.value.relation,
    role: inviteForm.value.role, perms: inviteForm.value.perms,
    scope_rooms: inviteForm.value.scope_rooms, scope_devices: inviteForm.value.scope_devices
  })
  if (inv) inviteForm.value.show = false
}
async function cancel(i) {
  const reason = prompt(`取消发给「${i.name}」的邀请？可填原因（可选）：`, '')
  if (reason === null) return
  await store.cancelInvite(i.id, reason)
}
function copyCode(code) {
  navigator.clipboard?.writeText(code).then(
    () => store.toastMsg(`邀请码 ${code} 已复制`, 'success'),
    () => store.toastMsg(`邀请码：${code}`, 'info'))
}

// ===== 编辑成员 =====
const editId = ref(null)
const editForm = ref({ name: '', relation: '', role: 'member', perms: [], scope_rooms: [], scope_devices: [] })
function toggleEdit(m) {
  if (editId.value === m.id) { editId.value = null; return }
  editId.value = m.id
  editForm.value = {
    name: m.name, relation: m.relation, role: m.role,
    // 勾选框的额外项 = 实际权限 − 角色默认
    perms: m.effective_perms.filter((p) => !isDefaultPerm(m.role, p)),
    scope_rooms: [...(m.scope_rooms || [])],
    scope_devices: [...(m.scope_devices || [])]
  }
}
function onEditRoleChange() {
  // 换角色后，已成为新角色默认权限的额外项自动剔除
  editForm.value.perms = editForm.value.perms.filter((p) => !isDefaultPerm(editForm.value.role, p))
}
function toggleEditPerm(p, checked) {
  const set = new Set(editForm.value.perms)
  checked ? set.add(p) : set.delete(p)
  editForm.value.perms = [...set]
}
async function submitEdit(m) {
  const ok = await store.updateMember(m.id, {
    name: editForm.value.name, relation: editForm.value.relation,
    role: editForm.value.role, perms: editForm.value.perms,
    scope_rooms: editForm.value.scope_rooms, scope_devices: editForm.value.scope_devices
  })
  if (ok) editId.value = null
}
async function revoke(m) {
  const reason = prompt(`撤销${m.role_label}「${m.name}」的全部授权？\n令牌立即失效，设备控制/场景执行/告警处理权限当场收回。可填原因（可选）：`, '')
  if (reason === null) return
  await store.revokeMember(m.id, reason)
}

// ===== 凭码加入 =====
const joinShow = ref(false)
const joinCode = ref('')
const joinPreview = ref(null)
const joinError = ref('')
const joinEffectivePerms = computed(() => {
  if (!joinPreview.value) return []
  return [...new Set([...(store.family.roles[joinPreview.value.role]?.default_perms || []), ...joinPreview.value.perms])]
})
const joinScopeText = computed(() => {
  if (!joinPreview.value) return ''
  return store.scopeLabel(joinPreview.value)
})
async function doPreview() {
  joinError.value = ''; joinPreview.value = null
  try { joinPreview.value = await store.previewInvite(joinCode.value.trim()) }
  catch (e) { joinError.value = e.message }
}
async function doAccept() {
  const ok = await store.acceptInvite(joinCode.value.trim())
  if (ok) { joinShow.value = false; joinCode.value = ''; joinPreview.value = null }
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<style scoped>
.family{display:flex;flex-direction:column;gap:16px;}
/* 身份栏 */
.id-bar{background:linear-gradient(135deg,#10234a,#0d1a36);border:1px solid rgba(120,160,220,0.22);border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;}
.me{display:flex;align-items:center;gap:12px;flex:1;min-width:280px;}
.avatar{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;font-size:19px;font-weight:700;background:linear-gradient(135deg,#42a5f5,#1565c0);color:#fff;}
.me-info b{color:#fff;font-size:16px;display:block;}
.role-tag{font-style:normal;font-size:11px;color:#90caf9;}
.role-tag.none{color:#8ba2c8;}
.role-tag em{color:#6f84ab;font-style:normal;}
.perm-chips{display:flex;flex-wrap:wrap;gap:5px;margin-left:auto;max-width:520px;}
.perm{font-style:normal;font-size:10px;background:#13315c;color:#90caf9;border:1px solid rgba(66,165,245,0.25);padding:2px 8px;border-radius:10px;white-space:nowrap;}
.perm.none{background:#263238;color:#90a4ae;border-color:#37474f;}
.id-ops{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.id-ops select,.id-ops button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer;}
.id-ops .join{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;}
.id-ops .ghost{background:#16263f;color:#8ba2c8;}
/* KPI */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.kpi{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;text-align:center;}
.kpi b{display:block;font-size:28px;color:#ffd54f;}
.kpi b.blue{color:#42a5f5;}.kpi b.grey{color:#78909c;}.kpi b.green{color:#66bb6a;}
.kpi em{font-size:12px;color:#8ba2c8;font-style:normal;}
/* 卡片 */
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
h4{margin:0;color:#fff;font-size:14px;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;cursor:pointer;border-radius:8px;padding:7px 14px;font-size:12px;}
.sub{margin:10px 0 0;font-size:11px;color:#5b6f94;}
.lock-tip{color:#ffb74d;}
/* 角色矩阵 */
.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;}
.role-card{background:#0c1730;border:1px solid rgba(120,160,220,0.16);border-radius:10px;padding:12px;border-top:3px solid #546e7a;}
.role-card.owner{border-top-color:#ffd54f;}.role-card.admin{border-top-color:#42a5f5;}
.role-card.member{border-top-color:#66bb6a;}.role-card.guest{border-top-color:#b0bec5;}
.role-card.cur{outline:2px solid #2962ff;}
.rc-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.rc-head b{color:#fff;font-size:13px;}
.cur-tag{font-style:normal;font-size:9px;background:#2962ff;color:#fff;padding:1px 7px;border-radius:8px;}
.rc-perms{display:flex;flex-direction:column;gap:4px;}
.rp{font-size:11px;color:#4d6085;}
.rp.on{color:#a5d6a7;}
/* 表单 */
.form{display:flex;gap:8px;flex-wrap:wrap;background:#0c1730;border:1px solid rgba(120,160,220,0.18);border-radius:10px;padding:12px;margin-bottom:12px;align-items:center;}
select,input,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.form .save{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;}
.form .ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.perm-pick{display:flex;gap:6px 14px;flex-wrap:wrap;align-items:center;flex-basis:100%;}
.pp-title{font-size:11px;color:#8ba2c8;width:100%;}
.perm-pick label{font-size:11px;color:#dbe4f3;display:flex;align-items:center;gap:4px;cursor:pointer;}
.perm-pick label.off{opacity:.4;}
.perm-pick input{width:auto;padding:0;}
/* 房间/设备操作范围选择器 */
.scope-pick{flex-basis:100%;background:#0a1529;border:1px dashed rgba(120,160,220,0.25);border-radius:8px;padding:9px 10px;}
.scope-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 14px;margin-top:6px;max-height:170px;overflow:auto;}
.scope-group{display:flex;flex-direction:column;gap:3px;border-left:2px solid rgba(120,160,220,0.25);padding-left:8px;}
.room-pick{font-size:12px;color:#90caf9!important;font-weight:600;cursor:pointer;}
.dev-pick{font-size:11px;color:#a8bdd8!important;padding-left:12px;cursor:pointer;}
.scope-pick input{width:auto;padding:0;margin-right:4px;}
.scope-line{font-size:10px;color:#7e93b8;margin-top:4px;}
.scope-line b{color:#90caf9;font-weight:600;margin-right:4px;}
.scope-line.house{color:#a5d6a7;}
.scope-line.house b{color:#a5d6a7;}
.scope-text{font-size:10px;color:#7e93b8;line-height:1.5;}
.scope-text.house{color:#a5d6a7;}
.perm.scope{background:#102540;color:#80deea;border-color:rgba(128,222,234,.3);}
.perm.scope.house{background:#12291c;color:#a5d6a7;border-color:rgba(165,214,167,.3);}
.pv-scope{font-size:12px!important;color:#80deea!important;}
.pv-scope b{color:#90caf9;}
/* 表格 */
table{width:100%;border-collapse:collapse;font-size:12px;}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid rgba(120,160,220,0.1);vertical-align:middle;}
th{color:#8ba2c8;font-weight:600;font-size:11px;}
td{color:#dbe4f3;}
tr.dead{opacity:.55;}
code{background:#0c1730;border:1px solid rgba(120,160,220,0.3);border-radius:6px;padding:2px 8px;font-size:12px;letter-spacing:1px;color:#ffd54f;}
code.soon{color:#ef9a9a;border-color:rgba(239,83,80,.4);}
.role-mini{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:600;}
.role-mini.owner{background:#4a3a10;color:#ffd54f;}.role-mini.admin{background:#13315c;color:#90caf9;}
.role-mini.member{background:#1b3a1f;color:#a5d6a7;}.role-mini.guest{background:#263238;color:#b0bec5;}
.inv-st{font-style:normal;font-size:10px;padding:2px 7px;border-radius:6px;margin-left:4px;}
.inv-st.pending{background:#4a3a10;color:#ffd54f;}.inv-st.accepted{background:#1b3a1f;color:#a5d6a7;}
.inv-st.canceled,.inv-st.expired{background:#263238;color:#90a4ae;}
.perm-list{font-size:11px;color:#90caf9;}
.dim{color:#5b6f94;font-size:11px;}
.ops{white-space:nowrap;}
.ops button{padding:4px 9px;margin-right:4px;cursor:pointer;font-size:11px;}
.ops .danger{color:#ef5350;border-color:rgba(239,83,80,.4);}
.ops .go{color:#90caf9;border-color:rgba(66,165,245,.4);}
.ops .ok-btn{color:#a5d6a7;border-color:rgba(102,187,106,.4);}
.ops .copy{color:#ffd54f;border-color:rgba(255,213,79,.35);}
.empty{color:#5b6f94;text-align:center;padding:14px;font-size:12px;}
/* 成员卡 */
.members{display:flex;flex-direction:column;gap:10px;}
.member{background:#0c1730;border:1px solid rgba(120,160,220,0.14);border-radius:10px;padding:12px;}
.member.revoked{opacity:.6;background:#0e1424;}
.member.editing{border-color:rgba(66,165,245,.5);}
.m-main{display:flex;gap:12px;align-items:flex-start;}
.m-avatar{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:#1b3a5c;color:#90caf9;font-weight:700;flex-shrink:0;}
.member.owner .m-avatar{background:#4a3a10;color:#ffd54f;}
.member.admin .m-avatar{background:#13315c;}
.member.guest .m-avatar{background:#263238;color:#cfd8dc;}
.m-info{flex:1;min-width:0;}
.m-info b{color:#fff;font-size:14px;}
.rel{font-style:normal;font-size:10px;color:#8ba2c8;background:#16263f;padding:1px 7px;border-radius:8px;margin-left:6px;font-weight:400;}
.me-tag{font-style:normal;font-size:10px;background:#2962ff;color:#fff;padding:1px 7px;border-radius:8px;margin-left:6px;}
.m-meta{display:flex;gap:8px;align-items:center;margin:3px 0;}
.st{font-style:normal;font-size:10px;padding:1px 7px;border-radius:6px;}
.st.active{background:#1b3a1f;color:#a5d6a7;}.st.revoked{background:#4a1818;color:#ef9a9a;}
.m-ops{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
.m-ops button{padding:5px 10px;font-size:11px;cursor:pointer;}
.edit-panel{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px dashed rgba(120,160,220,0.2);align-items:center;}
.edit-panel .save{background:#2962ff;border:none;color:#fff;cursor:pointer;}
.edit-panel .ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
/* 弹窗 */
.modal-mask{position:fixed;inset:0;background:rgba(4,10,24,.7);z-index:60;display:grid;place-items:center;padding:20px;}
.modal{background:#0f1b38;border:1px solid rgba(120,160,220,0.3);border-radius:14px;padding:20px;width:min(480px,100%);display:flex;flex-direction:column;gap:12px;}
.modal h4{margin:0;}
.join-step{display:flex;gap:8px;}
.code-input{flex:1;font-size:16px;letter-spacing:2px;text-transform:uppercase;}
.join-step .go{background:#13315c;border-color:#2962ff;color:#90caf9;cursor:pointer;font-weight:600;}
.preview{background:#0c1730;border:1px solid rgba(120,160,220,0.2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;}
.preview p{margin:0;font-size:12px;color:#dbe4f3;}
.pv-name b{color:#fff;}
.err{color:#ef9a9a;font-size:12px;margin:0;}
.modal-ops{display:flex;gap:8px;}
.modal-ops .save{flex:1;background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;padding:10px;border-radius:8px;}
.modal-ops .save:disabled{opacity:.45;cursor:not-allowed;}
.modal-ops .ghost{background:#16263f;color:#8ba2c8;cursor:pointer;padding:10px 14px;border-radius:8px;}
.modal code{color:#ffd54f;}
</style>
