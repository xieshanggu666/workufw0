import express from 'express'
import { db } from './db.js'
import { initEnergy, reconcileDevice, closeDevice, getSummary } from './energy.js'
import {
  initQuota, evaluateAll, createQuota, updateQuota, deleteQuota,
  applyBatchQuota, handleAlert, batchHandleAlerts,
  listQuotas, listAlerts, getAdjustments, activeAlertCount
} from './quota.js'
import {
  initFamily, getMemberByToken, listFamily, can,
  createInvite, acceptInvite, previewInvite, cancelInvite, resendInvite,
  updateMember, revokeMember, restoreMember, reinviteMember,
  canAccessDevice, canAccessRoom, isUnscoped, memberScope, scopeSummary,
  ROLE_LABEL, PERMISSIONS
} from './family.js'
import {
  initWorkOrders, syncWorkOrders, operateWorkOrder,
  listWorkOrders, getWorkOrder, activeOrderByAlert, STATUS_LABEL as WO_STATUS
} from './workorder.js'

const app = express()
app.use(express.json())

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)
const now = () => new Date().toLocaleString('zh-CN')

// 必须在 db.js 建表/播种完成后初始化能耗模块
initEnergy(db)
// 家庭模块先初始化：其 device_logs 迁移（operator/category 列）必须先完成，
// 紧接着的定额播种通知才能带操作人写入
initFamily(db, (entry, category = 'member', timeStr) => {
  run('INSERT INTO device_logs (device_name,action,detail,time,operator,operator_role,category) VALUES (?,?,?,?,?,?,?)',
    entry.device, entry.action, entry.detail, timeStr || now(), entry.operator || '系统', entry.operator_role || '', category)
})
// 定额模块依赖分段表：预警/超标触发时通过回调写入日志时间线作为通知
initQuota(db, (entry, timeStr) => {
  run('INSERT INTO device_logs (device_name,action,detail,time,operator,operator_role,category) VALUES (?,?,?,?,?,?,?)',
    entry.device, entry.action, entry.detail, timeStr || now(), '系统', '', entry.category || 'quota')
})
// 工单模块依赖设备表/定额告警表/成员表：离线、低电量、信号弱、能耗超标告警自动生成工单，
// 分派/接单/处理/挂起/完成/复开全程记入家庭日志时间线
initWorkOrders(db, (entry, timeStr) => {
  run('INSERT INTO device_logs (device_name,action,detail,time,operator,operator_role,category) VALUES (?,?,?,?,?,?,?)',
    entry.device, entry.action, entry.detail, timeStr || now(), '系统', '', 'workorder')
})

// 追加日志（operator/operator_role/category 可由调用方显式传入，默认按当前登录成员归因）
function log(device, action, detail = '', extra = {}) {
  const m = extra.member ?? reqCurrent.member
  run('INSERT INTO device_logs (device_name,action,detail,time,operator,operator_role,category) VALUES (?,?,?,?,?,?,?)',
    device, action, detail, now(),
    extra.operator ?? (m ? m.name : '系统'),
    extra.operator_role ?? (m ? ROLE_LABEL[m.role] : ''),
    extra.category || 'device')
  // 保留最近 300 条（设备/场景/定额/家庭协作统一时间线）
  const c = q1('SELECT COUNT(*) c FROM device_logs').c
  if (c > 300) db.exec('DELETE FROM device_logs WHERE id <= (SELECT MAX(id)-300 FROM device_logs)')
}

// ===== 当前身份解析 =====
// 演示环境无登录体系：前端通过 X-Home-Token 头（或 ?token=）携带成员令牌；
// 未携带/已撤销令牌视为未登录，所有写操作一律 401（看板等只读聚合仍可访问）。
function resolveMember(req) {
  const tok = req.get('X-Home-Token') || req.query.token || null
  return getMemberByToken(tok)
}
// 最近一次请求的成员（供 log() 兜底归因；显式传 member 时优先）
const reqCurrent = { member: null }
app.use((req, res, next) => {
  const m = resolveMember(req)
  reqCurrent.member = m
  req.member = m
  next()
})
// 权限守卫：无令牌（未登录）一律拒绝；有令牌但权限不足返回 403
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.member) return res.status(401).json({ error: '未选择家庭成员或令牌已失效，请先在「家庭」中选择身份/接受邀请' })
    if (!can(req.member, perm))
      return res.status(403).json({ error: `当前角色「${ROLE_LABEL[req.member.role]}」无权执行此操作（缺少：${PERMISSIONS[perm]}）`, no_perm: true, perm })
    next()
  }
}

