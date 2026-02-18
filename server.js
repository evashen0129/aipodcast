// 最先加载 .env，避免未配置 API Key（本地安全配置，见 .env.example 与 启动说明.md）
import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// DeepSeek 配置（从 .env 读取 DEEPSEEK_API_KEY）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// 本地 Ollama 配置（无需 API Key，需本机已安装并运行 Ollama）
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// 彻底解决浏览器跨域 / Failed to fetch：允许任意来源，并显式允许 POST 与 JSON
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(__dirname));

// 用数组 + join 定义，避免整段模板字符串在部分环境被误解析（如 Vercel compileSource）
const SYSTEM_PROMPT = [
  '你正在为一位**准妈妈播客制作人**服务。她做的是有温度、有细节的文化类播客。',
  '',
  '你的任务：',
  '1. **深度阅读**她提供的文稿/读书笔记，按「核心金句 + 逻辑拆解 + 互动建议」结构输出大纲（items）。',
  '2. 再写一段**播客开场白**（opening），口语化、有钩子，约 150–250 字。开场白中不要使用占位符（如 XX、XXX、填空），请直接写出完整可用的开场白。',
  '',
  '---',
  '',
  '【大纲结构——必须严格按以下三部分组织每条】',
  '每条 items 元素必须包含（可多行，用 \\n 换行；子项缩进两空格后写 - ）：',
  '',
  '1. **核心金句**：从文稿中摘出或提炼的一句可引用、可做标题的话。用 ** 标出关键词，例如 **宅兹中国**、**darchin（中国树）**。',
  '2. **逻辑拆解**：用 1～3 个子点（换行后两空格 + 短横）写出证据、案例、因果，例如：\\n  - 何尊铭文；周武王时期\\n  - 波斯文献中的异域想象。',
  '3. **互动建议**（可选）：括号里用「说明：」写一句给主播的提示，会显示为「AI 洞察」小标签。例如：（说明：用充满异域风情的诗意比喻，瞬间勾起好奇）',
  '',
  '单条示例（一条里含核心金句、子列表、说明）：',
  '"**宅兹中国**——何尊铭文里最早出现的"中国"，指地理中心而非国名。\\n  - 周武王时期；青铜器铭文证据\\n  - 从地名到国名的演变（说明：可对比今日「中国」一词的用法引发听众共鸣）"',
  '',
  '【丰富度与格式】',
  '- 主要点位不得少于 5 条；每条都要有**核心金句**和**逻辑拆解**，尽量带**互动建议**（说明：…）。',
  '- 关键词必须用 ** 加粗。',
  '- 只输出合法 JSON 一行，不要 markdown 代码块。**必须**包含 **items**（数组）和 **visualCode**（字符串）。',
  '- **紧箍咒**：请只返回纯净的 JSON 字符串，不要包含任何 Markdown 格式的块（例如三个反引号加 json 的写法），也不要包含任何多余的解释文字。',
  '',
  '【visualCode 字段——必须输出】',
  '- 你必须返回一个包含 **items** 和 **visualCode** 的 JSON 对象。',
  '- **如果文稿包含时间线或逻辑流程**（如朝代、事件顺序、因果、步骤）：在 **visualCode** 中生成 **Mermaid 语法代码**（如 graph TD、flowchart、timeline）。',
  '- **如果没有时间线或逻辑流程**：在 **visualCode** 中生成一段**简单的思维导图 Mermaid 代码**（mindmap 语法），概括文稿要点。',
  '',
  '示例（有流程）：{"items":[...],"opening":"...","visualCode":"graph TD\\n  A[起点]-->B[过程]\\n  B-->C[结果]"}',
  '示例（思维导图保底）：{"items":[...],"opening":"...","visualCode":"mindmap\\n  root((文稿))\\n    要点1\\n    要点2\\n    要点3"}',
  '只输出上述 JSON 一行。',
  '只输出 JSON，严禁包含 Markdown 代码块。'
].join('\n');

