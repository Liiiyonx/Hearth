# Hearth 围炉

> 一个会转文档、会读论文的桌面小人。

按方案书 v2.0 实现的 v0.1 验证版本。核心命题：**文档与论文永远留在你的电脑里。**

---

## 它能做什么（已实现并通过测试）

| 能力 | 状态 | 说明 |
|---|---|---|
| Word → PDF | ✅ 已验证 | 优先调用 Office/WPS 原生导出，7/7 保真项全保住 |
| PDF → Word | ✅ 已验证 | 解析文本层并重建段落、标题层级，中文无乱码 |
| 保真清单 | ✅ | 每次转换逐项打勾，并如实列出没保住的地方 |
| 桌宠窗口行为 | ✅ | 坐在当前窗口顶边、窗口关闭跳落、拖拽投掷、置顶 |
| 划词翻译 | ✅ | 内置离线词典（50+ 学术高频词），零网络延迟 |
| 气泡问答 | ✅ | OpenAI 兼容协议，支持 DeepSeek/千问/豆包/自定义 |
| 隐私状态灯 | ✅ | 顶栏常亮，明确显示此刻是否有数据离开本机 |
| 托盘常驻 / 单实例 / 开机自启 | ✅ | 自启延迟 30 秒，不抢开机资源 |
| 扫描件 OCR | ⏳ | 识别得出，但未内置引擎，需自行配置 |

---

## 快速开始

```bash
npm install          # 首次需要下载 Electron 二进制（约 100MB）
npm run build        # 构建
npm run app          # 启动应用
```

开发模式：

```bash
npm run dev          # electron-vite 热更新
```

### 测试

```bash
npm run typecheck    # 两套 tsconfig 全量类型检查
npm run test:convert # 纯 Node 验证 PDF→Word 引擎（13 项）
npm run test:regression  # Electron 内跑完整双向转换回归（16 项）
node scripts/run-smoke.mjs   # 启动应用做冒烟测试（22 项，含截图）
```

**当前状态：转换回归 16/16 通过，冒烟测试全部通过。**

---

## 架构

按方案书「架构分五层，层与层之间只通过明确定义的接口通信」组织：

```
src/
├── shared/types.ts          所有跨层契约（唯一类型来源）
├── preload/index.ts         白名单桥，contextIsolation 打开
├── main/
│   ├── index.ts             窗口、托盘、生命周期、IPC 注册
│   ├── store.ts             本地存储（人设/记忆/历史/设置）
│   ├── services/
│   │   ├── convert/         ★ P0 转换引擎
│   │   │   ├── index.ts       转换总入口 + 降级策略 + 历史记录
│   │   │   ├── word2pdf.ts    COM 原生导出 + HTML 打印回退
│   │   │   ├── htmlPrint.ts   mammoth → HTML → Chromium 打印
│   │   │   ├── pdf2word.ts    pdfjs 解析 + 结构重建
│   │   │   └── docxBuilder.ts 程序化生成 docx
│   │   ├── win32.ts         窗口枚举与事件钩子
│   │   ├── dictionary.ts     离线词典
│   │   └── llm.ts            云端调用（每次出网都上报状态灯）
│   ├── regression/          转换回归测试
│   └── smoke/               应用冒烟测试
└── renderer/
    ├── pet/                 桌宠（PixiJS 舞台 + 行为状态机）
    └── panel/               控制面板（React）
```

### 转换链路矩阵

| 方向 | 链路 | 触发条件 | 保真度 |
|---|---|---|---|
| Word → PDF | `com-native` | 装了 Office 或 WPS | 最高，7/7 保住 |
| Word → PDF | `html-print` | 没有 Office/WPS | 中，公式与页眉页脚丢失 |
| PDF → Word | `pdfjs-rebuild` | 有文本层的电子版 | 段落与标题可重建 |
| PDF → Word | `manual-required` | 扫描件 | 需配置 OCR 引擎 |

---

## 与方案书的三处偏离（及原因）

诚实起见，记录下实现过程中与方案书原定方案不同的地方。

### 1. Win32 桥：koffi → 常驻 PowerShell

方案书表 2 选定 **koffi** 做 FFI。实测本机 koffi 无预编译产物且缺 CMake，原生模块无法构建——一个装不上的依赖等于没有依赖。

改为在 PowerShell 里用 `Add-Type` 做 P/Invoke，注册 `SetWinEventHook`，有事件就往 stdout 写一行 JSON，Node 侧按行解析。

- 仍是**事件驱动**，不是轮询，空闲 CPU 可忽略
- 免原生编译，装机即用
- 代价：多一个常驻 PowerShell 进程（约 30–50MB）

代码里 `src/main/services/win32.ts` 有完整说明。

### 2. 主进程输出格式：CJS

`package.json` 不设 `"type": "module"`，主进程编译为 CommonJS。Electron 主进程在 Windows 上对 ESM 的支持在部分版本上不可靠，CJS 更稳。

### 3. 桌宠形象：程序化绘制，非美术资源

v0.1 不含任何二进制美术资源，角色由 PixiJS `Graphics` 程序化绘制。这样：

- 仓库是纯代码，`git clone` 下来就能跑，不需要 LFS
- 头部/身体是独立节点，将来「照片生成形象」只要替换对应纹理即可复用整套动画骨架
- 空闲时可以整体不重绘，性能预算守得住

`PetStage.applyGeneratedFace()` 已预留该接口。

---

## 隐私设计

方案书原则二：本地优先，云端可选，出网明示。

- **文档与论文不出本机**——转换全程在本机完成
- 出网的只有三类：对话/翻译文本片段、照片生成形象时的图片、扫描件 OCR
- 顶栏常亮状态灯，橙色呼吸 = 此刻有数据离开本机，并写明内容类别与供应商
- 每次云端调用都会经过 `egress()` 上报，不存在「悄悄联网」的代码路径
- API Key、人设、记忆、历史全部只存在本机，可一键备份或清空

---

## 性能预算

方案书表 4，超标即修：

| 指标 | 预算 | 手段 |
|---|---|---|
| 常驻内存（空闲） | ≤ 250MB | 无内置模型/OCR 引擎 |
| 常驻 CPU（空闲） | ≤ 2% | 桌宠空闲降帧至 8fps |
| 安装包 | ≤ 80MB | 不打包模型 |

实现细节：PixiJS 的眼睛、嘴、手臂只在状态**真正变化时**才重绘 `Graphics`——每帧重绘是空闲 CPU 的头号杀手。姿态切换时清空上一姿态残留的形变，避免拉伸跨姿态粘连。

---

## 已知限制

- **扫描件 OCR 未内置引擎**：能识别出「这是扫描件」并如实报错，不会假装成功
- **复杂表格保真有限**：PDF 的表格线信息本就稀疏，基础表格可重建，嵌套/合并单元格可能以文字呈现
- **公式以文本重建**：不保证排版等效，转换后会明确标注，建议对照原稿核对
- **双栏重排**：按栏顺序重排，跨栏段落可能被拆开
- **空闲 CPU 预算**已用降帧实现，但未做长期实测；上生产前需连续运行 24 小时验证

---

## 许可

MIT