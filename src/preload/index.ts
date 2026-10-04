import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ConvertResult,
  ConvertDirection,
  AppSettings,
  HistoryEntry,
  Persona,
  ChatSession,
  EgressStatus,
  LookupResult,
  WindowInfo,
  DroppedFile
} from '../shared/types'

/**
 * 预加载脚本 —— 渲染进程与主进程之间唯一的桥。
 * contextIsolation 打开，渲染进程拿不到 Node API，只能用这里白名单里的方法。
 */

const api = {
  // —— 转换 ——
  convert: (inputPath: string, direction: ConvertDirection): Promise<ConvertResult> =>
    ipcRenderer.invoke('convert:run', inputPath, direction),
  convertBatch: (inputs: string[], direction: ConvertDirection): Promise<ConvertResult[]> =>
    ipcRenderer.invoke('convert:batch', inputs, direction),
  inferDirection: (filePath: string): Promise<ConvertDirection | null> =>
    ipcRenderer.invoke('convert:inferDirection', filePath),
  getHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke('convert:history'),
  clearHistory: (): Promise<void> => ipcRenderer.invoke('convert:clearHistory'),
  getQuota: (): Promise<{ used: number; limit: number }> => ipcRenderer.invoke('convert:quota'),

  // —— 划词与对话 ——
  lookup: (word: string) => ipcRenderer.invoke('dict:lookup', word),
  // —— 划词气泡 ——
  bubbleDeepExplain: (word: string) => ipcRenderer.invoke('bubble:deepExplain', word),
  closeBubble: (): void => ipcRenderer.send('bubble:close'),
  onBubbleData: (cb: (p: { word: string; hit: LookupResult | null }) => void) => {
    const handler = (_e: unknown, p: { word: string; hit: LookupResult | null }) => cb(p)
    ipcRenderer.on('bubble:data', handler)
    return () => { ipcRenderer.removeListener('bubble:data', handler) }
  },
  deepExplain: (word: string, context: string) =>
    ipcRenderer.invoke('dict:deepExplain', word, context),
  ask: (question: string) => ipcRenderer.invoke('chat:ask', question),
  polish: (text: string, style: 'concise' | 'formal' | 'friendly') =>
    ipcRenderer.invoke('chat:polish', text, style),
  getPersona: (): Promise<Persona> => ipcRenderer.invoke('chat:persona'),  savePersona: (p: Persona): Promise<Persona> => ipcRenderer.invoke('chat:savePersona', p),
  getSessions: (): Promise<ChatSession[]> => ipcRenderer.invoke('chat:sessions'),
  saveSession: (s: ChatSession): Promise<void> => ipcRenderer.invoke('chat:saveSession', s),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke('chat:deleteSession', id),
  llmStatus: () => ipcRenderer.invoke('llm:status'),

  // —— 设置与数据 ——
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', patch),
  setAutoLaunch: (enable: boolean): Promise<void> => ipcRenderer.invoke('settings:autolaunch', enable),
  exportData: (): Promise<string> => ipcRenderer.invoke('data:export'),
  wipeData: (): Promise<void> => ipcRenderer.invoke('data:wipe'),

  // —— 窗口行为 ——
  listWindows: (): Promise<WindowInfo[]> => ipcRenderer.invoke('win:list'),
  getForeground: (): Promise<WindowInfo | null> => ipcRenderer.invoke('win:foreground'),

  // —— 桌宠窗口控制 ——
  setIgnoreMouse: (ignore: boolean): void => ipcRenderer.send('pet:setIgnoreMouse', ignore),
  setPetPosition: (x: number, y: number): void => ipcRenderer.send('pet:setPosition', x, y),
  dragPet: (dx: number, dy: number): void => ipcRenderer.send('pet:dragging', dx, dy),
  getPetPosition: (): void => ipcRenderer.send('pet:getPosition'),
  openPanel: (): void => ipcRenderer.send('panel:open'),
  closePanel: (): void => ipcRenderer.send('panel:close'),
  requestEgress: (): void => ipcRenderer.send('app:getEgress'),

  // —— 事件订阅 ——
  onEgressChanged: (cb: (s: EgressStatus) => void) => {
    const handler = (_e: unknown, s: EgressStatus) => cb(s)
    ipcRenderer.on('egress:changed', handler)
    return () => { ipcRenderer.removeListener('egress:changed', handler) }
  },
  onForegroundWindow: (cb: (w: WindowInfo) => void) => {
    const handler = (_e: unknown, w: WindowInfo) => cb(w)
    ipcRenderer.on('win:foreground', handler)
    return () => { ipcRenderer.removeListener('win:foreground', handler) }
  },
  onWindowDestroyed: (cb: (hwnd: number) => void) => {
    const handler = (_e: unknown, h: number) => cb(h)
    ipcRenderer.on('win:destroyed', handler)
    return () => { ipcRenderer.removeListener('win:destroyed', handler) }
  },
  onWin32Unsupported: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('win:unsupported', handler)
    return () => { ipcRenderer.removeListener('win:unsupported', handler) }
  },
  onDropReceived: (cb: (files: DroppedFile[]) => void) => {
    const handler = (_e: unknown, files: DroppedFile[]) => cb(files)
    ipcRenderer.on('drop:received', handler)
    return () => { ipcRenderer.removeListener('drop:received', handler) }
  },
  onPetPosition: (cb: (p: { x: number; y: number }) => void) => {
    const handler = (_e: unknown, p: { x: number; y: number }) => cb(p)
    ipcRenderer.on('pet:position', handler)
    return () => { ipcRenderer.removeListener('pet:position', handler) }
  },
  onScreenshotShortcut: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('shortcut:screenshot', handler)
    return () => { ipcRenderer.removeListener('shortcut:screenshot', handler) }
  },

  /** Electron 32+ 取拖放文件真实路径的唯一方式（File.path 已移除） */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return file.name
    }
  },

  platform: process.platform
}

export type HearthApi = typeof api

contextBridge.exposeInMainWorld('hearth', api)