import type { UninvitedApi } from '../../preload'

declare global {
  interface Window {
    /** 主进程通过 contextBridge 暴露的白名单 API */
    uninvited: UninvitedApi
  }
}

export {}