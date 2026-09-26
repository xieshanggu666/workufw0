import express from 'express'
import { db } from './db.js'
import { initEnergy, reconcileDevice, closeDevice, getSummary } from './energy.js'
import {
  initQuota, evaluateAll, createQuota, updateQuota, deleteQuota,
  applyBatchQuota, handleAlert, batchHandleAlerts,
  listQuotas, listAlerts, getAdjustments, activeAlertCount
} from './quota.js'
import {
  initFamily, getMemberByToken, getActiveMemberById, listFamily, can, deviceInScope, roomInScope,
  scopeDeniedMessage,
  createInvite, acceptInvite, previewInvite, cancelInvite, resendInvite,
  updateMember, revokeMember, restoreMember, reinviteMember, ROLE_LABEL, PERMISSIONS
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

// ===== 细粒度授权：在功能权限通过后，再校验操作对象是否落在该成员的房间/设备范围内 =====
// 越权拦截同样写家庭日志（operator=被拦截人），保留操作审计；户主/管理员全屋不限。
function denyScope(req, res, label, action = '越权操作拦截', extra = {}) {
  log(extra.device || '🔒', action, `${ROLE_LABEL[req.member.role]}「${req.member.name}」尝试操作授权范围外对象：${label}`,
    { category: extra.category || 'member' })
  return res.status(403).json({ error: scopeDeniedMessage(label), no_perm: true, out_of_scope: true })
}
// 设备维度：按设备 id 取设备后判定；设备不存在由原路由处理 404
function ensureDeviceScope(req, res, device) {
  if (deviceInScope(req.member, device)) return true
  return !denyScope(req, res, `${device.name}（${q1('SELECT name FROM rooms WHERE id=?', device.room_id)?.name || '未知房间'}）`,
    '越权设备操作拦截', { device: device.name }) && false
}
// 房间维度
function ensureRoomScope(req, res, roomId, roomName) {
  if (roomInScope(req.member, roomId)) return true
  denyScope(req, res, roomName || `房间#${roomId}`, '越权房间操作拦截', { device: roomName || `房间#${roomId}` })
  return false
}
// 定额对象：scope=room 判房间，scope=device 判设备（按稳定 device_id；设备删除则按其历史房间无从判定，仅定额主人可处理）
function quotaWithinMemberScope(member, quota) {
  if (quota.scope === 'room') return roomInScope(member, quota.room_id)
  const d = quota.device_id ? q1('SELECT * FROM devices WHERE id=?', quota.device_id) : null
  if (d) return deviceInScope(member, d)
  // 设备已删除的设备定额：房间推断已失效，仅全屋不限身份或仍显式持有该 device_id 授权者可操作
  const scope = safeParseScope(member.scope)
  return scope.all || scope.device_ids.includes(Number(quota.device_id))
}
function ensureQuotaScope(req, res, quota) {
  if (quotaWithinMemberScope(req.member, quota)) return true
  const tail = quota.scope === 'device' && !q1('SELECT id FROM devices WHERE id=?', quota.device_id) ? '（设备已删除）' : ''
  denyScope(req, res, `${quota.scope === 'room' ? '房间' : '设备'}定额「${quota.target_name}」${tail}`,
    '越权定额操作拦截', { device: '定额', category: 'quota' })
  return false
}
// 解析成员 scope（与 family.parseScope 同构，路由层只做只读判定，避免再导出内部函数）
function safeParseScope(raw) {
  try {
    const v = JSON.parse(raw || '{}')
    const roomIds = Array.isArray(v?.room_ids) ? v.room_ids.map(Number) : []
    const deviceIds = Array.isArray(v?.device_ids) ? v.device_ids.map(Number) : []
    return { room_ids: roomIds, device_ids: deviceIds, all: !roomIds.length && !deviceIds.length }
  } catch { return { room_ids: [], device_ids: [], all: true } }
}
// 工单对象范围：设备类工单按设备当前房间/稳定 id 判定；超标工单按其定额对象判定
function ensureWorkOrderScope(req, res, wo) {
  if (workOrderWithinMemberScope(req.member, wo)) return true
  denyScope(req, res, `工单 ${wo.code} · ${wo.target_name}`, '越权工单操作拦截', { device: '🎫', category: 'workorder' })
  return false
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
      role_label: ROLE_LABEL[req.member.role], token: req.member.token,
      scope_all: req.member.role === 'owner' || req.member.role === 'admin' ||
        (() => { const sc = safeParseScope(req.member.scope); return sc.all })()
    } : null,
    family: listFamily(),
    rooms: q('SELECT * FROM rooms'),
    types: q('SELECT * FROM device_types'),
    devices: q(`SELECT d.*, r.name room, t.name type_name, t.icon type_icon
                FROM devices d JOIN rooms r ON r.id=d.room_id JOIN device_types t ON t.id=d.type_id`)
      .map((d) => ({ ...d, in_scope: req.member ? deviceInScope(req.member, d) : false })),
    scenes: q('SELECT * FROM scenes').map((s) => {
      const actions = q(`SELECT sa.id, sa.device_id, sa.device_key, sa.action, d.name device_name, d.room_id droom,
                                (SELECT COUNT(*) FROM devices x WHERE x.name=sa.device_key) key_match_count
                         FROM scene_actions sa LEFT JOIN devices d ON d.id=sa.device_id
                         WHERE sa.scene_id=? ORDER BY sa.order_no, sa.id`, s.id)
        .map((a) => ({
          ...a,
          // device_id 为空时区分原因：同名设备不止一台=迁移时无法判定归属，需人工重新绑定；否则为设备已删除
          unresolved: !a.device_name ? (a.key_match_count > 1 ? 'duplicate' : 'missing') : null,
          // 每个动作设备是否在当前身份授权范围内（前端置灰提示；执行时后端整单复核）
          in_scope: !a.device_id || !req.member ? null
            : deviceInScope(req.member, { id: a.device_id, room_id: a.droom })
        }))
      // 场景可执行 = 全部已绑定设备都在范围内（有任一越界设备则整单会被后端拒绝，按钮直接置灰）
      const outOfScopeDevices = req.member
        ? actions.filter((a) => a.device_id && a.in_scope === false).map((a) => a.device_name)
        : []
      return {
        ...s, action_count: actions.length, actions,
        in_scope: !req.member ? null : outOfScopeDevices.length === 0,
        out_of_scope_devices: [...new Set(outOfScopeDevices)]
      }
    }),
    logs: q('SELECT * FROM device_logs ORDER BY id DESC LIMIT 50'),
    energy,
    quotas: listQuotas().map((qt) => ({ ...qt, in_scope: req.member ? quotaWithinMemberScope(req.member, qt) : false })),
    quota_alerts: listAlerts().map((al) => {
      const qt = q1('SELECT q.* FROM energy_quotas q JOIN quota_alerts a ON a.quota_id=q.id WHERE a.id=?', al.id)
      return { ...al, in_scope: req.member && qt ? quotaWithinMemberScope(req.member, qt) : (req.member ? true : false) }
    }),
    work_orders: listWorkOrders().map((wo) => ({
      ...wo,
      in_scope: req.member ? workOrderWithinMemberScope(req.member, wo) : false
    })),
    alerts: computeAlerts(energy)
  })
})

