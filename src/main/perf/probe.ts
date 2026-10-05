import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERF_BUDGET } from '../../shared/types'

/**
 * 性能预算实测。
 *
 * 方案书承诺「空闲 CPU ≤2%、常驻内存 ≤250MB」，此前只是写了常量，
 * 从未验证过是否真能守住——承诺没测过就等于没兑现。
 * 这个探针真实启动应用，按固定节奏采样，区分「空闲」与「交互」两种状态。
 *
 * 关键点：Electron 有多个进程（主/ 渲染 / GPU / 工具），
 * 只看主进程会严重低估，必须用 getAppMetrics 汇总全部进程。
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url))
const outRoot = path.join(__dirname_, '..', '..', 'out')

/** 一次采样 */
interface Sample {
  t: number
  cpuPercent: number
  memMB: number
  privateMB: number
  procs: number
}

/**
 * 达标判据用哪个内存指标。
 *
 * `workingSetSize`（驻留集）跨进程会重复计入共享页——Chromium 的 DLL、
 * 字体缓存被6 个进程共用，逐进程相加直接翻倍。所以 555MB 里有一半是重复的。
 * `privateBytes`（私有提交）才是应用独占的，用它判断「我占了多少」。
 */
function memForBudget(m: { memMB: number; privateMB: number }): number {
  return m.privateMB > 0 ? m.privateMB : m.memMB
}

/** 汇总所有进程的 CPU 与内存 */
function snapshot(): Omit<Sample, 't'> {
  const metrics = app.getAppMetrics()
  let cpu = 0
  let memKB = 0
  let privateKB = 0
  for (const m of metrics) {
    // type: 'Browser' 渲染进程 / 'Tab' GPU 等
    cpu += m.cpu.percentCPUUsage
    memKB += m.memory.workingSetSize
    privateKB += m.memory.privateBytes ?? 0
  }
  return {
    cpuPercent: cpu,
    memMB: memKB / 1024,
    privateMB: privateKB / 1024,
    procs: metrics.length
  }
}

/**
 * 在采样窗口内计算平均 CPU。
 *
 * Electron 的 percentCPUUsage 是「自上次调用以来的平均」，
 * 两次调用相减除以时间差即为该区间的真实占用。
 */
function sampler(intervalMs = 1000) {
  // 首次读数仅用于建立基线，不参与统计（Electron 的CPU 值是自上次调用以来的平均）
  snapshot()
  let lastT = Date.now()
  const out: Sample[] = []
  return {
    tick(): Sample | null {
      const now = Date.now()
      const dt = (now - lastT) / 1000
      if (dt < intervalMs / 1000) return null
      const cur = snapshot()
      // 两次读数之间的真实 CPU 占比
      const cpu = cur.cpuPercent
      const s: Sample = {
        t: now,
        cpuPercent: cpu,
        memMB: cur.memMB,
        privateMB: cur.privateMB,
        procs: cur.procs
      }
      out.push(s)
      lastT = now
      return s
    },
    all(): Sample[] {
      return out
    }
  }
}

function stats(xs: number[]) {
  if (xs.length === 0) return { avg: 0, max: 0, p95: 0 }
  const sorted = [...xs].sort((a, b) => a - b)
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    avg,
    max: sorted[sorted.length - 1],
    p95: sorted[Math.floor(sorted.length * 0.95)]
  }
}

function fmt(n: number, unit = ''): string {
  return `${n.toFixed(1)}${unit}`
}

/**
 * 跑一轮：warmup 秒用于让 JIT/缓存稳定（否则前几秒数字虚高），
 * 然后正式采样若干秒。
 */