// ===== 按房间/设备的细粒度操作范围（设备控制 / 场景 / 定额 / 工单统一校验）=====
function scopeDenied(res, text) {
  return res.status(403).json({ error: `超出当前操作范围：${text}（可在「家庭共享」中由管理员调整授权房间/设备）`, no_perm: true, out_of_scope: true })
}
// 定额对象（room/device 行，需含 scope/room_id/device_id）是否在成员范围内
function canAccessQuota(member, quotaRow) {
  if (!quotaRow || !member) return false
  if (isUnscoped(member)) return true
  if (quotaRow.scope === 'room') return canAccessRoom(member, quotaRow.room_id)
  const d = q1('SELECT id,room_id FROM devices WHERE id=?', quotaRow.device_id)
  // 设备已删除且成员无显式设备授权：限定范围成员无法再操作该设备定额（审计/告警处理仅全屋管理员可办）
  return d ? canAccessDevice(member, d) : memberScope(member).devices.includes(Number(quotaRow.device_id))
}
// 工单对象（work_orders 行）是否在成员范围内
function canAccessWorkOrder(member, wo) {
  if (!wo || !member) return false
  if (isUnscoped(member)) return true
  if (wo.device_id != null) {
    const d = q1('SELECT id,room_id FROM devices WHERE id=?', wo.device_id)
    if (d) return canAccessDevice(member, d)
    return memberScope(member).devices.includes(Number(wo.device_id))
  }
  if (wo.quota_alert_id != null) {
    const a = q1('SELECT qa.*, q.scope q_scope, q.room_id, q.device_id FROM quota_alerts qa JOIN energy_quotas q ON q.id=qa.quota_id WHERE qa.id=?', wo.quota_alert_id)
    if (!a) return false
    return canAccessQuota(member, { scope: a.q_scope, room_id: a.room_id, device_id: a.device_id })
  }
  return false
}
// 换房时计算受操作范围影响的在组成员，供设备更新审计（房间授权按当前房间动态判定，
// 设备授权绑定 device_id 自动跟随——这里只需审计「房间授权随换房而进出」的成员）
function roomMoveScopeAudit(deviceId, oldRoomId, newRoomId) {
  const gained = [], lost = []
  for (const m of q("SELECT * FROM household_members WHERE status='active' AND role<>'owner'")) {
    const sc = memberScope(m)
    if (!sc.rooms.length && !sc.devices.length) continue          // 全屋成员不受影响
    if (sc.devices.includes(Number(deviceId))) continue            // 显式设备授权随设备迁移，范围不变
    if (sc.rooms.includes(Number(newRoomId)) && !sc.rooms.includes(Number(oldRoomId))) gained.push(m.name)
    if (sc.rooms.includes(Number(oldRoomId)) && !sc.rooms.includes(Number(newRoomId))) lost.push(m.name)
  }
  return { gained, lost }
}

// ===== 状态聚合 =====
app.get('/api/state', (req, res) => {
  // 拉取前先校准一次工单：设备状态刚被改写（开关/删除/改名）或定额刚评估完时，
  // 工单与源告警的同步不必等 30s 节拍
  syncWorkOrders()
  const energy = getSummary()
  res.json({
    current: req.member ? {
      id: req.member.id, name: req.member.name, role: req.member.role,
      role_label: ROLE_LABEL[req.member.role], token: req.member.token
    } : null,
    family: listFamily(),
    rooms: q('SELECT * FROM rooms'),
    types: q('SELECT * FROM device_types'),
    devices: q(`SELECT d.*, r.name room, t.name type_name, t.icon type_icon
                FROM devices d JOIN rooms r ON r.id=d.room_id JOIN device_types t ON t.id=d.type_id`),
    scenes: q('SELECT * FROM scenes').map((s) => {
      const actions = q(`SELECT sa.id, sa.device_id, sa.device_key, sa.action, d.name device_name,
                                (SELECT COUNT(*) FROM devices x WHERE x.name=sa.device_key) key_match_count
                         FROM scene_actions sa LEFT JOIN devices d ON d.id=sa.device_id
                         WHERE sa.scene_id=? ORDER BY sa.order_no, sa.id`, s.id)
        .map((a) => ({
          ...a,
          // device_id 为空时区分原因：同名设备不止一台=迁移时无法判定归属，需人工重新绑定；否则为设备已删除
          unresolved: !a.device_name ? (a.key_match_count > 1 ? 'duplicate' : 'missing') : null
        }))
      return { ...s, action_count: actions.length, actions }
    }),
    logs: q('SELECT * FROM device_logs ORDER BY id DESC LIMIT 50'),
    energy,
    quotas: listQuotas(),
    quota_alerts: listAlerts(),
    work_orders: listWorkOrders(),
    alerts: computeAlerts(energy)
  })
})

