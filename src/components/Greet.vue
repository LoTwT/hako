<script setup lang="ts">
import { ref } from "vue"
import { safeInvoke } from "@/utils/tauri"

const greetMsg = ref("")
const name = ref("")

async function greet() {
  await safeInvoke(
    async (invoke) => {
      greetMsg.value = await invoke("greet", { name: name.value })
    },
    () => {
      greetMsg.value = `client: ${name.value}`
    },
  )
}
</script>

<template>
  <form class="row" @submit.prevent="greet">
    <input id="greet-input" v-model="name" placeholder="Enter a name..." />
    <button type="submit">Greet</button>
  </form>

  <p>{{ greetMsg }}</p>
</template>
