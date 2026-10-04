import { Application, Container, Graphics, Sprite, Texture, Text } from 'pixi.js'

/**
 * 桌宠舞台 —— PixiJS 2D 精灵动画（方案书表 2 选型）。
 *
 * 关于形象：v0.1 不依赖任何二进制美术资源，角色由 Graphics 程序化绘制。
 * 这样做的三个理由：
 *   1. 仓库是纯代码，clone 下来就能跑，不需要 LFS 或额外素材包；
 *   2. **纹理槽位设计**——头部/身体是独立的 Sprite，将来「照片生成形象」
 *      只要把生成图替换进对应槽位即可复用整套动画骨架；
 *   3. 空闲时可以整体不重绘，性能预算（≤2% CPU）才守得住。
 */

export type PetPose = 'idle' | 'perch' | 'falling' | 'walking' | 'sleeping' | 'poked'

/** 一次交互后维持满帧的帧数——够看完一段动画即可 */
const FAST_FRAME_BUDGET = 36

/** 角色配色方案——相当于内置预设形象 */
const PALETTES = {
  hearth: { body: 0x0E8F6E, dark: 0x0B7A5E, belly: 0xD4EFE5, blush: 0xFFB4B4, hair: 0x3D4A47 },
  dusk: { body: 0x228BE6, dark: 0x1B6FB8, belly: 0xEAF2FB, blush: 0xFFC4C4, hair: 0x2B3A47 },
  ember: { body: 0xE8734A, dark: 0xC25A34, belly: 0xFFE8D6, blush: 0xFFC9B8, hair: 0x4A2F26 }
}

export class PetStage {
  app!: Application
  private root = new Container()
  private bodyG!: Container
  private headG!: Container
  private armL!: Graphics
  private armR!: Graphics
  private eyeL!: Graphics
  private eyeR!: Graphics
  private mouth!: Graphics
  private breathG!: Graphics
  private zzz!: Text
  private palette = PALETTES.hearth
  private t = 0
  private pose: PetPose = 'idle'
  private facing: 1 | -1 = 1
  /** 上一次绘制的眼睛状态；null 表示需要重绘 */
  private lastEye: string | null = null
  /** 上一次绘制的嘴型状态 */
  private lastMouth: string | null = null
  /** 上一次绘制的手臂摆位缓存键 */
  private lastArms: string | null = null
  /** 空闲帧率上限 */
  private idleFps = 8
  /** 剩余的「需要满帧」帧数 */
  private fastFrames = 0

  async init(canvas: HTMLCanvasElement, idleFps = 8): Promise<void> {
    this.idleFps = idleFps
    this.app = new Application()
    await this.app.init({
      canvas,
      width: 220,
      height: 260,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      // 不要用 low-power：它会让部分驱动跳过呈现，表现为窗口全透明。
      // 空闲降帧改用 ticker.maxFPS 控制，更可控。
      powerPreference: 'default'
    })
    this.app.stage.addChild(this.root)
    this.buildCharacter()

    // 空闲降帧：默认 maxFPS 即为空闲帧率；有交互时短暂拉满。
    this.app.ticker.maxFPS = this.idleFps
    this.app.ticker.add((ticker) => {
      if (this.fastFrames > 0) {
        this.fastFrames--
        this.app.ticker.maxFPS = 60
      } else {
        this.app.ticker.maxFPS = this.idleFps
      }
      this.animate(ticker.deltaTime)
    })
  }

  private buildCharacter(): void {
    const p = this.palette
    this.bodyG = new Container()

    // —— 身体：圆润的炉火小团子——
    const body = new Graphics()
    // 主体
    body.ellipse(0, 42, 42, 46).fill({ color: p.body })
    // 肚皮浅色区
    body.ellipse(0, 52, 27, 31).fill({ color: p.belly })
    // 底部阴影
    body.ellipse(0, 80, 36, 9).fill({ color: p.dark, alpha: 0.25 })

    // —— 头——
    this.headG = new Container()
    const head = new Graphics()
    head.circle(0, 0, 36).fill({ color: p.body })
    // 头顶呆毛
    head.moveTo(-2, -34)
    head.quadraticCurveTo(6, -50, 15, -43)
    head.quadraticCurveTo(7, -38, 1, -36)
    head.fill({ color: p.dark })
    // 刘海：沿头顶圆弧向内收的一段弧形，而不是切到圆心的扇形
    head.moveTo(-33, -10)
    head.quadraticCurveTo(-18, -30, 0, -31)
    head.quadraticCurveTo(18, -30, 33, -10)
    head.quadraticCurveTo(24, -22, 0, -22)
    head.quadraticCurveTo(-24, -22, -33, -10)
    head.fill({ color: p.hair, alpha: 0.9 })

    // 眼睛（闭眼时用椭圆表示）
    this.eyeL = new Graphics()
    this.eyeR = new Graphics()
    // 腮红
    const blush = new Graphics()
    blush.ellipse(-18, 9, 7, 4.5).fill({ color: p.blush, alpha: 0.55 })
    blush.ellipse(18, 9, 7, 4.5).fill({ color: p.blush, alpha: 0.55 })

    // 嘴
    this.mouth = new Graphics()

    this.headG.addChild(head, blush, this.eyeL, this.eyeR, this.mouth)
    this.headG.y = -26

    // —— 手臂——
    this.armL = new Graphics()
    this.armR = new Graphics()

    // 呼吸缩放用的替身容器
    this.breathG = new Graphics()
    this.breathG.rect(-2, -2, 4, 4).fill({ color: 0x000000, alpha: 0 })

    // 睡觉的 Z
    this.zzz = new Text({
      text: 'Z',
      style: { fontFamily: 'Arial', fontSize: 16, fill: 0x8FA8A1, fontWeight: 'bold' }
    })
    this.zzz.position.set(30, -62)
    this.zzz.visible = false

    this.bodyG.addChild(body, this.armL, this.armR, this.headG, this.zzz)
    this.root.addChild(this.bodyG)
    // root 是整只角色的定位原点（画布 220x260，角色略微偏右下）。
    // 注意：bodyG 是 root 的子节点，它自己的 y 基准是 0，不要再叠加 190，
    // 否则角色会被整体推出画布，表现为「窗口一片空白」。
    this.root.position.set(110, 168)

    this.drawEyes('open')
    this.drawMouth('smile')
  }

