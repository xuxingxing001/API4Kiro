/**
 * Codex 订阅口径窗口目录 —— `contextWindow.ts` 既有三个来源之外的**第四个来源**（`codex`）。
 *
 * 要解决的问题：Codex 系模型的窗口会出现**口径错位**。
 *  - models.dev 登记的是**平台 API**（OpenAI / Azure / Bedrock）口径，`gpt-6-astra` 记作 1050000；
 *  - 而 ChatGPT 订阅的 Codex 后端（直连或经 CLIProxyAPI 之类网关）按 OpenAI 自己的客户端元数据是 272000；
 *  - 中转渠道既不声明窗口字段、也不走 OAuth 厂商内置表，于是解析值落到 models.dev —— 比真实窗口乐观约 3.9 倍，
 *    长会话会在"才用了 1/4"的位置撞上上游的上下文长度错误。
 *
 * 数据源是网关（CLIProxyAPI）自己用的那份远端目录，**两个文件**：
 *  1. `models.json` —— 按 `codex-free|team|plus|pro` 分池，每条带 `context_length`；
 *  2. `codex_client_models.json` —— OpenAI Codex 客户端自己的元数据，`models[].slug` + `context_window`
 *     （同一条还有 `max_context_window`，那是窗口上限，**不采用**：上报上限就是偏乐观）。
 *
 * **冲突取保守下限**：两份文件对 `gpt-5.6-sol|terra|luna` 并不一致 —— `models.json` 给 372000
 * （free/team/plus）× 921000（pro），客户端元数据给 272000；`models.json` 自身跨套餐也不自洽。
 * 故两个文件、四个池一起取最小。方向性理由：上报偏小只让 Kiro 早一点提示压缩，上报偏大则是
 * 长会话中途失败——正是本来源要消除的失效模式。
 *
 * 调用约定：仅明确的 Codex OAuth 渠道使用 `codexSubscriptionWindow()`，不能凭模型名套用到自定义渠道。
 * 返回非 undefined 时，调用方把它放进 `ContextWindowSources.codex` 并不再传 `catalog`：对订阅渠道而言
 * models.dev 的值属于另一条产品线。目录仅决定自动值，用户仍可手动覆盖。
 *
 * 设计要点（与 modelCatalog.ts 同款）：
 *  - **纯增强**：两个文件都拉不到时退回家族默认值（`codexFamilyWindow`），绝不降低可用性；
 *  - 磁盘缓存 + TTL：落 globalState，6h 内不重复拉；缓存键**带版本**（口径变化必须换键，否则旧快照会被 TTL 挡住）；
 *  - 激活时强制刷一次（两个小文件、非阻塞），TTL 留给后续刷新；
 *  - 单个文件失败不影响另一个。
 */

import * as vscode from "vscode";
import { requestUpstream, readBody } from "./upstream";
import { normalizeModelId } from "./modelCatalog";
import { debug, info } from "./log";

/** 网关目录里 Codex 的四个套餐池。 */
const CODEX_POOLS = ["codex-free", "codex-team", "codex-plus", "codex-pro"] as const;

const DEFAULT_POOLS_URL = "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json";
const DEFAULT_CLIENT_URL =
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/codex_client_models.json";

/**
 * 缓存键**带版本**：合并口径/字段一旦变化就必须换键，否则旧快照会继续被 TTL 挡住
 * （v1 → v2 就是从"单来源四池取最小"改成"两来源统一取保守下限"；换键前 5.6 系会沿用旧的 372000）。
 */
const CACHE_KEY = "codexCatalog.snapshot.v2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 12000;

/** Codex 家族（GPT-5 及以后）在订阅通道上的保守默认窗口。 */
const CODEX_FAMILY_DEFAULT = 272000;

let poolsUrl = DEFAULT_POOLS_URL;
let clientUrl = DEFAULT_CLIENT_URL;
/** 测试用：把目录地址指到本地假服务器。 */
export function _setCodexCatalogUrlForTest(url?: string): void {
  poolsUrl = url || DEFAULT_POOLS_URL;
}
export function _setCodexClientUrlForTest(url?: string): void {
  clientUrl = url || DEFAULT_CLIENT_URL;
}

interface Snapshot {
  at: number;
  windows: Array<[string, number]>;
}

let ctx: vscode.ExtensionContext | undefined;
let windows = new Map<string, number>();
let fetchedAt = 0;

/** 把四个套餐池解析成 id → 窗口。同 id 出现在多个池时取最小值。纯函数。 */
export function parseCodexCatalog(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!json || typeof json !== "object") {
    return out;
  }
  const root = json as Record<string, unknown>;
  for (const pool of CODEX_POOLS) {
    const list = root[pool];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      const cw = Number(rec.context_length ?? rec.context_window);
      if (!id || !Number.isFinite(cw) || cw <= 0) {
        continue;
      }
      const key = normalizeModelId(id);
      if (!key) {
        continue;
      }
      const prev = out.get(key);
      out.set(key, prev === undefined ? cw : Math.min(prev, cw));
    }
  }
  return out;
}

