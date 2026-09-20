interface IsaBenchDesktop {
  embedded: true
  shell: 'electron'
  origin?: string
}

interface Window {
  isaBenchDesktop?: IsaBenchDesktop
}