function parseClaudeResponse(text) {
  const openMarker = '【开场白】';
  const outlineMarker = '【大纲】';
  const openIdx = text.indexOf(openMarker);
  const outlineIdx = text.indexOf(outlineMarker);

  // 不依赖顺序：从各自标记后取到「下一个标记之前」或结尾
  function sliceSection(startIdx, markerLen, untilIdx) {
    if (startIdx === -1) return '';
    const start = startIdx + markerLen;
    const end = untilIdx === -1 ? text.length : untilIdx;
    return text.slice(start, end).trim();
  }

  let opening = '';
  let outline = '';

  if (openIdx !== -1 && outlineIdx !== -1) {
    opening = sliceSection(openIdx, openMarker.length, outlineIdx > openIdx ? outlineIdx : -1);
    outline = sliceSection(outlineIdx, outlineMarker.length, openIdx > outlineIdx ? openIdx : -1);
  } else if (openIdx !== -1) {
    opening = sliceSection(openIdx, openMarker.length, -1);
    outline = text.slice(0, openIdx).trim();
    // 去掉可能的前导说明，从大纲标记或列表符号开始截取
    const altMarkers = ['大纲：', '## 大纲', '## 内容大纲', '\n- ', '\n* '];
    for (const m of altMarkers) {
      const i = outline.indexOf(m);
      if (i !== -1) {
        outline = outline.slice(i + m.length).trim();
        break;
      }
    }
  } else if (outlineIdx !== -1) {
    outline = sliceSection(outlineIdx, outlineMarker.length, -1);
  } else {
    // 无标记时：整段当作开场白，前半段可当大纲
    opening = text.trim();
    const half = Math.floor(text.length / 2);
    outline = text.slice(0, half).trim();
  }

  return { outline, opening };
}

/** 将 items 数组转成 Markdown 圆点列表字符串 */
function itemsToOutline(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map((item) => {
    const text = typeof item === 'string' ? item : (item && typeof item === 'object' && item.text != null ? item.text : String(item));
    return '- ' + String(text).trim();
  }).join('\n');
}

/** 把 AI 返回的 item（可能是 { 核心金句, 逻辑拆解 } 等中文键）转成前端卡片需要的 { text: "..." } */
function normalizeItemForFrontend(item) {
  if (item == null) return { text: '' };
  if (typeof item === 'string') return { text: item.trim() };
  if (typeof item !== 'object') return { text: String(item) };
  if (item.text != null && typeof item.text === 'string') return { text: item.text.trim() };
  const core = item['核心金句'] ?? item.core ?? '';
  const logic = item['逻辑拆解'] ?? item.logic ?? '';
  const insight = item['互动建议'] ?? item.insight ?? '';
  const parts = [];
  if (core) parts.push(String(core).trim());
  if (logic) parts.push(String(logic).trim());
  if (insight) parts.push(String(insight).trim());
  return { text: parts.join('\n') };
}

/** 尝试从 AI 返回中解析 JSON；支持 items/opening 及 visualData */
function parseAIResponse(text) {
  const raw = (text || '').trim();
  const tick = '\x60'; // 反引号，避免源码中出现 ``` 导致部分环境误解析为模板字符串
  let jsonStr = raw.replace(new RegExp('^' + tick + tick + tick + '(?:json)?\\s*', 'i'), '').replace(new RegExp('\\s*' + tick + tick + tick + '$'), '').trim();
  try {
    const obj = JSON.parse(jsonStr);
    let outline = '';
    let opening = '';
    let items = null;
    let visualCode = null;
    if (obj) {
      if (typeof obj.outline === 'string') outline = obj.outline;
      if (Array.isArray(obj.items) && obj.items.length > 0) {
        items = obj.items;
        outline = itemsToOutline(obj.items);
      }
      opening = typeof obj.summary === 'string' ? obj.summary : (typeof obj.opening === 'string' ? obj.opening : '');
      if (obj.visualCode != null && String(obj.visualCode).trim() !== '') {
        visualCode = String(obj.visualCode).trim();
      }
    }
    if (outline !== '' || opening !== '' || items) {
      return { outline, opening, items, visualCode };
    }
  } catch (_) { /* 非 JSON，走下方兜底 */ }
  const { outline, opening } = parseClaudeResponse(raw);
  return { outline, opening, items: null, visualCode: null };
}

