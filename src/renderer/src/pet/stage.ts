import { Application, Container, Graphics, Sprite, Texture, Text } from 'pixi.js'
import { getTheme, THEMES, type ThemeId, type Palette } from './themes'

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
  /** 当前形象主题 */
  private themeId: ThemeId = 'hearth'
  /** 整张立绘（贴图模式）；null 表示用程序化几何 */
  private artSprite: Sprite | null = null
  /** 是否处于贴图模式 */
  private artMode = false
  /** 程序化几何部件，贴图模式下需隐藏 */
  private geoParts: Container[] = []
  /**
   * 主题变更代号。
   *
   * 立绘是异步加载的，快速切换主题时后发起的请求可能先返回，
   * 把过期的贴图挂上去。用代号保证只有「最后一次请求」能生效。
   */
  private themeGen = 0
  private palette: Palette = getTheme('hearth').palette
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
      // PixiJS 只认low-power / high-performance 两种。
      // 不能用 low-power：它会让部分驱动跳过呈现，窗口表现为全透明。
      // 空闲降帧由ticker.maxFPS 控制，与这个选项无关。
      powerPreference: 'high-performance'
    })
    this.app.stage.addChild(this.root)
    this.buildCharacter()
    // 初始主题若带立绘，这里加载一次（setTheme 对同 id 会提前返回）
    void this.maybeLoadArt(this.themeId)

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
    const theme = getTheme(this.themeId)
    const p = theme.palette
    this.bodyG = new Container()

    // —— 身体与头部由主题决定长什么样 ——
    const body = new Graphics()

    this.headG = new Container()
    const head = new Graphics()
    theme.draw({ body, head, p, theme: this.themeId })

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

    this.geoParts = [body, this.armL, this.armR, this.headG]
    this.bodyG.addChild(body, this.armL, this.armR, this.headG, this.zzz)
    this.root.addChild(this.bodyG)
    // root 是整只角色的定位原点（画布 220x260，角色略微偏右下）。
    // 注意：bodyG 是 root 的子节点，它自己的 y 基准是 0，不要再叠加 190，
    // 否则角色会被整体推出画布，表现为「窗口一片空白」。
    this.root.position.set(110, 168)

    this.drawEyes('open')
    this.drawMouth('smile')
  }

  /**
   * 切换桌宠形象。
   * 形象是「可自定义」的：换主题 = 换绘制器 + 换调色板，
   * 动画骨架、行为状态机、隐私逻辑全部复用。
   */
  /**
   * 设定自定义形象的立绘。
   * 由主进程在用户上传后 / 启动恢复时调用。
   */
  async setCustomArt(url: string, height: number): Promise<void> {
    const theme = THEMES.custom
    if (!theme) return
    theme.art = url ? { src: url, height } : undefined
    this.themeId = 'spider'
    this.setTheme('custom', true)
  }

  setTheme(id: ThemeId, force = false): void {
    if (id === this.themeId && !force) return
    this.themeId = id
    this.palette = getTheme(id).palette
    // 顺序要紧：destroyAndRebuild 会把 geoParts 换成新的一批 Graphics，
    // 若先处理立绘再去隐藏几何，拿到的是已被丢弃的旧数组。
    this.destroyAndRebuild()
    void this.maybeLoadArt(id)
  }

  get currentTheme(): ThemeId {
    return this.themeId
  }

  private destroyAndRebuild(): void {
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }))
    // 关键：立绘随bodyG 一起被销毁了，引用必须清空。
    // 否则 detachArt 会对一个已销毁对象判真而提前返回，
    // artMode 永远清不掉（表现为「切回几何主题仍是贴图」）。
    this.artSprite = null
    this.artMode = false
    this.buildCharacter()
  }

  /**
   * 预留接口：把生成的形象贴到头部槽位。
   * v0.2 的「照片生成形象」会走这里——Cloud 端生成立绘后，
   * 用立绘替换程序化头部，骨架与动画完全复用。
   */
  /** 该主题是否带立绘（贴图模式） */
  get usesArt(): boolean {
    return this.artMode
  }

  /**
   * 按主题决定用立绘还是程序化几何。
   * 切换主题时调用；立绘加载失败会自动退回几何形象，不会开天窗。
   */
  private async maybeLoadArt(id: ThemeId): Promise<void> {
    const gen = ++this.themeGen

    // 先同步拆掉上一套：applyArt 里的 img.decode() 是异步的，
    // 这期间旧贴图会一直挂在身上。
    this.detachArt()

    const art = THEMES[id]?.art
    if (!art) {
      this.geoParts.forEach((g) => (g.visible = true))
      this.artMode = false
      return
    }

    const sp = await this.loadArtSprite(art.src, art.height)
    // 加载期间又切了主题 → 丢弃这次结果，别把过期的贴图挂上去
    if (!sp || gen !== this.themeGen) {
      sp?.destroy(true)
      return
    }
    this.geoParts.forEach((g) => (g.visible = false))
    this.bodyG.addChild(sp)
    this.artSprite = sp
    this.artMode = true
  }

  /** 只做加载，不动显示状态——便于调用方决定何时挂载 */
  private async loadArtSprite(url: string, height: number): Promise<Sprite | null> {
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      const sp = new Sprite(Texture.from(img))
      sp.anchor.set(0.5, 1)
      sp.height = height
      sp.width = (height * img.width) / img.height
      sp.position.set(0, 88)
      return sp
    } catch (e) {
      console.warn('[pet] 立绘加载失败，退回程序化形象', e)
      return null
    }
  }

  /** 卸下立绘（不碰几何可见性，由调用方决定） */
  private detachArt(): void {
    if (!this.artSprite) return
    this.bodyG.removeChild(this.artSprite)
    this.artSprite.destroy(true)
    this.artSprite = null
    this.artMode = false
  }

  /** 卸下立绘并恢复程序化形象 */
  removeArt(): void {
    this.detachArt()
    this.geoParts.forEach((g) => (g.visible = true))
    this.artMode = false
  }

  /**
   * 用整张立绘替换程序化形象。
   *
   * 程序化 Graphics 画角色的天花板很低——只有圆、椭圆、贝塞尔，
   * 怎么调参数都做不出真正的角色美术。立绘模式才是桌宠该有的做法。
   * 动画骨架（呼吸缩放、朝向、姿态）仍然复用。
   */
  async applyArt(url: string, opts: { height: number }): Promise<boolean> {
    await this.maybeLoadArt(this.themeId)
    return this.artMode
  }

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

  /**
   * 眼睛绘制。不同主题差异很大——普通小团子是圆眼，
   * 而蒙面英雄是大号白色水滴眼（带深色描边），所以这里按主题分支。
   */
  private drawEyes(kind: 'open' | 'closed' | 'happy' | 'shock'): void {
    const p = this.palette
    const masked = this.themeId === 'spider'
    const ink = p.eye
    // 眼球底部的亮色：让圆眼不只是个黑豆子
    const lightenInk = (() => {
      let r = (ink >> 16) & 0xff
      let g = (ink >> 8) & 0xff
      let b = ink & 0xff
      r = Math.min(255, Math.round(r + (255 - r) * 0.45))
      g = Math.min(255, Math.round(g + (255 - g) * 0.45))
      b = Math.min(255, Math.round(b + (255 - b) * 0.45))
      return (r << 16) | (g << 8) | b
    })()

    const draw = (g: Graphics, side: number): void => {
      g.clear()
      // Q 版规范：眼睛大且位置偏低
      const cx = side * (masked ? 11.5 : 13)
      const cy = masked ? 5 : 2

      if (masked) {
        // 大号白色水滴眼：外深内亮，这是这类蒙面英雄角色的辨识特征
        switch (kind) {
          case 'open':
          case 'shock': {
            const r = kind === 'shock' ? 12.5 : 11.5
            g.moveTo(cx, cy - r)
            g.bezierCurveTo(cx + r * 0.95, cy - r * 0.2, cx + r * 0.8, cy + r * 0.9, cx, cy + r)
            g.bezierCurveTo(cx - r * 0.8, cy + r * 0.9, cx - r * 0.95, cy - r * 0.2, cx, cy - r)
            g.fill({ color: 0xf7faff })
            g.stroke({ color: ink, width: 1.6 })
            // 双高光：这是「有神」的关键，大瞳孔配一点亮立刻灵动
            g.circle(cx + r * 0.22, cy - r * 0.34, r * 0.26).fill({ color: 0xffffff })
            g.circle(cx - r * 0.3, cy + r * 0.28, r * 0.13).fill({ color: 0xffffff, alpha: 0.7 })
            break
          }
          case 'closed':
          case 'happy': {
            // 闭眼/笑眼：向下的弧线（蒙面时是标志性的「><」形笑眼）
            g.moveTo(cx - 8, cy - 2)
            g.quadraticCurveTo(cx, cy + (kind === 'happy' ? -6 : 5), cx + 8, cy - 2)
            g.stroke({ color: ink, width: 2.4 })
            break
          }
        }
        return
      }

      // 普通小团子：圆眼。Q 版规范里眼睛要占脸相当比例，
      // 所以比直觉画得大一些，并给渐变与双高光才显得有神。
      switch (kind) {
        case 'open': {
          const rx = 7.2
          const ry = 8.8
          g.ellipse(cx, cy, rx, ry).fill({ color: ink })
          // 虹膜底部略亮，模拟眼球受光
          g.ellipse(cx, cy + ry * 0.32, rx * 0.72, ry * 0.4).fill({
            color: lightenInk,
            alpha: 0.55
          })
          // 双高光
          g.circle(cx + rx * 0.32, cy - ry * 0.34, rx * 0.32).fill({ color: 0xffffff })
          g.circle(cx - rx * 0.3, cy + ry * 0.3, rx * 0.15).fill({
            color: 0xffffff,
            alpha: 0.7
          })
          break
        }
        case 'closed':
          g.moveTo(cx - 7, cy)
          g.quadraticCurveTo(cx, cy + 6, cx + 7, cy)
          g.stroke({ color: ink, width: 2.4 })
          break
        case 'happy':
          g.moveTo(cx - 7, cy + 2)
          g.quadraticCurveTo(cx, cy - 6, cx + 7, cy + 2)
          g.stroke({ color: ink, width: 2.6 })
          break
        case 'shock': {
          const r = 8.5
          g.circle(cx, cy, r).fill({ color: 0xffffff })
          g.circle(cx, cy, r * 0.95).stroke({ color: ink, width: 1.4 })
          g.circle(cx, cy, r * 0.55).fill({ color: ink })
          g.circle(cx + 2, cy - 2.4, r * 0.22).fill({ color: 0xffffff })
          break
        }
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

    // 缓存键带上主题：不同主题眼型不同，只比eye 会漏掉换主题后的重绘
    const eyeKey = `${this.themeId}:${eye}`
    if (eyeKey !== this.lastEye) {
      this.lastEye = eyeKey
      this.drawEyes(eye)
    }

    // 嘴型同理：只在变化时重绘
    const mouth: 'smile' | 'sleep' | 'open' =
      this.pose === 'sleeping'
        ? 'sleep'
        : this.pose === 'poked' || this.pose === 'falling'
          ? 'open'
          : 'smile'
    const mouthKey = `${this.themeId}:${mouth}`
    if (mouthKey !== this.lastMouth) {
      this.lastMouth = mouthKey
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

export { THEMES, THEME_LIST, getTheme } from './themes'