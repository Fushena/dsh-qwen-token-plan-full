import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_HOSTS, EQUITY_MCP_SERVICES, VIDEO_MCP_SERVICE,
  normalizeMcpMode, shouldMountService, suppressedBuiltins,
  serverOfToolName, equityKeysOfService, mcpToolPrefix,
  registerEquityMcp, filterMcpShadowedBuiltins, equityChannel,
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
  const requestTools = [{ name: 'mcp__EnhancedSearch__search_pro' }];
  assert.deepEqual(filterMcpShadowedBuiltins(['web_search', 'web_extractor'], mcp, requestTools).tools, ['web_extractor']);

  remaining.search_pro = 0;
  mcp.refresh();
  assert.ok(!mcp.mountedServices().includes('EnhancedSearch'), '增强搜索额度耗尽 → 摘 EnhancedSearch');
  assert.deepEqual(filterMcpShadowedBuiltins(['web_search', 'web_extractor'], mcp, requestTools).tools, ['web_search', 'web_extractor']);
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
  assert.deepEqual(filterMcpShadowedBuiltins(['web_search'], mcp, [{ name: 'mcp__EnhancedSearch__search_pro' }]).tools, ['web_search']);
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
  const mcp = registerEquityMcp(host.ctx, { budget: budgetOf({ search_pro: 10, vertical_search: 10 }, recorded) });
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
  assert.deepEqual(recorded.slice(2), [['tts', 1], ['asr', 1]], '语音权益也要记上');
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
