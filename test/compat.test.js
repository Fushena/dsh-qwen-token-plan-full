import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { Config, default as plugin } from '../index.js';
import { buildRequestBody } from '../lib/content.js';
import { buildChatRequestBody, chatToDshChunks } from '../lib/chat.js';
import { responsesToDshChunks } from '../lib/responses-sse.js';
import { resolveApiKey } from '../lib/apikey.js';
import { httpFailure } from '../lib/errors.js';
import { QwenTokenPlanAdapter } from '../lib/adapter.js';
import { registerMediaTools } from '../lib/media-tools.js';
import { normalizeHarnessMode } from '../lib/harness.js';
import { HarnessBudget } from '../lib/budget.js';
import { BUILTIN_CATALOG, DynamicCatalog } from '../lib/catalog.js';
const qwen = BUILTIN_CATALOG.models.find(m => m.id === 'qwen3.8-flash');
const glm = BUILTIN_CATALOG.models.find(m => m.transport === 'chat');
const tool = { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: {} } };
const opts = (extra = {}) => ({ model: qwen.id, messages: [], tools: [], ...extra });
function sse(events) { return new Response(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('')).body; }
async function collect(stream) { const chunks=[]; for await(const c of stream) chunks.push(c); return chunks; }
function assemble(chunks) { const a=new BlockAssembler(); for(const c of chunks) a.push(c); return a; }

