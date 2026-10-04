import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  shell,
  dialog
} from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  ConvertResult,
  ConvertDirection,
  AppSettings,
  EgressState,
  EgressStatus,
  DroppedFile
} from '../shared/types'
import { convert, convertBatch, inferDirection } from './services/convert'
import { lookup } from './services/dictionary'
import { resolveSelection, bubbleSize } from './services/selection'
import {
  processCustomArt,
  clearCustomArt,
  customArtPath,
  displayHeightFor
} from './services/customArt'
import type { LookupResult } from '../shared/types'
import { ask, polishText, cloudReady, setEgressListener, deepExplain } from './services/llm'
import { createWin32Bridge, screenSize } from './services/win32'
import {
  initStore,
  getSettings,
  saveSettings,
  getHistory,
  clearHistory,
  getPersona,
  savePersona,
  getSessions,
  saveSession,
  deleteSession,
  exportAll,
  wipeAll,
  getQuotaUsed,
  consumeQuota
} from './store'

const __dirname_ = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// 退出标记：区分「关窗口」与「真退出」，托盘常驻需要它
let isQuitting = false

// ==== 全局状态 ====
let petWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let tray: Tray | null = null
let win32: ReturnType<typeof createWin32Bridge> | null = null
/** 最近一次划词的光标屏幕坐标，气泡据此定位 */
let selectionAnchor = { x: 0, y: 0 }
let currentEgress: EgressStatus = {
  state: 'idle',
  detail: '无数据离开本机'
}
let egressTimer: NodeJS.Timeout | null = null

// ==== 测试模式（--regression / --smoke）====
// 在主进程里跑，因为 Word→PDF 的回退链路要用 BrowserWindow.printToPDF，
// 这样测的就是真实代码路径，而不是另写一套模拟实现。
const isRegressionMode = process.argv.includes('--regression')
const isSmokeMode = process.argv.includes('--smoke')
const isPerfMode = process.argv.includes('--perf')

if (isRegressionMode || isSmokeMode || isPerfMode) {
  app.whenReady().then(async () => {
    try {
      if (isSmokeMode) {
        const mod = await import('./smoke/index')
        await mod.runSmoke()
        return
      }
      if (isPerfMode) {
        const mod = await import('./perf/probe')
        await mod.runPerfProbe()
        return
      }
      const mod = await import('./regression/index')
      const ok = await mod.runRegression(path.join(app.getPath('temp'), 'uninvited-regression'))
      app.exit(ok ? 0 : 1)
    } catch (e) {
      console.error('[test] 运行失败', e)
      app.exit(1)
    }
  })
} else {
  // ==== 单实例（方案书 P1「单实例」）====
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (panelWindow) {
        panelWindow.show()
        panelWindow.focus()
      }
    })
  }
}

