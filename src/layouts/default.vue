<script setup lang="ts">
const navs = [
  {
    name: "Home",
    icon: "i-carbon-home",
    path: "/",
  },
  {
    name: "User",
    icon: "i-carbon-user",
    path: "/user",
  },
]

const route = useRoute()
</script>

<template>
  <main mb-60px pb-4>
    <slot />
  </main>
  <nav fixed bottom-0 left-0 w-full flex bg-white p-2 shadow="2xl gray-500">
    <RouterLink
      v-for="n in navs"
      :key="n.path"
      flex="~ 1 col"
      items-center
      justify-between
      border="l-1 solid first:none"
      :to="n.path"
      :class="[route.path === n.path ? 'text-blue' : '']"
    >
      <div :class="n.icon" text-xl />
      <div text-xs>{{ n.name }}</div>
    </RouterLink>
  </nav>
</template>
