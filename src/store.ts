import { Vault } from "./vault.js";
import type {
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  RememberInput,
  ReviseInput,
  SearchResult,
} from "./types.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// --- 리포트(docs/memory-model-report.md) 기반 파라미터 -------------------
/** ACT-R 기저활성 감쇠 파라미터 (거듭제곱 망각). 기본 0.5 = ACT-R 표준 */
const DECAY_D = 0.5;
/** 회상/reflect에서 "약해진 기억"으로 보는 기저활성 임계 τ (P6) */
const RETRIEVAL_THRESHOLD = -0.7;
/** 간격 게이트 — 직전 강화 후 이 시간이 지나야 저장강도 증가 (P3, 간격효과). 환경변수로 조정 */
const SPACING_WINDOW_MS = (() => {
  const v = Number(process.env.BIGBRAIN_SPACING_MS);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60_000; // 기본 10분
})();
/** 인출강도가 이 값 미만이면 "어렵게 찾은" 회상 → 바람직한 어려움 보너스 (P4) */
const HARD_RETRIEVAL_ACTIVATION = 0.5;
// -----------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function today(): string {
  return nowIso().slice(0, 10);
}

function newId(): string {
  return `mem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/** 한국어 조사/어미 변화를 흡수하기 위한 접두 일치 ("모드를" ≈ "모드") */
function tokenMatch(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** overlap 계수 — 짧은 쪽 집합 대비 겹침 비율 */
function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = [...new Set(a)];
  const sb = [...new Set(b)];
  let inter = 0;
  for (const t of sa) if (sb.some((u) => tokenMatch(t, u))) inter++;
  return inter / Math.min(sa.length, sb.length);
}

/**
 * ACT-R 기저활성 (거듭제곱 망각) — 리포트 P2.
 *   B = ln( n / (1 − d) ) − d · ln(L)
 *   n = 저장강도(빈도), L = 경과시간[시], d = 감쇠(0.5, ACT-R 기본값)
 * 이 식은 ACT-R의 표준 "optimized learning" 근사식(Anderson & Lebiere 1998,
 * Anderson & Schooler 1991의 합리적 분석 기반)이다. 정확식 B = ln(Σ t_j^−d)의
 * 저비용 근사이며, Petrov(2006)의 하이브리드 근사와는 다른 별개의 식이다.
 * 지수 망각곡선(에빙하우스) 대신 거듭제곱 법칙을 채택했다.
 */
function baseLevelActivation(storageStrength: number, ageMs: number): number {
  const n = Math.max(1, storageStrength);
  const ageHours = Math.max(ageMs, 60_000) / HOUR_MS; // 최소 1분 → 0 나눗셈/음수 폭주 방지
  return Math.log(n / (1 - DECAY_D)) - DECAY_D * Math.log(ageHours);
}

/** 활성값을 (0,1) 인출강도로 압축 (로지스틱) */
function retrievalStrength(activation: number): number {
  return 1 / (1 + Math.exp(-(activation - RETRIEVAL_THRESHOLD)));
}

/**
 * 인간형 기억 저장소 — 리포트(docs/memory-model-report.md) 원칙 P1~P8 반영.
 * - P1: 진실성 / 저장강도 / (계산되는)인출강도 3축 분리
 * - P2: 거듭제곱 기저활성으로 회상 순위
 * - P3: 간격 게이트 강화
 * - P4: 능동>수동 + 바람직한 어려움
 * - P5: 측면억제(RIF)는 순위에만
 * - P6: 적응적 망각 제안(자동삭제 금지)
 * - P7: 재공고화의 안전한 절반(revise)
 * - P8: verbatim 저장 + 출처 필드
 */
export class MemoryStore {
  constructor(private vault: Vault) {}

  loadAll(includeArchived = false): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    for (const { slug, archived } of this.vault.listSlugs(includeArchived)) {
      const rec = this.vault.read(slug, archived);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** id 또는 slug로 조회 */
  resolve(idOrSlug: string): { record: MemoryRecord; archived: boolean } | null {
    const bySlug = this.vault.find(idOrSlug);
    if (bySlug) return bySlug;
    for (const { slug, archived } of this.vault.listSlugs(true)) {
      const rec = this.vault.read(slug, archived);
      if (rec && rec.id === idOrSlug) return { record: rec, archived };
    }
    return null;
  }

  remember(input: RememberInput): { record: MemoryRecord; similar: MemoryRecord[] } {
    const now = nowIso();
    const slug = this.vault.makeSlug(input.title);
    const record: MemoryRecord = {
      id: newId(),
      slug,
      title: input.title,
      description: input.description ?? input.content.split("\n")[0].slice(0, 120),
      type: input.type,
      tags: input.tags ?? [],
      confidence: Math.min(1, Math.max(0, input.confidence ?? 0.8)),
      storageStrength: 1, // 최초 부호화 = 저장강도 1 (Bjork: 이후 단조 증가)
      status: "active",
      created: now,
      updated: now,
      lastAccessed: now,
      lastReinforced: now,
      accessCount: 0,
      source: input.source,
      links: [],
      history: [`${today()}: created${input.source ? ` (source: ${input.source})` : ""}`],
      body: input.content.trim(),
    };

    // 유사 기억 탐지 — 중복 저장 대신 revise를 유도하기 위한 신호 (P8: 파괴적 자동병합 금지)
    const titleTokens = tokenize(input.title + " " + record.description);
    const similar = this.loadAll()
      .filter((m) => m.status === "active")
      .filter((m) => overlap(titleTokens, tokenize(m.title + " " + m.description)) >= 0.45);

    // 기존 기억 대체(supersede) — 신규 레코드 쪽 표시는 **생성 전에** 해야 본문에 직렬화된다
    const found = input.supersedes ? this.resolve(input.supersedes) : null;
    const superseded = found && !found.archived ? found.record : null;
    if (superseded) {
      record.supersedes = superseded.slug;
      record.history.push(`${today()}: supersedes [[${superseded.slug}]]`);
    }

    // 원자적 생성 — slug 확정과 파일 생성이 한 연산이라 동시 remember 가 서로를
    // 덮어쓰지 못한다(감사 A5). 충돌 시 record.slug 가 -2, -3 … 으로 갱신된다.
    const finalSlug = this.vault.createNew(record);

    // 구 기억 쪽 역참조는 **최종 slug 확정 뒤에** — 충돌로 -2 가 붙으면
    // 생성 전 slug 로 기록한 supersededBy 가 없는 파일을 가리키게 된다
    if (superseded) {
      superseded.status = "superseded";
      superseded.supersededBy = finalSlug;
      superseded.updated = now;
      superseded.history.push(`${today()}: superseded by [[${finalSlug}]]`);
      this.vault.write(superseded);
    }

    // 요청된 링크 연결 (양방향)
    for (const target of input.links ?? []) {
      this.link(finalSlug, target);
    }

    this.regenerateIndex();
    return { record: this.vault.read(finalSlug) ?? record, similar };
  }

  /**
   * 회상 — 키워드 점수 × 진실성 가중 × 기저활성 가중 (P2).
   * 회상은 능동 인출로 간주해 상위 기억을 강화하고(P4),
   * 같은 클러스터의 경쟁 유사 기억은 순위에서만 완만히 억제한다(P5, RIF).
   */
  search(query: string, opts?: { type?: MemoryType; limit?: number; includeLinked?: boolean }): SearchResult[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const limit = opts?.limit ?? 5;
    const all = this.loadAll(true);
    const now = Date.now();

    const scored: SearchResult[] = [];
    for (const m of all) {
      if (opts?.type && m.type !== opts.type) continue;
      let keyword = 0;
      const title = m.title.toLowerCase();
      const desc = m.description.toLowerCase();
      const body = m.body.toLowerCase();
      const tags = m.tags.map((t) => t.toLowerCase());
      for (const t of tokens) {
        if (title.includes(t)) keyword += 5;
        if (tags.some((tag) => tag.includes(t))) keyword += 4;
        if (desc.includes(t)) keyword += 3;
        let idx = -1;
        let hits = 0;
        while (hits < 3 && (idx = body.indexOf(t, idx + 1)) !== -1) hits++;
        keyword += hits;
      }
      if (keyword === 0) continue;

      const activation = baseLevelActivation(m.storageStrength, now - Date.parse(m.created));
      let score = keyword;
      score *= 0.5 + 0.5 * m.confidence; // P1: 진실성 가중 (인출과 독립)
      score *= 0.55 + 0.9 * retrievalStrength(activation); // P2: 기저활성(빈도·최근성) 가중
      if (m.status !== "active") score *= 0.2; // 망각/대체된 기억은 희미하게

      scored.push({ record: m, score, activation, snippet: this.snippet(m, tokens) });
    }
    scored.sort((a, b) => b.score - a.score);

    // P5: 측면억제(RIF) — 상위 결과와 유사한 하위 경쟁 기억은 순위에서만 눌린다.
    // 저장된 진실성·저장강도는 절대 건드리지 않는다(오삭제 위험 차단).
    const kept: SearchResult[] = [];
    for (const r of scored) {
      const rivalOf = kept.find(
        (k) =>
          overlap(
            tokenize(k.record.title + " " + k.record.description),
            tokenize(r.record.title + " " + r.record.description),
          ) >= 0.5,
      );
      if (rivalOf) {
        r.score *= 0.5;
        r.inhibited = true;
      }
      kept.push(r);
    }
    kept.sort((a, b) => b.score - a.score);
    let results = kept.slice(0, limit);

    // 연상: 상위 결과의 링크 1-hop 이웃 (P: 확산활성 근사)
    if (opts?.includeLinked !== false) {
      const have = new Set(results.map((r) => r.record.slug));
      const assoc: SearchResult[] = [];
      for (const r of results.slice(0, 3)) {
        for (const linkSlug of r.record.links) {
          if (have.has(linkSlug)) continue;
          const found = this.vault.find(linkSlug);
          if (found && found.record.status === "active") {
            have.add(linkSlug);
            const act = baseLevelActivation(found.record.storageStrength, now - Date.parse(found.record.created));
            assoc.push({
              record: found.record,
              score: r.score * 0.3,
              activation: act,
              snippet: `(연상: [[${r.record.slug}]] 와 연결됨) ${found.record.description}`,
            });
          }
        }
      }
      results = results.concat(assoc.slice(0, 3));
    }

    // P4: 능동 회상 → 상위 결과 강화 (연상으로만 딸려온 것은 약하게)
    const direct = new Set(results.filter((r) => !r.snippet.startsWith("(연상")).map((r) => r.record.slug));
    for (const r of results) {
      const isDirect = direct.has(r.record.slug);
      this.reinforce(r.record, { active: isDirect, preActivation: r.activation });
    }
    return results;
  }

  /** 기억을 읽으면 강화되지만, 능동 인출(recall)보다 약하다 (P4, 검사효과) */
  read(idOrSlug: string): MemoryRecord | null {
    const found = this.resolve(idOrSlug);
    if (!found) return null;
    const act = baseLevelActivation(found.record.storageStrength, Date.now() - Date.parse(found.record.created));
    this.reinforce(found.record, { active: false, preActivation: act });
    return found.record;
  }

  /**
   * 잘못된 기억 교정 — 재공고화의 안전한 절반만 취한다 (P7).
   * 이력 보존 + 재확인(내용 미변경)은 저장강도·최근성 강화. 자동 오염 경로 없음.
   */
  revise(idOrSlug: string, input: ReviseInput): MemoryRecord | null {
    const found = this.resolve(idOrSlug);
    if (!found) return null;
    const m = found.record;
    const contentChanged = input.content !== undefined && input.content.trim() !== m.body;
    if (input.title !== undefined) m.title = input.title;
    if (input.description !== undefined) m.description = input.description;
    if (input.content !== undefined) m.body = input.content.trim();
    if (input.tags !== undefined) m.tags = input.tags;
    if (input.confidence !== undefined) m.confidence = Math.min(1, Math.max(0, input.confidence));
    if (input.source !== undefined) m.source = input.source;
    this.ensureBodyLinks(m); // 본문 교체로 연상 링크가 소실되지 않도록 복원
    // 재공고화: 재확인/갱신은 기억을 강화하고 최근성 시계를 갱신
    m.storageStrength += 1;
    m.lastReinforced = nowIso();
    m.lastAccessed = nowIso();
    m.updated = nowIso();
    m.history.push(
      `${today()}: ${contentChanged ? "revised" : "reconfirmed"} — ${input.reason}${input.source ? ` (source: ${input.source})` : ""}`,
    );
    this.vault.write(m, found.archived);
    this.regenerateIndex();
    return m;
  }

  /** 망각 — 삭제하지 않고 archive/로 이동, 사유 기록 (P6: 가역) */
  forget(idOrSlug: string, reason: string): MemoryRecord | null {
    const found = this.resolve(idOrSlug);
    if (!found) return null;
    const m = found.record;
    m.status = "archived";
    m.archiveReason = reason;
    m.updated = nowIso();
    m.history.push(`${today()}: forgotten — ${reason}`);
    if (!found.archived) {
      this.vault.write(m); // 이력 반영 후 이동
      this.vault.moveToArchive(m.slug);
    } else {
      this.vault.write(m, true);
    }
    this.regenerateIndex();
    return m;
  }

  /** 두 기억을 연상 관계로 연결 (양방향 위키링크) */
  link(sourceIdOrSlug: string, targetIdOrSlug: string, relation?: string): { source: MemoryRecord; target: MemoryRecord } | null {
    const s = this.resolve(sourceIdOrSlug);
    const t = this.resolve(targetIdOrSlug);
    if (!s || !t || s.record.slug === t.record.slug) return null;
    this.addLink(s.record, t.record.slug, relation, s.archived);
    this.addLink(t.record, s.record.slug, relation, t.archived);
    this.regenerateIndex();
    return { source: s.record, target: t.record };
  }

  /** 메타인지 — 기억 상태 점검 리포트 (P6: 망각은 제안만, 자동삭제 없음) */
  reflect(): {
    counts: { total: number; byType: Record<string, number>; byStatus: Record<string, number> };
    weakened: { slug: string; title: string; activation: number; confidence: number }[];
    forgetCandidates: { slug: string; title: string; activation: number; confidence: number }[];
    lowConfidence: MemoryRecord[];
    duplicates: [string, string][];
    orphans: MemoryRecord[];
  } {
    const all = this.loadAll(true);
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const m of all) {
      byType[m.type] = (byType[m.type] ?? 0) + 1;
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    }
    const now = Date.now();
    const active = all.filter((m) => m.status === "active");

    // 기저활성이 임계 τ 미만 = 오래 안 쓰여 약해진(회상 곤란) 기억
    const withAct = active.map((m) => ({
      m,
      act: baseLevelActivation(m.storageStrength, now - Date.parse(m.created)),
    }));
    const weakened = withAct
      .filter((x) => x.act < RETRIEVAL_THRESHOLD)
      .sort((a, b) => a.act - b.act)
      .map((x) => ({ slug: x.m.slug, title: x.m.title, activation: Number(x.act.toFixed(2)), confidence: x.m.confidence }));
    // 망각 후보 = 약해졌고(활성 낮음) + 확신도도 낮음 (적응적 망각 후보, 실제 삭제는 AI 판단)
    const forgetCandidates = withAct
      .filter((x) => x.act < RETRIEVAL_THRESHOLD && x.m.confidence < 0.5)
      .map((x) => ({ slug: x.m.slug, title: x.m.title, activation: Number(x.act.toFixed(2)), confidence: x.m.confidence }));

    const lowConfidence = active.filter((m) => m.confidence < 0.4);
    const duplicates: [string, string][] = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const sim = overlap(
          tokenize(active[i].title + " " + active[i].description),
          tokenize(active[j].title + " " + active[j].description),
        );
        if (sim >= 0.75) duplicates.push([active[i].slug, active[j].slug]);
      }
    }
    const orphans = active.filter((m) => m.links.length === 0);
    return { counts: { total: all.length, byType, byStatus }, weakened, forgetCandidates, lowConfidence, duplicates, orphans };
  }

  list(opts?: { type?: MemoryType; status?: MemoryStatus }): MemoryRecord[] {
    return this.loadAll(true)
      .filter((m) => (opts?.type ? m.type === opts.type : true))
      .filter((m) => (opts?.status ? m.status === opts.status : m.status === "active"))
      .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  }

  /** MEMORY.md 인덱스 재생성 (Obsidian에서 허브 노트로 사용 가능) */
  regenerateIndex(): void {
    const active = this.loadAll().filter((m) => m.status === "active");
    const groups: Record<MemoryType, MemoryRecord[]> = {
      preference: [],
      semantic: [],
      episodic: [],
      procedural: [],
    };
    for (const m of active) groups[m.type].push(m);
    const label: Record<MemoryType, string> = {
      preference: "취향/선호 (preference)",
      semantic: "지식/사실 (semantic)",
      episodic: "경험/사건 (episodic)",
      procedural: "방법/절차 (procedural)",
    };
    let md = `# BigBrainMemory 인덱스\n\n> 자동 생성 파일입니다. 직접 수정하지 마세요. (${nowIso()})\n`;
    for (const type of Object.keys(groups) as MemoryType[]) {
      const items = groups[type];
      if (items.length === 0) continue;
      md += `\n## ${label[type]}\n\n`;
      for (const m of items.sort((a, b) => b.confidence - a.confidence)) {
        md += `- [[memories/${m.slug}|${m.title}]] — ${m.description} (확신도 ${m.confidence.toFixed(2)})\n`;
      }
    }
    this.vault.writeIndex(md);
  }

  /**
   * 강화 (P3 간격 게이트 + P4 능동>수동 + 바람직한 어려움).
   * 저장강도는 간격이 지나야 오른다. 원문 접근수/최근성은 항상 갱신.
   *
   * **디스크 반영은 스냅샷이 아니라 재읽기 후 증분으로 한다(감사 A4).**
   * search() 는 시작 시 loadAll 로 전체 스냅샷을 뜨고 끝에서 강화를 기록하는데,
   * 그 창(볼트 스캔 1회 길이) 안에 다른 프로세스가 revise/forget 을 끝내면
   * 스냅샷 전체를 재직렬화하던 기존 구현이 상대의 변경을 흔적 없이 되돌렸다:
   *   - revise 소실: body/confidence/history 가 이전 상태로 복귀
   *   - forget 부활: archive 로 옮겨진 기억이 memories/ 에 되살아나 split-brain
   *   - 강화 소실: 2프로세스 300회씩 recall 시 84~99.5% 유실
   * 이제 쓰기 직전 파일을 다시 읽어 **그 레코드에 델타만 얹어** 기록하므로,
   * 경쟁 프로세스가 바꾼 내용(본문·확신도·이력·상태)은 그대로 보존된다.
   *
   * 강화는 best-effort 다 — 쓰기에 실패해도 던지지 않는다. 회상/열람이
   * 부수효과(강화) 실패 때문에 통째로 실패하면 안 된다.
   */
  private reinforce(m: MemoryRecord, opts: { active: boolean; preActivation: number }): void {
    const now = Date.now();
    const sinceReinforce = now - Date.parse(m.lastReinforced);
    const gateOpen = sinceReinforce >= SPACING_WINDOW_MS;
    let delta = 0;
    if (gateOpen) {
      delta = opts.active ? 1 : 0.5; // 검사효과: 능동 인출 > 수동 열람
      if (opts.active && opts.preActivation < HARD_RETRIEVAL_ACTIVATION) {
        delta += 0.5; // 바람직한 어려움: 어렵게 찾아낸 회상은 더 큰 강화
      }
    }

    // 호출자가 들고 있는 인메모리 레코드(검색 결과로 반환됨)도 일관되게 갱신
    m.accessCount += 1;
    m.lastAccessed = nowIso();
    if (delta > 0) {
      m.storageStrength += delta;
      m.lastReinforced = nowIso();
    }

    try {
      // 현재 디스크 상태를 다시 읽는다 — 위치(memories/archive)도 여기서 재확인된다.
      const fresh = this.vault.find(m.slug);
      if (!fresh) return; // 그 사이 삭제됨 → 되살리지 않는다
      const target = fresh.record;
      target.accessCount += 1;
      target.lastAccessed = m.lastAccessed;
      if (delta > 0) {
        target.storageStrength += delta;
        target.lastReinforced = m.lastReinforced;
      }
      this.vault.write(target, fresh.archived); // forget 으로 이동했으면 archive 쪽에 기록
    } catch (err) {
      console.error(
        `[BigBrainMemory] 강화 기록 실패(무시): ${m.slug} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private addLink(m: MemoryRecord, targetSlug: string, relation: string | undefined, archived: boolean): void {
    if (!m.links.includes(targetSlug)) m.links.push(targetSlug);
    this.appendBodyLink(m, targetSlug, relation);
    m.updated = nowIso();
    this.vault.write(m, archived);
  }

  /** frontmatter의 links 배열 기준으로 본문에 빠진 위키링크를 복원 */
  private ensureBodyLinks(m: MemoryRecord): void {
    for (const target of m.links) {
      this.appendBodyLink(m, target, undefined);
    }
  }

  private appendBodyLink(m: MemoryRecord, targetSlug: string, relation: string | undefined): void {
    if (m.body.includes(`[[${targetSlug}]]`)) return;
    const marker = "## 연관 기억";
    const line = `- [[${targetSlug}]]${relation ? ` — ${relation}` : ""}`;
    if (m.body.includes(marker)) {
      m.body = m.body.replace(marker, `${marker}\n${line}`);
    } else {
      m.body = `${m.body}\n\n${marker}\n${line}`;
    }
  }

  private snippet(m: MemoryRecord, tokens: string[]): string {
    const body = m.body;
    const lower = body.toLowerCase();
    for (const t of tokens) {
      const idx = lower.indexOf(t);
      if (idx !== -1) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(body.length, idx + 90);
        return (start > 0 ? "…" : "") + body.slice(start, end).replace(/\n+/g, " ") + (end < body.length ? "…" : "");
      }
    }
    return m.description;
  }
}
