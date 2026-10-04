import type { WindowInfo } from '../../../shared/types'

/**
 * 桌宠行为状态机。
 *
 * 方案书「窗口行为」一节列举的动作：
 *   坐在当前窗口顶边、窗口关闭时跳落到桌面、拖拽投掷、桌面遛弯、点击互动。
 *
 * 关键设计：所有移动都是**请求目标位置**，实际移动由渲染进程以帧率上限
 * 逐帧逼近，这样既能做出加速度与落地感，又能把空闲 CPU 压到预算内。
 */

export type PetState = 'idle' | 'perch' | 'falling' | 'walking' | 'dragging' | 'sleeping'

export interface PetPose {
  state: PetState
  /** 期望落点（屏幕绝对坐标，桌宠窗口左上角） */
  targetX: number
  targetY: number
  /** 目标朝向：1 向右，-1 向左 */
  facing: 1 | -1
}

const GRAVITY = 0.9
const WALK_SPEED = 2.2
const FALL_MAX = 14

export class BehaviorEngine {
  state: PetState = 'idle'
  x = 0
  y = 0
  vx = 0
  vy = 0
  facing: 1 | -1 = 1
  /** 当前趴着的窗口句柄 */
  private perchedOn: number | null = null
  private targetWindow: WindowInfo | null = null
  private lastInteraction = Date.now()
  private walkTimer = 0
  private screen: { width: number; height: number }
  private petSize = { w: 220, h: 260 }

  constructor(screenSize: { width: number; height: number }) {
    this.screen = screenSize
    this.x = screenSize.width - 300
    this.y = 80
  }

  setPetSize(w: number, h: number): void {
    this.petSize = { w, h }
  }

  /** 前台窗口变化 → 决定是否跳上去 */
  onForegroundWindow(win: WindowInfo | null): void {
    if (this.state === 'dragging' || this.state === 'sleeping') return
    this.targetWindow = win
    if (win && win.title) {
      this.perchedOn = win.handle
      this.state = 'falling'
      // 坐到窗口顶边右侧，略微缩进避免挡住标题栏按钮
      this.x = win.rect.x + win.rect.width - this.petSize.w - 24
      this.y = win.rect.y - this.petSize.h + 26 // 探出一截，像趴在边沿
      this.vx = 0
      this.vy = 0
    } else {
      this.perchedOn = null
    }
  }

  /** 被跟随的窗口消失了 → 跳下来 */
  onWindowDestroyed(hwnd: number): void {
    if (this.perchedOn !== hwnd) return
    this.perchedOn = null
    this.targetWindow = null
    this.state = 'falling'
    // 掉到桌面上
    this.vy = 2
    this.vx = (Math.random() - 0.5) * 3
  }

  /** 用户开始拖拽 */
  beginDrag(): void {
    this.state = 'dragging'
    this.vx = 0
    this.vy = 0
    this.lastInteraction = Date.now()
  }

  /** 拖拽中 */
  dragTo(x: number, y: number): void {
    this.x = x
    this.y = y
  }

  /** 松手 → 投掷（按速度决定落点） */
  endDrag(vx: number, vy: number): void {
    this.state = 'falling'
    this.vx = Math.max(-14, Math.min(14, vx))
    this.vy = Math.max(-14, Math.min(6, vy))
    this.lastInteraction = Date.now()
  }

  /** 点击互动 */
  poke(): void {
    this.lastInteraction = Date.now()
    this.vy = -6
    this.vx = (Math.random() - 0.5) * 5
    this.state = 'falling'
  }

  /** 空闲降帧：告诉渲染进程这次可以少画 */
  shouldRenderFast(): boolean {
    return (
      this.state === 'falling' ||
      this.state === 'dragging' ||
      this.state === 'walking' ||
      Date.now() - this.lastInteraction < 3000
    )
  }

