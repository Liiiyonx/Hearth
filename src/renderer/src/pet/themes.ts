/**
 * 桌宠形象主题。
 *
 * 设计要点：**形象可自定义**，而不是把某个角色焊死在代码里。
 * 因此把「画什么」和「画成什么颜色」都抽成主题：
 *   - 调色板（颜色）
 *   - 绘制器（形状与细节，Graphics 层面的程序化绘制）
 * 将来若接入「照片生成形象」，只需新增一种主题类型即可复用整套动画骨架。
 *
 * 版权说明：内置的 `spider` 主题是**受蜘蛛侠启发**的原创卡通形象，
 * 采用红蓝配色、网纹肌理与胸口蜘蛛徽记等标志性元素的原创演绎，
 * 并非漫威官方形象。公开仓库分发时这样更稳妥。
 */

/** 主题标识 */
export type ThemeId = 'hearth' | 'spider' | 'dusk' | 'ember' | 'mint'

/** 调色板 */
export interface Palette {
  /** 主体色 */
  body: number
  /** 深色（描边、阴影、头发） */
  dark: number
  /** 浅色区域（肚皮、眼白） */
  belly: number
  /** 腮红 */
  blush: number
  /** 头发 / 头套 */
  hair: number
  /** 眼睛主色 */
  eye: number
}

/** 绘制上下文：把当前 Graphics 交给主题去画 */
export interface DrawCtx {
  /** 身体（不含头） */
  body: import('pixi.js').Graphics
  /** 头部 */
  head: import('pixi.js').Graphics
  p: Palette
  theme: ThemeId
}

export interface ThemeDef {
  id: ThemeId
  name: string
  /** 一句话描述，帮用户挑 */
  desc: string
  palette: Palette
  draw(ctx: DrawCtx): void
}

/** —— 绘制工具 —— */

/**
 * 胸口蜘蛛徽记。
 * 带一圈深色描边，否则浅色徽记压在红底上会糊掉。
 */
function spiderEmblemAt(
  g: import('pixi.js').Graphics,
  color: number,
  outline: number,
  ox: number,
  oy: number,
  k: number
): void {
  const X = (v: number): number => ox + v * k
  const Y = (v: number): number => oy + v * k
  const S = (v: number): number => v * k

  // 八条腿：先深色粗描边，再浅色细描边
  for (const dir of [-1, 1]) {
    g.moveTo(X(dir * 2.5), Y(-2))
    g.quadraticCurveTo(X(dir * 11), Y(-6), X(dir * 14), Y(-1))
    g.moveTo(X(dir * 2.5), Y(0))
    g.quadraticCurveTo(X(dir * 12), Y(1), X(dir * 15), Y(6))
    g.moveTo(X(dir * 2.5), Y(2))
    g.quadraticCurveTo(X(dir * 10), Y(6), X(dir * 11), Y(11))
    g.moveTo(X(dir * 2.5), Y(3))
    g.quadraticCurveTo(X(dir * 7), Y(9), X(dir * 6), Y(14))
  }
  g.stroke({ color: outline, width: S(1.5) + 1.4, alpha: 1 })
  g.stroke({ color, width: S(1.5), alpha: 1 })

  // 腹部与头
  g.ellipse(X(0), Y(1), S(4.2), S(5.6)).fill({ color: outline })
  g.ellipse(X(0), Y(1), S(3.2), S(4.6)).fill({ color })
  g.circle(X(0), Y(-6.4), S(2.8)).fill({ color: outline })
  g.circle(X(0), Y(-6.4), S(1.9)).fill({ color })
}

// ==== 各主题的绘制器 ====

/** 原始「围炉」小团子 */
function drawHearth({ body, head, p }: DrawCtx): void {
  body.ellipse(0, 42, 42, 46).fill({ color: p.body })
  body.ellipse(0, 52, 27, 31).fill({ color: p.belly })
  body.ellipse(0, 80, 36, 9).fill({ color: p.dark, alpha: 0.25 })

  head.circle(0, 0, 36).fill({ color: p.body })
  head.moveTo(-2, -34)
  head.quadraticCurveTo(6, -50, 15, -43)
  head.quadraticCurveTo(7, -38, 1, -36)
  head.fill({ color: p.dark })
  head.moveTo(-33, -10)
  head.quadraticCurveTo(-18, -30, 0, -31)
  head.quadraticCurveTo(18, -30, 33, -10)
  head.quadraticCurveTo(24, -22, 0, -22)
  head.quadraticCurveTo(-24, -22, -33, -10)
  head.fill({ color: p.hair, alpha: 0.9 })
}

