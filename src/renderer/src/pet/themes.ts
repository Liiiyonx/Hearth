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

/** 在身体上叠一层网格纹理（蜘蛛侠的蛛网肌理） */
function webTexture(g: import('pixi.js').Graphics, color: number, alpha = 0.22): void {
  const r = 44
  const cx = 0
  const cy = 42
  // 从中心向外的辐射线
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2
    g.moveTo(cx, cy)
    g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
  }
  g.stroke({ color, width: 0.7, alpha })
  // 同心环：间距拉开一点，避免糊成一片
  for (let ring = 9; ring <= r; ring += 9) {
    g.moveTo(cx + ring, cy)
    g.arc(cx, cy, ring, 0, Math.PI * 2)
  }
  g.stroke({ color, width: 0.7, alpha })
}

/** 在头上叠蛛网状分割线 */
function webMask(g: import('pixi.js').Graphics, color: number, alpha = 0.3): void {
  for (let i = -2; i <= 2; i++) {
    g.moveTo(i * 15, -34)
    g.lineTo(i * 4, -6)
  }
  for (let ring = 12; ring <= 34; ring += 11) {
    g.moveTo(-ring, -4)
    g.arc(0, -4, ring, Math.PI, Math.PI * 2)
  }
  g.stroke({ color, width: 0.8, alpha })
}

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
 * 造型要点：红蓝分区、蛛网纹理、胸口蜘蛛徽记、头套网纹分割线、
 * 大号白色水滴眼——都是这类英雄角色的通用视觉语言。
 */
function drawSpider({ body, head, p }: DrawCtx): void {
  // —— 身体：红蓝分区 ——
  body.ellipse(0, 42, 42, 46).fill({ color: p.body })
  // 下半身与侧腰用深蓝，形成经典红蓝拼色
  body.ellipse(0, 62, 38, 28).fill({ color: p.dark })
  // 头套延续到身体上缘
  body.ellipse(0, 20, 40, 18).fill({ color: p.hair })
  // 蛛网纹理（压到红蓝交界之下，不喧宾夺主）
  webTexture(body, p.belly, 0.17)
  // 胸口徽记：深色圆底衬托，保证小尺寸下也看得清
  body.circle(0, 36, 13).fill({ color: p.dark, alpha: 0.55 })
  body.circle(0, 36, 13).stroke({ color: p.belly, width: 1.2, alpha: 0.6 })
  // 徽记直接按放大的坐标画：在 Graphics 上做 scale/position 变换
  // 会连带影响此前已绘制的所有形状，得不偿失。
  spiderEmblemAt(body, p.belly, p.dark, 0, 36, 1.15)
  // 底部阴影
  body.ellipse(0, 80, 36, 9).fill({ color: 0x000000, alpha: 0.22 })

  // —— 头：全红头套 + 网纹 ——
  head.circle(0, 0, 36).fill({ color: p.hair })
  webMask(head, p.dark, 0.26)
  // 头顶两根天线
  head.moveTo(-6, -33)
  head.quadraticCurveTo(-12, -47, -4, -45)
  head.stroke({ color: p.dark, width: 1.6 })
  head.moveTo(6, -33)
  head.quadraticCurveTo(12, -47, 4, -45)
  head.stroke({ color: p.dark, width: 1.6 })
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