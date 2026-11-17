import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CatalogFeed } from '../lib/catalog-feed.js';
import { isolateHome } from './home.mjs';

/**
 * 目录补货回归（v0.4.0）：只追加、真变化才写、seen 记忆、档案翻译、失败不标记。
 * 假 configEditor 记录 edit 调用；假 fetch 回答 /models；目录档案用 stub。
 */

const SPECS = {
  'qwen3.8-max': {
    reasoning: true, reasoningEfforts: ['none', 'low', 'medium', 'xhigh'],
    acceptedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    reasoningAliases: { high: 'xhigh', max: 'xhigh' },
    contextWindow: 983616, maxTokens: 131072, input: ['text', 'image'],
  },
  'glm-5.3': {
    reasoning: true, reasoningEfforts: ['low', 'high', 'max'],
    rejectedReasoningEfforts: ['none'],
    reasoningAliases: { minimal: 'low', medium: 'high', xhigh: 'max' },
    contextWindow: 1000000, maxTokens: 131072, input: ['text'],
  },
  auto: { reasoning: false, input: ['text'] },
};

function harness({ ids, ctl = { editFails: false }, providers }) {
  const edits = [];
  const entry = {
    options: {
      id: 'llm-pi-ai',
      config: {
        providers: providers ?? {
          qwentokenplan: {
            apiKeyEnv: 'QTPF_TEST_FEED_KEY', baseURL: 'https://gw.example/v1',
            models: [{ id: 'qwen4-max-preview', name: 'keep-me' }],
          },
          otherroute: { models: [{ id: 'untouched' }] },
        },
      },
    },
  };
  const editor = {
    entries: () => [entry],
    edit: async (target, change) => {
      if (ctl.editFails) throw new Error('schema validation refused');
      const next = change(structuredClone(target.options.config), {});
      target.options.config = next;
      edits.push(next);
    },
  };
  const ctx = { get: (name) => (name === 'configEditor' ? editor : undefined), logger: { info() {}, warn() {}, debug() {} } };
  const catalog = { find: (id) => SPECS[id] };
  const fetchImpl = async (url) => {
    assert.match(url, /\/models$/);
    return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) };
  };
  const feed = new CatalogFeed({ ctx, catalog, feedProvider: 'qwentokenplan', pluginName: 'test', fetchImpl });
  return { feed, entry, edits };
}