  /**
   * 推进一帧物理。
   * @returns true 表示本帧位置发生变化，需要推送新坐标
   */
  tick(): boolean {
    const before = { x: this.x, y: this.y }

    switch (this.state) {
      case 'dragging':
        break // 拖拽中位置由指针直接驱动

      case 'falling': {
        this.vy = Math.min(FALL_MAX, this.vy + GRAVITY)
        this.x += this.vx
        this.y += this.vy

        // 落地判定：掉到桌面底部，或者落到目标窗口顶边
        const groundY = this.screen.height - this.petSize.h
        const perchY = this.targetWindow
          ? this.targetWindow.rect.y - this.petSize.h + 26
          : null

        if (perchY !== null && this.vy > 0 && this.y >= perchY && this.y <= perchY + 40) {
          this.y = perchY
          this.vy = 0
          this.vx = 0
          this.state = 'perch'
        } else if (this.y >= groundY) {
          this.y = groundY
          this.vy = 0
          this.vx = 0
          this.state = 'idle'
          // 落地后若目标窗口还在，继续趴回去
          if (this.targetWindow) {
            this.x = this.targetWindow.rect.x + this.targetWindow.rect.width - this.petSize.w - 24
            this.state = 'walking'
          }
        }

        // 撞到屏幕左右边缘
        const maxX = this.screen.width - this.petSize.w
        if (this.x < 0) {
          this.x = 0
          this.vx = Math.abs(this.vx) * 0.4
        } else if (this.x > maxX) {
          this.x = maxX
          this.vx = -Math.abs(this.vx) * 0.4
        }
        break
      }

      case 'walking': {
        const tw = this.targetWindow
        if (!tw) {
          this.state = 'idle'
          break
        }
        const targetX = tw.rect.x + tw.rect.width - this.petSize.w - 24
        const dx = targetX - this.x
        if (Math.abs(dx) < 3) {
          this.x = targetX
          this.state = 'perch'
        } else {
          this.x += Math.sign(dx) * WALK_SPEED
          this.facing = dx > 0 ? 1 : -1
        }
        break
      }

      case 'perch': {
        // 趴着不动，只跟随窗口；若窗口没了由 onWindowDestroyed 切走
        const tw = this.targetWindow
        if (!tw) {
          this.state = 'idle'
          break
        }
        const targetX = tw.rect.x + tw.rect.width - this.petSize.w - 24
        const targetY = tw.rect.y - this.petSize.h + 26
        // 窗口被拖动时，小人贴着走（限速，避免抖动）
        if (Math.abs(targetX - this.x) > 1) {
          this.x += Math.sign(targetX - this.x) * Math.min(4, Math.abs(targetX - this.x))
        }
        if (Math.abs(targetY - this.y) > 1) {
          this.y += Math.sign(targetY - this.y) * Math.min(4, Math.abs(targetY - this.y))
        }
        break
      }

      case 'sleeping':
        break

      case 'idle': {
        // 空闲久了就在桌面上遛弯——「你不理它，它也不打扰你」的反面：
        // 只在完全空闲时缓慢踱步，且步幅极小
        const idleFor = Date.now() - this.lastInteraction
        if (idleFor > 8000) {
          this.walkTimer++
          if (this.walkTimer > 90) {
            this.walkTimer = 0
            this.vx = (Math.random() - 0.5) * 1.2
          }
          if (Math.abs(this.vx) > 0.1) {
            this.x += this.vx
            this.facing = this.vx > 0 ? 1 : -1
            const maxX = this.screen.width - this.petSize.w
            if (this.x <= 0 || this.x >= maxX) this.vx *= -1
            this.x = Math.max(0, Math.min(maxX, this.x))
          }
        }
        break
      }
    }

    return before.x !== this.x || before.y !== this.y
  }

  /** 睡觉（专注模式） */
  sleep(): void {
    this.state = 'sleeping'
  }

  /** 叫醒 */
  wake(): void {
    this.state = 'idle'
    this.lastInteraction = Date.now()
  }

  get isAsleep(): boolean {
    return this.state === 'sleeping'
  }

  /** 供渲染进程查询当前是否有窗口在跟随 */
  get currentWindowTitle(): string | null {
    return this.targetWindow?.title ?? null
  }
}