/**
 * 启动应用做冒烟测试。
 * ELECTRON_RUN_AS_NODE 的原因见 run-app.mjs。
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

// --enable-unsafe-swiftshader：无 GPU 环境（虚拟机/沙箱）下用软件渲染跑 WebGL，
// 否则 PixiJS 拿不到 WebGL context，canvas 会是全透明的。
const flags = [
  '--smoke',
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--in-process-gpu',
  '--enable-unsafe-swiftshader',
  '--no-sandbox'
]

const child = spawn(electronPath, [root, ...flags], { env, stdio: 'inherit', cwd: root })
child.on('exit', (code) => process.exit(code ?? 0))