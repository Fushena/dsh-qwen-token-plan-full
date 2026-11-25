import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_HOSTS, EQUITY_MCP_SERVICES, VIDEO_MCP_SERVICE,
  normalizeMcpMode, shouldMountService, suppressedBuiltins,
  serverOfToolName, equityKeysOfService, mcpToolPrefix,
  registerEquityMcp, filterMcpShadowedBuiltins, equityChannel,
  equityUnitsForDispatch, asrSecondsFromResult,
} from '../lib/mcp-equity.js';

/**
 * 假宿主：mcpManager（register/list）、tools（guard/definitions）、credentials（resolve）。
 * states 控制 manager.list() 报的连接状态——「注册了」与「连通了」必须分开测，
 * 因为抑制内置工具只认连通（连不上却摘内置工具等于把搜索能力整个弄丢）。
 */
function makeHost({ key = null, states = {}, defs = [], managerLate = false } = {}) {
  const registered = new Map();
  const guards = [];
  const listeners = new Map();
  const calls = [];
  let credentialValue = key;
  // managerLate：模拟冷启动竞态——宿主 mcp-manager 比本插件晚就绪。
  let managerPresent = !managerLate;
  const host = {
    registered, guards, calls,
    setKey(value) { credentialValue = value; },
    bringManagerUp() { managerPresent = true; },
    states,
    defs,
    emit(ref) { for (const fn of listeners.get('credentials/reference-updated') ?? []) fn(ref); },
    /** 宿主 dsh-tools/lib/pipeline.js notifyResult：(exec, result)，result.value 是工具原始返回。 */
    emitResult(exec, result) { for (const fn of listeners.get('tools/result') ?? []) fn(exec, result); },
    resultListenerCount() { return (listeners.get('tools/result') ?? []).length; },
    ctx: {
      get(name) {
        if (name === 'mcpManager') {
          if (!managerPresent) return undefined;
          return {
            register(service, entry) {
              if (registered.has(service)) throw new Error(`mcp-manager: server "${service}" is already configured or registered`);
              calls.push(['register', service, entry]);
              const off = () => { registered.delete(service); calls.push(['unregister', service]); };
              registered.set(service, { entry, off });
              return off;
            },
            list() {
              return [...registered.keys()].map((name) => ({ name, configured: false, status: { state: states[name] ?? 'connected' } }));
            },
          };
        }
        if (name === 'tools') {
          return {
            guard(fn) { guards.push(fn); return () => { const i = guards.indexOf(fn); if (i >= 0) guards.splice(i, 1); }; },
            definitions() { return defs; },
          };
        }
        if (name === 'credentials') {
          return { resolve: async () => (credentialValue == null ? undefined : { value: credentialValue }) };
        }
        return undefined;
      },
      on(event, fn) {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
        return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
      },
    },
  };
  return host;
}

/** 余额表：给定 key→remaining，其余项按未知处理（未知也挂，先让它试）。 */
function budgetOf(remainingByKey, recorded = []) {
  return {
    equityState(key) {
      const remaining = remainingByKey[key];
      if (remaining == null) return undefined;
      return { key, quota: 20, used: 20 - remaining, remaining, unit: '张', source: 'official' };
    },
    record(key, count) { recorded.push([key, count]); },
  };
}

test('normalizeMcpMode accepts auto/off and an explicit service list, dropping unknown names', () => {
  assert.deepEqual(normalizeMcpMode('auto'), { mode: 'auto' });
  assert.deepEqual(normalizeMcpMode(undefined), { mode: 'auto' });
  assert.deepEqual(normalizeMcpMode(true), { mode: 'auto' });
  assert.deepEqual(normalizeMcpMode(false), { mode: 'off' });
  assert.deepEqual(normalizeMcpMode('off'), { mode: 'off' });
  assert.deepEqual(normalizeMcpMode('TextGenerateImage, EnhancedSearch'), { mode: 'list', services: ['TextGenerateImage', 'EnhancedSearch'] });
  // 全是未知名字 → off，而不是「挂一堆不存在的服务」。
  assert.deepEqual(normalizeMcpMode('NoSuchService'), { mode: 'off' });
});

