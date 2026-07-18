#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Vault } from "./vault.js";
import { MemoryStore } from "./store.js";
import type { MemoryRecord, SearchResult } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = process.env.BIGBRAIN_VAULT
  ? path.resolve(process.env.BIGBRAIN_VAULT)
  : path.resolve(here, "..", "vault");

const vault = new Vault(vaultDir);
const store = new MemoryStore(vault);

/**
 * 볼트가 "지정됐는데 비어 있고 마커도 없는" 상태면 경로 오타/드라이브 이동을 의심한다 (감사 E3).
 * 이 경우 조용히 빈 볼트로 동작하면 모델이 "기억이 없다" 고 판단해 중복 저장을 시작하고
 * 볼트가 두 갈래로 분열된다. stderr 와 instructions 양쪽에 경고를 띄워 사람과 모델이
 * 모두 알아채게 한다. (BIGBRAIN_VAULT 를 지정하지 않은 첫 실행은 정상이므로 제외)
 */
function computeVaultWarning(): string | null {
  const st = vault.inspect();
  if (st.memories > 0 || st.archived > 0) return null;
  if (!process.env.BIGBRAIN_VAULT) return null; // 기본 경로의 첫 실행 — 정상
  if (st.hasMarker) return null; // 진짜로 비운 볼트
  return `WARNING: BIGBRAIN_VAULT points at "${vaultDir}" but it contains no memories and no vault marker. If you expected memories here, the path may be wrong (typo, moved drive) — do NOT start storing duplicates until it is confirmed.`;
}

/**
 * **기동 직후 한 번만** 판정한다. main() 의 regenerateIndex 가 볼트 마커를 만들기 때문에,
 * 나중에 다시 계산하면 경고가 사라져 instructions 와 stderr 가 어긋난다.
 */
const VAULT_WARNING = computeVaultWarning();

const MEMORY_TYPE = z
  .enum(["episodic", "semantic", "procedural", "preference"])
  .describe(
    "Memory type: episodic (events/experiences), semantic (facts/knowledge), procedural (how-to/workflows), preference (user tastes/style)",
  );

/** instructions 에 실을 기억 인덱스 최대 건수 (컨텍스트 예산 보호). 0 이면 인덱스 생략 */
const INDEX_LIMIT = (() => {
  const v = Number(process.env.BIGBRAIN_INDEX_LIMIT);
  return Number.isFinite(v) && v >= 0 ? v : 40;
})();

/**
 * 이 서버 인스턴스의 기본 프로젝트 스코프 (감사 E2).
 * 프로젝트별 .mcp.json 의 env 로 지정하면 그 프로젝트의 기억만 + 전역 기억이 회상된다.
 * 미지정이면 스코프 필터를 걸지 않는다(= 종전과 동일하게 전체 조회).
 */
const DEFAULT_PROJECT = process.env.BIGBRAIN_PROJECT?.trim() || undefined;

/**
 * 서버 기동 시점의 기억 인덱스를 instructions 에 덧붙인다 (감사 E1).
 *
 * 네이티브 메모리는 MEMORY.md 내용 자체가 매 세션 시스템 프롬프트에 주입돼
 * 모델이 "무엇이 저장돼 있는지" 를 보고 시작한다. BigBrainMemory 는 vault/MEMORY.md 를
 * 생성만 하고 어떤 경로로도 재노출하지 않아, 볼트에 무엇이 있는지 모르는 모델이
 * recall 키워드를 추측해야 했다 — 표층 문자열 검색(D1)과 겹치면 첫 질의가 0건이 되기 쉽다.
 *
 * MCP instructions 는 클라이언트가 세션 컨텍스트에 실어주므로, 여기에 제목·설명
 * 한 줄 인덱스를 붙이면 "무엇이 있는지" 가 자동 노출된다.
 * 주의: 이 스냅샷은 **서버 기동 시점** 기준이다. 항상 최신이 필요하면
 * SessionStart 훅으로 vault/MEMORY.md 를 주입하는 방법을 README 참조.
 */