test('feed appends only new chat models, translates specs, keeps existing entries and other providers', async () => {
  const { home, restore } = isolateHome('qtpf-feed-');
  const prevKey = process.env.QTPF_TEST_FEED_KEY;
  process.env.QTPF_TEST_FEED_KEY = 'sk-test';
  try {
    const { feed, entry, edits } = harness({
      ids: ['qwen4-max-preview', 'qwen3.8-max', 'glm-5.3', 'auto', 'mystery-1', 'wan2.7-image', 'qwen-image-3.0-pro'],
    });
    const r = await feed.run();
    assert.deepEqual(r.added, ['qwen3.8-max', 'glm-5.3', 'auto', 'mystery-1'], '非对话模型与已有 id 不进补货');
    assert.equal(edits.length, 1);
    const route = entry.options.config.providers.qwentokenplan;
    assert.deepEqual(route.models[0], { id: 'qwen4-max-preview', name: 'keep-me' }, '已有条目原样保留');
    assert.deepEqual(entry.options.config.providers.otherroute, { models: [{ id: 'untouched' }] }, '其它 provider 不动');
    assert.equal(route.models.length, 5);
    const qwen = route.models.find((m) => m.id === 'qwen3.8-max');
    assert.equal(qwen.contextWindow, 983616);
    assert.deepEqual(qwen.input, ['text', 'image']);
    assert.deepEqual(qwen.reasoningEfforts, { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' });
    assert.equal(qwen.compat.thinkingFormat, 'qwen');
    const glm = route.models.find((m) => m.id === 'glm-5.3');
    assert.equal(glm.reasoningEfforts.off, undefined, 'glm-5.3 拒绝 none → 不提供 off 档');
    assert.equal(glm.reasoningEfforts.minimal, 'low');
    assert.equal(glm.reasoningEfforts.xhigh, 'max');
    assert.equal(glm.compat.thinkingFormat, 'zai');
    assert.equal(route.models.find((m) => m.id === 'auto').reasoningEfforts, false, '非推理模型明确关档');
    const unknown = route.models.find((m) => m.id === 'mystery-1');
    assert.deepEqual(Object.keys(unknown).sort(), ['id', 'name'], '无档案只写 id/name，容量吃路由默认');
  } finally {
    if (prevKey === undefined) delete process.env.QTPF_TEST_FEED_KEY; else process.env.QTPF_TEST_FEED_KEY = prevKey;
    restore();
  }
});

test('second run writes nothing: existing and seen ids are never re-added', async () => {
  const { home, restore } = isolateHome('qtpf-feed-dedup-');
  const prevKey = process.env.QTPF_TEST_FEED_KEY;
  process.env.QTPF_TEST_FEED_KEY = 'sk-test';
  try {
    const { feed, edits } = harness({ ids: ['qwen4-max-preview', 'glm-5.3'] });
    assert.deepEqual((await feed.run()).added, ['glm-5.3']);
    assert.deepEqual((await feed.run()).added, []);
    assert.equal(edits.length, 1, '差集为空不碰配置');
  } finally {
    if (prevKey === undefined) delete process.env.QTPF_TEST_FEED_KEY; else process.env.QTPF_TEST_FEED_KEY = prevKey;
    restore();
  }
});

test('user-deleted model stays deleted: seen memory survives config removal', async () => {
  const { home, restore } = isolateHome('qtpf-feed-seen-');
  const prevKey = process.env.QTPF_TEST_FEED_KEY;
  process.env.QTPF_TEST_FEED_KEY = 'sk-test';
  try {
    const { feed, entry, edits } = harness({ ids: ['qwen4-max-preview', 'glm-5.3'] });
    await feed.run();
    const route = entry.options.config.providers.qwentokenplan;
    route.models = route.models.filter((m) => m.id !== 'glm-5.3'); // 用户手动删除
    assert.deepEqual((await feed.run()).added, [], '删掉的模型不被塞回来');
    assert.equal(edits.length, 1);
  } finally {
    if (prevKey === undefined) delete process.env.QTPF_TEST_FEED_KEY; else process.env.QTPF_TEST_FEED_KEY = prevKey;
    restore();
  }
});

test('edit refusal records error without marking seen; next tick retries and lands', async () => {
  const { home, restore } = isolateHome('qtpf-feed-fail-');
  const prevKey = process.env.QTPF_TEST_FEED_KEY;
  process.env.QTPF_TEST_FEED_KEY = 'sk-test';
  try {
    const ctl = { editFails: true };
    const h = harness({ ids: ['qwen4-max-preview', 'late-1'], ctl });
    const bad = await h.feed.run();
    assert.equal(bad.added.length, 0);
    assert.match(bad.error, /schema validation refused/);
    assert.equal(h.edits.length, 0);
    // 校验恢复后同一实例下一轮重试成功（失败不标记 seen）。
    ctl.editFails = false;
    assert.deepEqual((await h.feed.run()).added, ['late-1']);
    assert.equal(h.edits.length, 1);
  } finally {
    if (prevKey === undefined) delete process.env.QTPF_TEST_FEED_KEY; else process.env.QTPF_TEST_FEED_KEY = prevKey;
    restore();
  }
});

test('missing route or baseURL degrades to a recorded error, never throws', async () => {
  const { home, restore } = isolateHome('qtpf-feed-noroute-');
  try {
    const { feed } = harness({ ids: ['x'], providers: {} });
    const r = await feed.run();
    assert.equal(r.added.length, 0);
    assert.match(r.error, /baseURL/);
  } finally {
    restore();
  }
});
