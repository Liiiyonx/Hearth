/**
 * 验证打包产物能否真正启动。
 *
 * 方案书把「跑不起来」列为最不可接受的情形，
 * 所以不仅要打出 exe，还要确认它起来后不崩。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const exe = path.join(root, 'dist', 'win-unpacked', 'Hearth.exe')

if (!existsSync(exe)) {
  console.error(`找不到 ${exe}`)
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(exe, ['--disable-gpu', '--in-process-gpu', '--no-sandbox'], {
  env,
  stdio: 'ignore',
  detached: false
})

let alive = false
setTimeout(() => {
  alive = true
  console.log('打包产物启动成功，5 秒内未崩溃')
  child.kill()
}, 5000)

child.on('exit', (code) => {
  if (!alive) {
    console.error(`打包产物启动后立即退出，退出码 ${code}`)
    process.exit(1)
  }
})

child.on('error', (e) => {
  console.error(`无法启动打包产物：${e.message}`)
  process.exit(1)
})