/** 使用 DeepSeek API 生成（国内好申请、便宜） */
async function refineWithDeepSeek(notes) {
  const userContent = '请根据以下文稿/笔记，输出一个仅包含 summary 和 outline 的 JSON。summary=播客开场白/摘要，outline=Markdown 列表大纲。只输出 JSON，不要其他文字。\n\n文稿：\n' + notes;
  const url = `${DEEPSEEK_BASE.replace(/\/$/, '')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      max_tokens: 1024,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek 请求失败 (${res.status}): ${errText || res.statusText}`);
  }

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('DeepSeek 返回内容为空');
  return text;
}

/** 使用本地 Ollama 生成（无需 API Key） */
async function refineWithOllama(notes) {
  const userPrompt = '请根据以下文稿/笔记，输出一个仅包含 summary 和 outline 的 JSON。summary=播客开场白/摘要，outline=Markdown 列表大纲。只输出 JSON，不要其他文字。\n\n文稿：\n' + notes;
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: fullPrompt,
      stream: false,
      options: { num_predict: 1024 }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama 请求失败 (${res.status}): ${errText || res.statusText}`);
  }

  const data = await res.json();
  const text = (data.response || '').trim();
  if (!text) throw new Error('Ollama 返回内容为空');
  return text;
}

/** 检测 Ollama 是否可用 */
async function isOllamaAvailable() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

app.post('/api/claude', async (req, res) => {
  const { notes } = req.body || {};
  if (!notes || typeof notes !== 'string') {
    return res.status(400).json({ error: '请提供 notes 内容' });
  }

  const useDeepSeek = !!DEEPSEEK_API_KEY;

  try {
    let text;
    if (useDeepSeek) {
      text = await refineWithDeepSeek(notes);
    } else {
      // 未配置 DEEPSEEK_API_KEY 时使用本地 Ollama（无需 API Key）
      text = await refineWithOllama(notes);
    }

    const { outline, opening, items, visualCode } = parseAIResponse(text);
    const normalizedItems = Array.isArray(items) && items.length > 0
      ? items.map(normalizeItemForFrontend)
      : undefined;
    const outlineStr = normalizedItems
      ? itemsToOutline(normalizedItems.map((x) => x.text))
      : (typeof outline === 'string' ? outline : '');
    const jsonResponse = {
      outline: outlineStr,
      opening: typeof opening === 'string' ? opening : '',
      items: normalizedItems,
      visualCode: visualCode || ''
    };
    console.log('AI返回的完整数据:', jsonResponse);
    res.json(jsonResponse);
  } catch (err) {
    const who = useDeepSeek ? 'DeepSeek' : 'Ollama';
    console.error(who + ' 错误:', err);
    res.status(500).json({
      error: err.message || (who + ' 调用失败'),
      outline: '',
      opening: '',
      items: undefined,
      visualCode: ''
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 健康检查：用于确认服务已启动，并显示当前使用的模型来源
app.get('/api/health', async (req, res) => {
  const ollamaOk = await isOllamaAvailable();
  const provider = DEEPSEEK_API_KEY ? 'deepseek' : (ollamaOk ? 'ollama' : 'none');
  res.json({
    ok: true,
    hasDeepSeekKey: !!DEEPSEEK_API_KEY,
    ollamaAvailable: ollamaOk,
    provider,
    port: PORT
  });
});

// 本地直接运行才 listen；Vercel 上通过 api/index.js 调用 app，不执行 listen
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', async () => {
    console.log('播客助手已启动: http://localhost:' + PORT);
    console.log('请务必在浏览器打开上述地址使用（不要直接双击 index.html，否则会 Failed to fetch）');
    if (DEEPSEEK_API_KEY) {
      console.log('当前使用 DeepSeek 引擎');
    } else {
      const ollamaOk = await isOllamaAvailable();
      if (ollamaOk) {
        console.log('当前使用: 本地 Ollama（无需 API Key），模型: ' + OLLAMA_MODEL);
      } else {
        console.warn('警告: 未配置 DEEPSEEK_API_KEY 且 Ollama 未运行。请任选其一：');
        console.warn('  1) 在 .env 中填入 DEEPSEEK_API_KEY（推荐，国内好申请、便宜）');
        console.warn('  2) 安装并启动 Ollama: https://ollama.com ，然后运行如 ollama run qwen2.5:7b');
      }
    }
  });
}

export default app;