// 工单范围纯判定（供 /api/state 标记与操作路由共用）
function workOrderWithinMemberScope(member, wo) {
  if (wo.device_id != null) {
    const d = q1('SELECT * FROM devices WHERE id=?', wo.device_id)
    if (!d) {
      const sc = safeParseScope(member.scope)
      return sc.all || sc.device_ids.includes(Number(wo.device_id))
    }
    return deviceInScope(member, d)
  }
  if (wo.quota_alert_id != null) {
    const qt = q1('SELECT q.* FROM energy_quotas q JOIN quota_alerts a ON a.quota_id=q.id WHERE a.id=?', wo.quota_alert_id)
    return !qt || quotaWithinMemberScope(member, qt)
  }
  return true
}

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
  // 新增设备落到哪个房间，就需要该房间在操作范围内
  const room = q1('SELECT * FROM rooms WHERE id=?', room_id)
  if (!room) return res.status(400).json({ error: '房间不存在' })
  if (!ensureRoomScope(req, res, room.id, room.name)) return
  const r = run('INSERT INTO devices (name,type_id,room_id) VALUES (?,?,?)', name, type_id, room_id)
  log(name, '新增设备', `房间 ${room.name}`)
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.delete('/api/device/:id', requirePerm('device_control'), (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  if (!ensureDeviceScope(req, res, d)) return
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
  if (!ensureDeviceScope(req, res, d)) return
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
  if (!ensureDeviceScope(req, res, d)) return
  const { name, room_id, watts, power_on } = req.body
  if (room_id != null && !q1('SELECT id FROM rooms WHERE id=?', room_id))
    return res.status(400).json({ error: '房间不存在' })
  if (watts != null && (!Number.isFinite(+watts) || +watts < 0 || +watts > 10000))
    return res.status(400).json({ error: '功率需为 0-10000 的数字' })
  const nextName = (name ?? d.name).toString()
  const nextRoom = room_id ?? d.room_id
  // 换房：目标房间同样要在操作范围内——不能借「换房」把设备挪出自己的授权区域
  if (nextRoom !== d.room_id) {
    const target = q1('SELECT name FROM rooms WHERE id=?', nextRoom)
    if (!target || !ensureRoomScope(req, res, nextRoom, target.name)) return
  }
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
    const oldRoom = q1('SELECT name FROM rooms WHERE id=?', d.room_id)?.name
    const newRoom = q1('SELECT name FROM rooms WHERE id=?', nextRoom)?.name
    detail.push(`换房「${oldRoom || '—'}」→「${newRoom || '—'}」（按房间授予的成员授权随设备迁入/迁出自动迁移，按设备授予的授权按设备稳定保留）`)
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
  // 编排场景：每个动作引用的设备都必须存在且在编排人的授权范围内，
  // 否则可借场景间接控制范围外设备（场景执行的统一校验口径见 /run）
  const outOfScope = []
  for (const a of list) {
    const d = q1('SELECT * FROM devices WHERE id=?', a.device_id)
    if (!d) return res.status(400).json({ error: `动作引用了不存在的设备（ID ${a.device_id}）` })
    if (!deviceInScope(req.member, d)) outOfScope.push(d.name)
  }
  if (outOfScope.length) {
    log('🎬', '越权场景编排拦截', `「${name || '新场景'}」包含授权范围外设备：${outOfScope.join('、')}`, { category: 'scene' })
    return res.status(403).json({ error: `以下设备不在你的授权房间/设备范围内，无法编入场景：${outOfScope.join('、')}`, no_perm: true, out_of_scope: true })
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
  // 统一范围校验：场景里只要有一个已绑定设备超出触发人的授权房间/设备范围，整单拒绝执行
  // （绝不只跳过越权动作后悄悄执行其余部分——那样可借场景越权联动）。
  // 设备换房后这里按最新 room_id 判定，房间授权随设备迁移自动生效/失效，无需改写场景。
  const outOfScope = actions
    .filter((a) => a.did && !deviceInScope(req.member, { id: a.did, room_id: a.droom }))
    .map((a) => a.dname)
  if (outOfScope.length) {
    log('🎬', `场景「${s.name}」越权执行拦截`,
      `包含授权范围外设备：${[...new Set(outOfScope)].join('、')}`, { category: 'scene' })
    return res.status(403).json({
      error: `场景包含不在你授权房间/设备范围内的设备（${[...new Set(outOfScope)].join('、')}），整单未执行，请联系管理员调整授权`,
      no_perm: true, out_of_scope: true, out_of_scope_devices: [...new Set(outOfScope)]
    })
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
    // 新建定额的对象必须在配置人的授权范围内
    if (req.body.scope === 'room') {
      const room = q1('SELECT name FROM rooms WHERE id=?', req.body.room_id)
      if (!room) return res.status(400).json({ error: '房间不存在' })
      if (!ensureRoomScope(req, res, req.body.room_id, room.name)) return
    } else if (req.body.scope === 'device') {
      const d = q1('SELECT * FROM devices WHERE id=?', req.body.device_id)
      if (!d) return res.status(400).json({ error: '设备不存在' })
      if (!ensureDeviceScope(req, res, d)) return
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
    const before = q1('SELECT * FROM energy_quotas WHERE id=?', req.params.id)
    if (!before) return res.status(404).json({ error: '定额不存在' })
    if (!ensureQuotaScope(req, res, before)) return
    const changes = updateQuota(Number(req.params.id), req.body || {})
    const q0 = q1('SELECT * FROM energy_quotas WHERE id=?', req.params.id)
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
    if (!ensureQuotaScope(req, res, q0)) return
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
    // 批量范围预检：任一对象超出操作人授权范围则整批拒绝（在单事务落库之前拦截，不产生部分写入）
    const body = req.body || {}
    if (body.action === 'create') {
      const out = []
      for (const t of (Array.isArray(body.targets) ? body.targets : [])) {
        if (t.scope === 'room') {
          const room = q1('SELECT name FROM rooms WHERE id=?', Number(t.room_id))
          if (room && !roomInScope(req.member, room.id)) out.push(`房间·${room.name}`)
        } else {
          const d = q1('SELECT * FROM devices WHERE id=?', Number(t.device_id))
          if (d && !deviceInScope(req.member, d)) out.push(`设备·${d.name}`)
        }
      }
      if (out.length) {
        denyScope(req, res, `${out.join('、')}（共 ${out.length} 项）`, '越权批量定额拦截', { device: '定额', category: 'quota' })
        return
      }
    } else if (Array.isArray(body.quota_ids)) {
      const out = []
      for (const id of body.quota_ids) {
        const q0 = q1('SELECT * FROM energy_quotas WHERE id=?', Number(id))
        if (q0 && !quotaWithinMemberScope(req.member, q0)) out.push(`${q0.scope === 'room' ? '房间' : '设备'}·${q0.target_name}`)
      }
      if (out.length) {
        denyScope(req, res, `${out.join('、')}（共 ${out.length} 条）`, '越权批量定额拦截', { device: '定额', category: 'quota' })
        return
      }
    }
    const { results, applied, failed } = applyBatchQuota(body)
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
// 通过告警 id 反查其定额对象（scope 判定用）；告警必须挂在现存定额上
function quotaByAlertId(alertId) {
  return q1(`SELECT q.* FROM energy_quotas q
             JOIN quota_alerts a ON a.quota_id=q.id WHERE a.id=?`, Number(alertId))
}
// 告警处理闭环：待处理 → 处理中 → 已处理/已忽略，可附处理备注
app.post('/api/quota-alert/:id/handle', requirePerm('quota_alert_handle'), (req, res) => {
  try {
    const { status, note } = req.body || {}
    const a0 = q1('SELECT * FROM quota_alerts WHERE id=?', req.params.id)
    if (!a0) return res.status(404).json({ error: '告警不存在' })
    const quota = quotaByAlertId(req.params.id)
    if (quota && !ensureQuotaScope(req, res, quota)) return
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
    // 批量预检：任一条告警对应定额超出范围则整批拒绝（不在事务里，先于逐条状态机校验）
    const list = Array.isArray(ids) ? ids : []
    const out = []
    for (const id of list) {
      const q0 = quotaByAlertId(id)
      if (q0 && !quotaWithinMemberScope(req.member, q0)) out.push(`${q0.scope === 'room' ? '房间' : '设备'}·${q0.target_name}`)
    }
    if (out.length) {
      denyScope(req, res, `${[...new Set(out)].join('、')}（共 ${out.length} 条告警）`,
        '越权批量告警处理拦截', { device: '定额', category: 'quota' })
      return
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
    // 工单与设备/设备定额同源：分派与处理都必须在工单对象的授权范围内
    if (!ensureWorkOrderScope(req, res, before)) return
    // 分派/改派：被分派人必须在组、持有工单处理权限，且其授权范围覆盖该工单对象
    if (action === 'dispatch') {
      const assignee = getActiveMemberById(assignee_id)
      if (!assignee) return res.status(400).json({ error: '请选择有效的在组成员作为处理人' })
      if (!can(assignee, 'workorder_handle'))
        return res.status(400).json({ error: `「${assignee.name}」没有工单处理权限，不能被分派` })
      if (!workOrderWithinMemberScope(assignee, before))
        return res.status(400).json({ error: `「${assignee.name}」的授权房间/设备范围不覆盖该工单对象，请先调整其操作范围` })
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