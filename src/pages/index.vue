<script setup lang="ts">
import { routes } from "vue-router/auto/routes"
</script>

<template>
  <div>
    <template v-for="route in routes" :key="route.path">
      <RouterLink :to="route.path" block>
        <var-link underline="hover">{{ route.name }}</var-link>
      </RouterLink>
    </template>
  </div>
</template>
