<script setup lang="ts">
import { setupLayouts } from "virtual:generated-layouts"
import generatedRoutes from "~pages"

const routes = setupLayouts(generatedRoutes)

const appsRoutes = routes.filter((r) => r.path.startsWith("/apps"))

const formatName = (p: string) =>
  p
    .replace("/apps/", "")
    .split("-")
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(" ")
</script>

<template>
  <div flex p-4>
    <template v-for="app in appsRoutes" :key="app.path">
      <RouterLink
        :to="app.path"
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
