// 权益计数管线实测：走插件真实代码路径（buildRequestBody → Token Plan SSE →
// responses-sse 的 *_call 事件 → HarnessBudget.record），验证每项权益返回一次后
// equityCounts 的「剩余/周期总额」是否相应减一。用临时状态文件，不碰宿主真实计数。
// 运行：node --import ./test/runtime.mjs test/equity-pipeline.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildRequestBody } from '../lib/content.js';
import { responsesToDshChunks } from '../lib/responses-sse.js';
import { BUILTIN_CATALOG } from '../lib/catalog.js';
import { HarnessBudget } from '../lib/budget.js';

function readEnv(name) {
  const direct = process.env[name];
  if (direct?.trim()) return direct.trim();
  const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.env'), 'utf8');
  const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm').exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}
const KEY = readEnv('QWEN_TOKEN_PLAN_CN_API_KEY');
assert.ok(KEY, '需要 QWEN_TOKEN_PLAN_CN_API_KEY');
const ENDPOINT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses';

const budget = new HarnessBudget({
  config: {}, logger: { debug: () => {}, info: () => {}, warn: () => {} },
  filePath: path.join(os.tmpdir(), `qtpf-pipeline-${Date.now()}.json`),
});
budget.setTier({
  specCode: 'standard', quota: {}, fetchedAt: Date.now(),
  usage: { per1MonthPercentage: 0.58, per1MonthResetTime: Date.now() + 19 * 86_400_000 },
  subscription: { remainingDays: 19 },
});

const model = BUILTIN_CATALOG.models.find((m) => m.id === 'qwen3.8-flash');
const counts = () => budget.status().equityCounts.map((e) => `${e.key}=${e.remaining}/${e.quota}`).join(' ');

async function chat(builtins, prompt) {
  const options = {
    model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
  };
  const body = await buildRequestBody(options, model, undefined, builtins);
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, max_output_tokens: 1200 }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    assert.fail(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const seen = [];
  for await (const chunk of responsesToDshChunks(response.body, undefined, (type) => {
    seen.push(type);
    budget.record(type);
  })) { /* 消费流即可 */ }
  return seen;
}

console.log('初始：', counts(), '\n');

const t1 = await chat(['web_search'], '请搜索：2026年11月3日杭州天气，一句话回答。');
console.log('web_search 返回:', t1.join(','), '→', counts(), '\n');

const t2 = await chat(['web_search', 'web_extractor'], '请搜索并打开 https://platform.qianwenai.com/pricing/token-plan ，一句话总结套餐档位。');
console.log('web_extractor 返回:', t2.join(','), '→', counts(), '\n');

const t3 = await chat(['code_interpreter'], '用 Python 算 2 的 64 次方，告诉我结果。');
console.log('code_interpreter 返回:', t3.join(','), '→', counts(), '\n');

const t4 = await chat(['web_search_image'], '搜索几张西湖断桥的照片。');
console.log('web_search_image 返回:', t4.join(','), '→', counts(), '\n');

// 断言：每次 *_call 事件都让对应权益剩余 −1
assert.ok(budget.equityState('search_pro').used >= 2, 'search_pro 至少计 2（两次 web_search）');
assert.ok(budget.equityState('webfetch').used >= 1, 'webfetch 计 1');
assert.ok(budget.equityState('code_interpreter').used >= 1, 'code_interpreter 计 1');
assert.ok(budget.equityState('vertical_search').used >= 1, 'vertical_search 计 1');
console.log('\n管线断言通过：SSE *_call → record → equityCounts 递减 ✔');