test('shouldMountService keeps unknown balances mounted and drops exhausted ones', () => {
  // 余额未知（网关兜底、还没回源）：先挂着让它试，真实 401 由宿主状态暴露。
  assert.equal(shouldMountService('TextGenerateImage', {}), true);
  assert.equal(shouldMountService('TextGenerateImage', { image_generation: { remaining: 3 } }), true);
  assert.equal(shouldMountService('TextGenerateImage', { image_generation: { remaining: 0 } }), false);
  // 增强搜索与垂类搜索是**两个独立服务、各有独立额度**（实测确认），互不牵连。
  assert.equal(shouldMountService('EnhancedSearch', { search_pro: { remaining: 0 }, vertical_search: { remaining: 5 } }), false);
  assert.equal(shouldMountService('VerticalSearch', { search_pro: { remaining: 0 }, vertical_search: { remaining: 5 } }), true);
  assert.equal(shouldMountService('EnhancedSearch', { search_pro: { remaining: 2 } }), true);
  // 视频没有权益实例，恒挂（不参与权益门控）。
  assert.equal(shouldMountService(VIDEO_MCP_SERVICE.service, {}), true);
});

test('suppressedBuiltins covers exactly the capabilities the mounted services provide', () => {
  assert.deepEqual(suppressedBuiltins(['EnhancedSearch']), ['web_search']);
  assert.deepEqual(suppressedBuiltins(['VerticalSearch']), ['web_search_image', 'image_search']);
  assert.deepEqual(suppressedBuiltins(['EnhancedSearch', 'VerticalSearch']), ['web_search', 'web_search_image', 'image_search']);
  assert.deepEqual(suppressedBuiltins(['WebFetch']), ['web_extractor']);
  assert.deepEqual(suppressedBuiltins(['CodeInterpreter']), ['code_interpreter']);
  // 生图/语音没有对应的服务端内置工具，不该凭空抑制任何东西。
  assert.deepEqual(suppressedBuiltins(['TextGenerateImage', 'TextGenerateSpeech']), []);
  assert.deepEqual(suppressedBuiltins([]), []);
});

test('serverOfToolName only recognises registered servers', () => {
  assert.equal(serverOfToolName('mcp__EnhancedSearch__search', ['EnhancedSearch']), 'EnhancedSearch');
  assert.equal(serverOfToolName('mcp__Other__search', ['EnhancedSearch']), undefined);
  assert.equal(serverOfToolName('web_search', ['EnhancedSearch']), undefined);
  assert.equal(mcpToolPrefix('EnhancedSearch'), 'mcp__EnhancedSearch__');
  assert.deepEqual(equityKeysOfService('EnhancedSearch'), ['search_pro']);
  assert.deepEqual(equityKeysOfService('VerticalSearch'), ['vertical_search']);
});

test('without a pay-as-you-go key nothing is mounted and the panel is told why', async () => {
  // 根因：sk-sp-（Token Plan Key）打 MCP 一律 401。没有 sk- Key 就别挂——
  // 挂了只会给模型塞一堆用不了的工具、给日志刷错误。
  const host = makeHost({ key: null });
  const mcp = registerEquityMcp(host.ctx, { apiKeyEnv: 'BAILIAN_PAYG_API_KEY', budget: budgetOf({ image_generation: 20 }) });
  await mcp.rearm();
  assert.deepEqual(mcp.mountedServices(), []);
  assert.equal(mcp.usesEquity('image_generation'), false);
  const status = mcp.status();
  assert.equal(status.enabled, true);
  assert.equal(status.keyPresent, false);
  assert.equal(status.reason, 'missing-key');
  assert.equal(status.credentialRef, 'BAILIAN_PAYG_API_KEY');
  // 缺 Key 时每项权益都还在花 Credits，面板必须如实说。
  assert.equal(equityChannel('image_generation', status), 'credits');
  mcp.dispose();
});

