// ===== 告警工单闭环 =====
// 由四类告警自动生成工单：设备离线 / 低电量 / 信号弱 / 能耗定额超标。
//
// 工单状态机：
//   open(待分派) --分派--> dispatched(已分派) --接单--> accepted(已接单)
//     --开始处理--> processing(处理中) --挂起--> suspended(已挂起) --继续--> processing
//   processing/suspended --完成--> completed(已完成) --复开--> reopened(已复开) --重新分派--> dispatched
//   dispatched 可由分派权限人改派；reopened 必须重新分派后才能继续
//
// 自动生成口径（syncWorkOrders，30s 节拍 + /api/state 拉取前补一次）：
//   同一告警身份只允许存在一张「未完成」工单（部分唯一索引兜底）：
//     设备类身份 = source_type + device_id；定额类身份 = source_type + quota_alert_id
//   源告警消失不自动关单（只置 source_active=0 并写时间线，由处理人确认后完成）；
//   源告警恢复时未完成工单自动重新挂上源；已完成工单必须经历「告警消失→再次出现」
//   才会另开新单（同一问题持续未消除不重复建工单）。

const TICK_MS = 30_000

// 源告警类型：离线 / 低电量 / 信号弱 / 能耗超标（仅 error 级超标，80% 预警不开单）
export const SOURCE_LABEL = {
  device_offline: '离线告警',
  device_battery: '低电量告警',
  device_signal: '信号弱告警',
  quota_over: '能耗超标告警'
}
const SOURCE_ICON = {
  device_offline: '🔴',
  device_battery: '🪫',
  device_signal: '📶',
  quota_over: '🚨'
}
export const STATUS_LABEL = {
  open: '待分派',
  dispatched: '已分派',
  accepted: '已接单',
  processing: '处理中',
  suspended: '已挂起',
  completed: '已完成',
  reopened: '已复开'
}
// 未完成状态（参与「同一身份唯一活动工单」唯一索引）
const ACTIVE_STATUS = ['open', 'dispatched', 'accepted', 'processing', 'suspended', 'reopened']
// 合法的人工状态流转
const TRANSITIONS = {
  // 流转中（accepted/processing/suspended）也允许改派——典型场景：处理人成员被撤销，
  // 工单需改派给其他人，新处理人重新接单；时间戳随改派重置，时间线记为「改派」
  dispatch: { from: ['open', 'reopened', 'dispatched', 'accepted', 'processing', 'suspended'], to: 'dispatched' },
  accept: { from: ['dispatched'], to: 'accepted' },
  start: { from: ['accepted'], to: 'processing' },
  suspend: { from: ['processing'], to: 'suspended' },
  resume: { from: ['suspended'], to: 'processing' },
  complete: { from: ['processing', 'suspended'], to: 'completed' },
  reopen: { from: ['completed'], to: 'reopened' }
}
export const ACTION_LABEL = {
  created: '系统生成',
  dispatched: '分派',
  reassigned: '改派',
  accepted: '接单',
  started: '开始处理',
  suspended: '挂起',
  resumed: '继续处理',
  completed: '完成',
  reopened: '复开',
  source_cleared: '源告警消除',
  source_restored: '源告警恢复'
}
const PERIOD_LABEL = { daily: '每日', weekly: '每周', monthly: '每月' }

const BATTERY_THRESHOLD = 40   // 电量 < 40% 为低电量告警
const SIGNAL_THRESHOLD = 60    // 信号 < 60 为信号弱告警

let db
let stmts
// 通过注入回调写家庭日志时间线（category=workorder），避免与 index.js 循环依赖
let notify = () => {}

function nowIso() { return new Date().toISOString() }
function appendNote(note, text) { return note ? `${note} ｜ ${text}` : text }

