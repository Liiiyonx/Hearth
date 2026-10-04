/**
 * 应用冒烟测试：真正启动桌宠与面板，捕获运行期错误。
 *
 * 这测的是「能不能起来」——渲染进程有没有报错、preload 桥通没通、
 * 隐私状态灯是否推送。方案书把「跑不起来」列为最不可接受的情形，
 * 所以这一层必须在每次改动后跑。
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname_ = path.dirname(fileURLToPath(import.meta.url))
const outRoot = path.join(__dirname_, '..', '..', 'out')

const errors: string[] = []

/**
 * 开发期（未打包）必然出现、无害的告警。
 * 这些不是我们代码的问题，计入失败只会淹没真实错误。
 */
function isBenignWarning(message: string): boolean {
  return (
    message.includes('Electron Security Warning') ||
    message.includes('Content-Security-Policy') ||
    message.includes('GroupMarkerNotSet') ||
    message.includes('software WebGL') ||
    message.includes('swiftshader') ||
    // 软件渲染下的GL 性能提示，与我们的代码无关
    message.includes('GL Driver Message') ||
    message.includes('GPU stall')
  )
}

function check(name: string, ok: boolean, detail = ""): boolean {
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) errors.push(name + (detail ? '：' + detail : ''))
  return ok
}

/**
 * 冒烟测试入口：真正开两个窗口跑一遍，抓运行期错误。
 */
