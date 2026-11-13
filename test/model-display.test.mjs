/**
 * 模型命名与排序一致性回归（2026-11-13 用户要求：两插件模型排列与命名一致）。
 *
 * 钉三件事：
 *  1. displayName 规则样例（同族统一格式）；
 *  2. sortModels：家族分组 → 组内版本新者在上 → 日期新者在上 → 层级高者在上；
 *  3. 与 ark-agent-plan 的 lib/model-display.js **逐字节相同**（兄弟目录存在时校验），
 *     防止两个插件的规则各自漂移、同名模型两种写法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayName, sortModels, versionParts, releaseDate } from '../lib/model-display.js';
import { BUILTIN_CATALOG } from '../lib/catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('display names follow one format per family', () => {
  assert.equal(displayName('qwen3.8-max'), 'Qwen-3.8 Max');
  assert.equal(displayName('qwen3.7-plus'), 'Qwen-3.7 Plus');
  assert.equal(displayName('deepseek-v4.1-flash'), 'DeepSeek-V4.1 Flash');
  assert.equal(displayName('deepseek-v4-pro-0813'), 'DeepSeek-V4 Pro 0813');
  assert.equal(displayName('glm-5.3'), 'GLM-5.3');
  assert.equal(displayName('glm-5-3-flash-260828'), 'GLM-5.3 Flash 260828');
  assert.equal(displayName('kimi-k3-1-pro'), 'Kimi K3.1 Pro');
  assert.equal(displayName('doubao-seed-2-1-lite'), 'Doubao Seed 2.1 Lite');
  assert.equal(displayName('minimax-m3'), 'MiniMax M3');
});

test('date suffixes (4 or 6 digits) never leak into version numbers', () => {
  assert.deepEqual(versionParts('deepseek-v4-pro-0813'), [4]);
  assert.deepEqual(versionParts('deepseek-v4.1-flash-1017'), [4, 1]);
  assert.deepEqual(versionParts('glm-5-3-flash-260828'), [5, 3]);
  assert.equal(releaseDate('deepseek-v4-pro-0813'), 813);
  assert.equal(releaseDate('glm-5-3-flash-260828'), 260828);
  assert.equal(releaseDate('qwen3.8-max'), 0);
});

test('sortModels groups families and orders newest first inside each group', () => {
  const ids = (list) => list.map((m) => m.id);
  const sorted = sortModels(BUILTIN_CATALOG.models.map((m) => ({ id: m.id })));
  assert.deepEqual(ids(sorted), [
    // DeepSeek（order 0）：v4.1 组在上；无日期别名=跟随最新部署，排带日期快照之上
    'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017',
    'deepseek-v4-pro', 'deepseek-v4-pro-0813',
    'deepseek-v4-flash-0731',
    // 智谱（order 2）：5.3 在 5.2 上
    'glm-5.3', 'glm-5.2',
    // 千问（order 5）：3.8 > 3.7 > 3.6；同版本 max 先于 flash/plus
    'qwen3.8-max', 'qwen3.8-flash',
    'qwen3.7-max', 'qwen3.7-plus',
    'qwen3.6-flash',
    // auto 无版本号，垫底
    'auto',
  ]);
});

test('model-display.js is byte-identical to the ark-agent-plan copy (drift guard)', () => {
  const sibling = path.join(here, '../../../ark-agent-plan/lib/model-display.js');
  if (!fs.existsSync(sibling)) return; // 独立 clone 时无兄弟目录，跳过
  const mine = fs.readFileSync(path.join(here, '../lib/model-display.js'), 'utf8');
  const theirs = fs.readFileSync(sibling, 'utf8');
  assert.equal(mine, theirs, '两个插件的 model-display.js 必须逐字节一致；改一处要同步两处');
});