// ===== 当前告警身份快照：syncWorkOrders 与 /api/state 告警中心共用同一口径 =====
// 设备按优先级取一条（与告警中心一致）：离线 > 低电量 > 信号弱，绝不一单多源
function deviceAlertOf(d) {
  if (d.status === 'error') {
    return { source_type: 'device_offline', level: 'error', detail: '设备离线/异常' }
  }
  if (d.battery < BATTERY_THRESHOLD) {
    return { source_type: 'device_battery', level: 'warn', detail: `电量低(${d.battery}%)，请及时充电或更换电池` }
  }
  if (d.signal < SIGNAL_THRESHOLD) {
    return { source_type: 'device_signal', level: 'warn', detail: `信号弱(${d.signal})，请检查网络或设备位置` }
  }
  return null
}

export function currentAlertSignals() {
  const signals = []
  for (const d of stmts.allDevices.all()) {
    const a = deviceAlertOf(d)
    if (!a) continue
    signals.push({
      source_type: a.source_type,
      device_id: d.id,
      quota_alert_id: null,
      target_name: d.name,
      title: `${SOURCE_LABEL[a.source_type]} · ${d.name}`,
      detail: a.detail,
      level: a.level
    })
  }
  // 能耗「超标」告警（level=error 且未闭环）；80% 预警不生成工单
  for (const a of stmts.activeQuotaAlerts.all()) {
    const target = `${a.scope === 'room' ? '房间' : '设备'}·${a.target_name}`
    const pct = Math.round((a.used_kwh / a.limit_kwh) * 100)
    signals.push({
      source_type: 'quota_over',
      device_id: null,
      quota_alert_id: a.id,
      target_name: a.target_name,
      title: `能耗超标告警 · ${target}`,
      detail: `${PERIOD_LABEL[a.period]}定额超标：已用 ${a.used_kwh.toFixed(2)}/${a.limit_kwh}kWh（${pct}%）`,
      level: 'error'
    })
  }
  return signals
}

function identityKey(s) {
  return s.source_type === 'quota_over' ? `quota_over:${s.quota_alert_id}` : `${s.source_type}:${s.device_id}`
}

