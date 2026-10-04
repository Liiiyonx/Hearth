import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { PetStage, type PetPose } from './stage'
import { BehaviorEngine } from './behavior'
import type { DroppedFile, EgressStatus, PetThemeId } from '../../../shared/types'
import './pet.css'

/**
 * 桌宠窗口主组件。
 *
 * 职责：把「行为状态机」与「渲染舞台」绑在一起，并把用户交互转成 IPC。
 * 性能纪律：只在坐标真的变化时才向主进程推 IPC，空闲帧不做跨进程调用。
 */

const PET_W = 220
const PET_H = 260

function PetApp(): React.JSX.Element {
  const stageRef = useRef<PetStage | null>(null)
  const behaviorRef = useRef<BehaviorEngine | null>(null)
  const lastSent = useRef<{ x: number; y: number }>({ x: -9999, y: -9999 })
  const dragCursor = useRef<{ px: number; py: number; lx: number; ly: number } | null>(null)

  const [egress, setEgress] = useState<EgressStatus>({ state: 'idle', detail: '无数据离开本机' })
  const [progress, setProgress] = useState<{ show: boolean; pct: number }>({ show: false, pct: 0 })

  // —— 文件转换：拖到小人身上即转（方案书 P0 交互）——
  const handleFiles = useCallback(async (files: DroppedFile[]) => {
    const behavior = behaviorRef.current
    for (const f of files) {
      const direction = await window.uninvited.inferDirection(f.path)
      if (!direction) continue
      setProgress({ show: true, pct: 40 })
      const result = await window.uninvited.convert(f.path, direction)
      setProgress({ show: true, pct: 100 })
      behavior?.poke()
      stageRef.current?.requestFastRender()
      window.uninvited.openPanel()
      setTimeout(() => setProgress({ show: false, pct: 0 }), 900)
      if (!result.ok) console.warn('[pet] 转换失败', result.error)
    }
  }, [])

  useEffect(() => {
    const canvas = document.getElementById('stage') as HTMLCanvasElement
    const behavior = new BehaviorEngine({
      width: window.screen.availWidth,
      height: window.screen.availHeight
    })
    behavior.setPetSize(PET_W, PET_H)
    behaviorRef.current = behavior

    const stage = new PetStage()
    stageRef.current = stage

    let disposed = false

    void (async () => {
      // 先读设置里的形象主题，实现「打开就用上次选的形象」
      let theme: PetThemeId = 'spider'
      try {
        const s = await window.uninvited.getSettings()
        theme = s.petTheme ?? 'spider'
      } catch {
        /* 设置读不到就用默认形象 */
      }

      try {
        await stage.init(canvas, 8)
        stage.setTheme(theme)
      } catch (e) {
        // 初始化失败要让冒烟测试看得见，否则表现为「一片空白」无从排查
        console.error('[pet] PixiJS 初始化失败', e)
        ;(window as unknown as Record<string, unknown>).__petError = String(e)
        return
      }
      if (disposed) return
      ;(window as unknown as Record<string, unknown>).__petReady = true
      ;(window as unknown as Record<string, unknown>).__stage = stage
      window.uninvited.setPetPosition(behavior.x, behavior.y)

      // 面板里换了形象 → 这里立即重建，无需重启
      window.uninvited.onThemeChanged((id) => {
        // 切到 custom 时先等主进程下发图片路径，否则会短暂显示几何占位
        stage.setTheme(id)
        stage.requestFastRender()
      })

      // 用户上传/启动恢复的自定义形象
      window.uninvited.onCustomArt(({ url, height }) => {
        void stage.setCustomArt(url, height).then(() => stage.requestFastRender())
      })

      const loop = (): void => {
        const moved = behavior.tick()
        stage.setPose(mapPose(behavior.state), behavior.facing)

        if (moved) {
          stage.requestFastRender()
          if (
            Math.abs(behavior.x - lastSent.current.x) >= 1 ||
            Math.abs(behavior.y - lastSent.current.y) >= 1
          ) {
            window.uninvited.setPetPosition(behavior.x, behavior.y)

            lastSent.current = { x: behavior.x, y: behavior.y }
          }
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })()

    const offFg = window.uninvited.onForegroundWindow((win) => {
      behavior.onForegroundWindow(win)
      stage.requestFastRender()
    })
    const offDestroyed = window.uninvited.onWindowDestroyed((hwnd) => {
      behavior.onWindowDestroyed(hwnd)
      stage.requestFastRender()
    })
    const offUnsupported = window.uninvited.onWin32Unsupported(() => {
      // 退化为固定在右下角，不跟随窗口
      behavior.state = 'idle'
    })
    const offEgress = window.uninvited.onEgressChanged(setEgress)
    const offShortcut = window.uninvited.onScreenshotShortcut(() => {
      behavior.poke()
    })
    const offDrop = window.uninvited.onDropReceived((files) => {
      void handleFiles(files)
    })

    void window.uninvited.getForeground().then((win) => {
      if (win) behavior.onForegroundWindow(win)
    })

    // —— 拖放 ——
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      setProgress({ show: true, pct: 8 })
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setProgress({ show: false, pct: 0 })
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      setProgress({ show: false, pct: 0 })
      const files = collectDroppedFiles(e)
      if (files.length > 0) await handleFiles(files)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)

    return () => {
      disposed = true
      offFg()
      offDestroyed()
      offUnsupported()
      offEgress()
      offShortcut()
      offDrop()
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      stage.destroy()
    }
  }, [handleFiles])

  // —— 指针：拖拽与投掷 ——
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const el = e.target as HTMLElement
    el.setPointerCapture?.(e.pointerId)
    const b = behaviorRef.current
    if (!b) return
    dragCursor.current = { px: e.screenX, py: e.screenY, lx: b.x, ly: b.y }
    b.beginDrag()
    document.body.classList.add('dragging')
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const c = dragCursor.current
    const b = behaviorRef.current
    if (!c || !b) return
    const dx = e.screenX - c.px
    const dy = e.screenY - c.py
    if (dx === 0 && dy === 0) return
    c.px = e.screenX
    c.py = e.screenY
    c.lx += dx
    c.ly += dy
    b.dragTo(c.lx, c.ly)
    window.uninvited.setPetPosition(c.lx, c.ly)
    lastSent.current = { x: c.lx, y: c.ly }
    stageRef.current?.requestFastRender()
  }, [])

  const handlePointerUp = useCallback(() => {
    document.body.classList.remove('dragging')
    dragCursor.current = null
    // 投掷：给一点随机初速度，让它有抛物线感
    behaviorRef.current?.endDrag((Math.random() - 0.5) * 4, -1)
    stageRef.current?.requestFastRender()
  }, [])

  return (
    <div
      style={{ width: '100%', height: '100%' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={() => window.uninvited.openPanel()}
    >
      {egress.state !== 'idle' && (
        <div className="pet-egress" title={`正在出网：${egress.detail}`}>
          <span className="dot" />
          {egress.detail}
        </div>
      )}
      <div id="progress" style={{ display: progress.show ? 'block' : 'none' }}>
        <i style={{ width: `${progress.pct}%` }} />
      </div>
    </div>
  )
}

function mapPose(state: string): PetPose {
  switch (state) {
    case 'perch':
      return 'perch'
    case 'falling':
      return 'falling'
    case 'walking':
      return 'walking'
    case 'dragging':
      return 'falling'
    case 'sleeping':
      return 'sleeping'
    default:
      return 'idle'
  }
}

/**
 * 从拖放事件取文件真实路径。
 * Electron 32+ 必须用 webUtils.getPathForFile，File.path 已被移除。
 */
function collectDroppedFiles(e: DragEvent): DroppedFile[] {
  const out: DroppedFile[] = []
  const items = e.dataTransfer?.items
  if (!items) return out
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    out.push({ path: window.uninvited.getPathForFile(file), name: file.name, size: file.size })
  }
  return out
}

// 挂到 pet.html 里预留的 #overlay 上：用绝对定位铺满，
// 不会把画布挤出视口（流式布局的 100% 高度叠加会让画面消失）。
const host = document.getElementById('overlay') ?? document.body
createRoot(host).render(<PetApp />)