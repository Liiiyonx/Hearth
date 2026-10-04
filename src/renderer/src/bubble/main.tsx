import React, { useEffect, useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import type { LookupResult, DeepExplainResult, EgressStatus } from '../../../shared/types'
import './bubble.css'

/**
 * 划词气泡。
 *
 * 交互原则（方案书「不打扰」）：
 *  - 本地词典命中 → 立即显示，不联网，无任何等待感
 *  - 未命中 → 不擅自联网，先问用户「要不要深度解释」
 *  - 鼠标移开或点别处 → 自动消失
 */

interface BubblePayload {
  word: string
  /** 命中的本地词条，未命中为 null */
  hit: LookupResult | null
}

function Bubble(): React.JSX.Element {
  const [data, setData] = useState<BubblePayload | null>(null)
  const [deep, setDeep] = useState<DeepExplainResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [egress, setEgress] = useState<EgressStatus | null>(null)

  useEffect(() => {
    const offData = window.hearth.onBubbleData((payload: BubblePayload) => {
      setData(payload)
      setDeep(null)
      setBusy(false)
    })
    const offEgress = window.hearth.onEgressChanged((s) => {
      setEgress(s.state === 'idle' ? null : s)
    })
    return () => {
      offData()
      offEgress()
    }
  }, [])

  const askDeep = useCallback(async () => {
    if (!data) return
    setBusy(true)
    try {
      setDeep(await window.hearth.bubbleDeepExplain(data.word))
    } catch (e) {
      setDeep({
        summary: '问不了云端',
        detail: e instanceof Error ? e.message : String(e),
        source: 'local-fallback'
      })
    }
    setBusy(false)
  }, [data])

  const close = useCallback(() => {
    window.hearth.closeBubble()
  }, [])

  const openPanel = useCallback(() => {
    window.hearth.openPanel()
    close()
  }, [close])

  if (!data) return <></>

  return (
    <div className="bubble">
      <div className="head">
        <span className="word">{data.word}</span>
        {data.hit?.phonetic && <em className="phonetic">{data.hit.phonetic}</em>}
        <button className="close" onClick={close} title="关闭">
          ×
        </button>
      </div>

      {data.hit ? (
        <>
          <ul className="meanings">
            {data.hit.meanings.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          {data.hit.examples.length > 0 && (
            <div className="examples">
              {data.hit.examples.slice(0, 2).map((ex, i) => (
                <p key={i}>{ex}</p>
              ))}
            </div>
          )}
          {data.hit.labels && data.hit.labels.length > 0 && (
            <div className="tags">
              {data.hit.labels.map((l) => (
                <span className="tag" key={l}>
                  {l}
                </span>
              ))}
            </div>
          )}
          <div className="foot">
            <span className="src">本地词典</span>
            <button className="link" onClick={openPanel}>
              在面板中打开
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="miss">本地词典没有收录这个词。</p>
          {!deep && (
            <div className="foot">
              <span className="src dim">可请求云端解释（会发送这个词）</span>
              <button className="link" disabled={busy} onClick={() => void askDeep()}>
                {busy ? '解释中…' : '深度解释'}
              </button>
            </div>
          )}
          {deep && (
            <div className="deep">
              <strong>{deep.summary}</strong>
              <p>{deep.detail}</p>
              <div className="foot">
                <span className="src">云端解释</span>
              </div>
            </div>
          )}
        </>
      )}

      {egress && <div className="egress">正在出网：{egress.detail}</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Bubble />)