  /** 设置预设形象的配色 */
  setPalette(name: keyof typeof PALETTES): void {
    this.palette = PALETTES[name] ?? PALETTES.hearth
    this.destroyAndRebuild()
  }

  private destroyAndRebuild(): void {
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }))
    this.buildCharacter()
  }

  /**
   * 预留接口：把生成的形象贴到头部槽位。
   * v0.2 的「照片生成形象」会走这里——Cloud 端生成立绘后，
   * 用立绘替换程序化头部，骨架与动画完全复用。
   */
  async applyGeneratedFace(dataUrl: string): Promise<void> {
    try {
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const tex = Texture.from(img)
      const sprite = new Sprite(tex)
      sprite.anchor.set(0.5, 0.5)
      const size = 86
      sprite.width = size
      sprite.height = size
      sprite.position.set(0, 0)
      // 插到最底层，被表情覆盖
      this.headG.addChildAt(sprite, 0)
      // 隐藏程序化脸部的眼睛与腮红，保留嘴部动画
      this.eyeL.visible = false
      this.eyeR.visible = false
    } catch (e) {
      console.warn('[pet] 形象贴图应用失败', e)
    }
  }

  setPose(pose: PetPose, facing: 1 | -1 = 1): void {
    if (pose !== this.pose) {
      // 姿态切换时清掉上一个姿态残留的形变，避免拉伸/压扁跨姿态粘连
      this.bodyG.scale.set(1, 1)
      this.bodyG.rotation = 0
      this.headG.scale.set(1, 1)
      this.headG.rotation = 0
      this.bodyG.y = 0
      this.lastEye = null
    }
    this.pose = pose
    this.facing = facing
    this.zzz.visible = pose === 'sleeping'
  }

  private drawEyes(kind: 'open' | 'closed' | 'happy' | 'shock'): void {
    const draw = (g: Graphics, side: number): void => {
      g.clear()
      const cx = side * 13
      const cy = 2
      switch (kind) {
        case 'open':
          g.ellipse(cx, cy, 5.5, 7).fill({ color: 0x2B3A3F })
          g.circle(cx + 1.8, cy - 2.4, 1.8).fill({ color: 0xFFFFFF })
          break
        case 'closed':
          g.moveTo(cx - 6, cy)
          g.quadraticCurveTo(cx, cy + 5, cx + 6, cy)
          g.stroke({ color: 0x2B3A3F, width: 2.2 })
          break
        case 'happy':
          g.moveTo(cx - 6, cy + 2)
          g.quadraticCurveTo(cx, cy - 5, cx + 6, cy + 2)
          g.stroke({ color: 0x2B3A3F, width: 2.4 })
          break
        case 'shock':
          g.circle(cx, cy, 7).fill({ color: 0xFFFFFF })
          g.circle(cx, cy, 4).fill({ color: 0x2B3A3F })
          break
      }
    }
    draw(this.eyeL, -1)
    draw(this.eyeR, 1)
  }

  private drawMouth(kind: 'smile' | 'sleep' | 'open'): void {
    const g = this.mouth
    g.clear()
    switch (kind) {
      case 'smile':
        g.moveTo(-6, 16)
        g.quadraticCurveTo(0, 22, 6, 16)
        g.stroke({ color: 0x2B3A3F, width: 2 })
        break
      case 'sleep':
        g.ellipse(0, 18, 4, 3).fill({ color: 0x2B3A3F, alpha: 0.7 })
        break
      case 'open':
        g.ellipse(0, 18, 6, 5).fill({ color: 0x8A4A4A })
        break
    }
  }

  /** 逐帧动画 */
  private animate(delta: number): void {
    this.t += delta

    const p = this.palette
    const breathing = Math.sin(this.t * 0.05) * 0.02

    switch (this.pose) {
      case 'sleeping': {
        // 睡觉：缓慢起伏 + Z 飘动
        this.headG.scale.set(1 + breathing * 0.6, 1 - breathing * 0.4)
        this.zzz.y = -62 - ((this.t * 0.4) % 20)
        this.zzz.alpha = 1 - ((this.t * 0.4) % 20) / 24
        break
      }

      case 'falling': {
        // 下落：手臂上扬、身体拉伸
        const squash = Math.min(0.12, Math.abs(this.t * 0.2 % 2) * 0.06)
        this.bodyG.scale.set(1 + squash * 0.5, 1 + squash)
        this.headG.scale.set(1 - squash * 0.3, 1)
        this.drawArms(p, 'up')
        break
      }

      case 'walking': {
        // 走路：左右轻摆 + 腿部省略（小团子没有腿），用整体上下起伏表达
        const bob = Math.abs(Math.sin(this.t * 0.12)) * 4
        this.bodyG.y = -bob
        this.headG.rotation = Math.sin(this.t * 0.12) * 0.06
        this.drawArms(p, 'swing')
        break
      }

      case 'perch': {
        // 趴在窗边：身体前倾、偶尔眨眼
        this.bodyG.y = 0
        this.bodyG.rotation = this.facing * 0.05
        this.headG.rotation = this.facing * 0.08
        this.drawArms(p, 'rest')
        break
      }

      case 'poked': {
        // 被点击：弹跳 + 开心眼
        const bounce = Math.abs(Math.sin(this.t * 0.2)) * 10
        this.bodyG.y = -bounce
        this.drawArms(p, 'up')
        break
      }

      default: {
        // 待机：呼吸 + 轻微摇摆
        this.bodyG.scale.set(1 + breathing, 1 - breathing)
        this.bodyG.y = 0
        this.bodyG.rotation = 0
        this.headG.rotation = Math.sin(this.t * 0.02) * 0.03
        this.drawArms(p, 'rest')
      }
    }

    // 眨眼：统一在这里处理，且只在眼睛状态真的变化时重绘 Graphics。
    // 每帧重绘 Graphics 是空闲 CPU 的头号杀手，必须避免。
    const blinkWindow =
      this.pose === 'sleeping'
        ? false
        : (this.t % 230) < 8
    const eye: 'open' | 'closed' | 'happy' | 'shock' =
      this.pose === 'sleeping'
        ? 'closed'
        : this.pose === 'poked'
          ? 'happy'
          : this.pose === 'falling'
            ? 'shock'
            : blinkWindow
              ? 'closed'
              : 'open'

    if (eye !== this.lastEye) {
      this.lastEye = eye
      this.drawEyes(eye)
    }

    // 嘴型同理：只在变化时重绘
    const mouth: 'smile' | 'sleep' | 'open' =
      this.pose === 'sleeping'
        ? 'sleep'
        : this.pose === 'poked' || this.pose === 'falling'
          ? 'open'
          : 'smile'
    if (mouth !== this.lastMouth) {
      this.lastMouth = mouth
      this.drawMouth(mouth)
    }

    // 朝向翻转
    this.root.scale.x = this.facing
  }

  /**
   * 重绘手臂——按姿态给出不同摆位。
   * 与眼睛同理，只有摆位真正变化时才重绘 Graphics。
   */
  private drawArms(p: { body: number; dark: number }, mode: 'rest' | 'swing' | 'up'): void {
    const swing = mode === 'swing' ? Math.round(Math.sin(this.t * 0.12) * 6) : 0
    const key = mode + ':' + swing
    if (key === this.lastArms) return
    this.lastArms = key

    const cfg = {
      rest: { y: 38, dx: 0 },
      swing: { y: 38, dx: swing },
      up: { y: 24, dx: 0 }
    }[mode]

    this.armL.clear()
    this.armL.ellipse(cfg.dx - 40, cfg.y, 8, 13).fill({ color: p.body })
    this.armR.clear()
    this.armR.ellipse(cfg.dx + 40, cfg.y, 8, 13).fill({ color: p.body })
  }

  /**
   * 设置空闲帧率上限（方案书表 4：空闲降帧至 5-10fps）。
   * 桌宠绝大多数时间在发呆，这一步是 ≤2% CPU 预算的主要来源。
   */
  setIdleFps(fps: number): void {
    this.idleFps = Math.max(1, Math.min(30, fps))
  }

  /**
   * 标记「接下来需要精细渲染」。
   * 有交互或有形变时 ticker 跑满帧；空闲时自动降回 idleFps。
   */
  requestFastRender(): void {
    this.fastFrames = FAST_FRAME_BUDGET
  }

  get currentFps(): number {
    return this.app?.ticker.FPS ?? 0
  }

  destroy(): void {
    this.app?.destroy(true, { children: true })
  }
}

export { PALETTES }