export function initWorkOrders(database, notifyFn) {
  db = database
  if (typeof notifyFn === 'function') notify = notifyFn
  db.exec(`
  CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,            -- device_offline/device_battery/device_signal/quota_over
    device_id INTEGER,                    -- 设备类稳定标识（设备删除不级联，工单保留）
    quota_alert_id INTEGER,               -- 定额超标告警标识
    target_name TEXT NOT NULL,            -- 对象名快照（设备改名时随节拍同步）
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',      -- 告警详情快照（最近一次同步刷新）
    level TEXT NOT NULL DEFAULT 'warn',   -- error / warn
    status TEXT NOT NULL DEFAULT 'open',  -- open/dispatched/accepted/processing/suspended/completed/reopened
    assignee_id INTEGER,                  -- 处理人 member id（成员撤销后快照保留）
    assignee_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',        -- 处理备注（挂起/完成/复开等逐次追加）
    source_active INTEGER NOT NULL DEFAULT 1,  -- 源告警当前是否仍存在（消失不自动关单）
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    dispatched_at TEXT,
    accepted_at TEXT,
    started_at TEXT,
    suspended_at TEXT,
    completed_at TEXT,
    reopened_at TEXT
  );
  -- 同一告警身份只允许一张未完成工单（部分唯一索引 + 表达式列兜底设备/定额两类身份）
  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_active_identity
    ON work_orders(source_type, COALESCE(device_id,-1), COALESCE(quota_alert_id,-1))
    WHERE status IN ('open','dispatched','accepted','processing','suspended','reopened');
  CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
  CREATE INDEX IF NOT EXISTS idx_work_orders_quota ON work_orders(quota_alert_id);
  CREATE TABLE IF NOT EXISTS work_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL,
    action TEXT NOT NULL,                 -- created/dispatched/reassigned/accepted/started/suspended/resumed/completed/reopened/source_cleared/source_restored
    from_status TEXT,
    to_status TEXT,
    operator TEXT NOT NULL DEFAULT '系统',
    operator_role TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wo_events_order ON work_order_events(work_order_id, id);
  `)

  stmts = {
    allDevices: db.prepare('SELECT * FROM devices'),
    activeQuotaAlerts: db.prepare("SELECT * FROM quota_alerts WHERE level='error' AND status IN ('open','handling')"),
    insertOrder: db.prepare(`INSERT INTO work_orders
      (code,source_type,device_id,quota_alert_id,target_name,title,detail,level,status,source_active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'open',1,?,?)`),
    orderById: db.prepare('SELECT * FROM work_orders WHERE id=?'),
    activeByIdentityDevice: db.prepare("SELECT * FROM work_orders WHERE source_type=? AND device_id=? AND status IN ('open','dispatched','accepted','processing','suspended','reopened')"),
    activeByIdentityQuota: db.prepare("SELECT * FROM work_orders WHERE source_type='quota_over' AND quota_alert_id=? AND status IN ('open','dispatched','accepted','processing','suspended','reopened')"),
    latestCompletedQuota: db.prepare("SELECT * FROM work_orders WHERE source_type='quota_over' AND quota_alert_id=? AND status='completed' ORDER BY id DESC LIMIT 1"),
    latestCompletedDevice: db.prepare("SELECT * FROM work_orders WHERE source_type=? AND device_id=? AND status='completed' ORDER BY id DESC LIMIT 1"),
    allActiveOrders: db.prepare("SELECT * FROM work_orders WHERE status IN ('open','dispatched','accepted','processing','suspended','reopened')"),
    allCompletedOrders: db.prepare("SELECT * FROM work_orders WHERE status='completed' AND source_active=1"),
    allOrders: db.prepare('SELECT * FROM work_orders ORDER BY id DESC LIMIT 200'),
    updateSnapshot: db.prepare('UPDATE work_orders SET target_name=?,title=?,detail=?,level=?,updated_at=? WHERE id=?'),
    markSourceInactive: db.prepare('UPDATE work_orders SET source_active=0,updated_at=? WHERE id=?'),
    markSourceActive: db.prepare('UPDATE work_orders SET source_active=1,updated_at=? WHERE id=?'),
    clearCompletedFlag: db.prepare('UPDATE work_orders SET source_active=0 WHERE id=?'),
    insertEvent: db.prepare(`INSERT INTO work_order_events
      (work_order_id,action,from_status,to_status,operator,operator_role,detail,time)
      VALUES (?,?,?,?,?,?,?,?)`),
    eventsByOrder: db.prepare('SELECT * FROM work_order_events WHERE work_order_id=? ORDER BY id'),
    memberById: db.prepare("SELECT * FROM household_members WHERE id=? AND status='active'"),
    applyTransition: db.prepare(`UPDATE work_orders SET
      status=?, assignee_id=?, assignee_name=?, note=?, updated_at=?,
      dispatched_at=?, accepted_at=?, started_at=?, suspended_at=?,
      completed_at=?, reopened_at=?
      WHERE id=?`),
    countCodePrefix: db.prepare('SELECT COUNT(*) c FROM work_orders WHERE code LIKE ?')
  }

  seedWorkOrders()
  // 首次启动先同步一次：开箱即按当前告警生成工单
  syncWorkOrders(new Date())
  setInterval(() => { try { syncWorkOrders(new Date()) } catch (e) { console.error('[WORKORDER] tick error', e) } }, TICK_MS)
}

// 工单号：WO-YYMMDD-当日序号
function genCode(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const prefix = `WO-${String(at.getFullYear()).slice(2)}${p(at.getMonth() + 1)}${p(at.getDate())}-`
  return prefix + String(stmts.countCodePrefix.get(prefix + '%').c + 1).padStart(3, '0')
}

