<script setup lang="ts">
import { routes } from "vue-router/auto-routes"
</script>

<template>
  <div>
    <template v-for="route in routes" :key="route.path">
      <RouterLink :to="route.path" block>
        <div>{{ route.name }}</div>
      </RouterLink>
    </template>
  </div>
</template>
