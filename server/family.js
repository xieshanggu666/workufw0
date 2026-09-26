// ===== 家庭共享管理：邀请、角色权限与撤销，授权贯穿设备控制 / 场景执行 / 定额告警处理 =====
//
// 角色矩阵（ROLE_PERMS）：
//   owner   户主：全部权限，唯一不可撤销/不可改角色
//   admin   家庭管理员：除「邀请/管理同级或更高级角色」外全部具备（可管普通成员与访客）
//   member  家庭成员：设备控制、场景执行、定额告警处理（默认无定额配置管理）
//   guest   访客：仅可执行场景（演示家庭「可回收协作闭环」中权限最小的身份）
//
// admin 虽持有 member_manage，但 canManage() 层级校验保证其只能管理 member/guest，
// 不能邀请/撤销/降权管理员或户主。
//
// 权限可在邀请/编辑时在角色默认之上显式勾选自定义（perms 列存 JSON 键数组），
// 角色降级/提升时权限快照随编辑结果一起留痕，避免「换人不换权」。
//
// 细粒度授权（scope 列，JSON {room_ids:[], device_ids:[]}）：
//   管理员可把成员/访客的每项操作限定到指定房间与设备；scope 为空 = 全屋不限。
//   房间授权按 devices.room_id 动态判定——设备换房后授权自动跟随到新房间；
//   单设备授权按稳定 device_id 判定——换房/改名不丢失（历史授权随设备迁移）。
//   设备删除后其 device_id 残留在 scope 中（stale），列表回显标记但不影响判定。
//   户主/管理员始终全屋不限；邀请、续邀、接受、编辑权限、撤销/恢复全程携带 scope 快照。
//
// 可回收闭环：邀请(pending) → 接受(active, 发令牌) → 协作操作（全部记入家庭日志，带操作人）
//   → 撤销(revoked, 令牌立即失效、所有授权收回) → 重新邀请/恢复（新邀请或复用原身份回到 active）。
//   邀请也可在接受前取消/过期；每个状态迁移都写家庭日志。

const INVITE_TTL_MS = 7 * 24 * 3600_000   // 邀请有效期 7 天

// 权限键 → 中文说明（前端角色卡片与勾选框共用同一口径）
export const PERMISSIONS = {
  device_control: '设备控制（开关、编辑、增删）',
  scene_execute: '场景执行（触发已启用场景）',
  scene_manage: '场景管理（新建/启停/删除）',
  quota_alert_handle: '定额告警处理（待处理→处理中→已处理/忽略）',
  quota_manage: '定额配置管理（额度新建/调整/删除）',
  workorder_dispatch: '告警工单分派（待分派/复开→分派、改派）',
  workorder_handle: '告警工单处理（接单/处理中/挂起/完成/复开）',
  member_manage: '成员与邀请管理（邀请/编辑/撤销/恢复）'
}

export const ROLE_LABEL = { owner: '户主', admin: '家庭管理员', member: '家庭成员', guest: '访客' }
export const STATUS_LABEL = { active: '在组', revoked: '已撤销' }
export const INVITE_STATUS_LABEL = { pending: '待接受', accepted: '已接受', canceled: '已取消', expired: '已过期' }

export const ROLE_PERMS = {
  owner: ['device_control', 'scene_execute', 'scene_manage', 'quota_alert_handle', 'quota_manage', 'workorder_dispatch', 'workorder_handle', 'member_manage'],
  admin: ['device_control', 'scene_execute', 'scene_manage', 'quota_alert_handle', 'quota_manage', 'workorder_dispatch', 'workorder_handle', 'member_manage'],
  member: ['device_control', 'scene_execute', 'quota_alert_handle', 'workorder_handle'],
  guest: ['scene_execute']
}

// 哪些角色可以管理哪些目标角色（层级制；户主不可被任何人操作）
const ROLE_RANK = { owner: 3, admin: 2, member: 1, guest: 0 }

let db
let stmts
// 通过注入回调写家庭日志，避免与 index.js 循环依赖；与定额通知同一出口
let notify = () => {}

