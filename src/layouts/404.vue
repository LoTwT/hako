<template>
  <main flex="~ col" h-100vh items-center justify-center>
    <RouterView />
    <RouterLink mt-8 block border-1 rounded-full px-4 py-2 shadow to="/">
      Back to Home
    </RouterLink>
  </main>
</template>
