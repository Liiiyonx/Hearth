/**
 * 在 Electron 主进程里跑转换回归测试。
 * 说明见run-app.mjs：需要清掉 ELECTRON_RUN_AS_NODE。
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
delete env.ELECTRON_RUN_AS_NODE

// 沙箱/无GPU 环境里Chromium 的 GPU 进程会反复崩溃，
// 用软件渲染规避；这不影响转换结果，只影响画布渲染方式。
const flags = ['--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--no-sandbox']

const child = spawn(electronPath, [root, '--regression', ...flags], {
  env,
  stdio: 'inherit',
  cwd: root
})

child.on('exit', (code) => process.exit(code ?? 0))