// ===== 核心同步：告警 → 工单的自动生成 / 源消除 / 源恢复 =====
export function syncWorkOrders(at = new Date()) {
  const signals = currentAlertSignals()
  const curMap = new Map(signals.map((s) => [identityKey(s), s]))
  // 设备维度：一台设备同一时刻只有一条告警（离线>低电量>信号弱），
  // 旧工单跟进期间告警类型变化（如信号弱修好、发现电量也低）不算「源消除」
  const curDevice = new Map(signals.filter((s) => s.device_id != null).map((s) => [s.device_id, s]))
  const atIso = at.toISOString()
  const events = []

  // 1) 未完成工单：源仍在 → 同步快照；源消失 → 置 source_active=0（不自动关单，通知一次）
  for (const wo of stmts.allActiveOrders.all()) {
    const sameIdentity = curMap.get(identityKey(wo))
    // 设备工单：同设备有任意来源的告警即视为「设备问题仍在」，不因告警类型切换误标消除
    const sig = sameIdentity || (wo.device_id != null ? curDevice.get(wo.device_id) : null)
    if (sig) {
      if (wo.source_active === 0) {
        // 源告警恢复：重新挂上源并通知（工单仍按当前状态继续流转）
        stmts.markSourceActive.run(atIso, wo.id)
        stmts.insertEvent.run(wo.id, 'source_restored', wo.status, wo.status,
          '系统', '', '源告警再次出现，工单重新关联', atIso)
        events.push({ wo: { ...wo, source_active: 1 }, action: 'source_restored', detail: '源告警再次出现，工单重新关联' })
      }
      // 快照仅在「同一告警身份」仍在时刷新；类型切换不改写工单原始来源/标题，保留历史
      if (sameIdentity && (wo.target_name !== sig.target_name || wo.detail !== sig.detail
          || wo.title !== sig.title || wo.level !== sig.level)) {
        stmts.updateSnapshot.run(sig.target_name, sig.title, sig.detail, sig.level, atIso, wo.id)
      }
    } else if (wo.source_active === 1) {
      stmts.markSourceInactive.run(atIso, wo.id)
      stmts.insertEvent.run(wo.id, 'source_cleared', wo.status, wo.status,
        '系统', '', '触发工单的告警已消除，请核实后完成工单', atIso)
      events.push({ wo: { ...wo, source_active: 0 }, action: 'source_cleared', detail: '触发工单的告警已消除，请核实后完成工单' })
    }
  }

  // 2) 已完成工单：源消失时静默标记（之后再次越线才会另开新单）。
  // 按工单自身告警身份判断：旧类型告警消失、设备出现另一类型告警时，旧单结存、新类型另开新单
  for (const wo of stmts.allCompletedOrders.all()) {
    if (!curMap.has(identityKey(wo))) stmts.clearCompletedFlag.run(wo.id)
  }

  // 3) 当前存在、但没有未完成工单的告警：
  //    设备类：一台设备同一时刻只有一条告警（离线>低电量>信号弱），因此该设备只要
  //      还有任意来源的未完成工单，就不另开新单（旧单仍在跟进同一设备）；待旧单完成后
  //      仍存在的当前告警会在这里补建，告警类型变化不丢历史。设备最近一张已完成工单
  //      （任意来源）仍处于「问题未清」（source_active=1）时也不另开，应对旧单执行「复开」。
  //    定额类：身份为具体的 quota_alert_id（一条超标告警一张单）。
  //    最近已完成工单若从未经历「源消除」（问题持续未消失）不重复开单；
  //    否则（从未建过单，或已完成后告警消失又再次出现）自动新建工单
  const busyDeviceIds = new Set(stmts.allActiveOrders.all()
    .filter((w) => w.device_id != null).map((w) => w.device_id))
  for (const sig of signals) {
    if (sig.source_type !== 'quota_over' && busyDeviceIds.has(sig.device_id)) continue
    const active = sig.source_type === 'quota_over'
      ? stmts.activeByIdentityQuota.get(sig.quota_alert_id)
      : stmts.activeByIdentityDevice.get(sig.source_type, sig.device_id)
    if (active) continue
    const lastDone = sig.source_type === 'quota_over'
      ? stmts.latestCompletedQuota.get(sig.quota_alert_id)
      : stmts.latestCompletedDevice.get(sig.source_type, sig.device_id)
    if (lastDone && lastDone.source_active === 1) continue

    const r = stmts.insertOrder.run(genCode(at), sig.source_type, sig.device_id, sig.quota_alert_id,
      sig.target_name, sig.title, sig.detail, sig.level, atIso, atIso)
    const wo = stmts.orderById.get(r.lastInsertRowid)
    stmts.insertEvent.run(wo.id, 'created', null, null, '系统', '',
      `由${SOURCE_LABEL[sig.source_type]}自动生成：${sig.detail}`, atIso)
    events.push({ wo, action: 'created', detail: sig.detail, notify: true })
  }

  // 统一写时间线通知：新建工单与源恢复/消除均通知
  for (const e of events) {
    const { wo, action, detail } = e
    notify(buildEventLog(wo, action, detail), at.toLocaleString('zh-CN'))
  }
  return events.length
}