test('DSH loader receives a Config schema and the credential-ref field', () => {
  assert.equal(plugin.Config, Config);
  const config=Config({harnessBudget:{maxCallsPer5h:0}});
  assert.equal(config.apiKeyEnv,'QWEN_TOKEN_PLAN_CN_API_KEY');
  assert.equal(config.harnessBudget.maxCallsPer5h,0);
  assert.equal(Config.dict.apiKeyEnv.meta.role,'credential-ref');
});
test('missing credentials become a DSH failure without exposing secrets', async () => {
  const ref='DSH_QWEN_TEST_UNSET';delete process.env[ref];
  await assert.rejects(resolveApiKey({get:()=>({resolve:async()=>undefined})},ref,'test'), e=>e.code==='MISSING_CREDENTIAL');
  assert.equal(await resolveApiKey({get:()=>({resolve:async()=>({value:' fixture '})})},ref,'test'),'fixture');
});
test('entitled harness tools take precedence over same-capability DSH functions',async()=>{
  // 权益可用时服务端内置工具优先；只有同能力的本地函数让位，其余本地工具保留。
  const body=await buildRequestBody(opts({tools:[tool]}),qwen,undefined,qwen.harnessTools);
  assert.ok(!body.tools.some(t=>t.type==='function'&&t.name==='web_search'));
  assert.ok(body.tools.some(t=>t.type==='code_interpreter'));
  assert.ok(body.tools.some(t=>t.type==='web_search'),'内置 web_search 应被声明');
  assert.ok(body.tools.some(t=>t.type==='web_extractor'),'web_extractor 随 web_search 声明');
});
test('exhausted harness entitlements fall back to the DSH functions of the same capability',async()=>{
  // 权益耗尽后 adapter 传空 harnessTools：本地函数必须原样回来。
  const body=await buildRequestBody(opts({tools:[tool]}),qwen,undefined,[]);
  const fn=body.tools.find(t=>t.name==='web_search');
  assert.equal(fn.type,'function');
  assert.ok(!body.tools.some(t=>t.type==='web_search'));
});
test('normal mode excludes provider built-ins while preserving DSH functions',async()=>{
  const body=await buildRequestBody(opts({reasoningEffort:'none',tools:[tool]}),qwen,undefined,qwen.harnessTools);
  assert.equal(body.reasoning.effort,'none');
  assert.ok(body.tools.every(t=>t.type==='function'));
  assert.equal(body.tools[0].name,'web_search');
});
test('model defaults and aliases resolve for both request protocols',async()=>{
  const defaultBody=await buildRequestBody(opts(),qwen,undefined,[]);
  assert.equal(defaultBody.reasoning.effort,qwen.defaultReasoningEffort);
  assert.equal((await buildRequestBody(opts({reasoningEffort:'high'}),qwen,undefined,[])).reasoning.effort,'xhigh');
  const body=await buildChatRequestBody(opts({reasoningEffort:'xhigh'}),glm);
  assert.equal(body.reasoning_effort,glm.reasoningAliases.xhigh);
  assert.equal(body.enable_thinking,true);
});
test('rejected GLM efforts are refused before any HTTP request',async()=>{
  await assert.rejects(buildChatRequestBody(opts({reasoningEffort:'none'}),BUILTIN_CATALOG.models.find(m=>m.transport==='chat' && m.rejectedReasoningEfforts?.includes('none'))),e=>e.code==='UNSUPPORTED_OPTION');
});
test('DSH 0.2 tool result messages retain call ids on both protocols',async()=>{
  const messages=[{role:'assistant',content:[{type:'tool-call',id:'call_1',name:'web_search',arguments:'{"q":"x"}'}]}, {role:'tool',toolCallId:'call_1',content:[{type:'text',text:'result'}]}];
  const r=await buildRequestBody(opts({messages}),qwen,undefined,[]);
  assert.equal(r.input[1].type,'function_call_output');assert.equal(r.input[1].call_id,'call_1');
  const c=await buildChatRequestBody(opts({messages}),glm);
  assert.equal(c.messages[1].tool_call_id,'call_1');assert.equal(c.messages[1].content,'result');
});
test('Responses tool-call streams assemble with the real DSH BlockAssembler',async()=>{
  const chunks=await collect(responsesToDshChunks(sse([
    {type:'response.output_item.added',output_index:0,item:{type:'function_call',call_id:'call_1',name:'web_search',arguments:''}},
    {type:'response.function_call_arguments.delta',output_index:0,delta:'{"q":"x"}'},
    {type:'response.output_item.done',output_index:0,item:{type:'function_call',arguments:'{"q":"x"}'}},
    {type:'response.completed',response:{usage:{input_tokens:20,output_tokens:5}}}
  ])));
  const a=assemble(chunks);assert.equal(a.finish.kind,'tool-calls');assert.equal(a.blocks()[0].name,'web_search');assert.equal(a.blocks()[0].arguments,'{"q":"x"}');
});
test('Chat tool-call fragments assemble and replay through DSH',async()=>{
  const chunks=await collect(chatToDshChunks(sse([
    {choices:[{delta:{tool_calls:[{index:0,id:'call_1',function:{name:'web_search',arguments:'{"q":'}}]}}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"x"}'}}]},finish_reason:'tool_calls'}]}
  ])));
  const a=assemble(chunks);assert.equal(a.finish.kind,'tool-calls');assert.equal(a.blocks()[0].arguments,'{"q":"x"}');
});
const sseData = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`;

for (const [protocol, parse, payload] of [
  ['Responses', responsesToDshChunks, [
    {type:'response.output_item.added', output_index:0, item:{type:'message'}},
    {type:'response.output_text.delta', output_index:0, delta:'hello'},
    {type:'response.output_item.done', output_index:0, item:{type:'message'}},
    {type:'response.completed', response:{usage:{input_tokens:5, output_tokens:1}}},
  ].map(sseData).join('')],
  ['Chat', chatToDshChunks, [
    {choices:[{delta:{content:'hello'}, finish_reason:'stop'}]},
    {choices:[], usage:{prompt_tokens:5, completion_tokens:1}},
  ].map(sseData).join('') + 'data: [DONE]\r\n\r\n'],
]) {
  test(`${protocol} emits usage and finish before the stream closes`, async () => {
    let controller;
    let cancelled = false;
    const body = new ReadableStream({
      start(streamController) {
        controller = streamController;
        controller.enqueue(new TextEncoder().encode(payload));
      },
      cancel() { cancelled = true; },
    });
    let timeout;
    try {
      const chunks = await Promise.race([
        collect(parse(body)),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Stream waited for EOF')), 1000);
        }),
      ]);
      assert.deepEqual(chunks.at(-2), {type:'usage', usage:{inputTokens:5, outputTokens:1}});
      assert.deepEqual(chunks.at(-1), {type:'finish', reason:{kind:'stop'}});
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    } finally {
      clearTimeout(timeout);
      if (!cancelled) controller.close();
    }
  });
}

test('stream truncation is reported rather than finishing an incomplete turn',async()=>{
  await assert.rejects(collect(responsesToDshChunks(sse([]))),e=>e.code==='STREAM_CLOSED');
});
test('provider errors map to canonical DSH context and quota failures',async()=>{
  assert.equal(httpFailure(400,'maximum context length exceeded'),'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(httpFailure(400,'context setting is invalid'),'PROVIDER_ERROR');
  assert.equal(httpFailure(429,'rate limit exceeded'),'RATE_LIMIT');
  assert.equal(httpFailure(429,'insufficient_quota'),'QUOTA');
  const chunks=await collect(responsesToDshChunks(sse([{type:'response.failed',response:{error:{code:'context_length_exceeded',message:'maximum context length exceeded'}}}])));
  assert.equal(chunks.at(-1).reason.failure.code,'CONTEXT_WINDOW_EXCEEDED');
});
test('gateway 5xx maps to retryable SERVER instead of SERVER_ERROR',()=>{
  // dsh-llm 的 DEFAULT_RETRYABLE_CODES 只认 SERVER；写成 SERVER_ERROR 会让 5xx
  // 永远不会被 llm-retry 重试（回归：lib/errors.js 第 10 行）。
  assert.equal(httpFailure(500,'internal server error'),'SERVER');
  assert.equal(httpFailure(502,'bad gateway'),'SERVER');
  assert.equal(httpFailure(503,'service unavailable'),'SERVER');
  // 4xx 语义不受影响。
  assert.equal(httpFailure(404,'not found'),'PROVIDER_ERROR');
});

test('truncated streams keep max-tokens semantics instead of STREAM_CLOSED',async()=>{
  // 场景 1：max_output_tokens 截断时仍有未闭合 text 块 → 不再抛 STREAM_CLOSED，
  // finish.reason 必须是 max-tokens，且已流出的文本不能丢（回归：lib/responses-sse.js）。
  const unclosed=await collect(responsesToDshChunks(sse([
    {type:'response.output_item.added',output_index:0,item:{type:'message'}},
    {type:'response.output_text.delta',output_index:0,delta:'partial-text'},
    {type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:10,output_tokens:3}}},
  ])));
  assert.deepEqual(unclosed.at(-1),{type:'finish',reason:{kind:'max-tokens'}});
  assert.deepEqual(unclosed.at(-2),{type:'usage',usage:{inputTokens:10,outputTokens:3}});
  const assembled=assemble(unclosed);
  assert.equal(assembled.finish.kind,'max-tokens');
  assert.equal(assembled.blocks().filter(b=>b.type==='text').map(b=>b.text).join(''),'partial-text');
  // 场景 2：文本块已闭合的 incomplete 仍是 max-tokens。
  const closed=await collect(responsesToDshChunks(sse([
    {type:'response.output_item.added',output_index:0,item:{type:'message'}},
    {type:'response.output_text.delta',output_index:0,delta:'closed-text'},
    {type:'response.output_item.done',output_index:0,item:{type:'message',content:[{type:'text',text:'closed-text'}]}},
    {type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}},
  ])));
  assert.equal(closed.at(-1).reason.kind,'max-tokens');
  // 对照：真正没有终止事件的截断仍然是 STREAM_CLOSED（上面已有用例，这里再确认一次语义边界）。
  await assert.rejects(collect(responsesToDshChunks(sse([
    {type:'response.output_item.added',output_index:0,item:{type:'message'}},
    {type:'response.output_text.delta',output_index:0,delta:'x'},
  ]))),e=>e.code==='STREAM_CLOSED');
});

test('harness activity dedupes by output_index even without item ids',async()=>{
  // 同一个 web_search_call 的 added+done 只能计一次权益调用；不同 output_index
  // 的两次真实调用必须计两次（回归：mergeHarnessActivity 旧实现用 item.id 作键，
  // 不带 id 的 qwen 工具项会被 added/done 各计一次，多扣一倍预算）。
  const count=async(events)=>{let uses=0;for await(const c of responsesToDshChunks(sse(events),undefined,()=>{uses+=1;})) void c;return uses;};
  // 不带 id、同一 output_index：1 次。
  assert.equal(await count([
    {type:'response.output_item.added',output_index:2,item:{type:'web_search_call',status:'in_progress'}},
    {type:'response.output_item.done',output_index:2,item:{type:'web_search_call',status:'completed'}},
    {type:'response.completed',response:{usage:{}}},
  ]),1);
  // 带 id、同一 output_index：也仍是 1 次。
  assert.equal(await count([
    {type:'response.output_item.added',output_index:2,item:{type:'web_search_call',id:'ws_1',status:'in_progress'}},
    {type:'response.output_item.done',output_index:2,item:{type:'web_search_call',id:'ws_1',status:'completed'}},
    {type:'response.completed',response:{usage:{}}},
  ]),1);
  // 两个不同 output_index 的真实调用：2 次。
  assert.equal(await count([
    {type:'response.output_item.added',output_index:2,item:{type:'web_search_call',status:'in_progress'}},
    {type:'response.output_item.done',output_index:2,item:{type:'web_search_call',status:'completed'}},
    {type:'response.output_item.added',output_index:3,item:{type:'web_search_call',status:'in_progress'}},
    {type:'response.output_item.done',output_index:3,item:{type:'web_search_call',status:'completed'}},
    {type:'response.completed',response:{usage:{}}},
  ]),2);
});

test('adapter sends conflict-free schemas and attribution using real DSH classes',async()=>{
  let body,headers;
  const adapter=new QwenTokenPlanAdapter({ctx:{get:()=>({resolve:async()=>({value:'fixture'})})},catalog:{find:()=>qwen},providerId:'test',displayName:'test',apiKeyEnv:'TEST',pluginName:'test',endpoint:'https://example.invalid/responses',harnessMode:normalizeHarnessMode('auto'),fetchImpl:async(_url,init)=>{
    body=JSON.parse(init.body);headers=init.headers;
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{}})+'\n\n');
  }});
  await collect(adapter.stream(opts({tools:[tool]})));
  // 内置工具优先：本地 web_search 让位；其余能力照常声明。
  assert.ok(!body.tools.some(t=>t.type==='function'&&t.name==='web_search'));
  assert.ok(Object.keys(headers).some(k=>/user-agent/i.test(k)));
});

test('adapter request timeout and network failures become retryable codes',async()=>{
  // 网络类失败必须归到 TRANSPORT（可重试），超时归到 TIMEOUT；旧实现抛 NETWORK，
  // 不在 DSH 的 DEFAULT_RETRYABLE_CODES 里，一次抖动就终结本轮（回归：lib/timeout.js）。
  const base={ctx:{get:()=>({resolve:async()=>({value:'fixture'})})},catalog:{find:()=>qwen},providerId:'test',displayName:'test',apiKeyEnv:'TEST',pluginName:'test',endpoint:'https://example.invalid/responses',harnessMode:normalizeHarnessMode('none')};
  // ① 连接失败（undici 的 TypeError('fetch failed')）→ TRANSPORT。
  const netAdapter=new QwenTokenPlanAdapter({...base,fetchImpl:async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});}});
  await assert.rejects(collect(netAdapter.stream(opts())),e=>e.code==='TRANSPORT');
  // ② 请求迟迟拿不到响应 → 我们自己的超时触发 → TIMEOUT（不是干等 undici 的 300 秒）。
  const timeoutAdapter=new QwenTokenPlanAdapter({...base,requestTimeoutMs:30,fetchImpl:(_url,init)=>new Promise((_,reject)=>{
    const onAbort=()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
    init.signal.addEventListener('abort',onAbort,{once:true});
  })});
  await assert.rejects(collect(timeoutAdapter.stream(opts())),e=>e.code==='TIMEOUT');
  // ③ 用户主动取消仍然报 ABORTED（绝不被重试）。
  const controller=new AbortController();
  const cancelAdapter=new QwenTokenPlanAdapter({...base,requestTimeoutMs:30,fetchImpl:(_url,init)=>new Promise((_,reject)=>{
    const onAbort=()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
    init.signal.addEventListener('abort',onAbort,{once:true});
  })});
  const pending=(async()=>{for await(const _ of cancelAdapter.stream(opts({signal:controller.signal}))) void _;})();
  setTimeout(()=>controller.abort(),5);
  await assert.rejects(pending,e=>e.code==='ABORTED');
  // ④ 默认超时是 60 秒（够等慢响应，又不至于干等 5 分钟）。
  assert.equal(new QwenTokenPlanAdapter({...base,fetchImpl:async()=>new Response('')}).requestTimeoutMs,60_000);
});

test('video tool forwards duration and clamps invalid values',async()=>{
  const definitions=[];const submits=[];
  const credentials={resolve:async()=>({value:'fixture'})};
  const workingDirectory={ensure:async()=>'/tmp'};
  const ctx={get:name=>name==='credentials'?credentials:workingDirectory,tools:{register:def=>{definitions.push(def);return ()=>{};}}};
  // 提交即成功（task_status=SUCCEEDED + video_url），跳过轮询等待；下载 URL 返回小文件流。
  const dispose=registerMediaTools(ctx,{apiKeyEnv:'TEST',pluginName:'test',origin:'https://example.invalid',chatEndpoint:'https://example.invalid/chat',imageModels:['image'],videoModels:['video'],defaultImageModel:'image',defaultVideoModel:'video',fetchImpl:async(u,init)=>{
    if(String(u).includes('video-synthesis')){
      submits.push(JSON.parse(init.body));
      return Response.json({output:{task_id:'t1',task_status:'SUCCEEDED',video_url:'https://example.invalid/v.mp4'},usage:{duration:15}});
    }
    return new Response('x',{headers:{'content-type':'video/mp4'}});
  }});
  const videoTool=definitions[1];
  // 合法 duration 透传
  await videoTool.execute({prompt:'p',duration:15},{agent:{},signal:new AbortController().signal});
  // 非法值（超范围 / 缺失）→ 不传 duration
  await videoTool.execute({prompt:'p',duration:30},{agent:{},signal:new AbortController().signal});
  await videoTool.execute({prompt:'p'},{agent:{},signal:new AbortController().signal});
  assert.equal(submits[0].parameters.duration,15);
  assert.equal(submits[1].parameters?.duration,undefined);
  assert.equal(submits[2].parameters,undefined);
  dispose();
});

test('image tool rejects n above remaining image entitlement before charging',async()=>{
  // 剩 1 张时请求 n=4 必须在发出 HTTP 之前就被拒（回归：旧实现只判 remaining<=0，
  // 于是「剩 1 张」仍会一次生成 4 张，多出的按套餐外 88 折后付费）。
  const dir=mkdtempSync(path.join(os.tmpdir(),'qtpf-img-'));
  try {
    const definitions=[];const recorded=[];let requests=0;
    const credentials={resolve:async()=>({value:'fixture'})};
    const workingDirectory={ensure:async()=>dir};
    const ctx={get:name=>name==='credentials'?credentials:workingDirectory,tools:{register:def=>{definitions.push(def);return ()=>{};}}};
    const budget={equityState:()=>({key:'image_generation',used:19,quota:20,remaining:1,unit:'张',source:'local'}),
      record:(key,count)=>{recorded.push([key,count]);return null;}};
    const dispose=registerMediaTools(ctx,{apiKeyEnv:'TEST',pluginName:'test',origin:'https://example.invalid',chatEndpoint:'https://example.invalid/chat',imageModels:['image'],videoModels:['video'],defaultImageModel:'image',defaultVideoModel:'video',budget,fetchImpl:async()=>{
      requests+=1;return Response.json({choices:[{message:{content:[{type:'image',image:'https://example.invalid/r.png'}]}}]});
    }});
    const imageTool=definitions[0];
    const exec={agent:{},signal:new AbortController().signal};
    // 剩 1 张 + n=4 → 拒绝并说明剩余量，且不发出任何请求、不记账。
    await assert.rejects(imageTool.execute({prompt:'p',n:4},exec),/仅剩 1 张/);
    assert.equal(requests,0,'额度不足时不得先请求再算账');
    assert.deepEqual(recorded,[]);
    // 剩 1 张 + n=1 → 正常生成，按实际张数（1）记账。
    const result=await imageTool.execute({prompt:'p',n:1},exec);
    assert.equal(result.count,1);
    assert.deepEqual(recorded,[['image_generation',1]]);
    // 额度耗尽（remaining=0，n=1）同样拒绝。
    budget.equityState=()=>({key:'image_generation',used:20,quota:20,remaining:0,unit:'张',source:'local'});
    await assert.rejects(imageTool.execute({prompt:'p',n:1},exec),/仅剩 0 张/);
    dispose();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('image tool counts each downloaded image even when a later download fails', async () => {
  // 回归（2026-11-13）：旧实现全部下载成功才 record(paths.length)，中途失败/abort
  // → 已落盘的那几张全漏计 → 本地额度高估。每张成功即计 1，失败时已成功的仍计入。
  const dir=mkdtempSync(path.join(os.tmpdir(),'qtpf-img-partial-'));
  try {
    const definitions=[];const recorded=[];
    const credentials={resolve:async()=>({value:'fixture'})};
    const workingDirectory={ensure:async()=>dir};
    const ctx={get:name=>name==='credentials'?credentials:workingDirectory,tools:{register:def=>{definitions.push(def);return ()=>{};}}};
    const budget={equityState:()=>({key:'image_generation',used:0,quota:20,remaining:20,unit:'张',source:'local'}),
      record:(key,count)=>{recorded.push([key,count]);return null;}};
    const dispose=registerMediaTools(ctx,{apiKeyEnv:'TEST',pluginName:'test',origin:'https://example.invalid',chatEndpoint:'https://example.invalid/chat',imageModels:['image'],videoModels:['video'],defaultImageModel:'image',defaultVideoModel:'video',budget,fetchImpl:async(url)=>{
      if(String(url).endsWith('/chat'))return Response.json({choices:[{message:{content:[{type:'image',image:'https://example.invalid/a.png'},{type:'image',image:'https://example.invalid/b.png'}]}}]});
      if(String(url).endsWith('/b.png'))throw new Error('download boom');
      return new Response('x',{headers:{'content-type':'image/png'}});
    }});
    const imageTool=definitions[0];
    const exec={agent:{},signal:new AbortController().signal};
    await assert.rejects(imageTool.execute({prompt:'p',n:2},exec),/download boom/);
    assert.deepEqual(recorded,[['image_generation',1]],'第一张已落盘：失败也必须计入（旧实现 record=[]）');
    assert.equal(readdirSync(dir).filter(f=>f.startsWith('qwen-image')).length,1,'第一张确实已落盘');
    dispose();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('media tools propagate DSH directory errors instead of writing elsewhere',async()=>{
  const definitions=[];let requests=0;
  const credentials={resolve:async()=>({value:'fixture'})};
  const workingDirectory={ensure:async()=>{throw new Error('workspace unavailable')}};
  const ctx={get:name=>name==='credentials'?credentials:workingDirectory,tools:{register:def=>{definitions.push(def);return ()=>{};}}};
  const dispose=registerMediaTools(ctx,{apiKeyEnv:'TEST',pluginName:'test',origin:'https://example.invalid',chatEndpoint:'https://example.invalid/chat',imageModels:['image'],videoModels:['video'],defaultImageModel:'image',defaultVideoModel:'video',fetchImpl:async()=>{
    requests++;return Response.json({choices:[{message:{content:[{type:'image',image:'https://example.invalid/result.png'}]}}]});
  }});
  await assert.rejects(definitions[0].execute({prompt:'test'},{agent:{},signal:new AbortController().signal}),/workspace unavailable/);
  assert.equal(requests,1);dispose();
});

test('disabled budget neither counts nor blocks any entitlement',async()=>{
  const budget=new HarnessBudget({config:{harnessBudget:false},filePath:`/tmp/qtpf-test-${Date.now()}.json`});
  budget.setTier({specCode:'standard',quota:{},usage:{per1MonthPercentage:0.5,per1MonthResetTime:Date.now()+86400000},subscription:{},fetchedAt:Date.now()});
  assert.equal(budget.enabled,false);
  assert.deepEqual(budget.filterTools(['web_search','web_extractor']).tools,['web_search','web_extractor']);
  budget.record('web_search_call');
  assert.equal(budget.equityState('search_pro'),null);
  assert.deepEqual(budget.status().equityCounts,[]);
  assert.equal(budget.status().paused.any,false);
});
test('enabled budget counts per entitlement and drops exhausted tools',async()=>{
  const budget=new HarnessBudget({config:{},filePath:`/tmp/qtpf-test-${Date.now()}.json`});
  budget.setTier({specCode:'standard',quota:{},usage:{per1MonthPercentage:0.5,per1MonthResetTime:Date.now()+86400000},subscription:{},fetchedAt:Date.now()});
  for(let i=0;i<100;i++)budget.record('web_search_call');
  assert.equal(budget.equityState('search_pro').remaining,0);
  const {tools,dropped}=budget.filterTools(['web_search','web_extractor']);
  assert.deepEqual(tools,['web_extractor']);
  assert.equal(dropped[0].key,'search_pro');
  assert.equal(budget.status().paused.any,true);
});
test('official console balance overrides the local estimate and counts calls since fetch',async()=>{
  const file=`/tmp/qtpf-test-${Date.now()}-official.json`;
  const budget=new HarnessBudget({config:{},filePath:file});
  budget.setTier({specCode:'standard',quota:{},usage:{per1MonthPercentage:0.5,per1MonthResetTime:Date.now()+86400000},subscription:{},fetchedAt:Date.now()});
  // 官网只剩 3 次，本地计数此时为 0（本地估算会误判成满额 100）
  budget.setEquities([{key:'search_pro',unit:'次',available:3,total:100}]);
  assert.equal(budget.equityState('search_pro').source,'official');
  assert.equal(budget.equityState('search_pro').remaining,3);
  // 拉取之后本地又调用 2 次 → 真实剩 1
  budget.record('web_search_call');budget.record('web_search_call');
  const after=budget.equityState('search_pro');
  assert.equal(after.remaining,1);assert.equal(after.sinceFetch,2);
  // 再调 2 次 → 官网口径判定耗尽并拒绝声明（尽管本地估算还剩 96）
  budget.record('web_search_call');budget.record('web_search_call');
  assert.equal(budget.equityState('search_pro').remaining,0);
  assert.deepEqual(budget.filterTools(['web_search','web_extractor']).tools,['web_extractor']);
  assert.equal(budget.filterTools(['web_search']).dropped[0].source,'official');
});
test('budget saves atomically and restores from .bak instead of silently zeroing',async()=>{
  // 回归：旧 #load 的 catch 直接 return sanitizeState({})，一次坏读就把本周期计数
  // 清零 → 额度被放大 → 继续声明已耗尽的权益工具 → 套餐外后付费；
  // 旧 #save 直写主文件，进程中断会留下半截 JSON（就是坏读的来源）。
  const dir=mkdtempSync(path.join(os.tmpdir(),'qtpf-budget-'));
  const warns=[];
  const logger={warn:(m)=>warns.push(String(m?.message??m)),info:()=>{},debug:()=>{}};
  const file=path.join(dir,'budget.json');
  try {
    const budget=new HarnessBudget({config:{},logger,filePath:file});
    budget.setTier({specCode:'standard',quota:{},usage:{per1MonthPercentage:0.5,per1MonthResetTime:Date.now()+86400000},subscription:{},fetchedAt:Date.now()});
    for(let i=0;i<5;i++)budget.record('web_search_call');
    // 原子写：没有残留的 .tmp-*，且留了一份 .bak。
    assert.deepEqual(readdirSync(dir).filter(f=>f.includes('.tmp-')),[]);
    assert.equal(existsSync(`${file}.bak`),true,'成功保存后应有 .bak 备份');
    // 模拟崩溃留下的半截 JSON → 从 .bak 恢复计数，而不是归零。
    writeFileSync(file,'{"broken":');
    const reloaded=new HarnessBudget({config:{},logger,filePath:file});
    const state=reloaded.equityState('search_pro');
    assert.equal(state.source,'local');
    assert.ok(state.used>0,'坏读不得把计数清成 0（备份快照最多少一轮计数）');
    assert.ok(warns.some(w=>/读取失败/.test(w)),'坏读必须留下 warning，不得静默');
    assert.ok(warns.some(w=>/已另存为/.test(w)),'坏文件应被隔离成 .corrupt-<ts>');
    assert.ok(readdirSync(dir).some(f=>f.includes('.corrupt-')),'应存在 .corrupt 隔离文件');
    // 主文件与备份都坏 → 仍然要明确告警「计数已丢失」，并给出可读的兜底状态。
    writeFileSync(file,'{{{');writeFileSync(`${file}.bak`,'{{{');
    warns.length=0;
    const broken=new HarnessBudget({config:{},logger,filePath:file});
    assert.ok(warns.some(w=>/本周期权益计数丢失/.test(w)),'双坏时必须明确告知计数已丢失');
    assert.equal(existsSync(file),false,'坏文件被挪走后不应留在原位');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('stale or missing console data falls back to the local estimate',async()=>{
  const file=`/tmp/qtpf-test-${Date.now()}-stale.json`;
  const budget=new HarnessBudget({config:{},filePath:file});
  budget.setTier({specCode:'standard',quota:{},usage:{per1MonthPercentage:0.5,per1MonthResetTime:Date.now()+86400000},subscription:{},fetchedAt:Date.now()});
  // 从未拉取官网数据
  assert.equal(budget.equityState('search_pro').source,'local');
  assert.equal(budget.status().equitiesFresh,false);
  // 官网数据过期（超过默认 15 分钟）→ 退回本地
  budget.setEquities([{key:'search_pro',unit:'次',available:0,total:100}]);
  assert.equal(budget.equityState('search_pro').source,'official');
  const state=JSON.parse(readFileSync(file,'utf8'));
  state.equitiesFetchedAt=Date.now()-30*60_000;
  writeFileSync(file,JSON.stringify(state));
  const reloaded=new HarnessBudget({config:{},filePath:file});
  reloaded.setTier({specCode:'standard',quota:{},usage:{per1MonthPercentage:0.5,per1MonthResetTime:Date.now()+86400000},subscription:{},fetchedAt:Date.now()});
  assert.equal(reloaded.equityState('search_pro').source,'local');
  assert.equal(reloaded.status().equitiesFresh,false);
  assert.equal(reloaded.equityState('search_pro').remaining,100);
});

test('period rollover clears the official equities snapshot (new period falls back to local, not stale available=0)', async () => {
  // 回归（2026-11-13）：#rollover/setTier 过期分支只清 byEquity+suppressedNotifiedAt，
  // 不清 equities/equitiesFetchedAt/equityUsedAtFetch → 新周期 15min 新鲜期内仍用
  // 旧周期 available=0 → 工具被误抑制。重置后必须回落 local 兜底（新周期满额）。
  const dir=mkdtempSync(path.join(os.tmpdir(),'qtpf-rollover-'));
  const file=path.join(dir,'budget.json');
  const tierInfo={specCode:'standard',quota:{},usage:{per1MonthPercentage:0.5,per1MonthResetTime:Date.now()+86400000},subscription:{},fetchedAt:Date.now()};
  try {
    // 路径 A：#rollover —— 落盘状态锚点已过期，官网快照 available=0 且仍新鲜。
    writeFileSync(file,JSON.stringify({
      periodAnchor:Date.now()-1000,
      tier:{specCode:'standard',resetTime:Date.now()+86400000,source:'gateway'},
      byEquity:{search_pro:5},
      equities:[{key:'search_pro',unit:'次',available:0,total:100}],
      equitiesFetchedAt:Date.now(),
      equityUsedAtFetch:{},
    }));
    const a=new HarnessBudget({config:{},filePath:file});
    const stateA=a.equityState('search_pro');
    assert.equal(stateA.source,'local','新周期不得沿用旧周期官网快照（旧实现 official/0）');
    assert.equal(stateA.remaining,100,'新周期本地计数已清零 → 满额');
    assert.equal(a.status().equitiesFresh,false,'重置后官网快照视为不新鲜');

    // 路径 B：setTier 过期分支 —— 正常周期内官网 available=0，随后锚点过期再 setTier。
    const b=new HarnessBudget({config:{},filePath:file});
    b.setTier(tierInfo);
    b.setEquities([{key:'search_pro',unit:'次',available:0,total:100}]);
    assert.equal(b.equityState('search_pro').source,'official');
    const raw=JSON.parse(readFileSync(file,'utf8'));
    raw.periodAnchor=Date.now()-1000;
    writeFileSync(file,JSON.stringify(raw));
    const c=new HarnessBudget({config:{},filePath:file});
    c.setTier(tierInfo); // 旧锚点过期 → 应连同官网快照一起清
    const stateC=c.equityState('search_pro');
    assert.equal(stateC.source,'local','setTier 周期结算必须同时清官网快照（旧实现 official/0）');
    assert.equal(stateC.remaining,100);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('live catalog excludes wanx image models (wanx2.1 must not leak into chat catalog)', async () => {
  // 回归（2026-11-13）：NON_CHAT_PATTERNS 的 /^wan\d/ 不匹配 wanx2.1（x 不是数字）
  // → 图像模型混入对话目录，选中后 chat 失败。wanx 系列必须被排除。
  const ctx={get:()=>({resolve:async()=>({value:'K'})})};
  const catalog=new DynamicCatalog({
    ctx, modelsUrl:'https://example.invalid/compatible-mode/v1/models',
    apiKeyEnv:'TEST', pluginName:'test',
    fetchImpl:async()=>Response.json({data:[{id:'wanx2.1-t2i-turbo'},{id:'qwen3.8-flash'}]}),
  });
  assert.equal(await catalog.refresh(),true,'注入式刷新应成功');
  const ids=catalog.snapshot().models.map(m=>m.id);
  assert.equal(ids.includes('wanx2.1-t2i-turbo'),false,'wanx 图像模型不得进入对话目录（旧实现混入）');
  assert.equal(ids.includes('qwen3.8-flash'),true,'正常对话模型保留');
});
