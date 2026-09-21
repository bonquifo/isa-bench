/**
 * Asset imports Vite understands but TypeScript does not know about.
 *
 * `?url` on an arbitrary extension yields a string: a served path during
 * development, and a `data:` URI in a production build, because the packaged
 * desktop app loads over `file://` where fetching a sibling file is blocked.
 * The inlining is configured in vite.config.ts.
 */
declare module '*.elf?url' {
  const src: string
  export default src
}
