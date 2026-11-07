/**
 * 上下文挡位（4.13.55，目标 A / R24）——纯函数，不依赖 vscode。
 *
 * 一个已勾选模型的上下文窗口有四个来源（都可能缺席）：渠道 `/models` 的窗口字段、models.dev 目录（只认该模型自己的
 * 条目，family 兜底不给窗口，见 modelCatalog.lookupCapability）、OAuth 厂商内置目录、以及用户覆盖
 * （设置 `api2kiroDual.contextWindowOverrides`：Kiro 选择器里的模型 id → tokens）。
 *
 *  - 「已知最大窗口」= 三个来源的最大值；三个来源都没有 → 标「未知」，按默认 200000 算。
 *  - 「候选挡位」= 标准梯子 ∪ 各来源给出的精确值（去重升序）；目录值只决定自动值，不限制手动覆盖。
 *  - 「当前生效窗口」= 用户覆盖（须是候选之一或任意 > 0 的整数）?? 解析值。解析值沿用 4.13.54 的优先级
 *    （渠道字段 → 厂商目录 → models.dev → 默认），不因本功能改变默认行为。
 *  - CPS 把生效窗口放进 `tokenLimits.maxInputTokens`（Kiro 据此算 80% / 95% 阈值与百分比），把候选表放进
 *    description 私有微格式第 5 位（`__A2K_MDL__|推理|图片|窗口|挡位表|末行`），聊天框下拉 / 弹层从那里读。
 *
 * ⚠️ **生效窗口只能有一个来源。** CPS 广播、侧边栏下拉、流式占用百分比三条路径都走
 * `modelStore.resolveWindowForGroup()`；一旦分歧，同一模型会出现两个窗口值。曾经因此发生过一次事故：
 * 流式百分比路径用了另一个只查 mergedCache + models.dev 的函数，于是 Codex 系模型上
 * CPS 报 272000、百分比按目录的 1050000 算（差 3.86 倍）→ 永远到不了 80% 阈值 → 上下文无界增长。
 * 详见 `modelStore.resolveWindowForGroup` 的注释。
 *
 * Kiro 侧机制（1.0.437 定位、**1.1.14 复核**：`KJl()` = SummarizationDetectionNode、`Oxo()` = 阈值判定）：读流式响应里的
 * `contextUsageEvent.contextUsagePercentage`，**>= 80% 触发摘要、>= 95% 触发即时截断**；1.1.14 起还会把
 * 待回灌的工具结果按 `Pxo()` 折成百分比**叠加**到上报值上再判阈值（所以阈值实际是「本轮上报值 + 待回灌工具结果」）。
 * 所以「报多大的窗口，Kiro 就在多大的上下文处压缩」是成立的——窗口最小的模型最先被压缩（Codex / GPT 系 272K ⇒ ≈217.6K tokens）。
 */

/** 标准梯子（tokens）。 */
export const CONTEXT_LADDER: readonly number[] = [32768, 65536, 131072, 200000, 262144, 400000, 524288, 1000000, 1048576, 2097152];

/** 三个来源都没有时的默认窗口（与 4.13.54 之前 CPS 的兜底一致）。 */
export const DEFAULT_CONTEXT_WINDOW = 200000;

/** 用户覆盖的合法范围：太小会让 Kiro 每两轮就压缩，太大没有模型能吃下。 */
export const MIN_CONTEXT_OVERRIDE = 4096;
export const MAX_CONTEXT_OVERRIDE = 10_000_000;

export type ContextWindowSource = "override" | "upstream" | "vendor" | "codex" | "catalog" | "default";