/**
 * 卡通蜘蛛侠风格（原创演绎）。
 *
 * 造型依据（参考 Q 版角色画法通行的几条规范）：
 *  1. **头身比 1:2**——头占全身高度的一半，这是「一眼可爱」的关键；
 *  2. **省略颈部**，头直接坐在肩上；
 *  3. **眼睛又大又靠下**，占头部高度约三分之一，这是 Q 版的辨识特征；
 *  4. 躯干画成bean/ 团子形，重量集中在下半部，没有真实肌肉线条；
 *  5. 配色只用红 + 蓝两色，网格纹是识别符号。
 *
 * 另有一条实践提醒：**头套上的网纹不能画多、画乱**，否则整张脸糊掉。
 * 所以这里只在头部画三根分割线 + 两道弧，其余留白。
 */
function drawSpider({ body, head, p }: DrawCtx): void {
  // —— 身体：bean形，重量偏下——
  // 先画一圈深色底当描边：桌宠是透明窗口，浅色背景下没有描边会糊掉
  body.ellipse(0, 44, 42, 46).fill({ color: 0x141c30, alpha: 0.28 })
  body.ellipse(0, 44, 40, 44).fill({ color: p.body })
  // 下半身与腋下用深蓝——分界抬到腋下，这是这类英雄角色的标准画法
  body.ellipse(0, 60, 37, 30).fill({ color: p.dark })
  // 两侧收出腋下弧线，让红蓝交界不是一条平切
  body.moveTo(-40, 40)
  body.quadraticCurveTo(-30, 48, -22, 44)
  body.lineTo(-22, 58)
  body.lineTo(-40, 56)
  body.fill({ color: p.dark })
  body.moveTo(40, 40)
  body.quadraticCurveTo(30, 48, 22, 44)
  body.lineTo(22, 58)
  body.lineTo(40, 56)
  body.fill({ color: p.dark })
  // 头套延伸到肩上（省略颈部，让头直接压在身上）
  body.ellipse(0, 20, 38, 17).fill({ color: p.hair })

  // 披风：肩后一片深红，只露出肩线以上的一点
  body.moveTo(-30, 26)
  body.quadraticCurveTo(-44, 40, -38, 62)
  body.quadraticCurveTo(-30, 52, -22, 44)
  body.fill({ color: 0x8f1a16, alpha: 0.9 })
  body.moveTo(30, 26)
  body.quadraticCurveTo(44, 40, 38, 62)
  body.quadraticCurveTo(30, 52, 22, 44)
  body.fill({ color: 0x8f1a16, alpha: 0.9 })

  // 蛛网纹理：只刷蓝色下半身，红色胸腹保持干净
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    body.moveTo(0, 60)
    body.lineTo(Math.cos(a) * 44, 60 + Math.sin(a) * 30)
  }
  body.stroke({ color: p.belly, width: 0.7, alpha: 0.18 })

  // 胸口蜘蛛徽记：深色圆底衬托，位置在红色区内
  body.circle(0, 34, 13.5).fill({ color: 0x0a1a3a, alpha: 0.55 })
  body.circle(0, 34, 13.5).stroke({ color: p.belly, width: 1.2, alpha: 0.6 })
  spiderEmblemAt(body, p.belly, 0x0a1a3a, 0, 34, 1.12)

  // 底部阴影
  body.ellipse(0, 82, 34, 8).fill({ color: 0x000000, alpha: 0.2 })

  // —— 头：正圆，占全身约一半——
  head.circle(0, 0, 36).fill({ color: 0x141c30, alpha: 0.28 })
  head.circle(0, 0, 34).fill({ color: p.hair })

  // 头套网纹：仅三根分割线 + 两道弧，点到为止
  for (const a of [-0.85, 0, 0.85]) {
    head.moveTo(Math.sin(a) * 33, -Math.cos(a) * 33)
    head.lineTo(Math.sin(a) * 13, -Math.cos(a) * 13)
  }
  head.moveTo(-26, -22)
  head.arc(0, 0, 26, Math.PI * 1.18, Math.PI * 1.82)
  head.moveTo(-15, -29)
  head.arc(0, 0, 15, Math.PI * 1.2, Math.PI * 1.8)
  head.stroke({ color: 0x7a1210, width: 1.2, alpha: 0.5 })

  // 头顶两根天线
  head.moveTo(-7, -31)
  head.quadraticCurveTo(-14, -44, -5, -42)
  head.stroke({ color: p.dark, width: 1.7 })
  head.moveTo(7, -31)
  head.quadraticCurveTo(14, -44, 5, -42)
  head.stroke({ color: p.dark, width: 1.7 })
}

