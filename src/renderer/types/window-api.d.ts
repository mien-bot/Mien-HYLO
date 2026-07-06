import type { MienAPI } from '../../main/preload'

declare global {
  interface Window {
    api: MienAPI
  }
}

export {}