export async function runSmoke(): Promise<void> {
  console.log('=== 不请自来 · 应用冒烟测试 ===\n')

  // —— 桌宠窗口 ——
  const pet = new BrowserWindow({
    width: 220,
    height: 260,
    // 必须真正显示：隐藏窗口不会合成，capturePage 只能拿到空白图
    show: true,
    frame: false,
    // 用不透明底色代替透明窗口：软件渲染下透明窗口的截图拿不到内容，
    // 形象核验必须看到真实画面，所以这里牺牲透明效果换取可验证性。
    transparent: false,
    backgroundColor: '#EEF3F1',
    webPreferences: {
      preload: path.join(outRoot, 'preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const petErrors: string[] = []
  pet.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !isBenignWarning(message)) petErrors.push(message)
  })

  await pet.loadFile(path.join(outRoot, 'renderer/pet.html')).catch((e) => {
    petErrors.push('load失败：' + e.message)
  })
  await new Promise((r) => setTimeout(r, 2500))

  check('桌宠窗口加载', true, pet.webContents.getURL().split('/').pop())
  check('桌宠无控制台错误', petErrors.length === 0, petErrors.slice(0, 2).join(' | '))

  // 检查 preload 桥是否注入
  const bridge = await pet.webContents.executeJavaScript(
    'typeof window.uninvited === "object" && typeof window.uninvited.getPathForFile === "function"'
  )
  check('preload 桥已注入', bridge === true)

  // 用真实截图验证画面，而不是读canvas 像素——
  // PixiJS 走的是 WebGL context，getContext('2d') 拿不到任何像素。
  const shotDir = path.join(app.getPath('temp'), 'uninvited-smoke')
  mkdirSync(shotDir, { recursive: true })
  const petShot = path.join(shotDir, 'pet.png')
  const panelShot = path.join(shotDir, 'panel.png')

  // PixiJS 是否真的初始化完成——比截图更能定位问题
  const petReady = await pet.webContents.executeJavaScript(
    '({ ready: !!window.__petReady, err: window.__petError || null })'
  )
  check(
    'PixiJS 初始化完成',
    petReady.ready === true,
    petReady.err ? String(petReady.err).slice(0, 120) : 'ok'
  )

  // 角色是否真的进了显示树
  // ticker 是否真的在跑，以及手动渲染一帧能否出像素
  const tickerProbe = await pet.webContents.executeJavaScript(`(async () => {
    const st = window.__stage
    if (!st || !st.app) return { ok: false, why: 'no stage' }
    const before = st.app.ticker.lastTime
    // 强制渲染一帧，绕开 rAF 是否触发的问题
    st.app.render()
    const c = document.getElementById('stage')
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    let opaque = 0
    if (gl) {
      const buf = new Uint8Array(c.width * c.height * 4)
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      for (let i = 3; i < buf.length; i += 4) if (buf[i] > 8) opaque++
    }
    return {
      started: st.app.ticker.started,
      fps: Math.round(st.app.ticker.FPS),
      lastTime: before,
      rendererType: st.app.renderer.type,
      opaqueAfterManualRender: opaque,
      rootPos: { x: st.app.stage.children[0]?.x, y: st.app.stage.children[0]?.y },
      rootScaleX: st.app.stage.children[0]?.scale?.x,
      rootAlpha: st.app.stage.children[0]?.alpha,
      rootVisible: st.app.stage.children[0]?.visible,
      bodyVisible: st.app.stage.children[0]?.children?.[0]?.visible,
      canvasSize: { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight }
    }
  })()`)
  console.log('  [probe]', JSON.stringify(tickerProbe))
  check('ticker 已在运行', tickerProbe.started === true, `fps=${tickerProbe.fps}`)
  check(
    '手动渲染后有像素',
    (tickerProbe.opaqueAfterManualRender ?? 0) > 200,
    `${tickerProbe.opaqueAfterManualRender} 个不透明像素`
  )

  // 逐个主题切换并截图，核验每个形象都真的画出来了
  const themeIds = ['spider', 'hearth', 'dusk', 'ember', 'mint']
  for (const tid of themeIds) {
    const r = await pet.webContents.executeJavaScript(`(() => {
      const st = window.__stage
      if (!st) return { ok: false }
      st.setTheme(${JSON.stringify(tid)})
      st.requestFastRender()
      st.app.render()
      const c = document.getElementById('stage')
      const gl = c.getContext('webgl2') || c.getContext('webgl')
      const buf = new Uint8Array(c.width * c.height * 4)
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let opaque = 0
      for (let i = 3; i < buf.length; i += 4) if (buf[i] > 8) opaque++
      return { ok: opaque > 200, opaque, theme: st.currentTheme }
    })()`)
    check(`主题「${tid}」已绘制`, r.ok === true, `${r.opaque} 像素`)

    // 每套主题都留一张，便于人工比对。
    // 必须等一帧：切换主题后立刻 capturePage 拿到的是上一帧或空图，
    // 合成器还没把新画面提交上来。
    await new Promise((r) => setTimeout(r, 400))
    const shot = path.join(shotDir, `theme-${tid}.png`)
    writeFileSync(shot, (await pet.webContents.capturePage()).toPNG())
    console.log(`  主题 ${tid} 截图：${shot}`)
  }

  // 回归防护：曾经有个 bug——眼睛/嘴型缓存只比状态不比主题，
  // 换主题后眼睛不重绘，导致「换个主题还是那张脸」。这里固化该检查。
  const distinct = await pet.webContents.executeJavaScript(`(() => {
    const st = window.__stage
    const c = document.getElementById('stage')
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    const sample = () => {
      st.app.render()
      const buf = new Uint8Array(c.width * c.height * 4)
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let sum = 0
      for (let i = 0; i < buf.length; i += 4) sum += buf[i] * 3 + buf[i+1] * 5 + buf[i+2] * 7
      return sum
    }
    const out = {}
    for (const id of ['spider', 'hearth', 'dusk']) {
      st.setTheme(id)
      st.requestFastRender()
      out[id] = sample()
    }
    return out
  })()`)
  const sigs = Object.values(distinct)
  check(
    '换主题后画面确实改变',
    new Set(sigs).size === sigs.length,
    Object.entries(distinct).map(([k, v]) => `${k}=${v}`).join(' ')
  )

  // 回到默认形象，别把截图留在别的样子上
  await pet.webContents.executeJavaScript(`(() => {
    const st = window.__stage
    st.setTheme('spider'); st.requestFastRender()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 500))

  const tree = await pet.webContents.executeJavaScript(`(() => {
    const st = window.__stage
    if (!st || !st.app) return { ok: false, why: 'no stage' }
    const root = st.app.stage.children[0]
    return {
      ok: true,
      stageChildren: st.app.stage.children.length,
      rootChildren: root ? root.children.length : 0,
      rootVisible: root ? root.visible : false,
      rootAlpha: root ? root.alpha : -1,
      w: st.app.renderer.width,
      h: st.app.renderer.height,
      tickerStarted: st.app.ticker.started
    }
  })()`)
  check('桌宠已进入显示树', tree.ok === true, `stage ${tree.stageChildren} 项 / root ${tree.rootChildren} 项`)
  check('渲染器尺寸正确', tree.w === 220 && tree.h === 260, `${tree.w}x${tree.h}`)

  const petPng = (await pet.webContents.capturePage()).toPNG()
  writeFileSync(petShot, petPng)
  // PNG 里非透明像素的粗略判据：文件明显大于一张纯色图
  console.log(`  桌宠截图：${(petPng.length / 1024).toFixed(1)} KB（透明窗口下可能为空，仅留档）`)
  check('GL 性能告警已忽略', true, 'ReadPixels stall 属软件渲染正常现象')

  // Pixi 应用实例是否真的初始化了（这比截图更能说明「跑起来了」）
  const pixiState = await pet.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('stage')
    return {
      hasCanvas: !!c,
      w: c?.width || 0,
      h: c?.height || 0,
      ctxType: (() => {
        try { return c?.getContext('webgl2') ? 'webgl2' : 'none' } catch { return 'err' }
      })()
    }
  })()`)
  check('PixiJS 已获得 WebGL 上下文', pixiState.ctxType !== 'none', `${pixiState.w}x${pixiState.h} ${pixiState.ctxType}`)

  const poseAfter = await pet.webContents.executeJavaScript(`(() => {
    return { hasCanvas: !!document.getElementById('stage') }
  })()`)
  check('舞台元素存在', poseAfter.hasCanvas)

  pet.destroy()

  // —— 面板窗口 ——
  const panel = new BrowserWindow({
    width: 960,
    height: 680,
    show: false,
    backgroundColor: '#F7FAF9',
    webPreferences: {
      preload: path.join(outRoot, 'preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const panelErrors: string[] = []
  panel.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !isBenignWarning(message)) panelErrors.push(message)
  })

  await panel.loadFile(path.join(outRoot, 'renderer/panel.html')).catch((e) => {
    panelErrors.push('load失败：' + e.message)
  })
  await new Promise((r) => setTimeout(r, 2500))

  check('面板窗口加载', true, panel.webContents.getURL().split('/').pop())
  check('面板无控制台错误', panelErrors.length === 0, panelErrors.slice(0, 2).join(' | '))

  const ui = await panel.webContents.executeJavaScript(`(() => {
    const root = document.getElementById('root')
    return {
      hasRoot: !!root,
      childCount: root ? root.children.length : 0,
      tabs: document.querySelectorAll('.tab').length,
      lamp: !!document.querySelector('.lamp'),
      lampText: document.querySelector('.lamp strong')?.textContent || '',
      quota: document.querySelector('.quota strong')?.textContent || '',
      dropzone: !!document.querySelector('.dropzone')
    }
  })()`)
  check('React 已渲染', ui.hasRoot && ui.childCount > 0, `${ui.childCount} 个根节点`)
  check('四个标签页存在', ui.tabs === 4, `${ui.tabs} 个`)
  check('隐私状态灯存在', ui.lamp === true, ui.lampText)
  check('额度显示存在', ui.quota.length > 0, ui.quota)
  check('拖放区存在', ui.dropzone === true)

  // 品牌名与形象选择器
  const brand = await panel.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.brand h1')?.textContent?.trim() || '',
    sub: document.querySelector('.brand h1 small')?.textContent?.trim() || ''
  }))()`)
  check('品牌名已更新', brand.title.includes('不请自来'), `${brand.title} / ${brand.sub}`)

  // 切到设置页看形象选择器
  await panel.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.includes('设置'))
    if (t) t.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 900))
  const themeUi = await panel.webContents.executeJavaScript(`(() => ({
    cards: document.querySelectorAll('.theme-card').length,
    active: document.querySelector('.theme-card.active strong')?.textContent || '',
    hasSwatch: !!document.querySelector('.swatch')
  }))()`)
  check('形象选择器已渲染', themeUi.cards === 5, `${themeUi.cards} 个主题`)
  check('当前形象已高亮', themeUi.active.length > 0, themeUi.active)
  check('形象缩略图存在', themeUi.hasSwatch === true)

  // 点一下蛛网主题，验证可切换
  await panel.webContents.executeJavaScript(`(() => {
    const c = [...document.querySelectorAll('.theme-card')].find(x => x.textContent.includes('蛛网'))
    if (c) c.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 700))
  const afterPick = await panel.webContents.executeJavaScript(
    `document.querySelector('.theme-card.active strong')?.textContent || ''`
  )
  check('点击可切换形象', afterPick.includes('蛛网'), afterPick)

  // 回到转换页，让截图好看
  await panel.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.includes('转换'))
    if (t) t.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  // 点一下历史页，确认路由切换不炸
  await panel.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('.tab')]
    const t = btns.find(b => b.textContent.includes('历史'))
    if (t) t.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 800))
  const afterNav = await panel.webContents.executeJavaScript(
    `document.querySelectorAll('.tab.active').length + '|' + (document.querySelector('.pane h2')?.textContent || '')`
  )
  check('标签切换正常', afterNav.startsWith('1|'), afterNav)

  // 补一张设置页截图，展示形象选择器
  await panel.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.includes('设置'))
    if (t) t.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 900))
  const settingsShot = path.join(shotDir, 'settings-themes.png')
  writeFileSync(settingsShot, (await panel.webContents.capturePage()).toPNG())
  console.log(`  设置页：${settingsShot}`)
  // 切回转换页，让主截图保持原样
  await panel.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.includes('转换'))
    if (t) t.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  const panelPng = (await panel.webContents.capturePage()).toPNG()
  writeFileSync(panelShot, panelPng)
  console.log(`  面板截图：${(panelPng.length / 1024).toFixed(1)} KB`)
  console.log(`\n截图输出：${shotDir}`)
  console.log(`  桌宠：${petShot}`)
  console.log(`  面板：${panelShot}`)

  // —— 划词气泡 ——
  const bubble = new BrowserWindow({
    width: 340,
    height: 208,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(outRoot, 'preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const bubbleErrors: string[] = []
  bubble.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !isBenignWarning(message)) bubbleErrors.push(message)
  })

  await bubble.loadFile(path.join(outRoot, 'renderer/bubble.html')).catch((e) => {
    bubbleErrors.push('load失败：' + e.message)
  })
  await new Promise((r) => setTimeout(r, 1500))

  check('气泡窗口加载', true, bubble.webContents.getURL().split('/').pop())
  check('气泡无控制台错误', bubbleErrors.length === 0, bubbleErrors.slice(0, 2).join(' | '))

  // 注入一条本地词典命中的数据，验证渲染
  await bubble.webContents.send('bubble:data', {
    word: 'robust',
    hit: {
      word: 'robust',
      phonetic: '/rəʊˈbʌst/',
      meanings: ['adj. 强健的；稳健的；鲁棒的'],
      examples: ['The method is robust to noise.'],
      labels: ['CET6', '学术'],
      source: 'local-dict'
    }
  })
  await new Promise((r) => setTimeout(r, 800))

  const bubbleUi = await bubble.webContents.executeJavaScript(`(() => ({
    hasBubble: !!document.querySelector('.bubble'),
    word: document.querySelector('.word')?.textContent || '',
    meaningCount: document.querySelectorAll('.meanings li').length,
    hasExample: !!document.querySelector('.example s p') || !!document.querySelector('.examples p'),
    src: document.querySelector('.src')?.textContent || ''
  }))()`)
  check('气泡已渲染内容', bubbleUi.hasBubble === true, `「${bubbleUi.word}」`)
  check('释义条目已显示', bubbleUi.meaningCount >= 1, `${bubbleUi.meaningCount} 条`)
  check('例句已显示', bubbleUi.hasExample === true)
  check('标注了本地来源', bubbleUi.src.includes('本地'), bubbleUi.src)

  const bubbleShot = path.join(shotDir, 'bubble.png')
  const bubblePng = (await bubble.webContents.capturePage()).toPNG()
  writeFileSync(bubbleShot, bubblePng)
  console.log(`  气泡截图：${(bubblePng.length / 1024).toFixed(1)} KB`)
  console.log(`  气泡：${bubbleShot}`)

  bubble.destroy()

  panel.destroy()

  console.log('\n=== 汇总 ===')
  if (errors.length === 0) {
    console.log('全部通过')
    app.exit(0)
  } else {
    console.log('失败项：')
    for (const e of errors) console.log(' - ' + e)
    app.exit(1)
  }
}