function token() {
  return 'hm_' + Buffer.from(`${Date.now()}-${Math.random()}-${Math.random()}`).toString('base64url').slice(0, 32)
}
function inviteCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}
function nowIso() { return new Date().toISOString() }
function parsePerms(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.filter((k) => PERMISSIONS[k]) : [] }
  catch { return [] }
}
function validPerms(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((k) => PERMISSIONS[k]))]
}
// ===== 操作范围（按房间/设备细粒度授权）解析 =====
// scope 形态：{ room_ids: number[], device_ids: number[] }；空对象/空数组 = 全屋不限
function parseScope(raw) {
  let v
  try { v = JSON.parse(raw || '{}') } catch { v = {} }
  if (!v || (typeof v !== 'object' && !Array.isArray(v))) v = {}
  const roomIds = Array.isArray(v.room_ids) ? v.room_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  const deviceIds = Array.isArray(v.device_ids) ? v.device_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  return { room_ids: [...new Set(roomIds)], device_ids: [...new Set(deviceIds)] }
}
function validScope(input) {
  return parseScope(JSON.stringify(input && typeof input === 'object' ? input : {}))
}
// scope 是否为空（空 = 全屋不限）
function scopeIsEmpty(scope) {
  return !scope.room_ids.length && !scope.device_ids.length
}
// 设备是否落在操作范围内：全屋不限；或命中房间授权（按当前 room_id）；或命中单设备授权（按稳定 id）
// 房间授权是动态的：设备换房后自动按新房间判定，授权随之迁移，无需改写成员 scope
export function deviceInScope(member, device) {
  if (!member || !device) return false
  if (member.role === 'owner' || member.role === 'admin') return true
  const scope = parseScope(member.scope)
  if (scopeIsEmpty(scope)) return true
  return scope.device_ids.includes(Number(device.id)) || scope.room_ids.includes(Number(device.room_id))
}
// 房间是否落在操作范围内（房间定额/房间维度操作）：全屋不限或房间被显式授权
export function roomInScope(member, roomId) {
  if (!member) return false
  if (member.role === 'owner' || member.role === 'admin') return true
  const scope = parseScope(member.scope)
  if (scopeIsEmpty(scope)) return true
  return scope.room_ids.includes(Number(roomId))
}
// 越权拦截的统一文案
export function scopeDeniedMessage(targetLabel) {
  return `操作对象「${targetLabel}」不在你的授权房间/设备范围内，请联系管理员调整授权范围`
}

// 设备日志表补「操作人」列（旧库迁移）：家庭协作要求每条操作可归因到成员/访客
function migrateLogs() {
  const cols = db.prepare('PRAGMA table_info(device_logs)').all().map((c) => c.name)
  if (!cols.includes('operator')) db.exec("ALTER TABLE device_logs ADD COLUMN operator TEXT NOT NULL DEFAULT '系统'")
  if (!cols.includes('operator_role')) db.exec("ALTER TABLE device_logs ADD COLUMN operator_role TEXT NOT NULL DEFAULT ''")
  if (!cols.includes('category')) db.exec("ALTER TABLE device_logs ADD COLUMN category TEXT NOT NULL DEFAULT 'device'")
}

// 旧库迁移：成员/邀请表补「操作范围」列（按房间/设备细粒度授权，旧数据默认全屋不限）
function migrateScope() {
  for (const table of ['household_members', 'household_invites']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes('scope')) db.exec(`ALTER TABLE ${table} ADD COLUMN scope TEXT NOT NULL DEFAULT '{}'`)
  }
}