export interface ContextWindowSources {
  /** 渠道 `/models` 条目自带的窗口字段（`context_window` / `max_input_tokens` …），或 Kiro 官方 ListAvailableModels 的 `tokenLimits.maxInputTokens`。 */
  upstream?: number;
  /** OAuth 厂商内置目录（`src/oauth/vendors.ts`）。 */
  vendor?: number;
  /**
   * Codex **订阅通道口径**（`src/codexCatalog.ts`）：ChatGPT 订阅的 Codex 后端窗口，通常小于 models.dev
   * 登记的平台 API 口径。仅在模型属于 Codex 家族时给出；给出时调用方**不再传 `catalog`**，
   * 因为对这条通道而言 models.dev 的值是另一条产品线的数（见该文件头注释）。
   */
  codex?: number;
  /** models.dev 目录里该模型自己的条目。 */
  catalog?: number;
}

export interface ContextWindowInfo {
  /** 至少一个来源给了窗口。 */
  known: boolean;
  /** 已知最大窗口（未知时为默认 200000）。 */
  max: number;
  /** 当前生效窗口 = override ?? 解析值。 */
  effective: number;
  /** 生效窗口来自哪里。 */
  source: ContextWindowSource;
  /** 解析值（不含用户覆盖）。 */
  resolved: number;
  /** 解析值来自哪里（未知时 default）。 */
  resolvedSource: Exclude<ContextWindowSource, "override">;
  /** 候选挡位（升序、去重）。 */
  candidates: number[];
  /** 合法的用户覆盖值（无 / 非法为 undefined）。 */
  override?: number;
}

function posInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 校验一个用户覆盖值：正整数且在 [4096, 10,000,000] 内；否则 undefined（视为未设置）。 */
export function normalizeContextOverride(v: unknown): number | undefined {
  const n = posInt(v);
  if (n === undefined || n < MIN_CONTEXT_OVERRIDE || n > MAX_CONTEXT_OVERRIDE) {
    return undefined;
  }
  return n;
}

/** 解析值：渠道字段 → 厂商目录 → **Codex 订阅口径** → models.dev → 默认。 */
export function resolveBaseContextWindow(src: ContextWindowSources): { value: number; source: Exclude<ContextWindowSource, "override"> } {
  const up = posInt(src.upstream);
  if (up) {
    return { value: up, source: "upstream" };
  }
  const vendor = posInt(src.vendor);
  if (vendor) {
    return { value: vendor, source: "vendor" };
  }
  // Codex 订阅口径排在 models.dev 之前：同一个模型 id 在平台 API 与订阅通道下窗口不同，
  // 而中转渠道（如 CLIProxyAPI）既不声明字段、也不需要走厂商表，只有这里能给出订阅口径的正确答案。
  const codex = posInt(src.codex);
  if (codex) {
    return { value: codex, source: "codex" };
  }
  const cat = posInt(src.catalog);
  if (cat) {
    return { value: cat, source: "catalog" };
  }
  return { value: DEFAULT_CONTEXT_WINDOW, source: "default" };
}

/** 候选挡位：完整梯子 ∪ 各来源精确值 ∪ 当前生效值，去重升序。 */
export function contextCandidates(exact: number[] = []): number[] {
  const set = new Set<number>(CONTEXT_LADDER);
  for (const v of exact) {
    const n = posInt(v);
    if (n) {
      set.add(n);
    }
  }
  return [...set].sort((a, b) => a - b);
}

export function resolveContextWindow(src: ContextWindowSources, override?: unknown): ContextWindowInfo {
  const values = [posInt(src.upstream), posInt(src.vendor), posInt(src.codex), posInt(src.catalog)].filter((n): n is number => n !== undefined);
  const known = values.length > 0;
  const max = known ? Math.max(...values) : DEFAULT_CONTEXT_WINDOW;
  const base = resolveBaseContextWindow(src);
  const ov = normalizeContextOverride(override);
  const effective = ov ?? base.value;
  const candidates = contextCandidates([...values, effective]);
  return {
    known,
    max,
    effective,
    source: ov !== undefined ? "override" : base.source,
    resolved: base.value,
    resolvedSource: base.source,
    candidates,
    override: ov,
  };
}