test('with a key all seven benefit services mount with a credential template, never a literal key', async () => {
  const host = makeHost({ key: 'sk-fixture' });
  const mcp = registerEquityMcp(host.ctx, { apiKeyEnv: 'BAILIAN_PAYG_API_KEY', budget: budgetOf({ image_generation: 20 }) });
  await mcp.rearm();
  const mounted = mcp.mountedServices();
  // 7 项权益 → 7 个服务，一一对应（实测服务名，见 EQUITY_MCP_SERVICES 注释）；视频默认不挂。
  assert.equal(mounted.length, 7);
  assert.equal(new Set(EQUITY_MCP_SERVICES.map((i) => i.service)).size, 7);
  assert.ok(!mounted.includes(VIDEO_MCP_SERVICE.service), '视频无独立权益，默认不挂以免与 qwen_generate_video 重复');
  const entry = host.registered.get('TextGenerateImage').entry;
  assert.equal(entry.transport, 'streamable-http');
  assert.equal(entry.url, `${MCP_HOSTS.cn}/api/v1/mcps/TextGenerateImage/mcp`);
  // 明文 Key 绝不进 entry：交宿主展开模板（manager 固定 expandTemplates:true）。
  assert.equal(entry.headers.Authorization, 'Bearer ${credential:BAILIAN_PAYG_API_KEY}');
  assert.ok(!JSON.stringify(entry).includes('sk-fixture'), 'entry 里不得出现明文 Key');
  assert.equal(mcp.usesEquity('image_generation'), true);
  assert.equal(equityChannel('image_generation', mcp.status()), 'equity');
  mcp.dispose();
});

test('exhausting a quota unmounts its service and hands the capability back to built-in tools', async () => {
  // 用户选定策略：MCP 优先，额度耗尽自动回落模型 API（开始花 Credits）。
  // 摘服务的同时必须让内置工具重新声明，否则该能力就整个消失了。
  // webfetch 已耗尽 → WebFetch 不挂，web_extractor 始终留在内置工具里，
  // 好让本测试只观察 EnhancedSearch 的挂/摘对 web_search 声明的影响。
  const remaining = { search_pro: 1, vertical_search: 0, webfetch: 0, image_generation: 5 };
  const host = makeHost({ key: 'sk-fixture' });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf(remaining) });
  await mcp.rearm();
  assert.ok(mcp.readyServices().includes('EnhancedSearch'));
  assert.deepEqual(filterMcpShadowedBuiltins(['web_search', 'web_extractor'], mcp).tools, ['web_extractor']);

  remaining.search_pro = 0;
  mcp.refresh();
  assert.ok(!mcp.mountedServices().includes('EnhancedSearch'), '增强搜索额度耗尽 → 摘 EnhancedSearch');
  assert.deepEqual(filterMcpShadowedBuiltins(['web_search', 'web_extractor'], mcp).tools, ['web_search', 'web_extractor']);
  assert.equal(mcp.usesEquity('image_generation'), true, '生图还有余额，不受影响');
  assert.equal(equityChannel('search_pro', mcp.status()), 'credits');
  mcp.dispose();
});

test('a service that is registered but not connected neither shadows built-ins nor claims benefits', async () => {
  // 连不上（401/网络）却把内置工具摘了 = 把搜索能力整个弄丢；面板也不能谎报省钱。
  const host = makeHost({ key: 'sk-fixture', states: { EnhancedSearch: 'failed', TextGenerateImage: 'connected' } });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ search_pro: 10, image_generation: 10 }) });
  await mcp.rearm();
  assert.ok(mcp.mountedServices().includes('EnhancedSearch'), '注册仍在（宿主会自己重连）');
  assert.ok(!mcp.readyServices().includes('EnhancedSearch'), '但不算就绪');
  assert.deepEqual(filterMcpShadowedBuiltins(['web_search'], mcp).tools, ['web_search']);
  assert.equal(equityChannel('search_pro', mcp.status()), 'credits');
  assert.equal(equityChannel('image_generation', mcp.status()), 'equity');
  mcp.dispose();
});