async function measure(
  label: string,
  seconds: number,
  warmupSec: number,
  during?: () => void
): Promise<{ label: string; cpu: number[]; mem: number[]; priv: number[]; procs: number }> {
  for (let i = 0; i < warmupSec; i++) {
    during?.()
    await new Promise((r) => setTimeout(r, 1000))
  }
  const cpu: number[] = []
  const mem: number[] = []
  const priv: number[] = []
  let procs = 0
  const s = sampler(1000)
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < seconds) {
    during?.()
    const tick = s.tick()
    if (tick) {
      cpu.push(tick.cpuPercent)
      mem.push(tick.memMB)
      priv.push(tick.privateMB)
      procs = tick.procs
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return { label, cpu, mem, priv, procs }
}

/**
 * 判断当前是否在软件渲染下跑。
 *
 * 这件事至关重要：无 GPU 的环境（CI、虚拟机、本机的沙箱）会让
 * Chromium 回退到 SwiftShader 软件光栅化，PixiJS 每帧都在CPU 上
 * 逐像素绘制，CPU 开销比真实硬件高一个数量级。
 * 这种环境下的数字**不能用来判断是否达标**——必须明确告知使用者。
 */
function detectSoftwareRendering(): { software: boolean; reason: string } {
  // 1) 显式参数最容易判断
  const args = process.argv.join(' ').toLowerCase()
  if (
    args.includes('--disable-gpu') ||
    args.includes('--enable-unsafe-swiftshader')
  ) {
    return {
      software: true,
      reason: '启动参数强制关闭了 GPU（--disable-gpu / --enable-unsafe-swiftshader）'
    }
  }

  // 2) 查appmetrics 里的 GPU 进程类型。
  //    无显卡时 Chromium 会自己回退到 SwiftShader，此时没有 gpu 进程
  //    或进程名里带 swiftshader——只看启动参数会漏掉这种情况。
  try {
    const names = app
      .getAppMetrics()
      .map((m) => `${m.type}:${m.name}`.toLowerCase())
    const swiftshader = names.some((n) => n.includes('swiftshader'))
    const hasGpu = names.some((n) => n.includes('gpu'))
    if (swiftshader) {
      return { software: true, reason: '渲染进程使用 SwiftShader（无独立显卡或驱动不可用）' }
    }
    if (!hasGpu && names.length > 0) {
      return {
        software: true,
        reason: '未检测到独立 GPU 进程，很可能回退到软件渲染'
      }
    }
  } catch {
    /* 取不到就按硬件渲染算，不误报 */
  }

  return { software: false, reason: '' }
}

/** 机器是否有独显（粗略判断，仅用于报告） */
function gpuSummary(): string {
  try {
    // Electron 拿不到详细的 GPU 信息，用环境变量粗略提示
    const vendor = process.env.GPU_VENDOR || ''
    const renderer = process.env.GPU_RENDERER || ''
    if (vendor || renderer) return `${vendor} / ${renderer}`.trim()
  } catch {
    /* 忽略 */
  }
  return '（未暴露 GPU 信息）'
}


/**
 * 长时间浸泡测试。
 *
 * 快照只能回答「现在占用多少」，答不了「会不会随时间涨」。
 * 内存泄漏的典型特征是缓慢单调上升——跑一次快照完全看不出来，
 * 必须把时间序列画出来看趋势。
 *
 * 方案书要求「24 小时连续运行验证」，本模式就是为此准备的。
 */
async function runSoak(totalMinutes: number): Promise<void> {
  const intervalSec = 60
  const totalSamples = Math.floor((totalMinutes * 60) / intervalSec)

  console.log('=== 浸泡测试（检测内存泄漏）===')
  console.log(`计划：${totalMinutes} 分钟，每 ${intervalSec} 秒采样一次\n`)
  console.log('时间\tCPU 均%\tCPU 峰%\t内存 MB\t私有 MB\t进程\t趋势')

  const pet = new BrowserWindow({
    width: 220,
    height: 260,
    show: true,
    frame: false,
    transparent: false,
    backgroundColor: '#EEF3F1',
    webPreferences: {
      preload: path.join(outRoot, 'preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await pet.loadFile(path.join(outRoot, 'renderer/pet.html'))
  await new Promise((r) => setTimeout(r, 3000))

  const samples: { t: number; cpu: number; mem: number }[] = []
  const s = sampler(intervalSec * 1000)
  const t0 = Date.now()

  for (let i = 0; i < totalSamples; i++) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000))
    const tick = s.tick()
    if (!tick) continue
    samples.push({ t: (Date.now() - t0) / 60000, cpu: tick.cpuPercent, mem: tick.memMB })

    // 与首个样本比较，看是否有上升趋势
    const first = samples[0]
    const delta = tick.memMB - first.mem
    const trend = i < 1 ? '—' : delta > 20 ? `↑ +${delta.toFixed(0)}MB` : delta < -10 ? `↓ ${delta.toFixed(0)}MB` : '→ 稳定'
    console.log(
      `${((tick.t - t0) / 60000).toFixed(1)}min\t${tick.cpuPercent.toFixed(1)}\t` +
        `-\t${tick.memMB.toFixed(0)}\t${tick.privateMB.toFixed(0)}\t${tick.procs}\t${trend}`
    )
  }

  // 线性回归斜率：MB/分钟。
  //
  // 注意：**不能**只看整体斜率就判泄漏。前几分钟存在正常的预热增长
  // （JIT 编译、字体缓存、GC 堆扩张），会让斜率虚高。
  // 真正可靠的判据是「去掉前几个样本后的增长」——预热结束后应当趋平。
  const n = samples.length
  if (n >= 3) {
    const sumT = samples.reduce((a, b) => a + b.t, 0)
    const sumM = samples.reduce((a, b) => a + b.mem, 0)
    const sumTT = samples.reduce((a, b) => a + b.t * b.t, 0)
    const sumTM = samples.reduce((a, b) => a + b.t * b.mem, 0)
    const slope = (n * sumTM - sumT * sumM) / (n * sumTT - sumT * sumT)
    const first = samples[0].mem
    const last = samples[n - 1].mem
    console.log(`\n=== 浸泡结论 ===`)
    console.log(`样本 ${n} 个，历时 ${(samples[n - 1].t).toFixed(0)} 分钟`)
    console.log(`内存：${first.toFixed(0)} → ${last.toFixed(0)} MB（${(last - first >= 0 ? '+' : '')}${(last - first).toFixed(0)}）`)
    console.log(`回归斜率：${slope.toFixed(2)} MB/分钟`)

    // 去掉前 1/3 的预热段，只看稳定期的增长——这才是泄漏的真实速度
    const warmup = Math.max(1, Math.floor(n / 3))
    const steady = samples.slice(warmup)
    const ss = steady.length
    let steadySlope = 0
    if (ss >= 2) {
      const st = steady.reduce((a, b) => a + b.t, 0)
      const sm = steady.reduce((a, b) => a + b.mem, 0)
      const stt = steady.reduce((a, b) => a + b.t * b.t, 0)
      const stm = steady.reduce((a, b) => a + b.t * b.mem, 0)
      const den = ss * stt - st * st
      steadySlope = den === 0 ? 0 : (ss * stm - st * sm) / den
    }
    const perDay = steadySlope * 60 * 24
    console.log(
      `\n整体斜率 ${slope.toFixed(2)} MB/分钟（含预热，不可直接当泄漏）`
    )
    console.log(
      `稳定期斜率 ${steadySlope.toFixed(2)} MB/分钟（去掉前 ${warmup} 个预热样本）`
    )
    console.log(`按稳定期斜率，24 小时将变化 ${perDay >= 0 ? '+' : ''}${perDay.toFixed(0)} MB`)

    if (perDay > 500) {
      console.log('判定：**存在明显内存泄漏**，需修复')
    } else if (perDay > 100) {
      console.log('判定：有轻微增长，建议继续观察（可跑满 24 小时确认）')
    } else {
      console.log('判定：内存稳定，无明显泄漏')
    }
    if (n < 10) {
      console.log('提示：样本数偏少（建议 ≥ 30 个，即至少 30 分钟）才能据此下结论')
    }
  } else {
    console.log('\n样本不足，无法判断趋势（至少需要 3 个样本）')
  }
  app.exit(0)
}

export async function runPerfProbe(durationSec = 20): Promise<void> {
  console.log('=== 性能预算实测 ===\n')
  console.log(
    `预算：空闲 CPU ≤${PERF_BUDGET.idleCpuPercent}%，常驻内存 ≤${PERF_BUDGET.idleMemoryMB}MB\n`
  )

  if (process.argv.includes('--soak')) {
    // 浸泡模式：只看内存趋势
    const minutes = Number(process.env.SOAK_MINUTES || '30')
    await runSoak(minutes)
    return
  }

  const gpu = detectSoftwareRendering()
  console.log(`GPU：${gpuSummary()}`)
  if (gpu.software) {
    console.log(
      `\n⚠️警告：当前是**软件渲染**环境（${gpu.reason}）\n` +
        `  PixiJS 会走 CPU 逐像素光栅化，CPU 数字会远高于真实硬件。\n` +
        `  **本次结果不能用于判断是否达标**，请在有独立显卡的机器上重跑。\n`
    )
  } else {
    console.log('渲染：硬件加速（数据可用于判断是否达标）\n')
  }

  // 起一个窗口——桌宠常驻运行时窗口是存在的
  const pet = new BrowserWindow({
    width: 220,
    height: 260,
    show: true,
    frame: false,
    transparent: false,
    backgroundColor: '#EEF3F1',
    webPreferences: {
      preload: path.join(outRoot, 'preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await pet.loadFile(path.join(outRoot, 'renderer/pet.html'))
  await new Promise((r) => setTimeout(r, 2000))

  // 等待设置与主题就绪
  await pet.webContents.executeJavaScript('new Promise(r => setTimeout(r, 500))')

  const results = []

  // —— 1. 完全空闲：窗口静止，桌宠按 idleFps 降帧 ——
  console.log(`[1] 空闲状态（采样 ${durationSec} 秒，另有 4 秒预热）…`)
  results.push(await measure('空闲', durationSec, 4))

  // —— 2. 持续动画：把 maxFPS 拉满，看最坏情况 ——
  console.log(`[2] 满帧动画（采样 ${durationSec} 秒）…`)
  await pet.webContents.executeJavaScript(`(() => {
    const st = window.__stage
    if (st) st.app.ticker.maxFPS = 60
    return true
  })()`)
  results.push(
    await measure('满帧动画', durationSec, 2, () => {
      void pet.webContents.executeJavaScript(`(() => {
        const st = window.__stage
        if (st) { st.requestFastRender(); st.app.render() }
        return true
      })()`).catch(() => {})
    })
  )

  // —— 3. 快速姿态切换：考验重绘逻辑 ——
  console.log(`[3] 高频重绘（采样 ${durationSec} 秒）…`)
  const poses = ['idle', 'perch', 'walking', 'sleeping', 'poked', 'falling']
  let pi = 0
  results.push(
    await measure('高频重绘', durationSec, 1, () => {
      const p = poses[pi++ % poses.length]
      void pet.webContents
        .executeJavaScript(`(() => {
          const st = window.__stage
          if (st) { st.setPose(${JSON.stringify(p)}, 1); st.requestFastRender() }
          return true
        })()`)
        .catch(() => {})
    })
  )

  // —— 逐进程明细 ——
  // 直接把各进程的 workingSet 相加会**重复计入共享内存**
  // （Chromium 的 DLL、字体等被多个进程共用），所以总额虚高。
  // privateBytes 才是每个进程独占的，是判断「应用真实占用」更准的指标。
  //
  // 两个易错点：
  //  1. `workingSetSize` 与 `privateBytes` 的单位都是 **KB**，不是 MB；
  //  2. `privateBytes` 在部分平台上是 undefined，此时只能用 workingSet。
  //
  // 另外 workingSet 跨进程会重复计入共享页（Chromium 的 DLL、字体等
  // 被多个进程共用），所以逐进程相加会高估应用真实占用。
  console.log('\n=== 逐进程内存明细 ===')
  console.log(
    '进程类型'.padEnd(12) +
      'workingSet'.padStart(12) +
      'private'.padStart(12) +
      '  CPU%'
  )
  const metrics = app.getAppMetrics()
  for (const m of metrics) {
    const wsMB = m.memory.workingSetSize / 1024
    const pvMB = m.memory.privateBytes ? m.memory.privateBytes / 1024 : NaN
    console.log(
      `${m.type}`.padEnd(12) +
        `${wsMB.toFixed(0)}MB`.padStart(12) +
        `${Number.isNaN(pvMB) ? '—' : pvMB.toFixed(0) + 'MB'}`.padStart(12) +
        `${m.cpu.percentCPUUsage.toFixed(1)}`.padStart(6)
    )
  }
  const hasPrivate = metrics.every((m) => m.memory.privateBytes)
  const totalPrivate = metrics.reduce((a, m) => a + (m.memory.privateBytes ?? 0), 0) / 1024
  const totalWs = metrics.reduce((a, m) => a + m.memory.workingSetSize, 0) / 1024
  console.log(
    `\n合计 workingSet ${totalWs.toFixed(0)}MB` +
      (hasPrivate ? `，私有 ${totalPrivate.toFixed(0)}MB` : '（本平台无private 数据）')
  )
  console.log('注：workingSet 跨进程重复计入共享页，总额会高估真实占用')

  // —— 汇总 ——
  console.log('\n=== 结果 ===\n')
  const rows: string[] = []
  let failCount = 0

  for (const r of results) {
    const cpu = stats(r.cpu)
    const mem = stats(r.mem)
    const isIdle = r.label === '空闲'
    const cpuOk = !isIdle || cpu.avg <= PERF_BUDGET.idleCpuPercent
    // 达标判据用私有内存（见 memForBudget 的说明）
    const memPeak = stats(r.mem.map((_, i) => memForBudget({ memMB: r.mem[i], privateMB: r.priv[i] }))).max
    const memOk = memPeak <= PERF_BUDGET.idleMemoryMB
    if (!cpuOk || !memOk) failCount++

    rows.push(
      `${r.label.padEnd(10)} ` +
        `CPU 均 ${fmt(cpu.avg, '%').padStart(7)} 峰 ${fmt(cpu.max, '%').padStart(7)} p95 ${fmt(cpu.p95, '%').padStart(7)}  ` +
        `内存峰 ${fmt(memPeak, 'MB').padStart(8)}（私有口径）  驻留 ${fmt(mem.max, 'MB').padStart(8)}  ` +
        `${r.procs} 进程  ${cpuOk && memOk ? '[PASS]' : '[FAIL]'}`
    )
  }
  for (const line of rows) console.log('  ' + line)

  const idle = results[0]
  const idleCpu = stats(idle.cpu)
  const idleMemPeak = stats(
    idle.mem.map((_, i) => memForBudget({ memMB: idle.mem[i], privateMB: idle.priv[i] }))
  ).max
  const idleWsPeak = stats(idle.mem).max

  console.log('\n=== 对照方案书预算 ===')
  const cpuLine = idleCpu.avg <= PERF_BUDGET.idleCpuPercent
  const memLine = idleMemPeak <= PERF_BUDGET.idleMemoryMB
  console.log(
    `  空闲 CPU   ${fmt(idleCpu.avg, '%')} / ${PERF_BUDGET.idleCpuPercent}%   ${cpuLine ? '[PASS]' : '[FAIL]'}`
  )
  console.log(
    `  常驻内存   ${fmt(idleMemPeak, 'MB')} / ${PERF_BUDGET.idleMemoryMB}MB   ${memLine ? '[PASS]' : '[FAIL]'}` +
      `（私有口径；驻留集 ${fmt(idleWsPeak, 'MB')} 含共享页重复计入）`
  )

  if (failCount > 0) {
    console.log(`\n有 ${failCount} 项超出预算，需处理`)
    app.exit(1)
  } else {
    console.log('\n性能预算全部守住')
    app.exit(0)
  }
}
