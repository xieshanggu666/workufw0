<template>
  <div class="scope-pick">
    <div class="sp-title">
      🎯 操作范围（按房间 / 设备限定其设备控制、场景执行、定额与工单等操作）
      <label class="sp-all">
        <input type="checkbox" :checked="allHouse" @change="toggleAll" />
        全屋不限
      </label>
    </div>
    <div class="sp-cols">
      <div class="sp-col">
        <b>按房间授权</b>
        <span class="sp-hint">设备换房后授权自动跟随迁入/迁出</span>
        <label v-for="r in rooms" :key="r.id">
          <input type="checkbox" :value="r.id" v-model="roomIds" :disabled="allHouse" />
          {{ r.name }}
        </label>
      </div>
      <div class="sp-col">
        <b>按设备授权</b>
        <span class="sp-hint">按设备稳定标识，换房/改名不丢失</span>
        <label v-for="d in devices" :key="d.id">
          <input type="checkbox" :value="d.id" v-model="deviceIds" :disabled="allHouse" />
          <span>{{ d.name }}</span><em>{{ d.room }}</em>
        </label>
      </div>
    </div>
    <p v-if="!allHouse && !roomIds.length && !deviceIds.length" class="sp-warn">
      未勾选任何房间/设备 = 该成员的所有操作对象都会被后端拦截，请至少选择一项或勾选「全屋不限」
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
// v-model 绑定 { room_ids: number[], device_ids: number[] }；空数组 = 全屋不限
const props = defineProps({
  modelValue: { type: Object, default: () => ({ room_ids: [], device_ids: [] }) },
  rooms: { type: Array, default: () => [] },
  devices: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:modelValue'])
const roomIds = computed({
  get: () => props.modelValue.room_ids || [],
  set: (v) => emit('update:modelValue', { ...props.modelValue, room_ids: v.map(Number) })
})
const deviceIds = computed({
  get: () => props.modelValue.device_ids || [],
  set: (v) => emit('update:modelValue', { ...props.modelValue, device_ids: v.map(Number) })
})
const allHouse = computed(() => !roomIds.value.length && !deviceIds.value.length)
function toggleAll(e) {
  if (e.target.checked) emit('update:modelValue', { room_ids: [], device_ids: [] })
  else emit('update:modelValue', { room_ids: props.rooms.slice(0, 1).map((r) => r.id), device_ids: [] })
}
</script>

<style scoped>
.scope-pick{flex-basis:100%;background:#0a1428;border:1px dashed rgba(120,160,220,0.35);border-radius:10px;padding:10px 12px;}
.sp-title{font-size:11px;color:#ffd54f;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;}
.sp-all{margin-left:auto;color:#dbe4f3;font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;}
.sp-all input,.sp-cols input{width:auto;padding:0;}
.sp-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;}
.sp-col{display:flex;flex-direction:column;gap:4px;max-height:150px;overflow:auto;padding-right:6px;}
.sp-col b{font-size:11px;color:#90caf9;}
.sp-hint{font-size:10px;color:#5b6f94;}
.sp-col label{font-size:11px;color:#dbe4f3;display:flex;align-items:center;gap:6px;cursor:pointer;}
.sp-col label em{font-style:normal;color:#5b6f94;margin-left:auto;font-size:10px;}
.sp-warn{margin:8px 0 0;font-size:10px;color:#ef9a9a;}
</style>