test('storing the key later mounts the channel without a restart', async () => {
  // Key 是用户后补的：凭据一落盘就补挂（宿主 mcp-client 自己也会因该事件重连）。
  const host = makeHost({ key: null });
  const mcp = registerEquityMcp(host.ctx, { apiKeyEnv: 'BAILIAN_PAYG_API_KEY', budget: budgetOf({ image_generation: 20 }) });
  await mcp.rearm();
  assert.deepEqual(mcp.mountedServices(), []);
  host.setKey('sk-later');
  host.emit('BAILIAN_PAYG_API_KEY');
  await mcp.rearm();
  assert.ok(mcp.mountedServices().includes('TextGenerateImage'));
  assert.equal(mcp.status().keyPresent, true);
  // 别的凭据更新不该触发重算。
  const before = host.calls.length;
  host.emit('QWEN_TOKEN_PLAN_CN_API_KEY');
  assert.equal(host.calls.length, before);
  mcp.dispose();
});

test('the guard counts MCP dispatches optimistically and never rejects a call', async () => {
  const recorded = [];
  const host = makeHost({ key: 'sk-fixture' });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ search_pro: 10, vertical_search: 10, tts: 10000, asr: 18000 }, recorded) });
  await mcp.rearm();
  assert.equal(host.guards.length, 1);
  const guard = host.guards[0];
  // guard 在派发前运行、拿不到成功与否 → 只能乐观计数；口径由官方回源对齐。
  // 真实 exec 的形状是 { name, callId, arguments, signal, … }（dsh-tools/lib/pipeline.js
  // createExecution），**没有 exec.tool** —— 早先只按 exec.tool.name 写测试会漏掉真形状。
  assert.equal(guard({ name: 'mcp__EnhancedSearch__search_pro', callId: 'c1' }), undefined);
  assert.deepEqual(recorded, [['search_pro', 1]], '增强搜索只记自己那项额度');
  assert.equal(guard({ tool: { name: 'mcp__VerticalSearch__image_search' } }), undefined);
  assert.deepEqual(recorded, [['search_pro', 1], ['vertical_search', 1]], '垂类搜索记自己的额度');
  // 语音两项没有服务端内置工具类型，只能按权益键记账；漏了映射会被静默丢弃。
  assert.equal(guard({ name: 'mcp__TextGenerateSpeech__bailian_tts' }), undefined);
  assert.equal(guard({ name: 'mcp__SpeechGenerateText__bailian_asr' }), undefined);
  assert.deepEqual(recorded.slice(2), [['tts', 1], ['asr', 1]], '语音权益也要记上（无实参时退回按次估算）');
  // 非 MCP 工具、未注册的服务都不记账，也一律放行。
  assert.equal(guard({ tool: { name: 'web_search' } }), undefined);
  assert.equal(guard({ tool: { name: 'mcp__Unknown__x' } }), undefined);
  assert.equal(recorded.length, 4);
  mcp.dispose();
  assert.equal(host.guards.length, 0, 'dispose 必须撤掉 guard');
});

test('callTool uses the host-adapted definition and its real schema instead of guessed names', async () => {
  const seen = [];
  const defs = [{
    name: 'mcp__TextGenerateImage__bailian_text_to_image',
    description: 'text to image',
    parameters: { type: 'object', properties: { prompt: { type: 'string' }, size: { type: 'string' } } },
    execute: async (args) => { seen.push(args); return { content: [{ type: 'text', text: 'ok' }] }; },
  }];
  const host = makeHost({ key: 'sk-fixture', defs });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ image_generation: 20 }) });
  await mcp.rearm();
  const result = await mcp.callTool('TextGenerateImage', {}, (candidates) => ({ rawName: candidates[0].name, definition: defs[0] }),
    (schema) => ({ prompt: 'p', ...(schema.properties.size ? { size: '1024*1024' } : {}) }));
  assert.equal(result.tool, 'bailian_text_to_image');
  assert.deepEqual(seen, [{ prompt: 'p', size: '1024*1024' }]);
  assert.equal(mcp.status().servers.find((s) => s.service === 'TextGenerateImage').lastTool, 'bailian_text_to_image');
  // 工具还没同步过来时明确报「尚未就绪」，让调用方回落而不是静默失败。
  host.defs.length = 0;
  await assert.rejects(mcp.callTool('TextGenerateImage', {}, () => null, () => ({})), /尚未就绪/);
  mcp.dispose();
});

