import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { PetStage, type PetPose } from './stage'
import { BehaviorEngine } from './behavior'
import type { DroppedFile, EgressStatus } from '../../../shared/types'
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
      const direction = await window.hearth.inferDirection(f.path)
      if (!direction) continue
      setProgress({ show: true, pct: 40 })
      const result = await window.hearth.convert(f.path, direction)
      setProgress({ show: true, pct: 100 })
      behavior?.poke()
      stageRef.current?.requestFastRender()
      window.hearth.openPanel()
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
      try {
        await stage.init(canvas, 8)
      } catch (e) {
        // 初始化失败要让冒烟测试看得见，否则表现为「一片空白」无从排查
        console.error('[pet] PixiJS 初始化失败', e)
        ;(window as unknown as Record<string, unknown>).__petError = String(e)
        return
      }
      if (disposed) return
      ;(window as unknown as Record<string, unknown>).__petReady = true
      ;(window as unknown as Record<string, unknown>).__stage = stage
      window.hearth.setPetPosition(behavior.x, behavior.y)

      const loop = (): void => {
        const moved = behavior.tick()
        stage.setPose(mapPose(behavior.state), behavior.facing)

        if (moved) {
          stage.requestFastRender()
          if (
            Math.abs(behavior.x - lastSent.current.x) >= 1 ||
            Math.abs(behavior.y - lastSent.current.y) >= 1
          ) {
            window.hearth.setPetPosition(behavior.x, behavior.y)
            lastSent.current = { x: behavior.x, y: behavior.y }
          }
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })()

    const offFg = window.hearth.onForegroundWindow((win) => {
      behavior.onForegroundWindow(win)
      stage.requestFastRender()
    })
    const offDestroyed = window.hearth.onWindowDestroyed((hwnd) => {
      behavior.onWindowDestroyed(hwnd)
      stage.requestFastRender()
    })
    const offUnsupported = window.hearth.onWin32Unsupported(() => {
      // 退化为固定在右下角，不跟随窗口
      behavior.state = 'idle'
    })
    const offEgress = window.hearth.onEgressChanged(setEgress)
    const offShortcut = window.hearth.onScreenshotShortcut(() => {
      behavior.poke()
    })
    const offDrop = window.hearth.onDropReceived((files) => {
      void handleFiles(files)
    })

    void window.hearth.getForeground().then((win) => {
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
    window.hearth.setPetPosition(c.lx, c.ly)
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
      onDoubleClick={() => window.hearth.openPanel()}
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
    out.push({ path: window.hearth.getPathForFile(file), name: file.name, size: file.size })
  }
  return out
}

// 挂到 pet.html 里预留的 #overlay 上：用绝对定位铺满，
// 不会把画布挤出视口（流式布局的 100% 高度叠加会让画面消失）。
const host = document.getElementById('overlay') ?? document.body
createRoot(host).render(<PetApp />)