/** 解析 `codex_client_models.json` 的 `models[].{slug,context_window}`（客户端元数据）。纯函数。 */
export function parseCodexClientModels(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!json || typeof json !== "object") {
    return out;
  }
  const list = (json as Record<string, unknown>).models;
  if (!Array.isArray(list)) {
    return out;
  }
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const slug = typeof rec.slug === "string" ? rec.slug : typeof rec.id === "string" ? rec.id : "";
    const cw = Number(rec.context_window ?? rec.context_length);
    if (!slug || !Number.isFinite(cw) || cw <= 0) {
      continue;
    }
    const key = normalizeModelId(slug);
    if (!key) {
      continue;
    }
    const prev = out.get(key);
    out.set(key, prev === undefined ? cw : Math.min(prev, cw));
  }
  return out;
}

/** 多个来源合并，同 id 取最小（保守下限）。纯函数，便于断言。 */
export function mergeConservatively(...maps: Array<Map<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of maps) {
    for (const [k, v] of m) {
      const prev = out.get(k);
      out.set(k, prev === undefined ? v : Math.min(prev, v));
    }
  }
  return out;
}

/**
 * Codex 家族的保守窗口：目录里没有该 id 时的兜底。
 *
 * 它同时是"新模型上架即正确"的保险 —— 只要 id 长得像 gpt-N（N≥5）就按订阅口径算，
 * 而不是被 models.dev 的平台 API 口径顶上去。
 */
const CODEX_FAMILY_RE = /(^|[^a-z])gpt-?[5-9]/;
export function codexFamilyWindow(modelId: string): number | undefined {
  return CODEX_FAMILY_RE.test(String(modelId || "").toLowerCase()) ? CODEX_FAMILY_DEFAULT : undefined;
}

/** 目录里的精确值（未命中返回 undefined）。 */
export function lookupCodexWindow(modelId: string): number | undefined {
  const key = normalizeModelId(modelId);
  return key ? windows.get(key) : undefined;
}

/**
 * 交给 `ContextWindowSources.codex` 的值：目录精确值优先，目录未命中/不可用时退到家族默认。
 * 返回 undefined 表示"这不是 Codex 系模型"，调用方照常传 `catalog`。
 */
export function codexSubscriptionWindow(modelId: string): number | undefined {
  return lookupCodexWindow(modelId) ?? codexFamilyWindow(modelId);
}

/** 启动时调用：先吃磁盘缓存，再后台刷新（不阻塞激活）。 */
export async function initCodexCatalog(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;
  try {
    const snap = context.globalState.get<Snapshot>(CACHE_KEY);
    if (snap && Array.isArray(snap.windows)) {
      windows = new Map(snap.windows);
      fetchedAt = snap.at || 0;
      debug("codex catalog loaded from cache", { count: windows.size, at: snap.at });
    }
  } catch (e) {
    debug("codex catalog cache read failed:", (e as Error).message);
  }
  // 激活时**强制**刷一次：目录只有两个小文件，而 TTL 挡不住"口径变了但快照还新鲜"这类失效。
  void refreshCodexCatalog(true);
}

/** 拉一个 JSON，失败返回 undefined（不抛）。 */
async function fetchJson(url: string): Promise<unknown | undefined> {
  try {
    const res = await requestUpstream("GET", url, { Accept: "application/json" }, undefined, TIMEOUT_MS);
    const text = await readBody(res.body);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode}`);
    }
    return JSON.parse(text);
  } catch (e) {
    debug("codex catalog fetch failed:", (e as Error).message);
    return undefined;
  }
}

/**
 * 拉取两个目录文件并合并（保守下限）。force 忽略 TTL。
 * 失败静默（返回 false），既有缓存继续用；单个文件失败不影响另一个。
 */
export async function refreshCodexCatalog(force: boolean): Promise<boolean> {
  const fresh = Date.now() - fetchedAt < CACHE_TTL_MS && windows.size > 0;
  if (!force && fresh) {
    return true;
  }
  const [poolsJson, clientJson] = await Promise.all([fetchJson(poolsUrl), fetchJson(clientUrl)]);
  if (poolsJson === undefined && clientJson === undefined) {
    debug("codex catalog refresh failed (using existing/none): both sources unreachable");
    return false;
  }
  const merged = mergeConservatively(
    poolsJson === undefined ? new Map<string, number>() : parseCodexCatalog(poolsJson),
    clientJson === undefined ? new Map<string, number>() : parseCodexClientModels(clientJson)
  );
  if (merged.size === 0) {
    debug("codex catalog refresh failed (using existing/none): empty after parse");
    return false;
  }
  windows = merged;
  fetchedAt = Date.now();
  const snap: Snapshot = { at: fetchedAt, windows: [...windows.entries()] };
  await ctx?.globalState.update(CACHE_KEY, snap);
  info(
    `codex catalog refreshed: ${windows.size} models (pools=${poolsJson !== undefined}, client=${clientJson !== undefined})`
  );
  return true;
}
