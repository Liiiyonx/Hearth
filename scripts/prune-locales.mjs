/**
 * 裁剪已打包产物的 Electron 语言包。
 *
 * Electron 自带 55 个语言包约 41MB，本项目只面向中文用户。
 * 保留 zh-CN 与 en-US —— 后者是 Electron 内置兜底，删掉会让
 * 部分系统上的英文报错信息出现方块字。
 *
 * 之所以做成独立脚本而不是只放在 electron-builder 的 afterPack 里：
 * afterPack 只有在打包流程完整走完时才会执行，而部分受限环境
 * （非管理员会话无法创建符号链接）会让打包在更早的阶段就中断。
 * 这个脚本可以在打包后随时手动执行，也能校验已有产物。
 *
 * 用法：node scripts/prune-locales.mjs [产物目录]
 */
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const target = process.argv[2] || path.join(root, 'dist', 'win-unpacked')
const localesDir = path.join(target, 'locales')

const KEEP = new Set(['zh-CN.pak', 'en-US.pak'])

if (!existsSync(localesDir)) {
  console.error(`[locales] 找不到目录：${localesDir}`)
  console.error('[locales] 请先执行 npm run build 与 electron-builder --dir')
  process.exit(1)
}

const before = readdirSync(localesDir)
let freed = 0
let removed = 0

for (const name of before) {
  if (KEEP.has(name)) continue
  const p = path.join(localesDir, name)
  try {
    freed += statSync(p).size
    rmSync(p, { force: true })
    removed++
  } catch {
    // 删不掉就跳过，不影响其余
  }
}

const after = readdirSync(localesDir)
console.log(`[locales] ${before.length} → ${after.length} 个语言包`)
console.log(`[locales] 释放 ${(freed / 1048576).toFixed(1)} MB，保留：${after.join(', ')}`)

// 顺带报一下总体积，方便对照方案书 80MB 预算
let total = 0
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p)
    else total += st.size
  }
}
if (existsSync(target)) {
  walk(target)
  console.log(`[locales] 产物总体积：${(total / 1048576).toFixed(0)} MB`)
}