/**
 * 挡位标签，与模型厂商的叫法一致：整千先按十进制（128000 → 128K、200000 → 200K、400000 → 400K、1000000 → 1M），
 * 否则 1024 的倍数按二进制（32768 → 32K、131072 → 128K、204800 → 200K、1048576 → 1M、2097152 → 2M、1310720 → 1.3M），
 * 其余十进制保留一位小数。整千优先是因为 128000 = 125 × 1024，若先走二进制会得到 "125K"。
 */
export function formatContextTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return "?";
  }
  const fmt = (v: number, unit: string) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) + unit;
  if (n % 1000 !== 0 && n % 1024 === 0) {
    const k = n / 1024;
    return k >= 1024 ? fmt(k / 1024, "M") : fmt(k, "K");
  }
  const k = n / 1000;
  return k >= 1000 ? fmt(k / 1000, "M") : fmt(k, "K");
}

/** 来源的中文标签（下拉 title / 侧边栏说明用）。 */
export function contextSourceLabel(source: ContextWindowSource, known: boolean): string {
  switch (source) {
    case "override":
      return "用户覆盖";
    case "upstream":
      return "渠道 /models 字段";
    case "vendor":
      return "厂商目录";
    case "codex":
      return "Codex 订阅口径目录";
    case "catalog":
      return "models.dev";
    default:
      return known ? "默认" : "未知，默认";
  }
}

/**
 * description 第 5 位（`__A2K_MDL__|R|I|WINDOW|CTX|LAST` 的 CTX）：`候选逗号串~来源~已知(1/0)~解析值~解析来源`。
 * 只用 `,` `~` 与字母数字，不含 `|`。webview 侧用 parseContextTable 还原；聊天框下拉用「解析来源」给「自动」分组打标签
 * （覆盖态下「来源」是 override，看不出自动值是谁给的）。
 */
export function formatContextTable(info: ContextWindowInfo): string {
  return `${info.candidates.join(",")}~${info.source}~${info.known ? 1 : 0}~${info.resolved}~${info.resolvedSource}`;
}

export interface ContextTable {
  candidates: number[];
  source: ContextWindowSource;
  known: boolean;
  resolved: number;
  resolvedSource: Exclude<ContextWindowSource, "override">;
}

const SOURCES: readonly ContextWindowSource[] = ["override", "upstream", "vendor", "codex", "catalog", "default"];

export function parseContextTable(raw: string): ContextTable | undefined {
  const parts = String(raw || "").split("~");
  if (parts.length < 3) {
    return undefined;
  }
  const candidates = parts[0]
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) {
    return undefined;
  }
  const source = SOURCES.includes(parts[1] as ContextWindowSource) ? (parts[1] as ContextWindowSource) : "default";
  const resolved = Number(parts[3]);
  const rs = parts[4];
  const resolvedSource = rs && rs !== "override" && SOURCES.includes(rs as ContextWindowSource) ? (rs as Exclude<ContextWindowSource, "override">) : "default";
  return {
    candidates,
    source,
    known: parts[2] === "1",
    resolved: Number.isFinite(resolved) && resolved > 0 ? resolved : candidates[candidates.length - 1],
    resolvedSource,
  };
}

/** 聊天框 → 宿主的载体：`setSessionConfigOption({ configId: "a2k:ctx", value: "<modelId>|<tokens>" })`。 */
export const CTX_CONFIG_ID = "a2k:ctx";

export function encodeCtxConfigValue(modelId: string, tokens: number): string {
  return `${modelId}|${tokens}`;
}

/** 解析载体值；tokens 非法（非正整数 / 越界）→ undefined。 */
export function decodeCtxConfigValue(value: unknown): { modelId: string; tokens: number } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const at = value.lastIndexOf("|");
  if (at <= 0) {
    return undefined;
  }
  const modelId = value.slice(0, at).trim();
  const tokens = normalizeContextOverride(value.slice(at + 1));
  if (!modelId || tokens === undefined) {
    return undefined;
  }
  return { modelId, tokens };
}