function buildEventLog(wo, action, detail) {
  if (action === 'created') {
    return {
      device: '🎫', action: '生成告警工单',
      detail: `${wo.code} ${wo.title}（${detail}），状态：待分派`
    }
  }
  if (action === 'source_cleared') {
    return { device: '🌤️', action: '工单源告警消除', detail: `${wo.code} ${wo.title}：${detail}` }
  }
  return { device: '🔁', action: '工单源告警恢复', detail: `${wo.code} ${wo.title}：${detail}` }
}

// ===== 人工流转：分派/接单/处理中/挂起/完成/复开 =====
// actor 为当前请求成员；分派需 workorder_dispatch 权限（路由守卫），其余需 workorder_handle。
// 接单/开始/挂起/继续/完成仅限当前处理人本人；复开放开处理人限制——
// 管理员/户主（同样持有 workorder_handle）确认问题复发也可复开。
export function operateWorkOrder(id, action, actor, { assignee_id, note } = {}) {
  const wo = stmts.orderById.get(Number(id))
  if (!wo) throw Object.assign(new Error('工单不存在'), { status: 404 })
  const rule = TRANSITIONS[action]
  if (!rule) throw new Error('工单操作类型无效')
  if (!rule.from.includes(wo.status))
    throw new Error(`工单当前为「${STATUS_LABEL[wo.status]}」，不能执行「${ACTION_LABEL[action] || action}」`)
  if (!actor || actor.status !== 'active') throw new Error('身份无效，无法操作工单')

  const at = new Date()
  const atIso = at.toISOString()
  let nextAssigneeId = wo.assignee_id
  let nextAssigneeName = wo.assignee_name
  let nextNote = wo.note
  let eventAction = action
  let eventDetail = ''

  if (action === 'dispatch') {
    const targetId = Number(assignee_id)
    const target = stmts.memberById.get(targetId)
    if (!target) throw new Error('请选择有效的在组成员作为处理人')
    nextAssigneeId = target.id
    nextAssigneeName = target.name
    const isReassign = wo.status === 'dispatched' || wo.status === 'accepted'
      || wo.status === 'processing' || wo.status === 'suspended'
    eventAction = isReassign ? 'reassigned' : 'dispatched'
    eventDetail = isReassign
      ? `由「${wo.assignee_name || '—'}」改派给「${target.name}」（重新接单）`
      : `分派给「${target.name}」`
    if (note) { nextNote = appendNote(nextNote, `分派备注：${note}`); eventDetail += `；备注：${note}` }
  } else {
    // 接单后的执行动作（接单/开始/挂起/继续/完成）必须处理人本人，避免代接单/代完成；
    // 复开允许任何有处理权限的成员（含管理员/户主）
    if (action !== 'reopen' && wo.assignee_id !== actor.id)
      throw Object.assign(new Error(`该工单已分派给「${wo.assignee_name}」，仅处理人本人可执行此操作`), { status: 403 })

    if (action === 'accept') eventDetail = `「${actor.name}」接单`
    if (action === 'start') eventDetail = `「${actor.name}」开始处理`
    if (action === 'suspend') {
      const reason = String(note || '').trim()
      if (!reason) throw new Error('挂起工单必须填写挂起原因')
      nextNote = appendNote(nextNote, `挂起：${reason}`)
      eventDetail = `挂起原因：${reason}`
    }
    if (action === 'resume') eventDetail = `「${actor.name}」继续处理`
    if (action === 'complete') {
      const doneNote = String(note || '').trim()
      if (!doneNote) throw new Error('完成工单必须填写处理结果说明')
      nextNote = appendNote(nextNote, `完成：${doneNote}`)
      eventDetail = `处理结果：${doneNote}`
    }
    if (action === 'reopen') {
      if (!wo.source_active)
        throw new Error('触发工单的源告警已消除，无需复开；若告警再次出现系统会自动另开新工单')
      const reopenNote = String(note || '').trim()
      if (!reopenNote) throw new Error('复开工单必须填写复开原因')
      nextNote = appendNote(nextNote, `复开：${reopenNote}`)
      eventDetail = `复开原因：${reopenNote}`
    }
  }

  const to = rule.to
  // 任何分派/改派都开启新一轮执行：接受/开始/挂起时间全部清空（新处理人需重新接单）；
  // 复开后重分派同步清掉复开时间；完成时间在可分派的状态下本来就为空
  stmts.applyTransition.run(to, nextAssigneeId, nextAssigneeName, nextNote, atIso,
    action === 'dispatch' ? atIso : wo.dispatched_at,
    action === 'dispatch' ? null : (action === 'reopen' ? null : wo.accepted_at),
    action === 'dispatch' ? null : (action === 'reopen' ? null : wo.started_at),
    action === 'suspend' ? atIso : null,
    action === 'complete' ? atIso : (action === 'reopen' ? null : wo.completed_at),
    action === 'dispatch' ? null : (action === 'reopen' ? atIso : null),
    wo.id)
  stmts.insertEvent.run(wo.id, eventAction, wo.status, to,
    actor.name, actor.role_label || '', eventDetail, atIso)
  return stmts.orderById.get(wo.id)
}

