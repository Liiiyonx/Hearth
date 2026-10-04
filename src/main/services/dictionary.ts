import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { LookupResult } from '../../shared/types'

/**
 * 离线英汉词典。
 *
 * 方案书要求「本地离线词典，零网络延迟」。v0.1 内置一份高频词条，
 * 同时支持导入 ECDICT 格式的 csv/stardict 以扩展到数十万词条——
 * 走渐进路线：先用内置词保证开箱可用，再让用户按需扩容。
 */

interface DictEntry {
  word: string
  phonetic: string
  meanings: string[]
  examples: string[]
  labels: string[]
}

/** 内置高频词条：覆盖读论文时最常卡住的学术与日常词 */
const BUILT_IN: DictEntry[] = [
  { word: 'ubiquitous', phonetic: '/juːˈbɪkwɪtəs/', meanings: ['adj. 无处不在的；普遍存在的'], examples: ['Ubiquitous computing has reshaped daily life.', '智能手机的普及使移动计算变得无处不在。'], labels: ['CET6', 'TOEFL', '常难词'] },
  { word: 'novel', phonetic: '/ˈnɒvl/', meanings: ['adj. 新颖的；新奇的', 'n. 小说'], examples: ['The paper proposes a novel approach.', '这篇论文提出了一种新颖的方法。'], labels: ['CET6'] },
  { word: 'robust', phonetic: '/rəʊˈbʌst/', meanings: ['adj. 强健的；稳健的；鲁棒的'], examples: ['The method is robust to noise.', '该方法对噪声具有鲁棒性。'], labels: ['CET6', 'TOEFL', '学术'] },
  { word: 'baseline', phonetic: '/ˈbeɪslaɪn/', meanings: ['n. 基线；基准', 'adj. 基本的；起始的'], examples: ['We establish a strong baseline.', '我们建立了一个有力的基线。'], labels: ['学术', '常难词'] },
  { word: 'heuristic', phonetic: '/hjuˈrɪstɪk/', meanings: ['adj. 启发式的', 'n. 启发式方法'], examples: ['A simple heuristic works well here.', '这里一个简单的启发式方法效果很好。'], labels: ['学术', '常难词'] },
  { word: 'empirical', phonetic: '/ɪmˈpɪrɪkl/', meanings: ['adj. 经验的；实证的'], examples: ['Empirical results confirm the theory.', '实证结果证实了该理论。'], labels: ['学术', '常难词'] },
  { word: 'inference', phonetic: '/ˈɪnfərəns/', meanings: ['n. 推论；推断；推理'], examples: ['The model performs inference in real time.', '该模型可进行实时推理。'], labels: ['学术', '常难词'] },
  { word: 'convergence', phonetic: '/kənˈvɜːdʒəns/', meanings: ['n. 收敛；集中；会合'], examples: ['Training convergence was reached at epoch 50.', '训练在第50 轮达到收敛。'], labels: ['学术', '常难词'] },
  { word: 'gradient', phonetic: '/ˈɡrædiənt/', meanings: ['n. 梯度；陡度', 'adj. 梯度的'], examples: ['The gradient vanishes near the optimum.', '最优点附近梯度消失。'], labels: ['学术'] },
  { word: 'inference-time', phonetic: '/ˈɪnfərəns-taɪm/', meanings: ['n. 推理时；推理阶段'], examples: ['Inference-time cost is under 10ms.', '推理时开销低于10 毫秒。'], labels: ['学术'] },
  { word: 'annotate', phonetic: '/ˈænəteɪt/', meanings: ['v. 注释；标注'], examples: ['Annotate the batch with batch_size=16.', '用 batch_size=16 标注该批次。'], labels: ['学术'] },
  { word: 'benchmark', phonetic: '/ˈbentʃmɑːk/', meanings: ['n. 基准；基准测试', 'v. 对…进行基准测试'], examples: ['We benchmark against three baselines.', '我们与三个基线做了基准对比。'], labels: ['学术'] },
  { word: 'throughput', phonetic: '/ˈθruːpʊt/', meanings: ['n. 吞吐量；产出率'], examples: ['Throughput improved by 2.4x.', '吞吐量提升了 2.4 倍。'], labels: ['学术'] },
  { word: 'latency', phonetic: '/ˈleɪtənsi/', meanings: ['n. 延迟；潜伏期'], examples: ['Latency stays under 50ms.', '延迟保持在 50 毫秒以内。'], labels: ['学术'] },
  { word: 'framework', phonetic: '/ˈfreɪmwɜːk/', meanings: ['n. 框架；体系结构'], examples: ['We adopt an existing framework.', '我们采用了一个已有框架。'], labels: ['CET6'] },
  { word: 'modality', phonetic: '/məʊˈdæləti/', meanings: ['n. 模态；方式'], examples: ['Multimodal modality fusion improves results.', '多模态模态融合提升了效果。'], labels: ['学术'] },
  { word: 'deteriorate', phonetic: '/dɪˈtɪəriəreɪt/', meanings: ['v. 恶化；变坏'], examples: ['Accuracy deteriorates without regularization.', '没有正则化时准确率会恶化。'], labels: ['CET6', '常难词'] },
  { word: 'substantial', phonetic: '/səbˈstænʃl/', meanings: ['adj. 大量的；实质的'], examples: ['A substantial gain is observed.', '观察到显著提升。'], labels: ['CET6'] },
  { word: 'preliminary', phonetic: '/prɪˈlɪmɪnəri/', meanings: ['adj. 初步的；预备的'], examples: ['These are preliminary results.', '这些是初步结果。'], labels: ['CET6', '学术'] },
  { word: 'comprehensive', phonetic: '/ˌkɒmprɪˈhensɪv/', meanings: ['adj. 全面的；综合的'], examples: ['A comprehensive survey of the field.', '对该领域的全面综述。'], labels: ['CET6', '常难词'] },
  { word: 'inevitable', phonetic: '/ɪnˈevɪtəbl/', meanings: ['adj. 不可避免的'], examples: ['Some bias is inevitable.', '某些偏差是不可避免的。'], labels: ['CET6'] },
  { word: 'accumulate', phonetic: '/əˈkjuːmjəleɪt/', meanings: ['v. 积累；累积'], examples: ['Gradients accumulate over batches.', '梯度在批次间累积。'], labels: ['CET6'] },
  { word: 'mitigate', phonetic: '/ˈmɪtɪɡeɪt/', meanings: ['v. 缓解；减轻'], examples: ['We mitigate overfitting by dropout.', '我们用 dropout 缓解过拟合。'], labels: ['常难词', '学术'] },
  { word: 'asymmetry', phonetic: '/ˌeɪsɪˈmɪtrɪ/', meanings: ['n. 不对称；不对称性'], examples: ['Class asymmetry hurts minority recall.', '类别不对称损害了少数类的召回。'], labels: ['学术'] },
  { word: 'interpretability', phonetic: '/ɪnˌtɜːprɪtəˈbɪləti/', meanings: ['n. 可解释性'], examples: ['Interpretability matters in medical AI.', '可解释性在医疗 AI 中很重要。'], labels: ['学术'] },
  { word: 'fidelity', phonetic: '/fɪˈdeləti/', meanings: ['n. 保真度；忠实度'], examples: ['Fidelity of the conversion is the priority.', '转换保真度是首要事项。'], labels: ['常难词'] },
  { word: 'concise', phonetic: '/kənˈsaɪs/', meanings: ['adj. 简洁的；简明的'], examples: ['Keep the answer concise.', '回答要简洁。'], labels: ['CET6', '常难词'] },
  { word: 'crucial', phonetic: '/ˈkruːʃl/', meanings: ['adj. 至关重要的'], examples: ['This step is crucial for fidelity.', '这一步对保真度至关重要。'], labels: ['CET6', '常难词'] },
  { word: 'straightforward', phonetic: '/ˌstreɪtˈfɔːwəd/', meanings: ['adj. 直接的；简明的；易懂的'], examples: ['The fix is straightforward.', '这个修复很直接。'], labels: ['CET6'] },
  { word: 'plausible', phonetic: '/ˈplɔːzəbl/', meanings: ['adj. 貌似合理的'], examples: ['A plausible explanation for the gap.', '对该差距的一个合理解释。'], labels: ['CET6', '常难词'] },
  { word: 'inherent', phonetic: '/ɪnˈhɪərənt/', meanings: ['adj. 固有的；内在的'], examples: ['There are inherent limits.', '存在固有局限。'], labels: ['CET6'] },
  { word: 'notable', phonetic: '/ˈnəʊtəbl/', meanings: ['adj. 显著的；著名的'], examples: ['A notable improvement on benchmarks.', '在基准上有显著提升。'], labels: ['CET6'] },
  { word: 'prevalent', phonetic: '/ˈprevələnt/', meanings: ['adj. 普遍的；流行的'], examples: ['This bias is prevalent in the literature.', '这种偏差在文献中很普遍。'], labels: ['常难词'] },
  { word: 'scrutiny', phonetic: '/ˈskruːtəni/', meanings: ['n. 详细审查；细看'], examples: ['The claim deserves closer scrutiny.', '该主张值得更仔细审视。'], labels: ['常难词'] },
  { word: 'trade-off', phonetic: '/ˈtreɪd ɒf/', meanings: ['n. 权衡；取舍'], examples: ['There is a speed-accuracy trade-off.', '速度与精度之间存在权衡。'], labels: ['学术'] },
  { word: 'diversify', phonetic: '/daɪˈvɜːsɪfaɪ/', meanings: ['v. 使多样化'], examples: ['Diversify the training data.', '使训练数据多样化。'], labels: ['常难词'] },
  { word: 'granularity', phonetic: '/ˌɡrænjʊˈlærəti/', meanings: ['n. 粒度；细度'], examples: ['Reduce the granularity of the labels.', '降低标签的粒度。'], labels: ['学术', '常难词'] },
  { word: 'nonlinear', phonetic: '/ˌnɒnlɪˈnɪə/', meanings: ['adj. 非线性的'], examples: ['A nonlinear activation function.', '一个非线性激活函数。'], labels: ['学术'] },
  { word: 'regularization', phonetic: '/ˌreɡjələraɪˈzeɪʃn/', meanings: ['n. 正则化'], examples: ['Regularization reduces overfitting.', '正则化可减少过拟合。'], labels: ['学术'] },
  { word: 'asymptotic', phonetic: '/ˌæsɪmˈptɒtɪk/', meanings: ['adj. 渐近的'], examples: ['Asymptotic complexity is O(n log n).', '渐近复杂度为 O(n log n)。'], labels: ['学术', '常难词'] },
  { word: 'evaluate', phonetic: '/ɪˈvæljueɪt/', meanings: ['v. 评估；评价'], examples: ['Evaluate on the held-out set.', '在留出集上评估。'], labels: ['CET4'] },
  { word: 'sophisticated', phonetic: '/səˈfɪstɪkeɪtɪd/', meanings: ['adj. 复杂精密的；老练的'], examples: ['A sophisticated decoding strategy.', '一种精密的解码策略。'], labels: ['CET6'] },
  { word: 'leveraging', phonetic: '/ˈliːvərɪdʒɪŋ/', meanings: ['v. 利用；撬动'], examples: ['Leveraging self-supervision improves transfer.', '利用自监督可提升迁移效果。'], labels: ['学术'] },
  { word: 'comparable', phonetic: '/ˈkɒmpərəbl/', meanings: ['adj. 可比较的；类似的'], examples: ['Results are comparable to prior work.', '结果与先前工作可比。'], labels: ['CET6'] },
  { word: 'ambiguous', phonetic: '/æmˈbɪɡjuəs/', meanings: ['adj. 模棱两可的；含糊的'], examples: ['The wording is ambiguous.', '该表述模棱两可。'], labels: ['CET6'] },
  { word: 'redundant', phonetic: '/rɪˈdʌndənt/', meanings: ['adj. 多余的；冗余的'], examples: ['Remove redundant layers.', '移除冗余层。'], labels: ['CET6'] },
  { word: 'coherent', phonetic: '/kəʊˈhɪərənt/', meanings: ['adj. 连贯的；一致的'], examples: ['A coherent narrative.', '一个连贯的叙述。'], labels: ['CET6'] }
]

