<template>
  <div class="logs">
    <div class="toolbar">
      <div class="filters">
        <button v-for="f in filters" :key="f.v" :class="{active: cat===f.v}" @click="setCat(f.v)">{{ f.t }}</button>
      </div>
      <label class="mine"><input type="checkbox" v-model="onlyMine" @change="reload"/> 只看我的操作</label>
      <button @click="reload">🔄 刷新</button>
      <span class="cnt">共 {{ logs.length }} 条</span>
    </div>
    <div class="timeline">
      <div v-for="l in logs" :key="l.id" class="entry">
        <span class="dot" :class="dotClass(l)"></span>
        <div class="body">
          <div class="line">
            <b>{{ l.device_name }}</b>
            <span class="act" :class="l.category">{{ l.action }}</span>
            <span class="who" :class="roleKey(l.operator_role)">
              {{ l.operator || '系统' }}<i v-if="l.operator_role"> · {{ l.operator_role }}</i>
            </span>
            <span class="time">{{ l.time }}</span>
          </div>
          <div v-if="l.detail" class="detail">{{ l.detail }}</div>
        </div>
      </div>
      <div v-if="!logs.length" class="none">暂无日志</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()
const cat = ref('all')
const onlyMine = ref(false)
const logs = ref([])

const filters = [
  { v: 'all', t: '全部' },
  { v: 'member', t: '👥 家庭协作' },
  { v: 'device', t: '📟 设备' },
  { v: 'scene', t: '🎬 场景' },
  { v: 'quota', t: '📏 定额告警' },
  { v: 'workorder', t: '🎫 工单' }
]
function setCat(v) { cat.value = v; reload() }
async function reload() {
  const qs = []
  if (cat.value !== 'all') qs.push('category=' + cat.value)
  if (onlyMine.value && store.current) qs.push('operator=' + encodeURIComponent(store.current.name))
  const r = await fetch('/api/logs' + (qs.length ? '?' + qs.join('&') : ''), {
    headers: store.current ? { 'X-Home-Token': localStorage.getItem('home_member_token') || '' } : {}
  })
  logs.value = await r.json()
}
function dotClass(l) {
  if (l.category === 'member') return 'member'
  if (l.category === 'scene') return 'scene'
  if (l.category === 'workorder') {
    if (/完成|消除/.test(l.action)) return 'ok'
    if (/挂起/.test(l.action)) return 'scene'
    if (/复开/.test(l.action)) return 'reopen'
    return 'workorder'
  }
  if (l.category === 'quota') return /解除/.test(l.action) ? 'ok' : 'quota'
  const t = l.action
  if (t.includes('关')) return 'off'
  if (t.includes('开')) return 'on'
  if (t.includes('新增') || t.includes('删除')) return 'sys'
  return ''
}
function roleKey(label) {
  return { 户主: 'owner', 家庭管理员: 'admin', 家庭成员: 'member', 访客: 'guest' }[label] || ''
}
onMounted(reload)
</script>

<style scoped>
.logs{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.filters{display:flex;gap:6px;flex-wrap:wrap;}
.filters button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;}
.filters button.active{background:#2962ff;border-color:#2962ff;color:#fff;}
.mine{font-size:12px;color:#8ba2c8;display:flex;align-items:center;gap:5px;cursor:pointer;}
.mine input{width:auto;}
.toolbar>button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;}
.cnt{color:#8ba2c8;font-size:12px;}
.timeline{border-left:2px solid #1a2a4a;padding-left:18px;display:flex;flex-direction:column;gap:14px;max-height:560px;overflow-y:auto;padding-right:8px;}
.entry{position:relative;}
.dot{position:absolute;left:-24px;top:4px;width:11px;height:11px;border-radius:50%;background:#546e7a;border:2px solid #0a1224;}
.dot.on{background:#66bb6a;}.dot.off{background:#ef5350;}.dot.scene{background:#ffd54f;}.dot.sys{background:#42a5f5;}
.dot.member{background:#ab47bc;}.dot.quota{background:#ef5350;}.dot.ok{background:#66bb6a;}
.dot.workorder{background:#ce93d8;}.dot.reopen{background:#ffab91;}
.body{background:#0f1b38;border:1px solid rgba(120,160,220,0.14);border-radius:10px;padding:10px 12px;}
.line{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.line b{color:#fff;font-size:13px;}
.act{background:#16263f;color:#90caf9;font-size:11px;padding:2px 8px;border-radius:5px;}
.act.member{background:#2d1b3d;color:#ce93d8;}
.act.scene{background:#3d3416;color:#ffd54f;}
.act.quota{background:#3d1b1b;color:#ef9a9a;}
.act.workorder{background:#2f2648;color:#ce93d8;}
.who{font-size:10px;padding:2px 8px;border-radius:10px;background:#13233f;color:#8ba2c8;border:1px solid rgba(120,160,220,0.15);}
.who i{font-style:normal;color:#6f84ab;}
.who.owner{color:#ffd54f;border-color:rgba(255,213,79,.3);}
.who.admin{color:#90caf9;}.who.member{color:#a5d6a7;}.who.guest{color:#b0bec5;}
.time{margin-left:auto;color:#5b6f94;font-size:10px;}
.detail{color:#8ba2c8;font-size:11px;margin-top:4px;}
.none{color:#5b6f94;text-align:center;padding:30px;}
</style>