function computeAlerts(energy) {
  const devs = q('SELECT * FROM devices')
  const alerts = []
  // 设备类告警身份与 workorder.currentAlertSignals 同口径（离线 > 低电量 > 信号弱，一台设备一条），
  // 附带未完成工单 id 供告警中心直达工单闭环
  const pushDeviceAlert = (d, level, text) => {
    const sourceType = d.status === 'error' ? 'device_offline'
      : d.battery < 40 ? 'device_battery' : 'device_signal'
    const wo = activeOrderByAlert(sourceType, d.id, null)
    alerts.push({ device: d.name, level, text, source_type: sourceType, device_id: d.id,
      kind: 'workorder', work_order_id: wo ? wo.id : null, work_order_status: wo ? wo.status : null })
  }
  for (const d of devs) {
    if (d.status === 'error') pushDeviceAlert(d, 'error', '设备离线/异常')
    else if (d.battery < 40) pushDeviceAlert(d, 'warn', `电量低(${d.battery}%)`)
    else if (d.signal < 60) pushDeviceAlert(d, 'warn', `信号弱(${d.signal})`)
  }
  // 能耗尖峰：按设备标识聚合近 24h 的小时桶，存在一个小时明显偏离其活跃时段均值即告警
  // （改名/换房不影响识别；已删除设备不产生尖峰告警）
  for (const d of energy.devices) {
    if (!d.deleted && !d.unbound && d.active_buckets >= 6 && d.peak >= 0.05 && d.avg > 0 && d.peak > d.avg * 3) {
      alerts.push({ device: d.device_name, level: 'info', text: `能耗尖峰：单小时 ${d.peak.toFixed(2)}kWh，远超均值 ${d.avg.toFixed(2)}kWh` })
    }
  }
  // 定额超标预警/告警：仅未闭环（待处理、处理中）的进入告警中心；已处理/已忽略不再打扰。
  // level=error 的超标告警自动生成工单，点击直达工单闭环；warn 预警仍走定额处理闭环
  for (const a of listAlerts()) {
    if (a.status === 'resolved' || a.status === 'ignored') continue
    const wo = a.level === 'error' ? activeOrderByAlert('quota_over', null, a.id) : null
    alerts.push({
      kind: wo ? 'workorder' : 'quota', quota_alert_id: a.id,
      source_type: 'quota_over',
      work_order_id: wo ? wo.id : null, work_order_status: wo ? wo.status : null,
      device: `${a.scope === 'room' ? '房间' : '设备'}·${a.target_name}`,
      level: a.level,
      text: `${a.period_label}定额${a.level === 'error' ? '超标' : '接近超标'}：已用 ${a.used_kwh.toFixed(2)}/${a.limit_kwh}kWh（${Math.round((a.used_kwh / a.limit_kwh) * 100)}%，${a.status_label}）`
    })
  }
  return alerts
}

