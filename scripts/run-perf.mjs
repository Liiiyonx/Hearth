/**
 * 启动应用跑性能测试。
 *
 * ⚠️ 关键：**不要**加 --disable-gpu / --enable-unsafe-swiftshader。
 * 那些参数会强制 Chromium 走CPU 软件光栅化，PixiJS 每帧逐像素绘制，
 * CPU 数字比真实硬件高一个数量级，测出来的结论毫无意义。
 * 无显卡时 Chromium 会自己回退到软件渲染，此时探针会明确警告。
 *
 * 用法：
 *   node scripts/run-perf.mjs                     # 快照测试（默认 20 秒/轮）
 *   PERF_SECONDS=60 node scripts/run-perf.mjs
 *   node scripts/run-perf.mjs --soak              # 浸泡测试（默认 30 分钟）
 *   SOAK_MINUTES=180 node scripts/run-perf.mjs --soak
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const electronPath = require('electron')
const env = { ...process.env }
// 本机设了 ELECTRON_RUN_AS_NODE=1，会让 electron 以纯 Node 模式启动
delete env.ELECTRON_RUN_AS_NODE

const soak = process.argv.includes('--soak')
// --no-sandbox 是本机沙箱环境所必需；GPU 相关参数一律不加，
// 否则会强制软件光栅化，测出来的CPU 数字不可信。
const flags = ['--perf', '--no-sandbox']
if (soak) flags.push('--soak')

console.log(soak ? '启动浸泡测试…' : '启动性能快照测试…')
console.log('（若本机无独立显卡，探针会提示数据不可用于判断达标）\n')

const child = spawn(electronPath, [root, ...flags], { env, stdio: 'inherit', cwd: root })
child.on('exit', (code) => process.exit(code ?? 0))