export function initFamily(database, notifyFn) {
  db = database
  if (typeof notifyFn === 'function') notify = notifyFn
  migrateLogs()
  db.exec(`
  CREATE TABLE IF NOT EXISTS household_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    relation TEXT NOT NULL DEFAULT '',       -- 关系/称呼，如 妈妈、保洁阿姨
    role TEXT NOT NULL,                      -- owner/admin/member/guest
    perms TEXT NOT NULL DEFAULT '[]',        -- 显式权限键 JSON（与角色默认取并集）
    scope TEXT NOT NULL DEFAULT '{}',        -- 操作范围 JSON {room_ids:[],device_ids:[]}，空=全屋不限
    status TEXT NOT NULL DEFAULT 'active',   -- active / revoked
    token TEXT UNIQUE,                       -- 访问令牌；撤销即失效，恢复/重新接受时换新
    invited_by INTEGER,                      -- 邀请人 member id（户主为自身）
    invited_at TEXT NOT NULL,
    joined_at TEXT,                          -- 接受邀请（在组生效）时间
    revoked_at TEXT,
    revoke_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_members_status ON household_members(status);
  CREATE TABLE IF NOT EXISTS household_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    perms TEXT NOT NULL DEFAULT '[]',
    scope TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending / accepted / canceled / expired
    expires_at TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    accepted_member_id INTEGER,
    accepted_at TEXT,
    cancel_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_invites_status ON household_invites(status);
  `)
  // 旧库升级：表已存在时补 scope 列（全新库建表语句已包含，ALTER 前先判断列）
  migrateScope()
  stmts = {
    memberById: db.prepare('SELECT * FROM household_members WHERE id=?'),
    memberByName: db.prepare('SELECT * FROM household_members WHERE name=?'),
    memberByToken: db.prepare('SELECT * FROM household_members WHERE token=?'),
    allMembers: db.prepare('SELECT * FROM household_members ORDER BY id'),
    insertMember: db.prepare(`INSERT INTO household_members
      (name,relation,role,perms,scope,status,token,invited_by,invited_at,joined_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
    updateMember: db.prepare('UPDATE household_members SET name=?,relation=?,role=?,perms=?,scope=? WHERE id=?'),
    revokeMember: db.prepare(`UPDATE household_members SET status='revoked',token=NULL,revoked_at=?,revoke_reason=? WHERE id=?`),
    restoreMember: db.prepare(`UPDATE household_members SET status='active',token=?,revoked_at=NULL,revoke_reason='' WHERE id=?`),
    inviteById: db.prepare('SELECT * FROM household_invites WHERE id=?'),
    inviteByCode: db.prepare('SELECT * FROM household_invites WHERE code=?'),
    pendingInviteByName: db.prepare("SELECT * FROM household_invites WHERE name=? AND status='pending'"),
    allInvites: db.prepare('SELECT * FROM household_invites ORDER BY id DESC'),
    pendingInvites: db.prepare("SELECT * FROM household_invites WHERE status='pending' ORDER BY id DESC"),
    insertInvite: db.prepare(`INSERT INTO household_invites
      (code,name,relation,role,perms,scope,status,expires_at,created_by,created_at)
      VALUES (?,?,?,?,?,?, 'pending', ?,?,?)`),
    acceptInvite: db.prepare(`UPDATE household_invites SET status='accepted',accepted_member_id=?,accepted_at=? WHERE id=?`),
    cancelInvite: db.prepare(`UPDATE household_invites SET status='canceled',cancel_reason=? WHERE id=?`),
    expireInvite: db.prepare("UPDATE household_invites SET status='expired' WHERE id=?"),
    pendingInvitesAll: db.prepare("SELECT id FROM household_invites WHERE status='pending' AND expires_at<=?")
  }
  seedFamily()
  // 过期邀请在首次加载与每次状态查询时惰性结存（写一次家庭日志）
  expireStaleInvites(new Date())
}

// ===== 权限解析 =====
export function effectivePerms(member) {
  if (!member) return []
  const base = ROLE_PERMS[member.role] || []
  return [...new Set([...base, ...parsePerms(member.perms)])]
}
export function can(member, perm) {
  if (!member || member.status !== 'active') return false
  if (member.role === 'owner') return true
  return effectivePerms(member).includes(perm)
}
// actor 必须比 target 层级高才能管理（管理员可管成员/访客，户主可管所有人）
function canManage(actor, target) {
  if (!actor || actor.status !== 'active') return false
  if (actor.role === 'owner') return target.role !== 'owner'
  if (actor.role === 'admin') return ROLE_RANK[actor.role] > ROLE_RANK[target.role]
  return false
}

// ===== 令牌解析（请求身份）；令牌不存在/已撤销一律视为无身份 =====
export function getMemberByToken(tok) {
  if (!tok) return null
  const m = stmts.memberByToken.get(tok)
  if (!m || m.status !== 'active') return null
  return m
}
// 按 id 取在组成员（工单分派校验被分派人资格/范围用；非在组返回 null）
export function getActiveMemberById(id) {
  const m = stmts.memberById.get(Number(id))
  return m && m.status === 'active' ? m : null
}

// ===== 邀请生命周期 =====
export function createInvite(actor, { name, relation = '', role, perms, scope }) {
  if (!can(actor, 'member_manage')) throw new Error('无成员管理权限')
  name = String(name || '').trim()
  if (!name) throw new Error('请填写受邀人名称')
  if (!ROLE_LABEL[role]) throw new Error('角色无效')
  if (role === 'owner') throw new Error('不能邀请户主')
  if (!canManage(actor, { role })) throw new Error(`无权邀请「${ROLE_LABEL[role]}」`)
  if (stmts.memberByName.get(name)) throw new Error('该名称的成员已存在（如已撤销，请使用「重新邀请」）')
  if (stmts.pendingInviteByName.get(name)) throw new Error('该成员已有待接受的邀请')

  const at = new Date()
  const exp = new Date(at.getTime() + INVITE_TTL_MS)
  const code = uniqueCode()
  const permList = validPerms(perms)
  const scopeVal = normalizeInviteScope(role, scope)
  const r = stmts.insertInvite.run(code, name, String(relation || ''), role,
    JSON.stringify(permList), JSON.stringify(scopeVal), exp.toISOString(), actor.id, at.toISOString())
  notify({
    device: '👥', action: '邀请成员',
    detail: `${actorLabel(actor)} 向「${name}${relation ? '·' + relation : ''}」发出${ROLE_LABEL[role]}邀请，邀请码 ${code}（7 天内有效）；${scopeSummary(scopeVal)}`,
    operator: actor.name, operator_role: ROLE_LABEL[actor.role]
  }, 'member')
  return stmts.inviteById.get(r.lastInsertRowid)
}

// 户主/管理员角色本身全屋不限：为其携带的房间/设备限定直接规整为全屋，避免无效配置
function normalizeInviteScope(role, scope) {
  if (role === 'admin') return { room_ids: [], device_ids: [] }
  return validScope(scope)
}

function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const c = inviteCode()
    if (!stmts.inviteByCode.get(c)) return c
  }
  return inviteCode() + Date.now().toString(36).slice(-3)
}

// 接受邀请：校验待接受 + 未过期 + 同名未在组，生成访问令牌成为在组（active）成员
export function acceptInvite(code) {
  code = String(code || '').trim().toUpperCase()
  const inv = stmts.inviteByCode.get(code)
  if (!inv || inv.status !== 'pending') throw new Error('邀请码无效或已被使用')
  if (new Date(inv.expires_at).getTime() <= Date.now()) {
    stmts.expireInvite.run(inv.id)
    throw new Error('邀请已过期')
  }
  const exist = stmts.memberByName.get(inv.name)
  if (exist && exist.status === 'active') throw new Error('该成员已在家庭中')

  const at = new Date()
  let memberId
  if (exist) {
    // 同名的已撤销成员：复用原身份回到在组，角色/权限/范围以本次邀请为准（可回收闭环的「再加入」）
    stmts.updateMember.run(exist.name, inv.relation, inv.role, inv.perms, inv.scope, exist.id)
    stmts.restoreMember.run(token(), exist.id)
    memberId = exist.id
  } else {
    const r = stmts.insertMember.run(inv.name, inv.relation, inv.role, inv.perms, inv.scope,
      'active', token(), inv.created_by, inv.created_at, at.toISOString())
    memberId = Number(r.lastInsertRowid)
  }
  stmts.acceptInvite.run(memberId, at.toISOString(), inv.id)
  notify({
    device: '🎉', action: '接受邀请',
    detail: `「${inv.name}」凭邀请码 ${code} 加入家庭，角色：${ROLE_LABEL[inv.role]}，授权范围 ${permSummary(inv.role, parsePerms(inv.perms))}；${scopeSummary(parseScope(inv.scope))}`,
    operator: inv.name, operator_role: ROLE_LABEL[inv.role]
  }, 'member')
  return stmts.memberById.get(memberId)
}

// 取消尚未接受的邀请
export function cancelInvite(actor, id, reason = '') {
  if (!can(actor, 'member_manage')) throw new Error('无成员管理权限')
  const inv = stmts.inviteById.get(Number(id))
  if (!inv) throw new Error('邀请不存在')
  if (inv.status !== 'pending') throw new Error('仅待接受的邀请可取消')
  stmts.cancelInvite.run(String(reason || ''), inv.id)
  notify({
    device: '🚫', action: '取消邀请',
    detail: `${actorLabel(actor)} 取消了发给「${inv.name}」的${ROLE_LABEL[inv.role]}邀请${reason ? '：' + reason : ''}`,
    operator: actor.name, operator_role: ROLE_LABEL[actor.role]
  }, 'member')
}

// 重新发送（续期）邀请码：保持待接受并刷新 7 天有效期，生成新码
export function resendInvite(actor, id) {
  if (!can(actor, 'member_manage')) throw new Error('无成员管理权限')
  const inv = stmts.inviteById.get(Number(id))
  if (!inv || inv.status !== 'pending') throw new Error('邀请不存在或已结束')
  const at = new Date()
  const exp = new Date(at.getTime() + INVITE_TTL_MS)
  const code = uniqueCode()
  db.prepare('UPDATE household_invites SET code=?,expires_at=?,created_at=? WHERE id=?')
    .run(code, exp.toISOString(), at.toISOString(), inv.id)
  notify({
    device: '✉️', action: '重新发送邀请',
    detail: `${actorLabel(actor)} 向「${inv.name}」重新生成邀请码 ${code}（有效期顺延 7 天）`,
    operator: actor.name, operator_role: ROLE_LABEL[actor.role]
  }, 'member')
  return stmts.inviteById.get(inv.id)
}

// 编辑成员：改称呼/角色/自定义权限/操作范围。降权或收窄范围即立即生效
// （操作人令牌不变，授权当场收窄；下次请求即按新范围拦截）
export function updateMember(actor, id, { name, relation, role, perms, scope }) {
  if (!can(actor, 'member_manage')) throw new Error('无成员管理权限')
  const m = stmts.memberById.get(Number(id))
  if (!m) throw new Error('成员不存在')
  if (m.role === 'owner') throw new Error('户主信息不可修改')
  if (!canManage(actor, m)) throw new Error('无权管理该成员')
  const nextName = name != null ? String(name).trim() : m.name
  if (!nextName) throw new Error('名称不能为空')
  const nextRole = role || m.role
  if (!ROLE_LABEL[nextRole] || nextRole === 'owner') throw new Error('角色无效')
  if (!canManage(actor, { role: nextRole })) throw new Error(`无权设置「${ROLE_LABEL[nextRole]}」角色`)
  const dup = db.prepare('SELECT id FROM household_members WHERE name=? AND id<>?').get(nextName, m.id)
  if (dup) throw new Error('该名称已被其他成员使用')
  const nextPerms = JSON.stringify(validPerms(perms))
  // 升为管理员后房间/设备限定无意义（管理员全屋不限），规整为空避免误导
  const nextScope = normalizeInviteScope(nextRole, scope !== undefined ? scope : parseScope(m.scope))

  const changes = []
  if (nextName !== m.name) changes.push(`名称「${m.name}」→「${nextName}」`)
  if (relation !== undefined && relation !== m.relation) changes.push(`称呼「${m.relation || '—'}」→「${relation || '—'}」`)
  if (nextRole !== m.role) changes.push(`角色 ${ROLE_LABEL[m.role]}→${ROLE_LABEL[nextRole]}`)
  const oldSet = new Set(effectivePerms(m))
  const nextSet = new Set([...(ROLE_PERMS[nextRole] || []), ...validPerms(perms)])
  const granted = [...nextSet].filter((p) => !oldSet.has(p))
  const revoked = [...oldSet].filter((p) => !nextSet.has(p))
  if (granted.length) changes.push(`授予：${granted.map((p) => PERMISSIONS[p].split('（')[0]).join('、')}`)
  if (revoked.length) changes.push(`收回：${revoked.map((p) => PERMISSIONS[p].split('（')[0]).join('、')}`)
  const scopeChange = describeScopeChange(parseScope(m.scope), nextScope)
  if (scopeChange) changes.push(scopeChange)

  stmts.updateMember.run(nextName, relation !== undefined ? String(relation) : m.relation, nextRole, nextPerms,
    JSON.stringify(nextScope), m.id)
  notify({
    device: '🛠️', action: '调整成员权限',
    detail: `${actorLabel(actor)} 编辑成员「${m.name}」：${changes.join('，') || '无变化'}`,
    operator: actor.name, operator_role: ROLE_LABEL[actor.role]
  }, 'member')
}

// 撤销成员：令牌立即失效、授权全部收回（设备控制/场景/定额处理同时失权），身份保留为已撤销
export function revokeMember(actor, id, reason = '') {
  if (!can(actor, 'member_manage')) throw new Error('无成员管理权限')
  const m = stmts.memberById.get(Number(id))
  if (!m) throw new Error('成员不存在')
  if (m.role === 'owner') throw new Error('户主不可撤销')
  if (m.id === actor.id) throw new Error('不能撤销自己')
  if (!canManage(actor, m)) throw new Error('无权管理该成员')
  if (m.status === 'revoked') throw new Error('该成员已处于撤销状态')
  stmts.revokeMember.run(nowIso(), String(reason || ''), m.id)
  notify({
    device: '⛔', action: '撤销成员',
    detail: `${actorLabel(actor)} 撤销${ROLE_LABEL[m.role]}「${m.name}」的全部授权，访问令牌已失效${reason ? '：' + reason : ''}`,
    operator: actor.name, operator_role: ROLE_LABEL[actor.role]
  }, 'member')
}

// 恢复已撤销成员：直接回到在组并签发新令牌（闭环回收；也可改用「重新邀请」走邀请码流程）
export function restoreMember(actor, id) {
  if (!can(actor, 'member_manage')) throw new Error('无成员管理权限')
  const m = stmts.memberById.get(Number(id))
  if (!m) throw new Error('成员不存在')
  if (m.role === 'owner') throw new Error('户主无需恢复')
  if (!canManage(actor, m)) throw new Error('无权管理该成员')
  if (m.status !== 'revoked') throw new Error('该成员未被撤销')
  stmts.restoreMember.run(token(), m.id)
  notify({
    device: '♻️', action: '恢复成员',
    detail: `${actorLabel(actor)} 恢复${ROLE_LABEL[m.role]}「${m.name}」并重新签发访问令牌，授权范围 ${permSummary(m.role, parsePerms(m.perms))}；${scopeSummary(parseScope(m.scope))}`,
    operator: actor.name, operator_role: ROLE_LABEL[actor.role]
  }, 'member')
}

// 为已撤销成员重新发起邀请（原身份保留，接受时角色权限以新邀请为准）
export function reinviteMember(actor, id) {
  if (!can(actor, 'member_manage')) throw new Error('无成员管理权限')
  const m = stmts.memberById.get(Number(id))
  if (!m || m.status !== 'revoked') throw new Error('仅已撤销成员可重新邀请')
  if (!canManage(actor, m)) throw new Error('无权管理该成员')
  if (stmts.pendingInviteByName.get(m.name)) throw new Error('该成员已有待接受的邀请')
  const at = new Date()
  const exp = new Date(at.getTime() + INVITE_TTL_MS)
  const code = uniqueCode()
  const r = stmts.insertInvite.run(code, m.name, m.relation, m.role, m.perms, m.scope,
    exp.toISOString(), actor.id, at.toISOString())
  notify({
    device: '✉️', action: '重新邀请',
    detail: `${actorLabel(actor)} 向已撤销的「${m.name}」重新发出${ROLE_LABEL[m.role]}邀请，邀请码 ${code}；${scopeSummary(parseScope(m.scope))}`,
    operator: actor.name, operator_role: ROLE_LABEL[actor.role]
  }, 'member')
  return stmts.inviteById.get(r.lastInsertRowid)
}

// 惰性过期：到期的待接受邀请结存为 expired
function expireStaleInvites(at) {
  const rows = stmts.pendingInvitesAll.all(at.toISOString())
  for (const r of rows) {
    const inv = stmts.inviteById.get(r.id)
    stmts.expireInvite.run(inv.id)
    notify({
      device: '⌛', action: '邀请过期',
      detail: `发给「${inv.name}」的${ROLE_LABEL[inv.role]}邀请码 ${inv.code} 超过 7 天未接受，已自动失效`
    }, 'member')
  }
}

// ===== 序列化视图 =====
// scope 附带房间/设备名称快照与已失效（设备删除）标记，前端无需再二次拼名
function scopeView(raw) {
  const scope = parseScope(raw)
  const rooms = scope.room_ids.map((id) => {
    const r = db.prepare('SELECT name FROM rooms WHERE id=?').get(id)
    return { id, name: r ? r.name : null }
  })
  const devices = scope.device_ids.map((id) => {
    const d = db.prepare('SELECT name,room_id FROM devices WHERE id=?').get(id)
    return { id, name: d ? d.name : null, room_id: d ? d.room_id : null, deleted: !d }
  })
  return { room_ids: scope.room_ids, device_ids: scope.device_ids, rooms, devices, all: scopeIsEmpty(scope) }
}
function memberView(m) {
  return {
    id: m.id, name: m.name, relation: m.relation, role: m.role,
    role_label: ROLE_LABEL[m.role],
    status: m.status, status_label: STATUS_LABEL[m.status],
    perms: parsePerms(m.perms),
    effective_perms: effectivePerms(m),
    scope: scopeView(m.scope),
    invited_by: m.invited_by,
    invited_at: m.invited_at, joined_at: m.joined_at,
    revoked_at: m.revoked_at, revoke_reason: m.revoke_reason
  }
}
function inviteView(i) {
  return {
    id: i.id, code: i.code, name: i.name, relation: i.relation,
    role: i.role, role_label: ROLE_LABEL[i.role],
    perms: parsePerms(i.perms),
    scope: scopeView(i.scope),
    status: i.status, status_label: INVITE_STATUS_LABEL[i.status],
    expires_at: i.expires_at, expired: i.status === 'pending' && new Date(i.expires_at).getTime() <= Date.now(),
    created_by: i.created_by, created_at: i.created_at,
    accepted_member_id: i.accepted_member_id, accepted_at: i.accepted_at,
    cancel_reason: i.cancel_reason
  }
}

export function listFamily() {
  expireStaleInvites(new Date())
  return {
    roles: Object.fromEntries(Object.entries(ROLE_LABEL).map(([k, v]) => [k, {
      label: v, default_perms: ROLE_PERMS[k]
    }])),
    permissions: PERMISSIONS,
    members: stmts.allMembers.all().map(memberView),
    invites: stmts.allInvites.all().map(inviteView)
  }
}

// 公开（无需登录）查询邀请：接受页只回显角色与称呼，不暴露创建人等管理信息
export function previewInvite(code) {
  const inv = stmts.inviteByCode.get(String(code || '').trim().toUpperCase())
  if (!inv) throw new Error('邀请码无效')
  if (inv.status !== 'pending') throw new Error(`邀请${INVITE_STATUS_LABEL[inv.status]}，无法接受`)
  if (new Date(inv.expires_at).getTime() <= Date.now()) {
    stmts.expireInvite.run(inv.id)
    throw new Error('邀请已过期')
  }
  return {
    code: inv.code, name: inv.name, relation: inv.relation,
    role: inv.role, role_label: ROLE_LABEL[inv.role],
    perms: parsePerms(inv.perms), scope: scopeView(inv.scope), expires_at: inv.expires_at
  }
}

export function actorLabel(m) {
  return m ? `${ROLE_LABEL[m.role]}「${m.name}」` : '系统'
}
function permSummary(role, extra) {
  const ps = effectivePerms({ role, perms: JSON.stringify(extra) })
  return ps.length ? ps.map((p) => PERMISSIONS[p].split('（')[0]).join('、') : '仅浏览'
}
// 操作范围中文摘要（写日志/通知用）：房间/设备已删除时仍展示其 id，保证审计可归属
function scopeSummary(scope) {
  if (!scope || scopeIsEmpty(scope)) return '操作范围：全屋不限'
  const parts = []
  const roomNames = scope.room_ids.map((id) => db.prepare('SELECT name FROM rooms WHERE id=?').get(id)?.name || `房间#${id}`)
  if (roomNames.length) parts.push(`房间「${roomNames.join('、')}」`)
  const devNames = scope.device_ids.map((id) => {
    const d = db.prepare('SELECT name FROM devices WHERE id=?').get(id)
    return d ? d.name : `设备#${id}（已删除）`
  })
  if (devNames.length) parts.push(`设备「${devNames.join('、')}」`)
  return `操作范围仅限：${parts.join('；')}`
}
// 编辑成员时范围前后差异描述；无差异返回空串
function describeScopeChange(oldScope, newScope) {
  const nameOf = (scope) => ({
    rooms: new Set(scope.room_ids),
    devices: new Set(scope.device_ids)
  })
  const a = nameOf(oldScope), b = nameOf(newScope)
  if (a.rooms.size === b.rooms.size && a.devices.size === b.devices.size &&
      [...a.rooms].every((x) => b.rooms.has(x)) && [...a.devices].every((x) => b.devices.has(x))) return ''
  // scopeSummary 自带「操作范围：」前缀，这里直接引用避免日志出现「操作范围：操作范围…」
  return scopeSummary(newScope)
}

// ===== 首次启动演示数据：固定户主令牌 + 不同角色/状态的成员，开箱即可演示闭环 =====
function seedFamily() {
  if (stmts.allMembers.all().length > 0) return
  const at = new Date().toISOString()
  const owner = stmts.insertMember.run('我（户主）', '', 'owner', '[]', '{}', 'active',
    'owner-demo-token', null, at, at)
  const ownerId = Number(owner.lastInsertRowid)
  const add = (name, relation, role, perms, status, joinedOffsetH, scope = {}) => {
    const invited = new Date(Date.now() - (joinedOffsetH + 24) * 3600_000).toISOString()
    const joined = new Date(Date.now() - joinedOffsetH * 3600_000).toISOString()
    const r = stmts.insertMember.run(name, relation, role, JSON.stringify(validPerms(perms)),
      JSON.stringify(validScope(scope)),
      status, status === 'active' ? token() : null, ownerId, invited, status === 'active' ? joined : null)
    const id = Number(r.lastInsertRowid)
    if (status === 'revoked') {
      stmts.revokeMember.run(new Date(Date.now() - 2 * 3600_000).toISOString(), '施工结束，临时权限回收（演示）', id)
    }
    return id
  }
  add('妈妈', '家人', 'admin', [], 'active', 200)
  add('爷爷', '家人', 'member', [], 'active', 120)
  add('小宇', '孩子', 'member', [], 'active', 72)
  // 访客默认仅场景执行；再显式授予设备控制，演示「角色默认 + 自定义勾选」
  add('王阿姨', '钟点工', 'guest', ['device_control'], 'active', 8)
  // 限定操作范围的访客：设备控制仅限厨房（房间授权随设备换房动态迁移），演示按房间/设备细粒度授权
  add('张姐', '钟点工', 'guest', ['device_control'], 'active', 4, { room_ids: [3] })
  add('李师傅', '维修工', 'guest', [], 'revoked', 26)

  // 一条待接受邀请 + 一条已取消邀请，演示邀请状态机
  const exp = new Date(Date.now() + 3 * 24 * 3600_000).toISOString()
  stmts.insertInvite.run('GUEST2026', '访客小陈', '朋友', 'guest',
    JSON.stringify(['device_control']), JSON.stringify({ room_ids: [1] }),
    exp, ownerId, new Date(Date.now() - 5 * 3600_000).toISOString())
  const old = stmts.insertInvite.run('OLDLABEL1', '访客老赵', '朋友', 'guest', '[]', '{}',
    new Date(Date.now() - 8 * 86400_000).toISOString(), ownerId,
    new Date(Date.now() - 9 * 86400_000).toISOString())
  stmts.cancelInvite.run('来访计划取消（演示）', old.lastInsertRowid)
}