test('off mode and a host without mcpManager degrade to credits without throwing', async () => {
  const off = registerEquityMcp(makeHost({ key: 'sk-fixture' }).ctx, { mode: 'off' });
  assert.equal(off.status().enabled, false);
  assert.equal(off.usesEquity('image_generation'), false);
  assert.equal(equityChannel('image_generation', off.status()), 'credits');
  await assert.rejects(off.callTool('TextGenerateImage', {}, () => null, () => ({})), /未启用/);
  off.dispose();

  const noManager = registerEquityMcp({ get: () => undefined }, {});
  assert.equal(noManager.status().reason, 'no-manager');
  assert.deepEqual(noManager.mountedServices(), []);
  noManager.dispose();
});

// 冷启动竞态回归：宿主 mcp-manager 是独立插件，重启 App 时可能比本插件晚就绪。
// 旧实现在 apply 时抓一次 manager 就定死，导致整条权益通道永久降级（热重载时看不出来）。
test('a manager that appears later is picked up instead of degrading forever', async () => {
  const host = makeHost({ key: 'sk-fixture', managerLate: true });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ image_generation: 20 }) });
  await mcp.rearm();
  assert.equal(host.registered.size, 0, 'manager 未就绪时不挂');
  assert.equal(mcp.status().reason, 'no-manager');
  assert.equal(mcp.usesEquity('image_generation'), false, '未就绪不得声称走权益');
  assert.equal(equityChannel('image_generation', mcp.status()), 'credits');
  // 宿主就绪后，下一次重算必须接上（权益回源/凭据更新/轮询都会触发 rearm）。
  host.bringManagerUp();
  await mcp.rearm();
  assert.equal(host.registered.size, 7, 'manager 就绪后七项全挂');
  assert.equal(mcp.status().reason, 'mounted');
  assert.equal(mcp.usesEquity('image_generation'), true);
  mcp.dispose();
});

test('dispose unmounts every service and stays idempotent', async () => {
  const host = makeHost({ key: 'sk-fixture' });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ image_generation: 20 }) });
  await mcp.rearm();
  assert.equal(host.registered.size, 7);
  mcp.dispose();
  assert.equal(host.registered.size, 0);
  mcp.dispose();
  mcp.refresh();
  assert.equal(host.registered.size, 0, 'dispose 后 refresh 不得复活服务');
});
test('Q5 MCP guard 按真实计量单位记账：tts 字符 / 生图 张 / 搜索 次', async () => {
  const recorded = [];
  const host = makeHost({ key: 'sk-fixture' });
  const mcp = registerEquityMcp(host.ctx, {
    budget: budgetOf({ tts: 10000, image_generation: 50, search_pro: 100 }, recorded),
  });
  await mcp.rearm();
  const guard = host.guards[0];
  // 上游真实 schema（本会话对宿主 MCP 服务实调确认）：语音是 text，生图是 prompt + n。
  const text = '你好'.repeat(50); // 100 字符
  guard({ name: 'mcp__TextGenerateSpeech__bailian_tts', callId: 'c1', arguments: { text, voice: '温柔女声' } });
  assert.deepEqual(recorded.at(-1), ['tts', 100], '按字符计：合成 100 字符要记 100，不是 1');
  guard({ name: 'mcp__TextGenerateImage__bailian_image_gen', callId: 'c2', arguments: { prompt: 'p', n: 3 } });
  assert.deepEqual(recorded.at(-1), ['image_generation', 3], '按张计：一次三张要记 3');
  guard({ name: 'mcp__TextGenerateImage__bailian_image_gen', callId: 'c3', arguments: { prompt: 'p' } });
  assert.deepEqual(recorded.at(-1), ['image_generation', 1], 'n 缺省按一张');
  guard({ name: 'mcp__EnhancedSearch__search_pro', callId: 'c4', arguments: { query: 'q' } });
  assert.deepEqual(recorded.at(-1), ['search_pro', 1], '按次计的服务不受影响');
  // 越界/非数字的 n 不许放大记账（上游会拒或忽略，本地按合法范围收敛）。
  guard({ name: 'mcp__TextGenerateImage__bailian_image_gen', callId: 'c5', arguments: { prompt: 'p', n: 99 } });
  assert.deepEqual(recorded.at(-1), ['image_generation', 4], 'n 超上限按上游上限 4 记');
  mcp.dispose();
});