// ===== 序列化视图 =====
function orderView(wo) {
  return {
    id: wo.id,
    code: wo.code,
    source_type: wo.source_type,
    source_label: SOURCE_LABEL[wo.source_type] || wo.source_type,
    source_icon: SOURCE_ICON[wo.source_type] || '🎫',
    device_id: wo.device_id,
    quota_alert_id: wo.quota_alert_id,
    target_name: wo.target_name,
    title: wo.title,
    detail: wo.detail,
    level: wo.level,
    status: wo.status,
    status_label: STATUS_LABEL[wo.status],
    active: wo.status !== 'completed',
    assignee_id: wo.assignee_id,
    assignee_name: wo.assignee_name,
    note: wo.note,
    source_active: !!wo.source_active,
    created_at: wo.created_at,
    updated_at: wo.updated_at,
    dispatched_at: wo.dispatched_at,
    accepted_at: wo.accepted_at,
    started_at: wo.started_at,
    suspended_at: wo.suspended_at,
    completed_at: wo.completed_at,
    reopened_at: wo.reopened_at
  }
}

export function listWorkOrders() {
  return stmts.allOrders.all().map((wo) => ({
    ...orderView(wo),
    device_deleted: wo.device_id
      ? !db.prepare('SELECT id FROM devices WHERE id=?').get(wo.device_id)
      : false,
    assignee_revoked: wo.assignee_id
      ? !db.prepare("SELECT id FROM household_members WHERE id=? AND status='active'").get(wo.assignee_id)
      : false
  }))
}

export function getWorkOrder(id) {
  const wo = stmts.orderById.get(Number(id))
  if (!wo) return null
  const events = stmts.eventsByOrder.all(wo.id).map((e) => ({
    id: e.id,
    action: e.action,
    action_label: ACTION_LABEL[e.action] || e.action,
    from_status: e.from_status,
    to_status: e.to_status,
    from_label: e.from_status ? STATUS_LABEL[e.from_status] : '',
    to_label: e.to_status ? STATUS_LABEL[e.to_status] : '',
    operator: e.operator,
    operator_role: e.operator_role,
    detail: e.detail,
    time: e.time
  }))
  return {
    ...orderView(wo),
    events,
    device_deleted: wo.device_id ? !db.prepare('SELECT id FROM devices WHERE id=?').get(wo.device_id) : false
  }
}