// ===== 设备 =====
app.post('/api/device', requirePerm('device_control'), (req, res) => {
  const { name, type_id, room_id } = req.body
  if (!name || !type_id || !room_id) return res.status(400).json({ error: 'missing' })
  if (!q1('SELECT id FROM rooms WHERE id=?', room_id)) return res.status(400).json({ error: '房间不存在' })
  // 新建设备落到的房间必须在操作范围内（设备一旦在授权房间内即自动可操作）
  if (!canAccessRoom(req.member, room_id))
    return scopeDenied(res, `不能在「${q1('SELECT name FROM rooms WHERE id=?', room_id)?.name || room_id}」新建设备`)
  const r = run('INSERT INTO devices (name,type_id,room_id) VALUES (?,?,?)', name, type_id, room_id)
  log(name, '新增设备', `房间 ${q1('SELECT name FROM rooms WHERE id=?', room_id).name}`)
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.delete('/api/device/:id', requirePerm('device_control'), (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  if (!canAccessDevice(req.member, d)) return scopeDenied(res, `不能删除设备「${d.name}」`)
  // 引用该设备的场景动作将随外键 ON DELETE SET NULL 置空（失效引用）
  const affected = q1('SELECT COUNT(*) c FROM scene_actions WHERE device_id=?', d.id).c
  // 先结落未结用电段（历史记录保留），再删除设备
  closeDevice(d.id)
  run('DELETE FROM devices WHERE id=?', d.id)
  // 结段产生的新记录先计入定额，再评估（设备定额保留并标记已删除，历史告警按快照留存）
  evaluateAll()
  log(d.name, '删除设备', affected ? `${affected} 个场景动作失效` : '')
  res.json({ ok: true, affected_actions: affected })
})
// 切换开关
app.post('/api/device/:id/toggle', requirePerm('device_control'), (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  if (!canAccessDevice(req.member, d)) return scopeDenied(res, `不能操作设备「${d.name}」`)
  if (d.status === 'error') return res.status(409).json({ error: '设备异常，无法操作' })
  const on = d.power_on ? 0 : 1
  run('UPDATE devices SET power_on=? WHERE id=?', on, d.id)
  // 开关即分段边界：关闭结落本段用电，开启打开新段
  reconcileDevice(d.id)
  evaluateAll()
  log(d.name, on ? '开启' : '关闭')
  res.json({ ok: true, power_on: on })
})
// 更新设备字段
app.post('/api/device/:id/update', requirePerm('device_control'), (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  if (!canAccessDevice(req.member, d)) return scopeDenied(res, `不能编辑设备「${d.name}」`)
  const { name, room_id, watts, power_on } = req.body
  if (room_id != null && !q1('SELECT id FROM rooms WHERE id=?', room_id))
    return res.status(400).json({ error: '房间不存在' })
  // 换房：目标房间同样必须在操作范围内（防止借换房把设备挪出/挪入授权边界）
  if (room_id != null && Number(room_id) !== Number(d.room_id) && !canAccessRoom(req.member, room_id))
    return scopeDenied(res, `不能把设备移入「${q1('SELECT name FROM rooms WHERE id=?', room_id)?.name || room_id}」`)
  if (watts != null && (!Number.isFinite(+watts) || +watts < 0 || +watts > 10000))
    return res.status(400).json({ error: '功率需为 0-10000 的数字' })
  const nextName = (name ?? d.name).toString()
  const nextRoom = room_id ?? d.room_id
  const nextWatts = watts ?? d.watts
  const nextOn = power_on ?? d.power_on
  run('UPDATE devices SET name=?, room_id=?, watts=?, power_on=? WHERE id=?',
    nextName, nextRoom, nextWatts, nextOn, d.id)
  // 改名后同步场景动作里的名称快照（关联仍按 device_id，不受影响）
  if (nextName !== d.name) run('UPDATE scene_actions SET device_key=? WHERE device_id=?', nextName, d.id)
  // 功率/开关变化、改名、换房都构成分段边界：旧段按旧快照结落，新段用新快照记账
  if (nextName !== d.name || nextRoom !== d.room_id || nextWatts !== d.watts || nextOn !== d.power_on) {
    reconcileDevice(d.id)
    // 与单设备开关一致：结段后立刻校准定额用量和告警，不能等 30s 节拍
    evaluateAll()
  }
  const detail = []
  if (nextName !== d.name) detail.push(`改名「${d.name}」→「${nextName}」`)
  if (nextRoom !== d.room_id) {
    const oldRoom = q1('SELECT name FROM rooms WHERE id=?', d.room_id)?.name || d.room_id
    const newRoom = q1('SELECT name FROM rooms WHERE id=?', nextRoom)?.name || nextRoom
    detail.push(`换房 ${oldRoom}→${newRoom}`)
    // 历史授权迁移审计：显式设备授权随设备自动跟随；房间授权随换房当场进出，
    // 记录受影响成员，操作范围调整对其下一次请求同步生效
    const { gained, lost } = roomMoveScopeAudit(d.id, d.room_id, nextRoom)
    if (gained.length) detail.push(`房间授权放开：${gained.join('、')}`)
    if (lost.length) detail.push(`房间授权移出：${lost.join('、')}`)
    if (!gained.length && !lost.length) detail.push('设备级授权随设备迁移')
  }
  if (nextWatts !== d.watts) detail.push(`功率 ${d.watts}W→${nextWatts}W`)
  if (nextOn !== d.power_on) detail.push(nextOn ? '已开启' : '已关闭')
  log(nextName, '更新设备', detail.join('，'))
  res.json({ ok: true })
})

// ===== 场景 =====
app.post('/api/scene', requirePerm('scene_manage'), (req, res) => {
  const { name, actions } = req.body
  const list = Array.isArray(actions) ? actions : []
  for (const a of list) {
    const d = q1('SELECT * FROM devices WHERE id=?', a.device_id)
    if (!d)
      return res.status(400).json({ error: `动作引用了不存在的设备（ID ${a.device_id}）` })
    // 编排动作只能引用操作范围内的设备（场景管理是设备级授权，不随全屋放开）
    if (!canAccessDevice(req.member, d))
      return scopeDenied(res, `不能编排设备「${d.name}」`)
  }
  const r = run('INSERT INTO scenes (name,desc,enabled) VALUES (?,?,1)', name || '新场景', '')
  const act = db.prepare('INSERT INTO scene_actions (scene_id,device_id,device_key,action,order_no) VALUES (?,?,?,?,?)')
  list.forEach((a, i) => {
    const d = q1('SELECT name FROM devices WHERE id=?', a.device_id)
    act.run(r.lastInsertRowid, a.device_id, d.name, a.action, i)
  })
  log(name || '新场景', '新建场景', `${list.length} 个动作`, { category: 'scene' })
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.delete('/api/scene/:id', requirePerm('scene_manage'), (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (s) {
    run('DELETE FROM scenes WHERE id=?', s.id)
    run('DELETE FROM scene_actions WHERE scene_id=?', s.id)
    log(s.name, '删除场景', '', { category: 'scene' })
  }
  res.json({ ok: true })
})
app.post('/api/scene/:id/toggle', requirePerm('scene_manage'), (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  run('UPDATE scenes SET enabled=? WHERE id=?', s.enabled ? 0 : 1, s.id)
  log(s.name, s.enabled ? '停用场景' : '启用场景', '', { category: 'scene' })
  res.json({ ok: true, enabled: s.enabled ? 0 : 1 })
})
// 触发场景：按 device_id 逐条执行，成功/失败如实记录并返回
app.post('/api/scene/:id/run', requirePerm('scene_execute'), (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  if (!s.enabled) return res.status(409).json({ error: '场景已停用，无法执行' })
  const actions = q(`SELECT sa.*, d.id did, d.name dname, d.status dstatus, d.room_id droom,
                            (SELECT COUNT(*) FROM devices x WHERE x.name=sa.device_key) key_match_count
                     FROM scene_actions sa LEFT JOIN devices d ON d.id=sa.device_id
                     WHERE sa.scene_id=? ORDER BY sa.order_no, sa.id`, s.id)
  // 统一校验：触发场景前，所有「可解析的绑定设备」都必须在操作范围内（原子拒绝，绝不执行一半；
  // 已删除/重名待绑定的失效动作不算越权，仍按既有逻辑逐项跳过失败）
  if (!isUnscoped(req.member)) {
    const out = actions.filter((a) => a.did && !canAccessDevice(req.member, { id: a.did, room_id: a.droom }))
    if (out.length)
      return scopeDenied(res, `场景包含范围外设备：${out.map((a) => a.dname).join('、')}`)
  }
  const executed = [], failed = []
  const changed = new Set()
  const batchAt = new Date()
  for (const a of actions) {
    const label = a.dname || a.device_key || `设备#${a.device_id ?? '?'}`
    if (!a.did) {
      // 未绑定动作一律跳过，绝不按名称猜测执行，避免误控同名设备
      const duplicate = a.key_match_count > 1
      const reason = duplicate ? '存在重名设备，待重新绑定' : '设备已删除'
      failed.push({ device: label, action: a.action, reason })
      log(label, `场景「${s.name}」执行失败`, `${a.action}（${reason}）`, { category: 'scene' })
      continue
    }
    if (a.dstatus !== 'online') {
      failed.push({ device: a.dname, action: a.action, reason: '设备离线/异常' })
      log(a.dname, `场景「${s.name}」执行失败`, `${a.action}（设备离线/异常）`, { category: 'scene' })
      continue
    }
    // 每个动作确定性地映射为开/关：关闭/关机/撤防→关，其余（开启/启动/布防/制冷/调光…）→开
    const on = /关|撤防/.test(a.action) ? 0 : 1
    run('UPDATE devices SET power_on=? WHERE id=?', on, a.did)
    reconcileDevice(a.did, batchAt)
    changed.add(a.did)
    log(a.dname, `场景「${s.name}」执行`, a.action, { category: 'scene' })
    executed.push({ device: a.dname, action: a.action })
  }
  // 批量动作全部结段后统一评估一次：紧接着读取 /api/state 时定额用量与告警状态已是最新。
  // changed 仅用于标记本批确有设备状态被写入；评估本身全量执行，避免房间定额漏掉联动设备。
  if (changed.size) evaluateAll(batchAt)
  res.json({ ok: failed.length === 0, executed, failed })
})

// ===== 能耗定额与超标预警闭环 =====
// 额度配置（按房间/设备 × 日/周/月）；同一对象同一周期唯一
app.post('/api/quota', requirePerm('quota_manage'), (req, res) => {
  try {
    // 范围校验先于业务校验：房间必须授权；设备必须存在且在授权范围内
    const scope = req.body?.scope
    if (scope === 'room' && !canAccessRoom(req.member, req.body.room_id)) {
      const rn = q1('SELECT name FROM rooms WHERE id=?', req.body.room_id)?.name || req.body.room_id
      return scopeDenied(res, `不能配置房间「${rn}」的定额`)
    }
    if (scope === 'device') {
      const d = q1('SELECT * FROM devices WHERE id=?', req.body.device_id)
      if (!d) return res.status(400).json({ error: '设备不存在' })
      if (!canAccessDevice(req.member, d)) return scopeDenied(res, `不能配置设备「${d.name}」的定额`)
    }
    const id = createQuota(req.body || {})
    log('定额', '新增定额',
      `${req.body.scope === 'room' ? '房间' : '设备'}定额已配置，周期 ${req.body.period}，额度 ${Number(req.body.limit_kwh)}kWh`,
      { category: 'quota' })
    res.json({ ok: true, id })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/quota/:id/update', requirePerm('quota_manage'), (req, res) => {
  try {
    const q0 = q1('SELECT * FROM energy_quotas WHERE id=?', req.params.id)
    if (!q0) return res.status(404).json({ error: '定额不存在' })
    if (!canAccessQuota(req.member, q0)) return scopeDenied(res, `不能调整「${q0.target_name}」的定额`)
    const changes = updateQuota(Number(req.params.id), req.body || {})
    log('定额', '调整定额',
      `「${q0.target_name}」${changes.length ? changes.join('，') : '无变化'}` +
      `${req.body.reason ? `；备注：${req.body.reason}` : ''}`,
      { category: 'quota' })
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.delete('/api/quota/:id', requirePerm('quota_manage'), (req, res) => {
  try {
    const q0 = q1('SELECT * FROM energy_quotas WHERE id=?', req.params.id)
    if (!q0) return res.status(404).json({ error: '定额不存在' })
    if (!canAccessQuota(req.member, q0)) return scopeDenied(res, `不能删除「${q0.target_name}」的定额`)
    deleteQuota(Number(req.params.id), req.body?.reason || '')
    log('定额', '删除定额', `「${q0.target_name}」${q0.period} 定额已删除，未关闭告警自动解除`, { category: 'quota' })
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// 批量定额策略：跨房间/设备统一 新建/调整/启停/删除。
// 服务端单事务落库、末尾统一评估（历史告警迁移 + 实时用量重算），逐项返回成败；
// 每一项单独写 quota_adjustments 留痕，本接口再写一条汇总时间线（带操作人）。
const BATCH_ACTION_LABEL = {
  create: '批量新建定额', update: '批量调整定额', enable: '批量启用定额',
  disable: '批量停用定额', delete: '批量删除定额'
}
app.post('/api/quota/batch', requirePerm('quota_manage'), (req, res) => {
  try {
    // 逐项范围授权：新建按目标房间/设备判定，既有定额按其行判定；越权项只标记失败
    const authorize = (row) => {
      if (isUnscoped(req.member)) return true
      if (row.scope === 'room') return canAccessRoom(req.member, row.room_id)
      const d = q1('SELECT id,room_id FROM devices WHERE id=?', row.device_id)
      return d ? canAccessDevice(req.member, d) : memberScope(req.member).devices.includes(Number(row.device_id))
    }
    const { results, applied, failed } = applyBatchQuota(req.body || {}, authorize)
    const skipped = results.filter((r) => r.skipped).length
    const fails = results.filter((r) => !r.ok).map((r) => `${r.label}（${r.message}）`).join('；')
    log('定额', BATCH_ACTION_LABEL[req.body?.action] || '批量定额操作',
      `共 ${results.length} 项：生效 ${applied} 项` +
      (skipped ? `，无变化 ${skipped} 项` : '') +
      (failed ? `，失败 ${failed} 项：${fails}` : '，全部成功') +
      (req.body?.reason ? `；备注：${req.body.reason}` : ''),
      { category: 'quota' })
    res.json({ ok: failed === 0, applied, failed, results })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// 告警处理闭环：待处理 → 处理中 → 已处理/已忽略，可附处理备注
app.post('/api/quota-alert/:id/handle', requirePerm('quota_alert_handle'), (req, res) => {
  try {
    const { status, note } = req.body || {}
    const a0 = q1('SELECT * FROM quota_alerts WHERE id=?', req.params.id)
    if (!a0) return res.status(404).json({ error: '告警不存在' })
    // 告警归属对象（房间/设备）必须在操作范围内
    const qq0 = q1('SELECT * FROM energy_quotas WHERE id=?', a0.quota_id)
    if (qq0 && !canAccessQuota(req.member, qq0))
      return scopeDenied(res, `不能处理「${a0.target_name}」的定额告警`)
    if (!qq0 && !isUnscoped(req.member))
      return scopeDenied(res, `不能处理「${a0.target_name}」的定额告警（定额已删除）`)
    const a = handleAlert(Number(req.params.id), { status, note })
    const label = { handling: '开始处理', resolved: '标记已处理', ignored: '忽略告警', open: a0.status === 'handling' ? '退回待处理' : '重新打开' }[status] || '更新状态'
    const periodLabel = { daily: '每日', weekly: '每周', monthly: '每月' }[a.period] || a.period
    log(`${a.scope === 'room' ? '房间' : '设备'}·${a.target_name}`, `定额告警·${label}`,
      `${periodLabel}用量 ${a.used_kwh.toFixed(2)}/${a.limit_kwh}kWh` + (note ? `；备注：${note}` : ''),
      { category: 'quota' })
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// 告警批量处理：同一状态流转 + 同一备注应用到多条告警；
// 每条成功项单独写家庭日志时间线（带操作人），形成逐项审计
app.post('/api/quota-alert/batch-handle', requirePerm('quota_alert_handle'), (req, res) => {
  try {
    const { ids, status, note } = req.body || {}
    // 批量统一校验：任一告警归属对象超出范围则整批拒绝（原子处理，避免部分流转造成审计割裂）
    if (!isUnscoped(req.member)) {
      const idList = Array.isArray(ids) ? ids : []
      const denied = []
      for (const rawId of idList) {
        const a = q1('SELECT qa.*, q.scope q_scope, q.room_id, q.device_id FROM quota_alerts qa LEFT JOIN energy_quotas q ON q.id=qa.quota_id WHERE qa.id=?', Number(rawId))
        if (!a) continue
        const okRow = a.q_scope ? canAccessQuota(req.member, { scope: a.q_scope, room_id: a.room_id, device_id: a.device_id }) : false
        if (!okRow) denied.push(a.target_name)
      }
      if (denied.length) return scopeDenied(res, `告警超出操作范围：${denied.join('、')}`)
    }
    const { results, applied, failed } = batchHandleAlerts(ids, { status, note })
    const label = { handling: '开始处理', resolved: '标记已处理', ignored: '忽略告警', open: '重新打开/退回' }[status] || '更新状态'
    const periodLabel = { daily: '每日', weekly: '每周', monthly: '每月' }
    for (const r of results) {
      if (!r.ok) continue
      const a = r.alert
      log(r.label, `定额告警·${label}（批量）`,
        `${periodLabel[a.period] || a.period}用量 ${a.used_kwh.toFixed(2)}/${a.limit_kwh}kWh` + (note ? `；备注：${note}` : ''),
        { category: 'quota' })
    }
    res.json({ ok: failed === 0, applied, failed, results })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// 额度调整历史（不传 quota_id 时为全局最近 50 条）
app.get('/api/quota-adjustments', (req, res) => {
  res.json(getAdjustments(req.query.quota_id ? Number(req.query.quota_id) : null))
})

// ===== 告警工单闭环：分派 / 接单 / 处理中 / 挂起 / 继续 / 完成 / 复开 =====
// 工单详情（含处理时间线）只读公开
app.get('/api/work-order/:id', (req, res) => {
  const wo = getWorkOrder(Number(req.params.id))
  if (!wo) return res.status(404).json({ error: '工单不存在' })
  res.json(wo)
})
// 状态流转：分派/改派要 workorder_dispatch，其余动作要 workorder_handle；
// 接单后动作后端强制「处理人本人」，越权返回 403
app.post('/api/work-order/:id/operate', (req, res) => {
  const { action, assignee_id, note } = req.body || {}
  const needPerm = action === 'dispatch' ? 'workorder_dispatch' : 'workorder_handle'
  if (!req.member)
    return res.status(401).json({ error: '未选择家庭成员或令牌已失效，请先在「家庭」中选择身份' })
  if (!can(req.member, needPerm))
    return res.status(403).json({ error: `当前角色「${ROLE_LABEL[req.member.role]}」无权执行此操作（缺少：${PERMISSIONS[needPerm]}）`, no_perm: true, perm: needPerm })
  try {
    const before = q1('SELECT * FROM work_orders WHERE id=?', req.params.id)
    if (!before) return res.status(404).json({ error: '工单不存在' })
    // 细粒度范围：工单对象（设备/定额）必须在操作者授权范围内
    if (!canAccessWorkOrder(req.member, before))
      return scopeDenied(res, `不能操作工单「${before.title}」`)
    // 分派/改派时，被分派的处理人也必须覆盖该工单对象（处理人本人范围校验由其后续接单/处理请求保证）
    if (action === 'dispatch' && assignee_id != null) {
      const assignee = q1("SELECT * FROM household_members WHERE id=? AND status='active'", Number(assignee_id))
      if (assignee && !canAccessWorkOrder(assignee, before))
        return scopeDenied(res, `处理人「${assignee.name}」的操作范围不覆盖该工单对象`)
    }
    // operateWorkOrder 内成员对象需要角色中文标签写事件时间线
    const actor = { ...req.member, role_label: ROLE_LABEL[req.member.role] }
    const wo = operateWorkOrder(Number(req.params.id), action, actor, { assignee_id, note })
    const actionLabel = {
      dispatch: ['dispatched', 'accepted', 'processing', 'suspended'].includes(before.status) ? '工单改派' : '工单分派',
      accept: '工单接单', start: '工单开始处理', suspend: '工单挂起',
      resume: '工单继续处理', complete: '工单完成', reopen: '工单复开'
    }[action] || '工单更新'
    const parts = [`${wo.code} ${wo.title}`, `${WO_STATUS[before.status] || before.status} → ${WO_STATUS[wo.status]}`]
    if (wo.assignee_name) parts.push(`处理人：${wo.assignee_name}`)
    if (note) parts.push(`备注：${note}`)
    log('🎫', actionLabel, parts.join('；'), { category: 'workorder' })
    res.json({ ok: true, work_order: getWorkOrder(wo.id) })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, ...(e.status === 403 ? { no_perm: true } : {}) })
  }
})

// ===== 家庭共享管理：邀请 / 角色权限 / 撤销恢复 =====
// 查询邀请回显（接受页用，无需登录令牌）
app.get('/api/family/invite-preview', (req, res) => {
  try { res.json(previewInvite(req.query.code)) }
  catch (e) { res.status(404).json({ error: e.message }) }
})
// 接受邀请：无需登录（访客凭邀请码加入），成功后返回成员令牌
app.post('/api/family/invite/accept', (req, res) => {
  try {
    const m = acceptInvite(req.body?.code)
    res.json({ ok: true, token: m.token, member: { id: m.id, name: m.name, role: m.role, role_label: ROLE_LABEL[m.role] } })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/family/invite', requirePerm('member_manage'), (req, res) => {
  try {
    const inv = createInvite(req.member, req.body || {})
    res.json({ ok: true, invite: { id: inv.id, code: inv.code, expires_at: inv.expires_at } })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/family/invite/:id/cancel', requirePerm('member_manage'), (req, res) => {
  try { cancelInvite(req.member, Number(req.params.id), req.body?.reason || ''); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/family/invite/:id/resend', requirePerm('member_manage'), (req, res) => {
  try {
    const inv = resendInvite(req.member, Number(req.params.id))
    res.json({ ok: true, code: inv.code, expires_at: inv.expires_at })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/family/member/:id/update', requirePerm('member_manage'), (req, res) => {
  try { updateMember(req.member, Number(req.params.id), req.body || {}); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/family/member/:id/revoke', requirePerm('member_manage'), (req, res) => {
  try { revokeMember(req.member, Number(req.params.id), req.body?.reason || ''); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/family/member/:id/restore', requirePerm('member_manage'), (req, res) => {
  try { restoreMember(req.member, Number(req.params.id)); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/family/member/:id/reinvite', requirePerm('member_manage'), (req, res) => {
  try {
    const inv = reinviteMember(req.member, Number(req.params.id))
    res.json({ ok: true, invite: { id: inv.id, code: inv.code, expires_at: inv.expires_at } })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// ===== 日志（家庭时间线：设备 / 场景 / 定额 / 成员协作，全部带操作人） =====
app.get('/api/logs', (req, res) => {
  const { category, operator } = req.query
  const where = []
  const params = []
  if (category && category !== 'all') { where.push('category=?'); params.push(category) }
  if (operator) { where.push('operator=?'); params.push(operator) }
  const sql = 'SELECT * FROM device_logs' + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY id DESC LIMIT 100'
  res.json(q(sql, ...params))
})

const PORT = 4120
app.listen(PORT, () => console.log(`[HOME] API running at http://localhost:${PORT}`))