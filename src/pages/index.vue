<script setup lang="ts">
import { routes } from "vue-router/auto-routes"

const appsRoutes = routes.find((r) => r.path === "/apps")

const formatName = (path: string) =>
  path
    .split("-")
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ")
</script>

<template>
  <div flex p-4>
    <template v-for="app in appsRoutes?.children" :key="app.name">
      <RouterLink
        :to="`/apps/${app.path}`"
        w-full
        border-1
        rounded-full
        px-4
        py-2
        text-center
        shadow
      >
        {{ formatName(app.path) }}
      </RouterLink>
    </template>
  </div>
</template>
