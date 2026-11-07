"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { PassThrough } = require("node:stream");
const { boot, rawProvider } = require("./helpers");
const context = require("./.build/contextWindow.js");
const catalog = require("./.build/modelCatalog.js");
const store = require("./.build/modelStore.js");
const { CpsProxyServer } = require("./.build/cpsServer.js");
const { KrsProxyServer } = require("./.build/krsServer.js");
const { EventStreamDecoder } = require("./.build/eventstream.js");
const { SidebarProvider } = require("./.build/sidebar.js");
const { contextUsagePercentFloat } = require("./.build/streamShared.js");
const vscode = require("./.build/node_modules/vscode");

function group(providerId, baseId, extra = {}) {
  return { providerId, baseId, name: baseId, protocol: "openai", efforts: new Set(), ...extra };
}

test("自动值不限制手动档位，未知模型也能选 1M/2M 和精确覆盖值", () => {
  for (const sources of [{}, { upstream: 128000 }, { codex: 272000 }]) {
    const auto = context.resolveContextWindow(sources);
    assert.ok(auto.candidates.includes(1000000));
    assert.ok(auto.candidates.includes(2097152));
    const manual = context.resolveContextWindow(sources, 1500000);
    assert.equal(manual.effective, 1500000);
    assert.equal(manual.resolved, auto.resolved);
    assert.equal(manual.source, "override");
    assert.ok(manual.candidates.includes(1500000));
    assert.deepEqual(manual.candidates, [...new Set(manual.candidates)].sort((a, b) => a - b));
  }
  const info = context.resolveContextWindow({ codex: 272000 });
  const table = context.parseContextTable(context.formatContextTable(info));
  assert.equal(table.source, "codex");
  assert.equal(table.resolvedSource, "codex");
});

test("自定义 GPT provider 使用 API 目录，只有 Codex OAuth 使用订阅默认值", async () => {
  const h = await boot({ settings: { providers: [
    rawProvider({ id: "custom", protocol: "openai" }),
    rawProvider({ id: "subscription", protocol: "openai", auth: "oauth", oauthVendor: "codex" }),
  ] } }).init();
  catalog.loadCatalogJsonForTest({ openai: { models: {
    "gpt-6-astra": { id: "gpt-6-astra", limit: { context: 1050000 } },
  } } });
  assert.equal(store.resolveWindowForGroup(group("custom", "gpt-6-astra"), "gpt-6-astra").effective, 1050000);
  const subscription = store.resolveWindowForGroup(group("subscription", "gpt-6-astra"), "gpt-6-astra@subscription");
  assert.equal(subscription.source, "vendor");
  assert.equal(subscription.effective, 272000);
  assert.equal(store.resolveWindowForGroup(group("subscription", "gpt-9-custom"), "gpt-9-custom").source, "codex");
  const upstream = store.resolveWindowForGroup(group("custom", "gpt-6-astra", { upstreamContextWindow: 1000000 }), "gpt-6-astra");
  assert.equal(upstream.source, "upstream");
  assert.equal(upstream.effective, 1000000);
  await h.config.setContextWindowOverride("gpt-6-astra@subscription", 1000000);
  assert.equal(store.resolveWindowForGroup(group("subscription", "gpt-6-astra"), "gpt-6-astra@subscription").effective, 1000000);
});

test("四种自定义协议：保存、重读、同名渠道隔离、CPS 与用量百分比保持一致", async () => {
  catalog.resetCatalogForTest([]);
  const formats = [
    { protocol: "anthropic", context_window: 128000 },
    { protocol: "openai", openaiApi: "chat", context_length: 200000 },
    { protocol: "openai", openaiApi: "responses", max_input_tokens: 400000 },
    { protocol: "gemini", inputTokenLimit: 1048576 },
  ];
  const providers = formats.map(({ protocol, openaiApi }, i) => rawProvider({
    id: `format${i}`, protocol, openaiApi, enabledModels: ["shared-model"],
  }));
  const h = await boot({ settings: { providers } }).init();
  for (let i = 0; i < providers.length; i++) {
    store.__seedRaw(providers[i], [{ id: "shared-model", ...formats[i] }]);
  }
  await store.fetchAllModels();
  const before = store.contextWindowRows();
  assert.deepEqual(before.map((r) => r.info.effective), [128000, 200000, 400000, 1048576]);
  for (let i = 0; i < before.length; i++) {
    await h.config.setContextWindowOverride(before[i].kiroId, 1000000 + i * 100000);
  }
  h.config.initConfig(h.ctx);
  await store.fetchAllModels();
  const cps = new CpsProxyServer(0);
  const broadcast = await cps.buildModelList();
  for (const [i, row] of store.contextWindowRows().entries()) {
    const expected = 1000000 + i * 100000;
    assert.equal(row.info.effective, expected);
    assert.equal(store.effectiveContextWindowFor(row.kiroId), expected);
    assert.equal(contextUsagePercentFloat(expected / 2, row.kiroId), 50);
    const model = broadcast.models.find((m) => m.modelId === row.kiroId);
    assert.equal(model.tokenLimits.maxInputTokens, expected);
    const table = context.parseContextTable(model.description.split("|")[4]);
    assert.ok(table.candidates.includes(expected));
    assert.equal(table.source, "override");
  }
  const panel = Object.create(SidebarProvider.prototype);
  panel.postCtxWindows = () => {};
  await panel.applyContextWindowOverride(before[0].kiroId, before[0].info.resolved, "panel");
  assert.equal(store.contextWindowRows()[0].info.source, "upstream");
  assert.equal(store.contextWindowRows()[1].info.effective, 1100000);
});

