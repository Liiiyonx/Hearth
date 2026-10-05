/**
 * 桌宠立绘素材预处理：去白底 → 裁到内容 → 缩到桌宠尺寸 → 存回 assets。
 *
 * 为什么需要：
 *  - AI 生成的图通常是白底（无alpha），而桌宠窗口要求透明背景，
 *    直接用会显示成一个白方块；
 *  - 1024px 的原图对 220x260 的桌宠窗口来说太大，
 *    徒增安装包体积与显存占用。
 *
 * 这是**构建期脚本**，pngjs 只在开发时用，不进产物。
 *
 * 用法：node scripts/prep-pet-art.mjs [输入.png]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const BATCH_ONLY = process.env.PET_ART_BATCH === '1'

/** 素材源目录与各主题的对应关系 */
const GEN_DIR ='C:/Users/Liii/WorkBuddy/2026-10-04-20-47-04/generated-images'

/** 批量模式：把生成好的立绘一次处理成各主题的资产 */
const BATCH = {
  hearth: '一只原创的Q版_chibi_吉祥物角色_全身正面站立_双手自_2026-10-04T18-39-21.png',
  dusk: '一只原创的Q版_chibi_吉祥物角色_全身正面站立_双手自_2026-10-04T18-39-41.png',
  ember: '一只原创的Q版_chibi_吉祥物角色_全身正面站立_双手自_2026-10-04T18-40-16.png'
}

/** 桌宠显示高度（像素）。取256 可兼顾清晰度与体积 */
const TARGET_H = 512

function processOne(name, input, outPath) {
  const png = PNG.sync.read(readFileSync(input))
  const { width, height, data } = png
  console.log(`读入：${width}x${height}`)

  // 先从四角采样推断背景基准色（AI 出图的白底常带偏色，不能假设纯白）
  const cornerIdx = [0, width - 1, (height - 1) * width, height * width - 1]
  const bgR = cornerIdx.reduce((a, i) => a + data[i * 4], 0) / 4
  const bgG = cornerIdx.reduce((a, i) => a + data[i * 4 + 1], 0) / 4
  const bgB = cornerIdx.reduce((a, i) => a + data[i * 4 + 2], 0) / 4
  console.log(
    `  背景基准色 (${bgR.toFixed(0)}, ${bgG.toFixed(0)}, ${bgB.toFixed(0)})`
  )

  // —— 1. 背景转透明：从四边向内漫水填充 ——
  //
  // 为什么不用「按亮度阈值」：AI 出图的白底往往带渐变或偏色，
  // 实测这批图的背景从 228到 253 都有，纯阈值方案会漏掉一部分，
  // 桌宠周围就会出现一圈半透明「鬼影」。
  //
  // 漫水填充从边界出发，只把**与边界连通**的像素判为背景——
  // 这样既能吃掉渐变的整片背景，又不会误伤角色内部的浅色区域
  // （比如角色的白色肚皮、高光）。
  const maxDiff = 26// 与邻居的最大色差，超过就认为是不同的区域
  const visited = new Uint8Array(width * height)
  const stack = []

  const isBgLike = (idx) => {
    const r = data[idx * 4]
    const g = data[idx * 4 + 1]
    const b = data[idx * 4 + 2]
    // 与四角基准色的距离在宽限内
    const d = Math.sqrt((r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2)
    return d <= maxDiff * 2
  }

  // 把四条边上的像素入队
  for (let x = 0; x < width; x++) {
    stack.push(x, x + (height - 1) * width)
  }
  for (let y = 0; y < height; y++) {
    stack.push(y * width, y * width + width - 1)
  }

  while (stack.length > 0) {
    const idx = stack.pop()
    if (idx < 0 || idx >= width * height) continue
    if (visited[idx]) continue
    if (!isBgLike(idx)) continue
    visited[idx] = 1
    const x = idx % width
    const y = (idx / width) | 0
    if (x > 0) stack.push(idx - 1)
    if (x < width - 1) stack.push(idx + 1)
    if (y > 0) stack.push(idx - width)
    if (y < height - 1) stack.push(idx + width)
  }

  // 连通背景 → 全透明；紧邻背景的边缘像素做半透明过渡消锯齿
  for (let i = 0; i < data.length; i += 4) {
    const pi = i / 4
    if (visited[pi]) {
      data[i + 3] = 0
    } else {
      // 看四邻是否有背景，有则渐变过渡
      const x = pi % width
      const y = (pi / width) | 0
      let nearBg = 0
      if (x > 0 && visited[pi - 1]) nearBg++
      if (x < width - 1 && visited[pi + 1]) nearBg++
      if (y > 0 && visited[pi - width]) nearBg++
      if (y < height - 1 && visited[pi + width]) nearBg++
      if (nearBg > 0) data[i + 3] = 150
    }
  }

  // —— 2. 找内容包围盒 ——
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    console.error('没有找到非透明内容，请检查输入图')
    process.exit(1)
  }
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  console.log(`内容包围盒：${cw}x${ch}（原图 ${width}x${height}）`)

  // —— 3. 等比缩放到目标高度 ——
  const scale = TARGET_H / ch
  const outW = Math.max(1, Math.round(cw * scale))
  const outH = Math.max(1, Math.round(ch * scale))

  const out = new PNG({ width: outW, height: outH })
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      // 源坐标（用中心采样避免边缘锯齿）
      const sx = minX + Math.min(cw - 1, Math.floor((x + 0.5) / scale))
      const sy = minY + Math.min(ch - 1, Math.floor((y + 0.5) / scale))
      const si = (sy * width + sx) * 4
      const di = (y * outW + x) * 4
      out.data[di] = data[si]
      out.data[di + 1] = data[si + 1]
      out.data[di + 2] = data[si + 2]
      out.data[di + 3] = data[si + 3]
    }
  }

  mkdirSync(path.dirname(outPath), { recursive: true })
  const buf = PNG.sync.write(out, { colorType: 6 })
  writeFileSync(outPath, buf)
  console.log(`  ${name.padEnd(8)} ${cw}x${ch} → ${outW}x${outH}，${(buf.length / 1024).toFixed(0)} KB`)
}

function main() {
  // 单张模式：node scripts/prep-pet-art.mjs <输入> [输出名]
  if (process.argv[2] && !BATCH_ONLY) {
    const input = process.argv[2]
    const outName = process.argv[3] || 'spider'
    processOne(
      outName,
      input,
      path.join(root, 'src/renderer/assets', `pet-${outName}.png`)
    )
    return
  }
  // 批量模式：把已生成好的立绘全部处理一遍
  console.log('批量处理：')
  for (const [name, file] of Object.entries(BATCH)) {
    const input = path.join(GEN_DIR, file)
    try {
      processOne(name, input, path.join(root, 'src/renderer/assets', `pet-${name}.png`))
    } catch (e) {
      console.log(`  ${name.padEnd(8)} 跳过：${e.message}`)
    }
  }
}

main()