export function activeWorkOrderCount() {
  return db.prepare("SELECT COUNT(*) c FROM work_orders WHERE status<>'completed'").get().c
}

// 告警身份 → 未完成工单（供 /api/state 告警中心关联跳转）
export function activeOrderByAlert(sourceType, deviceId, quotaAlertId) {
  const wo = sourceType === 'quota_over'
    ? stmts.activeByIdentityQuota.get(quotaAlertId)
    : stmts.activeByIdentityDevice.get(sourceType, deviceId)
  return wo || null
}

// ===== 首次启动演示工单：一张已走完全流程的历史工单（源告警当前不存在） =====
function seedWorkOrders() {
  if (db.prepare('SELECT COUNT(*) c FROM work_orders').get().c > 0) return
  const lamp = db.prepare("SELECT id FROM devices WHERE name='客厅主灯'").get()
  if (!lamp) return
  const assignee = db.prepare("SELECT * FROM household_members WHERE name='小宇'").get()
    || db.prepare("SELECT * FROM household_members WHERE status='active' AND role='member'").get()
  if (!assignee) return

  const now = Date.now()
  const iso = (offsetH) => new Date(now - offsetH * 3600_000).toISOString()
  const tCreated = iso(26), tDispatch = iso(25), tAccept = iso(24.5), tStart = iso(24)
  const tSuspend = iso(20), tResume = iso(6), tComplete = iso(5)

  const code = (() => {
    const at = new Date(now - 26 * 3600_000)
    const p = (n) => String(n).padStart(2, '0')
    return `WO-${String(at.getFullYear()).slice(2)}${p(at.getMonth() + 1)}${p(at.getDate())}-001`
  })()

  db.prepare(`INSERT INTO work_orders
    (code,source_type,device_id,quota_alert_id,target_name,title,detail,level,status,
     assignee_id,assignee_name,note,source_active,created_at,updated_at,
     dispatched_at,accepted_at,started_at,suspended_at,completed_at,reopened_at)
    VALUES (?,?,?,?,?,?,?,?, 'completed', ?,?,? ,0, ?,?, ?,?,?, ?,?,NULL)`)
    .run(code, 'device_signal', lamp.id, null, '客厅主灯', '信号弱告警 · 客厅主灯',
      '信号弱(48)，请检查网络或设备位置', 'warn',
      assignee.id, assignee.name, '挂起：等待路由器重启后观察 ｜ 完成：已将网关移至客厅，信号恢复至 90',
      tCreated, tComplete, tDispatch, tAccept, tStart, tSuspend, tComplete)
  const wo = db.prepare('SELECT * FROM work_orders WHERE code=?').get(code)
  const ev = (action, from, to, operator, role, detail, time) =>
    stmts.insertEvent.run(wo.id, action, from, to, operator, role, detail, time)
  ev('created', null, 'open', '系统', '', '由信号弱告警自动生成：信号弱(48)，请检查网络或设备位置', tCreated)
  ev('dispatched', 'open', 'dispatched', '妈妈', '家庭管理员', '分派给「小宇」', tDispatch)
  ev('accepted', 'dispatched', 'accepted', assignee.name, '家庭成员', '「小宇」接单', tAccept)
  ev('started', 'accepted', 'processing', assignee.name, '家庭成员', '「小宇」开始处理', tStart)
  ev('suspended', 'processing', 'suspended', assignee.name, '家庭成员', '挂起原因：等待路由器重启后观察', tSuspend)
  ev('resumed', 'suspended', 'processing', assignee.name, '家庭成员', '「小宇」继续处理', tResume)
  ev('completed', 'processing', 'completed', assignee.name, '家庭成员', '处理结果：已将网关移至客厅，信号恢复至 90', tComplete)
}
