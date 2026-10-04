import React, { useEffect, useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ConvertResult,
  HistoryEntry,
  AppSettings,
  EgressStatus,
  Persona,
  LookupResult
} from '../../../shared/types'
import { PERF_BUDGET, EGRESS_CATEGORIES } from '../../../shared/types'
import './panel.css'

/**
 * 控制面板 —— 转换是主角，这里是验收台。
 *
 * 方案书「保真清单逐项打勾」是 P0 的验收纪律，
 * 所以每次转换结果都完整展示保真项与降级说明，不做粉饰。
 */

type Tab = 'convert' | 'history' | 'assistant' | 'settings'

function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('convert')
  const [egress, setEgress] = useState<EgressStatus>({ state: 'idle', detail: '无数据离开本机' })
  const [quota, setQuota] = useState<{ used: number; limit: number }>({ used: 0, limit: 5 })

  useEffect(() => {
    const off = window.hearth.onEgressChanged(setEgress)
    void window.hearth.getQuota().then(setQuota)
    return off
  }, [])

  const refreshQuota = useCallback(async () => {
    setQuota(await window.hearth.getQuota())
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          <div>
            <h1>Hearth 围炉</h1>
            <p className="sub">文档与论文永远留在炉边，不出这台电脑</p>
          </div>
        </div>
        <PrivacyLamp egress={egress} />
        <div className={'quota' + (quota.used >= quota.limit ? ' exhausted' : '')}>
          <strong>
            今日 {quota.used}/{quota.limit}
          </strong>
          <em>{quota.used >= quota.limit ? '额度已用完' : '次转换'}</em>
        </div>
      </header>

      <nav className="tabs">
        {(
          [
            ['convert', '文档转换'],
            ['history', '转换历史'],
            ['assistant', '阅读助手'],
            ['settings', '设置']
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === 'convert' && <ConvertPane onQuotaUsed={refreshQuota} quota={quota} />}
        {tab === 'history' && <HistoryPane />}
        {tab === 'assistant' && <AssistantPane />}
        {tab === 'settings' && <SettingsPane egress={egress} />}
      </main>
    </div>
  )
}

/** 隐私状态灯——方案书原则二的核心呈现 */
function PrivacyLamp({ egress }: { egress: EgressStatus }): React.JSX.Element {
  const on = egress.state !== 'idle'
  return (
    <div className={'lamp ' + (on ? 'on' : 'off')}>
      <span className="bulb" />
      <div>
        <strong>{on ? '此刻有数据离开本机' : '此刻无数据离开本机'}</strong>
        <em>
          {on ? `${egress.detail}${egress.provider ? ` · ${egress.provider}` : ''}` : '文档与论文仅在本机处理'}
        </em>
      </div>
    </div>
  )
}

// ==== 转换面板 ====

function ConvertPane({
  onQuotaUsed,
  quota
}: {
  onQuotaUsed: () => void
  quota: { used: number; limit: number }
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConvertResult | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [progress, setProgress] = useState(0)

  const run = useCallback(
    async (direction: 'auto' | 'word2pdf' | 'pdf2word') => {
      if (files.length === 0) return
      setBusy(true)
      setResult(null)
      let last: ConvertResult | null = null
      for (let i = 0; i < files.length; i++) {
        setProgress(Math.round(((i + 0.3) / files.length) * 100))
        const file = files[i]
        const path = window.hearth.getPathForFile(file)
        const dir =
          direction === 'auto' ? undefined : direction
        const r = await window.hearth.convert(path, dir ?? (await window.hearth.inferDirection(path)) ?? 'word2pdf')
        last = r
      }
      setProgress(100)
      setResult(last)
      setBusy(false)
      onQuotaUsed()
      setTimeout(() => setProgress(0), 400)
    },
    [files, onQuotaUsed]
  )

  return (
    <div className="pane">
      <section
        className="dropzone"
        onDragOver={(e) => {
          e.preventDefault()
          e.currentTarget.classList.add('hot')
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('hot')}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('hot')
          setFiles(Array.from(e.dataTransfer.files))
        }}
        onClick={() => document.getElementById('fileInput')?.click()}
      >
        <input
          id="fileInput"
          type="file"
          multiple
          accept=".docx,.doc,.rtf,.odt,.pdf"
          style={{ display: 'none' }}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <div className="dz-icon" />
        <h2>把 Word 或 PDF 拖到这里</h2>
        <p>也可以把文件直接拖到桌宠身上——它会接住</p>
        {files.length > 0 && (
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.name}>
                {f.name}
                <em>{(f.size / 1024).toFixed(0)} KB</em>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="actions">
        <button className="btn primary" disabled={busy || files.length === 0} onClick={() => run('auto')}>
          自动识别方向并转换
        </button>
        <button className="btn" disabled={busy || files.length === 0} onClick={() => run('word2pdf')}>
          Word → PDF
        </button>
        <button className="btn" disabled={busy || files.length === 0} onClick={() => run('pdf2word')}>
          PDF → Word
        </button>
        {busy && <span className="busy-note">转换中… {progress}%</span>}
      </div>

      {result && <ResultCard result={result} />}
    </div>
  )
}

/** 转换结果卡：保真清单逐项打勾 */
function ResultCard({ result }: { result: ConvertResult }): React.JSX.Element {
  const laneLabel: Record<string, string> = {
    'com-native': 'Office / WPS 原生导出',
    'html-print': '内置链路（docx → HTML → 打印）',
    'pdfjs-rebuild': 'pdfjs 解析 + docx 重建',
    'ocr-rebuild': 'OCR + 文本重建',
    'manual-required': '需人工处理'
  }
  const statusIcon: Record<string, string> = {
    ok: '✓',
    partial: '◐',
    missing: '✗',
    'embedded-as-image': '▣'
  }
  const statusText: Record<string, string> = {
    ok: '保住',
    partial: '部分',
    missing: '未保住',
    'embedded-as-image': '以图嵌入'
  }

  return (
    <section className={'result ' + (result.ok ? 'ok' : 'fail')}>
      <div className="result-head">
        <h3>{result.ok ? '转换完成' : '转换失败'}</h3>
        <span className="lane">{laneLabel[result.lane] ?? result.lane}</span>
        <span className="time">{(result.durationMs / 1000).toFixed(2)}s</span>
      </div>

      {result.error && <p className="error">{result.error}</p>}

      {result.outputPath && (
        <p className="outpath" title={result.outputPath}>
          输出：{result.outputPath}
        </p>
      )}

      {result.fidelity.length > 0 && (
        <table className="fidelity">
          <thead>
            <tr>
              <th>保真项</th>
              <th>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {result.fidelity.map((f) => (
              <tr key={f.item}>
                <td className="fi">{f.item}</td>
                <td className={'fs ' + f.status}>
                  <span className="ico">{statusIcon[f.status]}</span>
                  {statusText[f.status]}
                </td>
                <td className="fn">{f.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result.degradedNotes.length > 0 && (
        <div className="honest">
          <strong>如实告知（这些地方没有完全保住）</strong>
          <ul>
            {result.degradedNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// ==== 历史 ====

function HistoryPane(): React.JSX.Element {
  const [items, setItems] = useState<HistoryEntry[]>([])
  useEffect(() => {
    void window.hearth.getHistory().then(setItems)
  }, [])

  return (
    <div className="pane">
      <div className="pane-head">
        <h2>转换历史</h2>
        <button
          className="btn small"
          onClick={async () => {
            await window.hearth.clearHistory()
            setItems([])
          }}
        >
          清空
        </button>
      </div>
      {items.length === 0 && <p className="empty">还没有转换记录。</p>}
      <ul className="history">
        {items.map((h) => (
          <li key={h.id} className={h.ok ? '' : 'bad'}>
            <div className="h-main">
              <strong>{h.inputName}</strong>
              <span className="h-dir">{h.direction === 'word2pdf' ? 'Word → PDF' : 'PDF → Word'}</span>
            </div>
            <div className="h-meta">
              <span>{new Date(h.createdAt).toLocaleString('zh-CN')}</span>
              <span>{(h.durationMs / 1000).toFixed(2)}s</span>
              <span className={h.ok ? 'tag ok' : 'tag bad'}>{h.ok ? '成功' : '失败'}</span>
            </div>
            {h.outputPath && <div className="h-out" title={h.outputPath}>{h.outputPath}</div>}
            {h.degradedNotes.length > 0 && (
              <ul className="h-notes">
                {h.degradedNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ==== 阅读助手 ====

function AssistantPane(): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [word, setWord] = useState('')
  const [lookup, setLookup] = useState<LookupResult | null>(null)
  const [llm, setLlm] = useState<{ ready: boolean; label: string; model: string } | null>(null)

  useEffect(() => {
    void window.hearth.llmStatus().then(setLlm)
  }, [])

  const doLookup = useCallback(async () => {
    const w = word.trim()
    if (!w) return
    setLookup(await window.hearth.lookup(w))
  }, [word])

  const ask = useCallback(async () => {
    const q = question.trim()
    if (!q) return
    setBusy(true)
    setAnswer('')
    try {
      setAnswer(await window.hearth.ask(q))
    } catch (e) {
      setAnswer(`问不了：${e instanceof Error ? e.message : String(e)}`)
    }
    setBusy(false)
  }, [question])

  return (
    <div className="pane two-col">
      <section>
        <h2>划词翻译</h2>
        <p className="tip">本地离线词典，命中即出，不经过网络。</p>
        <div className="row">
          <input
            className="input"
            placeholder="输入一个英文单词，如 robust"
            value={word}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doLookup()}
          />
          <button className="btn primary" onClick={() => void doLookup()}>
            查询
          </button>
        </div>
        {lookup && (
          <div className="dict-card">
            <div className="dict-head">
              <strong>{lookup.word}</strong>
              <em>{lookup.phonetic}</em>
              {lookup.labels?.map((l) => (
                <span className="tag" key={l}>
                  {l}
                </span>
              ))}
            </div>
            <ul className="meanings">
              {lookup.meanings.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
            {lookup.examples.length > 0 && (
              <div className="examples">
                {lookup.examples.map((ex, i) => (
                  <p key={i}>{ex}</p>
                ))}
              </div>
            )}
          </div>
        )}
        {lookup === null && word && <p className="empty">本地词典没收录这个词。</p>}
      </section>

      <section>
        <h2>气泡问答</h2>
        <p className="tip">
          {llm?.ready
            ? `已接入 ${llm.label}（${llm.model}）`
            : '尚未配置 API Key，可在设置页填入自有 Key'}
        </p>
        <textarea
          className="textarea"
          rows={4}
          placeholder="问点什么……例如：解释一下这段话的意思 / 把这段话改得更正式"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button className="btn primary" disabled={busy} onClick={() => void ask()}>
          {busy ? '思考中…' : '问小围'}
        </button>
        {answer && <div className="answer">{answer}</div>}
      </section>
    </div>
  )
}

// ==== 设置 ====

function SettingsPane({ egress }: { egress: EgressStatus }): React.JSX.Element {
  const [s, setS] = useState<AppSettings | null>(null)
  const [persona, setPersona] = useState<Persona | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.hearth.getSettings().then(setS)
    void window.hearth.getPersona().then(setPersona)
  }, [])

  if (!s || !persona) return <div className="pane">载入中…</div>

  const patch = async (p: Partial<AppSettings>): Promise<void> => {
    const next = await window.hearth.saveSettings(p)
    setS(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  return (
    <div className="pane">
      <section className="card">
        <h2>云端大脑</h2>
        <p className="tip">只发送对话与翻译的文本片段；文档与论文不出本机。</p>
        <label className="field">
          <span>供应商</span>
          <select
            value={s.provider}
            onChange={(e) => {
              const provider = e.target.value as AppSettings['provider']
              const presets: Record<string, { baseUrl: string; model: string }> = {
                deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
                qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
                doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro' },
                custom: { baseUrl: s.baseUrl, model: s.model }
              }
              void patch({ provider, ...presets[provider] })
            }}
          >
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">通义千问</option>
            <option value="doubao">豆包</option>
            <option value="custom">自定义（OpenAI 兼容）</option>
          </select>
        </label>
        <label className="field">
          <span>API Key</span>
          <input
            className="input"
            type="password"
            value={s.apiKey}
            placeholder="填入自有 Key，仅保存在本机"
            onChange={(e) => void patch({ apiKey: e.target.value })}
          />
        </label>
        <label className="field">
          <span>接口地址</span>
          <input className="input" value={s.baseUrl} onChange={(e) => void patch({ baseUrl: e.target.value })} />
        </label>
        <label className="field">
          <span>模型</span>
          <input className="input" value={s.model} onChange={(e) => void patch({ model: e.target.value })} />
        </label>
      </section>

      <section className="card">
        <h2>桌宠</h2>
        <label className="check">
          <input type="checkbox" checked={s.alwaysOnTop} onChange={(e) => void patch({ alwaysOnTop: e.target.checked })} />
          <span>始终置顶</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.enableSelectionLookup} onChange={(e) => void patch({ enableSelectionLookup: e.target.checked })} />
          <span>划词即译</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoLaunch} onChange={(e) => {
            void window.hearth.setAutoLaunch(e.target.checked)
            void patch({ autoLaunch: e.target.checked })
          }} />
          <span>开机自启（延迟 30 秒，不拖慢开机）</span>
        </label>
        <label className="field">
          <span>空闲降帧（fps）</span>
          <input
            className="input"
            type="number"
            min={1}
            max={30}
            value={s.idleFps}
            onChange={(e) => void patch({ idleFps: Number(e.target.value) })}
          />
        </label>
      </section>

      <section className="card">
        <h2>人设与记忆</h2>
        <label className="field">
          <span>名字</span>
          <input
            className="input"
            value={persona.name}
            onChange={(e) => setPersona({ ...persona, name: e.target.value })}
            onBlur={() => void window.hearth.savePersona(persona)}
          />
        </label>
        <label className="field">
          <span>人设</span>
          <textarea
            className="textarea"
            rows={3}
            value={persona.description}
            onChange={(e) => setPersona({ ...persona, description: e.target.value })}
            onBlur={() => void window.hearth.savePersona(persona)}
          />
        </label>
        <label className="field">
          <span>语气</span>
          <input
            className="input"
            value={persona.tone}
            onChange={(e) => setPersona({ ...persona, tone: e.target.value })}
            onBlur={() => void window.hearth.savePersona(persona)}
          />
        </label>
      </section>

      <section className="card">
        <h2>出网说明</h2>
        <p className="tip">只有以下三类内容会离开本机，默认明示。</p>
        <ul className="egress-list">
          {EGRESS_CATEGORIES.map((c) => (
            <li key={c.id}>
              <strong>{c.label}</strong>
              <em>{c.userTriggered ? '需你主动触发' : '对话/翻译时自动'}</em>
            </li>
          ))}
        </ul>
        <p className="tip">
          当前状态：{egress.state === 'idle' ? '无数据离开本机' : `${egress.detail}`}
        </p>
      </section>

      <section className="card">
        <h2>性能预算</h2>
        <p className="tip">超标即修——这些数字写进每版验收标准。</p>
        <ul className="budget">
          <li>常驻内存（空闲）≤ {PERF_BUDGET.idleMemoryMB}MB</li>
          <li>常驻 CPU（空闲）≤ {PERF_BUDGET.idleCpuPercent}%</li>
          <li>安装包 ≤ {PERF_BUDGET.installerMB}MB（不内置模型与 OCR 引擎）</li>
        </ul>
      </section>

      <section className="card">
        <h2>数据</h2>
        <div className="row">
          <button className="btn" onClick={async () => {
            const p = await window.hearth.exportData()
            alert(`已导出到：${p}`)
          }}>
            备份全部本地数据
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (confirm('确定清空全部本地数据？人设、记忆与历史都会删除，且不可恢复。')) {
                await window.hearth.wipeData()
                alert('已清空。')
              }
            }}
          >
            清空全部本地数据
          </button>
        </div>
      </section>

      {saved && <div className="toast">已保存</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)