// ==== 桌宠窗口 ====
function createPetWindow(): BrowserWindow {
  const { width } = screenSize()

  const win = new BrowserWindow({
    width: 220,
    height: 260,
    x: width - 300,
    y: 80,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 桌宠需要接收鼠标事件（拖拽、点击互动），穿透由设置控制
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname_, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const petHtml = path.join(__dirname_, '../renderer/pet.html')
  if (isDev) {
    win.loadURL(`file://${petHtml}`).catch(() => {})
  } else {
    win.loadFile(petHtml).catch(() => {})
  }

  win.on('closed', () => {
    petWindow = null
  })

  // 忽略所有导航与新窗口，保证安全
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  return win
}

// ==== 设置面板窗口 ====
function createPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 680,
    show: false,
    minWidth: 780,
    minHeight: 560,
    autoHideMenuBar: true,
    title: '不请自来 Uninvited',
    backgroundColor: '#F7FAF9',
    webPreferences: {
      preload: path.join(__dirname_, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const panelHtml = path.join(__dirname_, '../renderer/panel.html')
  if (isDev) {
    win.loadURL(`file://${panelHtml}`).catch(() => {})
  } else {
    win.loadFile(panelHtml).catch(() => {})
  }

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

function showPanel(): void {
  if (!panelWindow) panelWindow = createPanelWindow()
  if (panelWindow.isMinimized()) panelWindow.restore()
  panelWindow.show()
  panelWindow.focus()
}

// ==== 划词气泡窗口 ====

let bubbleWindow: BrowserWindow | null = null
let bubbleHideTimer: NodeJS.Timeout | null = null

function createBubbleWindow(): BrowserWindow {
  const { width, height } = bubbleSize('placeholder')

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    // 气泡不能抢焦点，否则用户会丢失原本的输入上下文
    webPreferences: {
      preload: path.join(__dirname_, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const html = path.join(__dirname_, '../renderer/bubble.html')
  if (isDev) win.loadURL(`file://${html}`).catch(() => {})
  else win.loadFile(html).catch(() => {})

  win.on('closed', () => {
    bubbleWindow = null
  })

  // 失焦即隐藏：用户去别处干活了，气泡就该消失
  win.on('blur', () => {
    if (bubbleWindow && !bubbleWindow.webContents.isDevToolsOpened()) {
      bubbleWindow.hide()
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  return win
}

/** 在光标附近弹出气泡 */
function showBubble(word: string, hit: LookupResult | null): void {
  if (!bubbleWindow) bubbleWindow = createBubbleWindow()

  const { width, height } = bubbleSize(word)
  bubbleWindow.setSize(width, height)

  // 贴着选区显示，并保证不出屏
  const { width: sw, height: sh } = screenSize()
  const x = Math.min(Math.max(4, selectionAnchor.x), Math.max(4, sw - width - 4))
  const y = Math.min(
    Math.max(4, selectionAnchor.y + 18),
    Math.max(4, sh - height - 4)
  )
  bubbleWindow.setPosition(Math.round(x), Math.round(y), false)

  bubbleWindow.webContents.send('bubble:data', { word, hit })
  bubbleWindow.showInactive()

  // 兜底自动消失，避免忘记关的气泡一直挂着
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer)
  bubbleHideTimer = setTimeout(() => bubbleWindow?.hide(), 8000)
}

function hideBubble(): void {
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer)
  bubbleWindow?.hide()
}

/** 划词事件处理：本地词典命中就弹，否则安静地什么都不做 */
async function onSelection(text: string, cx: number, cy: number): Promise<void> {
  selectionAnchor = { x: cx, y: cy }
  const settings = await getSettings()
  if (!settings.enableSelectionLookup) return

  const r = await resolveSelection(text)
  if (!r) return
  showBubble(r.word, r.hit)
}

// ==== 托盘 ====
function createTray(): void {
  // 内联生成一个极简托盘图标，避免额外资源文件
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dx = x - 7.5
      const dy = y - 8.5
      const inside = dx * dx + dy * dy < 36
      buf[i] = inside ? 0x0e : 0
      buf[i + 1] = inside ? 0x8f : 0
      buf[i + 2] = inside ? 0x6e : 0
      buf[i + 3] = inside ? 0xff : 0
    }
  }
  const icon = nativeImage.createFromBuffer(buf, { width: size, height: size })
  tray = new Tray(icon)
  tray.setToolTip('不请自来 Uninvited')
  refreshTrayMenu()
  tray.on('click', showPanel)
}

function refreshTrayMenu(): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: '打开不请自来', click: showPanel },
    { type: 'separator' },
    { label: '显示/隐藏桌宠', click: () => togglePet() },
    { label: '转换历史…', click: showPanel },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autoLaunchState,
      click: async (item) => {
        await setAutoLaunch(item.checked)
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function togglePet(): void {
  if (!petWindow) return
  if (petWindow.isVisible()) petWindow.hide()
  else petWindow.show()
}

// ==== 开机自启（注册表 Run 项 + 延迟 30 秒，方案书表 4）====
let autoLaunchState = false

async function setAutoLaunch(enable: boolean): Promise<void> {
  if (process.platform !== 'win32') return
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  // --delay 参数让 Explorer 在登录 30 秒后才拉起，不与开机加载抢资源
  const value = enable
    ? `cmd /c timeout /t 30 /nobreak >nul && "${process.execPath}" --autostart`
    : ''

  try {
    await run(
      'reg.exe',
      [
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        'Uninvited',
        '/t',
        'REG_SZ',
        '/d',
        value,
        '/f'
      ],
      { windowsHide: true }
    )
    autoLaunchState = enable
    await saveSettings({ autoLaunch: enable })
    refreshTrayMenu()
  } catch (e) {
    console.error('[autolaunch] 设置失败', e)
  }
}

async function readAutoLaunch(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Uninvited'],
      { windowsHide: true }
    )
    autoLaunchState = /Uninvited\s+REG_SZ/i.test(stdout)
  } catch {
    autoLaunchState = false
  }
}

// ==== 出网状态灯 ====
function pushEgress(state: EgressState, detail: string, provider?: string): void {
  currentEgress = { state, detail, provider, since: Date.now() }
  petWindow?.webContents.send('egress:changed', currentEgress)
  panelWindow?.webContents.send('egress:changed', currentEgress)

  // 15 秒后自动回到 idle
  if (egressTimer) clearTimeout(egressTimer)
  if (state !== 'idle') {
    egressTimer = setTimeout(() => {
      currentEgress = { state: 'idle', detail: '无数据离开本机' }
      petWindow?.webContents.send('egress:changed', currentEgress)
      panelWindow?.webContents.send('egress:changed', currentEgress)
    }, 15_000)
  }
}

setEgressListener((kind, detail, provider) => {
  pushEgress(kind, detail, provider)
})

// ==== IPC 处理器 ====
function registerIpc(): void {
  // —— 转换 ——
  ipcMain.handle('convert:run', async (_e, inputPath: string, direction: ConvertDirection): Promise<ConvertResult> => {
    const used = await getQuotaUsed()
    const s = await getSettings()
    if (used >= s.dailyFreeQuota) {
      return {
        ok: false,
        inputPath,
        direction,
        lane: 'manual-required',
        durationMs: 0,
        fidelity: [],
        degradedNotes: [`今日免费额度已用完（${used}/${s.dailyFreeQuota}）。`],
        error: '今日免费额度已用完'
      }
    }
    await consumeQuota()
    return convert({ inputPath, direction })
  })

  ipcMain.handle('convert:batch', async (_e, inputs: string[], direction: ConvertDirection) =>
    convertBatch(inputs, direction)
  )

  ipcMain.handle('convert:inferDirection', async (_e, filePath: string) => inferDirection(filePath))

  ipcMain.handle('convert:history', async () => getHistory())
  ipcMain.handle('convert:clearHistory', async () => clearHistory())
  ipcMain.handle('convert:quota', async () => {
    const s = await getSettings()
    return { used: await getQuotaUsed(), limit: s.dailyFreeQuota }
  })

  // —— 划词与对话 ——
  ipcMain.handle('dict:lookup', async (_e, word: string) => lookup(word))
  ipcMain.handle('dict:deepExplain', async (_e, word: string, context: string) =>
    deepExplain(word, context)
  )
  ipcMain.handle('chat:ask', async (_e, question: string) => {
    const persona = await getPersona()
    return ask(question, [], persona)
  })
  ipcMain.handle('chat:polish', async (_e, text: string, style: 'concise' | 'formal' | 'friendly') =>
    polishText(text, style)
  )
  ipcMain.handle('chat:persona', async () => getPersona())
  ipcMain.handle('chat:savePersona', async (_e, p) => savePersona(p))
  ipcMain.handle('chat:sessions', async () => getSessions())
  ipcMain.handle('chat:saveSession', async (_e, s) => saveSession(s))
  ipcMain.handle('chat:deleteSession', async (_e, id: string) => deleteSession(id))
  ipcMain.handle('llm:status', async () => cloudReady())

  // —— 设置与数据 ——
  ipcMain.handle('settings:get', async () => getSettings())
  ipcMain.handle('settings:save', async (_e, patch: Partial<AppSettings>) => {
    const saved = await saveSettings(patch)
    // 换形象时通知桌宠窗口立即重建，无需重启
    if (patch.petTheme) {
      petWindow?.webContents.send('pet:theme', saved.petTheme)
    }
    return saved
  })
  ipcMain.handle('settings:autolaunch', async (_e, enable: boolean) => setAutoLaunch(enable))
  ipcMain.handle('data:export', async () => exportAll())
  ipcMain.handle('data:wipe', async () => wipeAll())

  // —— 窗口行为 ——
  ipcMain.handle('win:list', async () => win32?.listWindows() ?? [])
  ipcMain.handle('win:foreground', async () => win32?.getForeground() ?? null)

  ipcMain.on('pet:setIgnoreMouse', (_e, ignore: boolean) => {
    if (petWindow) petWindow.setIgnoreMouseEvents(ignore, { forward: true })
  })

  ipcMain.on('pet:setPosition', (_e, x: number, y: number) => {
    if (petWindow) petWindow.setPosition(Math.round(x), Math.round(y))
  })

  ipcMain.on('pet:getPosition', (e) => {
    const [x, y] = petWindow?.getPosition() ?? [0, 0]
    e.sender.send('pet:position', { x, y })
  })

  ipcMain.on('pet:dragging', (_e, dx: number, dy: number) => {
    if (!petWindow) return
    const [x, y] = petWindow.getPosition()
    petWindow.setPosition(Math.round(x + dx), Math.round(y + dy))
  })

  ipcMain.on('panel:open', showPanel)

  ipcMain.on('panel:close', () => panelWindow?.hide())

  // 桌宠启动时若主题为 custom，直接把已处理的图给它，
  // 避免渲染进程自己去猜路径（那里拿不到 userData 的绝对路径）
  petWindow?.webContents.on('did-finish-load', () => {
    void getSettings().then((s) => {
      if (s.petTheme !== 'custom') return
      const p = customArtPath()
      if (!existsSync(p)) return
      petWindow?.webContents.send('pet:custom-art', {
        url: pathToFileURL(p).href,
        height: 186
      })
    })
  })

  // —— 自定义形象 ——
  ipcMain.handle(
    'art:pick',
    async (): Promise<{ ok: boolean; error?: string; saved?: AppSettings }> => {
    try {
      const r = await dialog.showOpenDialog({
        title: '选择桌宠形象图片',
        properties: ['openFile'],
        filters: [
          { name: 'PNG 图片', extensions: ['png'] }
        ]
      })
      if (r.canceled || r.filePaths.length === 0) {
        return { ok: false, error: '已取消' }
      }
      const res = await processCustomArt(r.filePaths[0])
      if (!res.ok) {
        return { ok: false, error: res.error }
      }

      // 切到自定义主题并持久化
      const saved = await saveSettings({ petTheme: 'custom' as AppSettings['petTheme'] })
      petWindow?.webContents.send('pet:custom-art', {
        url: pathToFileURL(res.outPath).href,
        height: displayHeightFor(res.width, res.height)
      })
      return { ok: true, saved }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('art:clear', async (): Promise<boolean> => {
    await clearCustomArt()
    await saveSettings({ petTheme: 'spider' as AppSettings['petTheme'] })
    petWindow?.webContents.send('pet:custom-art', { url: '', height: 0 })
    return true
  })

  // —— 划词气泡 ——
  ipcMain.handle('bubble:deepExplain', async (_e, word: string) => deepExplain(word, ''))
  ipcMain.on('bubble:close', () => hideBubble())

  ipcMain.on('app:getEgress', (e) => {
    e.sender.send('egress:changed', currentEgress)
  })

  // 文件被拖入：主进程在生产环境才能拿到真实路径
  ipcMain.on('drop:files', (e, files: DroppedFile[]) => {
    petWindow?.webContents.send('drop:received', files)
    panelWindow?.webContents.send('drop:received', files)
    e.sender.send('drop:received', files)
  })
}

// ==== 快捷键 ====
function registerShortcuts(): void {
  const s = getSettings()
  void s.then((settings) => {
    if (settings.screenshotShortcut) {
      try {
        globalShortcut.register(settings.screenshotShortcut, () => {
          pushEgress('ocr', '本地截图（未上传）')
          petWindow?.webContents.send('shortcut:screenshot')
          panelWindow?.webContents.send('shortcut:screenshot')
        })
      } catch (e) {
        console.error('[shortcut] 注册失败', e)
      }
    }
  })
}

// ==== 窗口跟随事件转发给渲染进程 ====
function wireWin32(): void {
  win32 = createWin32Bridge()
  const e = (win32 as any).emitter

  e.on('foreground', (info: any) => {
    petWindow?.webContents.send('win:foreground', info)
  })
  e.on('window-destroyed', (hwnd: number) => {
    petWindow?.webContents.send('win:destroyed', hwnd)
  })
  e.on('unsupported', () => {
    petWindow?.webContents.send('win:unsupported')
  })

  // 划词：拿到选区就查本地词典，命中才弹气泡
  e.on('selection', (sel: { text: string; cx: number; cy: number }) => {
    void onSelection(sel.text, sel.cx, sel.cy)
  })

  win32.start()
}

// ==== 生命周期 ====
app.whenReady().then(async () => {
  // 回归测试模式只跑测试，不开任何窗口
  if (isRegressionMode) return

  initStore()
  await readAutoLaunch()

  registerIpc()

  petWindow = createPetWindow()
  panelWindow = createPanelWindow()
  createTray()
  wireWin32()
  registerShortcuts()

  // 性能预算自检：空闲降帧已在渲染进程实现，这里记录启动完成时刻供后续测量
  console.log(`[uninvited] 启动完成，${new Date().toISOString()}`)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) petWindow = createPetWindow()
  })
})

app.on('window-all-closed', () => {
  // 桌宠常驻：所有窗口关闭时不退出，留在托盘
  if (process.platform !== 'darwin') {
    // Windows 常驻设计——不退出
  }
})

app.on('before-quit', () => {
  isQuitting = true
  globalShortcut.unregisterAll()
  win32?.stop()
})

// 兜底：任何未捕获异常都不让桌宠静默消失
process.on('uncaughtException', (err) => {
  console.error('[uninvited] 未捕获异常', err)
})

// 首实例参数里带 --autostart 时不弹面板
if (process.argv.includes('--autostart')) {
  app.whenReady().then(() => {
    // 自启路径：只留桌宠与托盘
  })
}