let dict: Map<string, DictEntry> | null = null

function normalize(w: string): string {
  return w.trim().toLowerCase().replace(/[''`]/g, "'")
}

async function loadDict(): Promise<Map<string, DictEntry>> {
  if (dict) return dict
  const map = new Map<string, DictEntry>()
  for (const e of BUILT_IN) map.set(normalize(e.word), e)

  // 若用户导入了扩展词典，加载进来
  const userPath = path.join(app.getPath('userData'), 'dict', 'user-dict.json')
  try {
    const raw = await fs.readFile(userPath, 'utf-8')
    const list = JSON.parse(raw) as DictEntry[]
    for (const e of list) if (e?.word) map.set(normalize(e.word), e)
  } catch {
    // 未导入扩展词典，用内置词即可
  }

  dict = map
  return dict
}

/** 划词查询：本地优先，命中即零延迟返回 */
export async function lookup(word: string): Promise<LookupResult | null> {
  const d = await loadDict()
  const entry = d.get(normalize(word))
  if (!entry) return null
  return {
    word: entry.word,
    phonetic: entry.phonetic,
    meanings: entry.meanings,
    examples: entry.examples,
    labels: entry.labels,
    source: 'local-dict'
  }
}

/** 导入 ECDICT csv（词,音标,翻译,标签…）为本地词典 */
export async function importEcdict(csvPath: string): Promise<number> {
  const raw = await fs.readFile(csvPath, 'utf-8')
  const out: DictEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split(',')
    if (cols.length < 3) continue
    const [word, phonetic, translation] = cols
    if (!word || !word.trim()) continue
    out.push({
      word: word.trim(),
      phonetic: phonetic?.trim() ?? '',
      meanings: translation.split(/\\n|;/).filter(Boolean),
      examples: [],
      labels: cols[4]?.split(/\s+/).filter(Boolean) ?? []
    })
  }
  const dir = path.join(app.getPath('userData'), 'dict')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'user-dict.json'), JSON.stringify(out), 'utf-8')
  dict = null // 下次查询重新加载
  return out.length
}

/** 词典规模 */
export async function dictSize(): Promise<number> {
  const d = await loadDict()
  return d.size
}