test("已知窗口字段跳过无效值；模型映射按真实模型解析窗口", async () => {
  const p = rawProvider({ id: "mapped", protocol: "openai", modelMapping: { alias: "real-model" } });
  await boot({ settings: { providers: [p] } }).init();
  store.__seedRaw(p, [
    { id: "alias" },
    { id: "real-model", context_window: 0, context_length: "invalid", max_input_tokens: "1000000" },
  ]);
  assert.equal(store.resolveWindowForGroup(group(p.id, "alias"), "alias").effective, 1000000);
  catalog.loadCatalogJsonForTest({ custom: { models: {
    "catalog-model": { id: "catalog-model", limit: { context: 1500000 } },
  } } });
  globalThis.__a2kSettings.providers[0].modelMapping.alias = "catalog-model";
  const info = store.resolveWindowForGroup(group(p.id, "alias"), "alias");
  assert.equal(info.effective, 1500000);
  assert.equal(info.source, "catalog");
  globalThis.__a2kSettings.providers[0].modelMapping = {};
  globalThis.__a2kSettings.providers[0].defaultModel = "catalog-model";
  assert.equal(store.resolveWindowForGroup(group(p.id, "alias"), "alias").effective, 1500000);
});

test("实际四协议响应流按所选渠道与别名的覆盖值计算百分比", async () => {
  const providers = ["first", "second"].map((id) => rawProvider({
    id, protocol: "openai", enabledModels: ["upstream-model", "alias"], modelMapping: { alias: "upstream-model" },
  }));
  const h = await boot({ settings: { providers, showTokenUsage: false } }).init();
  catalog.resetCatalogForTest([]);
  for (const p of providers) store.__seedRaw(p, [{ id: "upstream-model" }, { id: "alias" }]);
  await store.fetchAllModels();
  await h.config.setContextWindowOverride("alias", 200000);
  await h.config.setContextWindowOverride("alias@second", 1000000);
  const frames = {
    anthropic: { type: "message_start", message: { usage: { input_tokens: 500000 } } },
    openai: { choices: [], usage: { prompt_tokens: 500000, completion_tokens: 1 } },
    responses: { type: "response.completed", response: { usage: { input_tokens: 500000, output_tokens: 1 } } },
    gemini: { usageMetadata: { promptTokenCount: 500000, candidatesTokenCount: 1 } },
  };
  const server = Object.create(KrsProxyServer.prototype);
  for (const [wire, frame] of Object.entries(frames)) {
    const body = new PassThrough();
    const response = new PassThrough();
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    const done = server.pumpStream(response, wire, body, wire, "upstream-model", undefined, {
      provider: providers[1], credential: { id: "c1" }, kiroModel: "alias",
      upstreamModel: "upstream-model", convId: wire, startedAt: Date.now(),
    }, 200);
    body.end(Buffer.from(`data: ${JSON.stringify(frame)}\n\n`));
    await done;
    const events = new EventStreamDecoder().feed(Buffer.concat(chunks));
    const usage = events.find((e) => e.type === "contextUsageEvent");
    assert.equal(usage?.payload.contextUsagePercentage, 50, wire);
  }
});

test("自定义输入：合法值写入，取消和非法值不改变原覆盖", async () => {
  const h = await boot().init();
  const panel = Object.create(SidebarProvider.prototype);
  panel.postCtxWindows = () => {};
  const toasts = [];
  panel.toast = (...args) => toasts.push(args);
  const previous = vscode.window.showInputBox;
  try {
    vscode.window.showInputBox = async (options) => {
      for (const value of ["4096", "1000000", "10000000"]) assert.equal(options.validateInput(value), undefined);
      for (const value of ["", "4095", "10000001", "1000000.5", "NaN", "Infinity", "1M"]) assert.ok(options.validateInput(value));
      return "1500000";
    };
    await panel.onMessage({ type: "setCtxWindow", modelId: "custom-model", custom: true });
    assert.equal(h.config.getContextWindowOverride("custom-model"), 1500000);
    vscode.window.showInputBox = async () => undefined;
    await panel.onMessage({ type: "setCtxWindow", modelId: "custom-model", custom: true });
    assert.equal(h.config.getContextWindowOverride("custom-model"), 1500000);
    for (const tokens of [-1, 4095, 10000001, "bad", 1000000.5]) {
      await panel.onMessage({ type: "setCtxWindow", modelId: "custom-model", tokens });
      assert.equal(h.config.getContextWindowOverride("custom-model"), 1500000);
      assert.equal(toasts.at(-1)[0], "error");
    }
    await panel.onMessage({ type: "setCtxWindow", modelId: "custom-model", tokens: null });
    assert.equal(h.config.getContextWindowOverride("custom-model"), undefined);
  } finally {
    vscode.window.showInputBox = previous;
  }
});

test("侧边栏生成的 webview 脚本语法正确（模板内 JavaScript 不由 tsc 检查）", () => {
  const previous = vscode.Uri.joinPath;
  vscode.Uri.joinPath = (...parts) => parts.join("/");
  try {
    const html = SidebarProvider.prototype.html.call({
      context: { extension: { packageJSON: { version: "test" } }, extensionUri: "/test" },
      iconFiles: () => ({}), svgIds: () => [],
    }, { cspSource: "test", asWebviewUri: (uri) => uri });
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));
  } finally {
    vscode.Uri.joinPath = previous;
  }
});