// Q5 的另一半：asr 按**秒**计，但入参只有音频 URL，派发时无法知道时长（先记 1 秒占位）。
// 上游 MCP 响应实测（2026-11-25 本会话实调）只有 { request_id, results:[转写文本] }，没有时长字段，
// 所以真实秒数在 tools/result 里按转写文本量补记差额；一律停在 1 秒会让 5 小时额度永远用不完。
test('Q5 asr 秒数在 tools/result 里补记：转写 400 字 ≈ 100 秒，而不是永远 1 秒', async () => {
  const recorded = [];
  const host = makeHost({ key: 'sk-fixture' });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ asr: 18000 }, recorded) });
  await mcp.rearm();
  const guard = host.guards[0];
  const exec = { name: 'mcp__SpeechGenerateText__bailian_speech_to_text', callId: 'a1', arguments: { file_urls: ['https://x.test/a.wav'] } };
  guard(exec);
  assert.deepEqual(recorded, [['asr', 1]], '派发时先记 1 秒占位');
  // 宿主真实形状：MCP 适配定义把上游 JSON 放在 content[].text 里（没有 structuredContent）。
  const transcript = '语音识别'.repeat(100); // 400 个汉字
  host.emitResult(exec, { isError: false, value: { content: [{ type: 'text', text: JSON.stringify({ request_id: 'r1', results: [transcript] }) }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recorded, [['asr', 1], ['asr', 99]], '补记到 100 秒（差额 99），不是再加一次 1');
  // 同一次调用只校正一次：宿主可能重复投递，重复补记会把额度扣穿。
  host.emitResult(exec, { isError: false, value: { content: [{ type: 'text', text: JSON.stringify({ results: [transcript] }) }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recorded.length, 2, '同一 callId 不得重复补记');
  mcp.dispose();
});

test('Q5 asr 校正只认自己派发过的调用，失败调用与无文本结果不补记', async () => {
  const recorded = [];
  const host = makeHost({ key: 'sk-fixture' });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ asr: 18000 }, recorded) });
  await mcp.rearm();
  const guard = host.guards[0];
  const name = 'mcp__SpeechGenerateText__bailian_speech_to_text';
  // 失败调用：保持占位，不按空文本补记（口径由官方回源对齐）。
  guard({ name, callId: 'e1', arguments: {} });
  host.emitResult({ name, callId: 'e1' }, { isError: true, error: new Error('boom') });
  // 没经 guard 记过账的调用（例如挂载前就派发的）不得凭空补记。
  host.emitResult({ name, callId: 'never-dispatched' }, { isError: false, value: { content: [{ type: 'text', text: JSON.stringify({ results: ['字'.repeat(400)] }) }] } });
  // 成功但没有转写文本（上游只回 request_id）：不猜数。
  guard({ name, callId: 'e2', arguments: {} });
  host.emitResult({ name, callId: 'e2' }, { isError: false, value: { content: [{ type: 'text', text: JSON.stringify({ request_id: 'r' }) }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recorded, [['asr', 1], ['asr', 1]], '只有两次派发占位，没有任何补记');
  mcp.dispose();
  assert.equal(host.resultListenerCount(), 0, 'dispose 必须撤掉 tools/result 观察器');
});

test('Q5 asr 上游若给出明确时长就按它记账，不用估算', async () => {
  const recorded = [];
  const host = makeHost({ key: 'sk-fixture' });
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ asr: 18000 }, recorded) });
  await mcp.rearm();
  const guard = host.guards[0];
  const name = 'mcp__SpeechGenerateText__bailian_speech_to_text';
  guard({ name, callId: 'd1', arguments: {} });
  // 秒：duration；毫秒：end_time（paraformer 句末时间即音频长度）。明确值优先于文本估算。
  host.emitResult({ name, callId: 'd1' }, { isError: false, value: { structuredContent: { duration: 42, results: ['字'.repeat(400)] } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recorded.at(-1), ['asr', 41], '上游说 42 秒就记 42 秒');
  guard({ name, callId: 'd2', arguments: {} });
  host.emitResult({ name, callId: 'd2' }, { isError: false, value: { structuredContent: { sentences: [{ text: 'x', end_time: 90_000 }] } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recorded.at(-1), ['asr', 89], 'end_time 是毫秒，90000ms = 90 秒');
  mcp.dispose();
});

// 纯函数边界：上游形状各家不同，估算口径必须只在**转写正文**上数字符，
// 且拿不到任何线索时返回 null（保持占位、不猜数），不能凭空造出秒数。
test('Q5 asrSecondsFromResult 只数转写正文，拿不到线索就不猜数', () => {
  const text = '字'.repeat(400);
  // 上游 JSON 整段塞在 content[].text 里（宿主真实形状）：request_id 不算语音内容。
  assert.equal(asrSecondsFromResult({ content: [{ type: 'text', text: JSON.stringify({ request_id: 'r'.repeat(64), results: [text] }) }] }), 100);
  // 纯文本转写（没有 JSON 包装）也要认。
  assert.equal(asrSecondsFromResult({ content: [{ type: 'text', text }] }), 100);
  // 句级结构：sentences[].text 逐句累加；end_time 明确值优先。
  assert.equal(asrSecondsFromResult({ structuredContent: { sentences: [{ text: '字'.repeat(200) }, { text: '字'.repeat(200) }] } }), 100);
  // 只有 request_id / 空结果 / 非对象 → null（不猜数）。
  assert.equal(asrSecondsFromResult({ content: [{ type: 'text', text: JSON.stringify({ request_id: 'r' }) }] }), null);
  assert.equal(asrSecondsFromResult({ content: [] }), null);
  assert.equal(asrSecondsFromResult(undefined), null);
  assert.equal(asrSecondsFromResult({ structuredContent: { results: [] } }), null);
  // 明确时长的三种写法都认，且优先于文本估算。
  assert.equal(asrSecondsFromResult({ structuredContent: { duration: 7, results: [text] } }), 7);
  assert.equal(asrSecondsFromResult({ structuredContent: { duration_ms: 7_400 } }), 8, '毫秒向上取整');
  assert.equal(asrSecondsFromResult({ structuredContent: { sentences: [{ end_time: 1_000 }, { end_time: 12_000 }] } }), 12, '取最大句末时间');
  // 循环引用不得栈溢出（上游 JSON 解开后理论上无环，但结构化内容可能自引用）。
  const cyclic = { results: [text] };
  cyclic.self = cyclic;
  assert.equal(asrSecondsFromResult({ structuredContent: cyclic }), 100);
  // 估算向上取整：401 字 → 101 秒（宁可略微高估，不让余额虚高）。
  assert.equal(asrSecondsFromResult({ structuredContent: { results: ['字'.repeat(401)] } }), 101);
});

test('Q5 equityUnitsForDispatch 的单位口径与脏值收敛', () => {
  assert.equal(equityUnitsForDispatch('tts', { text: '你好世界' }), 4);
  assert.equal(equityUnitsForDispatch('tts', {}), 1, '拿不到文本时退回按次');
  assert.equal(equityUnitsForDispatch('tts', { text: 123 }), 1, '非字符串不当字符数');
  assert.equal(equityUnitsForDispatch('image_generation', { n: 2 }), 2);
  assert.equal(equityUnitsForDispatch('image_generation', { n: 0 }), 1);
  assert.equal(equityUnitsForDispatch('image_generation', { n: -5 }), 1);
  assert.equal(equityUnitsForDispatch('image_generation', { n: 2.9 }), 2, '小数取整不放大');
  assert.equal(equityUnitsForDispatch('image_generation', { n: '3' }), 3, '数字字符串可接受');
  assert.equal(equityUnitsForDispatch('image_generation', { n: NaN }), 1);
  assert.equal(equityUnitsForDispatch('search_pro', { query: 'x'.repeat(500) }), 1, '按次计的服务不受入参长度影响');
  assert.equal(equityUnitsForDispatch('asr', { file_urls: ['https://x/a.wav'] }), 1, 'asr 派发时只有占位');
  assert.equal(equityUnitsForDispatch('tts', undefined), 1);
});