/** 夜色蓝 */
function drawDusk({ body, head, p }: DrawCtx): void {
  body.ellipse(0, 42, 42, 46).fill({ color: p.body })
  body.ellipse(0, 54, 25, 28).fill({ color: p.belly, alpha: 0.9 })
  body.ellipse(0, 80, 36, 9).fill({ color: p.dark, alpha: 0.25 })

  head.circle(0, 0, 36).fill({ color: p.body })
  head.moveTo(-34, -6)
  head.quadraticCurveTo(-20, -32, 0, -33)
  head.quadraticCurveTo(20, -32, 34, -6)
  head.quadraticCurveTo(18, -20, 0, -20)
  head.quadraticCurveTo(-18, -20, -34, -6)
  head.fill({ color: p.hair, alpha: 0.92 })
}

/** 暖橙 */
function drawEmber({ body, head, p }: DrawCtx): void {
  body.ellipse(0, 42, 42, 46).fill({ color: p.body })
  body.ellipse(0, 52, 28, 32).fill({ color: p.belly, alpha: 0.92 })
  body.ellipse(0, 80, 36, 9).fill({ color: p.dark, alpha: 0.25 })

  head.circle(0, 0, 36).fill({ color: p.body })
  head.moveTo(-33, -8)
  head.quadraticCurveTo(-16, -33, 2, -32)
  head.quadraticCurveTo(20, -31, 33, -8)
  head.quadraticCurveTo(22, -20, 0, -20)
  head.quadraticCurveTo(-22, -20, -33, -8)
  head.fill({ color: p.hair, alpha: 0.9 })
}

/** 薄荷绿 */
function drawMint({ body, head, p }: DrawCtx): void {
  body.ellipse(0, 42, 42, 46).fill({ color: p.body })
  body.ellipse(0, 52, 27, 31).fill({ color: p.belly, alpha: 0.88 })
  body.ellipse(0, 80, 36, 9).fill({ color: p.dark, alpha: 0.25 })

  head.circle(0, 0, 36).fill({ color: p.body })
  // 圆润刘海
  head.moveTo(-33, -9)
  head.quadraticCurveTo(-20, -31, 0, -32)
  head.quadraticCurveTo(20, -31, 33, -9)
  head.quadraticCurveTo(20, -22, 0, -22)
  head.quadraticCurveTo(-20, -22, -33, -9)
  head.fill({ color: p.hair, alpha: 0.9 })
  // 小发夹
  head.roundRect(14, -28, 10, 4, 2).fill({ color: p.blush, alpha: 0.9 })
}

// ==== 主题表 ====

export const THEMES: Record<ThemeId, ThemeDef> = {
  hearth: {
    id: 'hearth',
    name: '围炉',
    desc: '最初的青绿色小团子',
    palette: {
      body: 0x0e8f6e,
      dark: 0x0b7a5e,
      belly: 0xd4efe5,
      blush: 0xffb4b4,
      hair: 0x3d4a47,
      eye: 0x1f2a28
    },
    draw: drawHearth
  },
  spider: {
    id: 'spider',
    name: '蛛网',
    desc: '原创卡通蜘蛛侠风格：红蓝配色、蛛网纹理、胸口蜘蛛徽记',
    palette: {
      body: 0xd8352a, // 经典英雄红
      dark: 0x1b4fa8, // 深蓝分区
      belly: 0xf0f4ff, // 眼白与网纹
      blush: 0xff9a9a,
      hair: 0xc42a22, // 头套红
      eye: 0x16233f
    },
    draw: drawSpider
  },
  dusk: {
    id: 'dusk',
    name: '夜色',
    desc: '安静的深蓝',
    palette: {
      body: 0x228be6,
      dark: 0x1b6fb8,
      belly: 0xeaf2fb,
      blush: 0xffc4c4,
      hair: 0x2b3a47,
      eye: 0x16222e
    },
    draw: drawDusk
  },
  ember: {
    id: 'ember',
    name: '暖阳',
    desc: '暖色调，适合白天',
    palette: {
      body: 0xe8734a,
      dark: 0xc25a34,
      belly: 0xffe8d6,
      blush: 0xffc9b8,
      hair: 0x4a2f26,
      eye: 0x2a1a14
    },
    draw: drawEmber
  },
  mint: {
    id: 'mint',
    name: '薄荷',
    desc: '清爽的浅绿',
    palette: {
      body: 0x3ec9a7,
      dark: 0x2a9d82,
      belly: 0xdcf7ef,
      blush: 0xffb8c8,
      hair: 0x2f6b5c,
      eye: 0x1c3a34
    },
    draw: drawMint
  }
}

export const THEME_LIST: ThemeDef[] = Object.values(THEMES)

/** 容错：未知 id 回落到围炉 */
export function getTheme(id: string | undefined): ThemeDef {
  return (id && THEMES[id as ThemeId]) || THEMES.hearth
}