function memoryIndexLines(): string[] {
  let items: ReturnType<typeof store.list>;
  try {
    items = store.list(DEFAULT_PROJECT ? { project: DEFAULT_PROJECT } : undefined);
  } catch (err) {
    console.error(
      `[BigBrainMemory] 인덱스 요약 생략(계속 진행): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (items.length === 0) {
    return ["", "The vault is currently EMPTY — no memories stored yet. Use `remember` as you learn durable facts."];
  }
  const scope = DEFAULT_PROJECT
    ? [
        "",
        `Current project scope: "${DEFAULT_PROJECT}". Recall returns this project's memories plus global ones.`,
        `When storing, set \`project: "${DEFAULT_PROJECT}"\` for facts that only apply here; omit \`project\` for knowledge that should follow the user everywhere (preferences, general workflows).`,
      ]
    : [];
  if (INDEX_LIMIT === 0) return scope; // 인덱스 생략 (스코프 안내는 유지)
  const shown = items.slice(0, INDEX_LIMIT);
  const head =
    items.length > shown.length
      ? `Vault index — ${items.length} memories stored, ${shown.length} most recently updated shown. Use \`recall\` for the full text and anything not listed:`
      : `Vault index — ${items.length} memories currently stored. Use \`recall\` to read the full text:`;
  return [
    ...scope,
    "",
    head,
    ...shown.map((m) => `- [${m.type}] ${m.title} — ${m.description}`),
  ];
}

const server = new McpServer(
  { name: "bigbrainmemory", version: "0.1.0" },
  {
    instructions: [
      // 경고가 있으면 맨 앞 — 모델이 빈 결과를 "기억 없음" 으로 오해하지 않도록
      ...(VAULT_WARNING ? [VAULT_WARNING, ""] : []),
      "BigBrainMemory is a persistent, human-like memory vault (Obsidian-compatible markdown).",
      "Behave like a person with long-term memory:",
      "1. RECALL FIRST — at the start of a task, or when the user mentions past context, call `recall` before answering.",
      "2. REMEMBER — after learning a durable fact, decision, preference, or lesson, call `remember` (not for trivia that only matters this conversation).",
      "3. CORRECT — when new information contradicts an existing memory, call `revise` (fixable) or `forget` (wrong memory) instead of piling up duplicates. If `remember` reports similar memories, prefer revising them.",
      "4. ASSOCIATE — connect related memories with `link` so recall can spread across them.",
      "5. REFLECT — periodically call `reflect` to find weakened, low-confidence, or duplicate memories and clean them up (forget candidates are surfaced, never auto-deleted).",
      "Two independent dimensions (do not conflate them): `confidence` = how likely the memory is TRUE (change only via `revise`); recall accessibility = base-level activation from frequency+recency, computed automatically. A rarely-recalled memory can still be highly trusted, and vice versa.",
      "Record a `source` when you know where a fact came from — it prevents source confusion later. Memories are stored verbatim and never auto-merged; consolidate only via explicit `revise`.",
      "Every result carries `age_days` (days since last update). A memory is a point-in-time observation, not live state: when it cites code, file paths, versions or config and `stale_hint` is present, verify against the current source before asserting it as fact — and `revise` it when reality has moved on.",
      ...memoryIndexLines(),
    ].join("\n"),
  },
);

/** 이 일수 이상 갱신되지 않은 기억에 낡음 경고를 붙인다 (0 이면 항상 경고) */
const STALE_DAYS = (() => {
  const v = Number(process.env.BIGBRAIN_STALE_DAYS);
  return Number.isFinite(v) && v >= 0 ? v : 30;
})();

/**
 * 기억의 나이를 응답에 실어준다 (감사 E4).
 *
 * recall 결과에는 시간 정보가 하나도 없어서, 120일 방치된 기억도 아무 표시 없이
 * 등장했다. confidence 는 "얼마나 참인가" 축이라 시간 경과를 표현하지 못하므로
 * 보완재가 되지 못한다. 감쇠는 순위만 낮출 뿐 나이를 전달하지 않는다.
 * 그 결과 모델이 반년 전 코드 구조 기억을 최신 사실로 인용할 수 있었다 —
 * 네이티브 메모리가 Read 시 자동으로 붙여주는 "N days old" 리마인더에 해당하는 것이 없었다.
 */
function ageInfo(m: MemoryRecord): Record<string, unknown> {
  const ms = Date.now() - Date.parse(m.updated);
  if (!Number.isFinite(ms)) return {};
  const ageDays = Math.max(0, Math.floor(ms / 86_400_000));
  return {
    updated: m.updated,
    age_days: ageDays,
    ...(ageDays >= STALE_DAYS
      ? {
          stale_hint: `이 기억은 ${ageDays}일 전에 갱신됐습니다 — 현재 코드/사실과 대조한 뒤 사용하고, 달라졌으면 revise 로 교정하세요.`,
        }
      : {}),
  };
}

function brief(m: MemoryRecord): Record<string, unknown> {
  return {
    ...ageInfo(m),
    id: m.id,
    slug: m.slug,
    title: m.title,
    description: m.description,
    type: m.type,
    tags: m.tags,
    confidence: m.confidence,
    storage_strength: Number(m.storageStrength.toFixed(2)),
    status: m.status,
    access_count: m.accessCount,
    source: m.source,
    project: m.project,
    links: m.links,
  };
}

function full(m: MemoryRecord): Record<string, unknown> {
  return { ...brief(m), created: m.created, updated: m.updated, history: m.history, body: m.body };
}

function searchHit(r: SearchResult): Record<string, unknown> {
  return {
    ...brief(r.record),
    score: Number(r.score.toFixed(2)),
    activation: Number(r.activation.toFixed(2)),
    inhibited: r.inhibited ?? false,
    snippet: r.snippet,
  };
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

server.registerTool(
  "remember",
  {
    title: "Remember (store a new memory)",
    description:
      "Store a durable memory as a markdown note in the vault. Call this after learning a lasting fact, user preference, decision, lesson, or workflow. " +
      "NOT for transient conversation details. If the result lists `similar_existing_memories`, consider calling `revise` on one of them instead of keeping a duplicate. " +
      "Use `supersedes` to replace an outdated memory with this new one.",
    inputSchema: {
      title: z.string().min(1).describe("Short human-readable title (becomes the note filename)"),
      content: z.string().min(1).describe("The memory body in markdown. May contain [[wikilinks]]"),
      description: z.string().optional().describe("One-line summary used for recall ranking (defaults to first line of content)"),
      type: MEMORY_TYPE,
      tags: z.array(z.string()).optional().describe("Topic tags for recall"),
      links: z.array(z.string()).optional().describe("Slugs or ids of related memories to link bidirectionally"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Truthfulness — how certain this memory is CORRECT (default 0.8). Independent of how often it is recalled."),
      source: z
        .string()
        .optional()
        .describe("Where this came from (e.g. 'user stated', 'inferred from code', 'docs/x.md'). Recorded to prevent source confusion."),
      project: z
        .string()
        .optional()
        .describe(
          "Project this memory belongs to. OMIT for knowledge that applies everywhere (user preferences, general workflows) — those stay globally recallable. Set it for project-specific facts so other projects are not polluted.",
        ),
      supersedes: z.string().optional().describe("Slug or id of an outdated memory this one replaces"),
    },
  },
  async (args) => {
    // project 를 생략하면 전역 기억이다 — 서버 스코프를 몰래 씌우지 않는다.
    // (씌우면 "전역이면 생략" 이라는 도구 설명과 모순되고, 사용자 선호 같은
    //  범용 지식이 한 프로젝트에 갇혀 다른 곳에서 조용히 회상되지 않는다)
    const { record, similar } = store.remember(args);
    return ok({
      stored: brief(record),
      similar_existing_memories: similar.filter((m) => m.slug !== record.slug).map(brief),
      hint:
        similar.length > 0
          ? "Similar memories exist. If this duplicates one of them, call `forget` on this new memory and `revise` the existing one instead."
          : undefined,
    });
  },
);

server.registerTool(
  "recall",
  {
    title: "Recall (search memories)",
    description:
      "Search the memory vault by keywords. Call this FIRST when starting a task, when the user references past work/preferences, or before answering anything that prior sessions may have covered. " +
      "Results are ranked by relevance x truthfulness(confidence) x base-level activation (power-law of frequency+recency, ACT-R). Competing near-duplicate memories are laterally inhibited in ranking (retrieval-induced forgetting) — see `inhibited`. Associated (linked) memories are surfaced too. Active recall reinforces the recalled memories.",
    inputSchema: {
      query: z.string().min(1).describe("Keywords to search for (matched against title, tags, description, body)"),
      type: MEMORY_TYPE.optional(),
      limit: z.number().int().min(1).max(20).optional().describe("Max direct results (default 5)"),
      include_linked: z.boolean().optional().describe("Also surface 1-hop linked memories as associations (default true)"),
      project: z
        .string()
        .optional()
        .describe(
          "Restrict to this project's memories plus global ones. Defaults to the server's BIGBRAIN_PROJECT. Pass an empty string to search every project.",
        ),
    },
  },
  async ({ query, type, limit, include_linked, project }) => {
    const scope = project === undefined ? DEFAULT_PROJECT : project || undefined;
    const results = store.search(query, { type, limit, includeLinked: include_linked, project: scope });
    if (results.length === 0) {
      // 0건에 곧장 remember 를 권하면 "사실은 있는데 표현이 어긋난" 기억이 중복 저장된다.
      // 재질의를 먼저 유도한다 (감사 D2).
      return ok({
        results: [],
        note: "No memories matched this query. Before concluding nothing is stored: retry with different wording (synonyms, the other language, a broader single keyword), or call `list_memories` to see what exists. Only use `remember` once you are confident this is genuinely new.",
      });
    }
    return ok({ results: results.map(searchHit) });
  },
);

server.registerTool(
  "read_memory",
  {
    title: "Read a memory in full",
    description: "Read the full body and history of one memory by slug or id. Reading reinforces the memory.",
    inputSchema: { id: z.string().describe("Memory slug or id") },
  },
  async ({ id }) => {
    const m = store.read(id);
    if (!m) return fail(`Memory not found: ${id}`);
    return ok(full(m));
  },
);

server.registerTool(
  "revise",
  {
    title: "Revise (correct a memory)",
    description:
      "Correct or update an existing memory when it is wrong, incomplete, or outdated (memory reconsolidation). Always provide `reason` — it is appended to the memory's history for audit. " +
      "Revising reinforces the memory and refreshes its recency. Lower `confidence` if the memory became doubtful; raise it when re-confirmed. Prefer this over creating duplicate memories.",
    inputSchema: {
      id: z.string().describe("Memory slug or id"),
      reason: z.string().min(1).describe("Why this revision is being made (recorded in history)"),
      content: z.string().optional().describe("New full markdown body (replaces the old body)"),
      title: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional().describe("New truthfulness score (0-1)"),
      source: z.string().optional().describe("Updated provenance for this memory"),
      project: z
        .string()
        .optional()
        .describe("Reassign project scope. Pass an empty string to make the memory global again."),
    },
  },
  async ({ id, reason, content, title, description, tags, confidence, source, project }) => {
    const m = store.revise(id, { reason, content, title, description, tags, confidence, source, project });
    if (!m) return fail(`Memory not found: ${id}`);
    return ok({ revised: full(m) });
  },
);

server.registerTool(
  "forget",
  {
    title: "Forget (archive a wrong/obsolete memory)",
    description:
      "Archive a memory that turned out to be wrong or is no longer relevant. Not a hard delete — the note moves to the archive with the reason recorded, so it can be audited or restored by hand. " +
      "Use when information is proven false; use `revise` instead if it just needs correction.",
    inputSchema: {
      id: z.string().describe("Memory slug or id"),
      reason: z.string().min(1).describe("Why this memory is being forgotten (recorded in history)"),
    },
  },
  async ({ id, reason }) => {
    const m = store.forget(id, reason);
    if (!m) return fail(`Memory not found: ${id}`);
    return ok({ forgotten: brief(m), archived_to: `archive/${m.slug}.md` });
  },
);

server.registerTool(
  "link",
  {
    title: "Link (associate two memories)",
    description:
      "Create a bidirectional association ([[wikilink]]) between two memories, like human associative memory. Linked memories surface together during recall. " +
      "Call this when two memories are about the same project, cause/effect, or complement each other.",
    inputSchema: {
      source: z.string().describe("Slug or id of the first memory"),
      target: z.string().describe("Slug or id of the second memory"),
      relation: z.string().optional().describe("Short label for the relationship, e.g. 'same project', 'contradicts', 'caused by'"),
    },
  },
  async ({ source, target, relation }) => {
    const linked = store.link(source, target, relation);
    if (!linked) return fail(`Could not link: one of [${source}, ${target}] not found, or they are the same memory.`);
    return ok({ linked: { source: brief(linked.source), target: brief(linked.target), relation } });
  },
);

server.registerTool(
  "reflect",
  {
    title: "Reflect (memory health check)",
    description:
      "Metacognition over the whole vault: counts by type/status, WEAKENED memories (base-level activation fallen below the retrieval threshold — hard to recall), FORGET CANDIDATES (weakened AND low-confidence), low-confidence memories, likely duplicates, and orphans (no links). " +
      "Nothing is deleted automatically — this only surfaces candidates. Call periodically, then clean up with `revise`, `forget`, or `link`.",
    inputSchema: {},
  },
  async () => {
    const r = store.reflect();
    return ok({
      counts: r.counts,
      weakened_hard_to_recall: r.weakened,
      forget_candidates: r.forgetCandidates,
      low_confidence: r.lowConfidence.map((m) => ({ slug: m.slug, title: m.title, confidence: m.confidence })),
      possible_duplicates: r.duplicates,
      orphans_without_links: r.orphans.map((m) => m.slug),
      suggestion:
        "Review forget_candidates and `forget` the ones that are truly obsolete/wrong (reversible — moved to archive). Revise low-confidence memories if you can confirm or correct them. Merge duplicates (revise one, forget the other). Link orphans to related memories.",
    });
  },
);

server.registerTool(
  "list_memories",
  {
    title: "List memories",
    description: "Browse the memory index. Defaults to active memories, most recently updated first.",
    inputSchema: {
      type: MEMORY_TYPE.optional(),
      status: z.enum(["active", "superseded", "archived"]).optional().describe("Filter by status (default: active)"),
      project: z
        .string()
        .optional()
        .describe(
          "Restrict to this project's memories plus global ones. Defaults to the server's BIGBRAIN_PROJECT. Pass an empty string to list every project.",
        ),
    },
  },
  async ({ type, status, project }) => {
    const scope = project === undefined ? DEFAULT_PROJECT : project || undefined;
    const items = store.list({ type, status, project: scope });
    return ok({ count: items.length, memories: items.map(brief) });
  },
);

async function main() {
  // 인덱스 재생성 실패가 서버 기동을 막아서는 안 된다(감사 A1: 손상 파일 1개로
  // process.exit(1) → 8개 도구 전부 사용 불능). MEMORY.md 는 파생 파일이고
  // 기억 조회 자체는 인덱스 없이도 동작한다.
  try {
    store.regenerateIndex();
  } catch (err) {
    console.error(
      `[BigBrainMemory] 인덱스 재생성 실패(계속 진행): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout은 MCP 프로토콜 전용 — 로그는 반드시 stderr로
  const st = vault.inspect();
  const parts = [`memories=${st.memories}`];
  if (st.archived > 0) parts.push(`archived=${st.archived}`);
  if (st.quarantined > 0) parts.push(`quarantined=${st.quarantined}(!)`);
  if (DEFAULT_PROJECT) parts.push(`project=${DEFAULT_PROJECT}`);
  console.error(`[BigBrainMemory] ready. vault=${vaultDir} ${parts.join(" ")}`);
  if (VAULT_WARNING) console.error(`[BigBrainMemory] ${VAULT_WARNING}`);
  if (st.quarantined > 0) {
    console.error(
      `[BigBrainMemory] 격리된 손상 파일 ${st.quarantined}건이 있습니다 — vault/quarantine/ 확인 필요`,
    );
  }
}

main().catch((err) => {
  console.error("[BigBrainMemory] fatal:", err);
  process.exit(1);
});
