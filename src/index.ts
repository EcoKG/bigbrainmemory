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

const store = new MemoryStore(new Vault(vaultDir));

const MEMORY_TYPE = z
  .enum(["episodic", "semantic", "procedural", "preference"])
  .describe(
    "Memory type: episodic (events/experiences), semantic (facts/knowledge), procedural (how-to/workflows), preference (user tastes/style)",
  );

/** instructions 에 실을 기억 인덱스 최대 건수 (컨텍스트 예산 보호) */
const INDEX_LIMIT = Number(process.env.BIGBRAIN_INDEX_LIMIT) || 40;

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
    items = store.list();
  } catch (err) {
    console.error(
      `[BigBrainMemory] 인덱스 요약 생략(계속 진행): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (items.length === 0) {
    return ["", "The vault is currently EMPTY — no memories stored yet. Use `remember` as you learn durable facts."];
  }
  const shown = items.slice(0, INDEX_LIMIT);
  const head =
    items.length > shown.length
      ? `Vault index — ${items.length} memories stored, ${shown.length} most recently updated shown. Use \`recall\` for the full text and anything not listed:`
      : `Vault index — ${items.length} memories currently stored. Use \`recall\` to read the full text:`;
  return [
    "",
    head,
    ...shown.map((m) => `- [${m.type}] ${m.title} — ${m.description}`),
  ];
}

const server = new McpServer(
  { name: "bigbrainmemory", version: "0.1.0" },
  {
    instructions: [
      "BigBrainMemory is a persistent, human-like memory vault (Obsidian-compatible markdown).",
      "Behave like a person with long-term memory:",
      "1. RECALL FIRST — at the start of a task, or when the user mentions past context, call `recall` before answering.",
      "2. REMEMBER — after learning a durable fact, decision, preference, or lesson, call `remember` (not for trivia that only matters this conversation).",
      "3. CORRECT — when new information contradicts an existing memory, call `revise` (fixable) or `forget` (wrong memory) instead of piling up duplicates. If `remember` reports similar memories, prefer revising them.",
      "4. ASSOCIATE — connect related memories with `link` so recall can spread across them.",
      "5. REFLECT — periodically call `reflect` to find weakened, low-confidence, or duplicate memories and clean them up (forget candidates are surfaced, never auto-deleted).",
      "Two independent dimensions (do not conflate them): `confidence` = how likely the memory is TRUE (change only via `revise`); recall accessibility = base-level activation from frequency+recency, computed automatically. A rarely-recalled memory can still be highly trusted, and vice versa.",
      "Record a `source` when you know where a fact came from — it prevents source confusion later. Memories are stored verbatim and never auto-merged; consolidate only via explicit `revise`.",
      ...memoryIndexLines(),
    ].join("\n"),
  },
);

function brief(m: MemoryRecord): Record<string, unknown> {
  return {
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
      supersedes: z.string().optional().describe("Slug or id of an outdated memory this one replaces"),
    },
  },
  async (args) => {
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
    },
  },
  async ({ query, type, limit, include_linked }) => {
    const results = store.search(query, { type, limit, includeLinked: include_linked });
    if (results.length === 0) return ok({ results: [], note: "No memories matched. Consider `remember` if you learn something durable here." });
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
    },
  },
  async ({ id, reason, content, title, description, tags, confidence, source }) => {
    const m = store.revise(id, { reason, content, title, description, tags, confidence, source });
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
    },
  },
  async ({ type, status }) => {
    const items = store.list({ type, status });
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
  console.error(`[BigBrainMemory] ready. vault=${vaultDir}`);
}

main().catch((err) => {
  console.error("[BigBrainMemory] fatal:", err);
  process.exit(1);
});
