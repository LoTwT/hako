/* eslint-disable */
/* prettier-ignore */
// @ts-nocheck
// Generated by unplugin-vue-router. ‼️ DO NOT MODIFY THIS FILE ‼️
// It's recommended to commit this file.
// Make sure to add this file to your tsconfig.json file as an "includes" or "files" entry.

declare module 'vue-router/auto-routes' {
  import type {
    RouteRecordInfo,
    ParamValue,
    ParamValueOneOrMore,
    ParamValueZeroOrMore,
    ParamValueZeroOrOne,
  } from 'unplugin-vue-router/types'

  /**
   * Route name map generated by unplugin-vue-router
   */
  export interface RouteNamedMap {
    'Home': RouteRecordInfo<'Home', '/', Record<never, never>, Record<never, never>>,
    '$All': RouteRecordInfo<'$All', '/:all(.*)', { all: ParamValue<true> }, { all: ParamValue<false> }>,
    'User': RouteRecordInfo<'User', '/user', Record<never, never>, Record<never, never>>,
  }
}
