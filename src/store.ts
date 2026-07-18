import { Vault } from "./vault.js";
import type {
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  RememberInput,
  ReviseInput,
  SearchOutcome,
  SearchResult,
} from "./types.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// --- 리포트(docs/memory-model-report.md) 기반 파라미터 -------------------
/** ACT-R 기저활성 감쇠 파라미터 (거듭제곱 망각). 기본 0.5 = ACT-R 표준 */
const DECAY_D = 0.5;
/**
 * 회상/reflect에서 "약해진 기억"으로 보는 기저활성 임계 τ (P6).
 *
 * 활성식을 최근 연습항 분리형으로 바꾸면서(감사 C1) 척도가 통째로 내려갔다:
 * 종전 근사식은 n=1 구간에서 상수항 `ln(1/(1−d))` = ln(2) ≈ 0.693 을 얹고 있었는데
 * 새 식에는 그 항이 없다. 그래서 임계도 **같은 폭만큼 내려야** 종전 판정이 보존된다.
 * (검산: n=1 기억이 τ 를 밑도는 시점이 종전과 동일하게 약 16.2시간)
 */
const RETRIEVAL_THRESHOLD = -0.7 - Math.log(1 / (1 - 0.5)); // ≈ -1.393
/** 간격 게이트 — 직전 강화 후 이 시간이 지나야 저장강도 증가 (P3, 간격효과). 환경변수로 조정 */
const SPACING_WINDOW_MS = (() => {
  const v = Number(process.env.BIGBRAIN_SPACING_MS);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60_000; // 기본 10분
})();
/**
 * 인출강도가 이 값 미만이면 "어렵게 찾은" 회상 → 바람직한 어려움 보너스 (P4).
 * τ 와 같은 이유로 ln(2) 만큼 함께 내렸다(위 RETRIEVAL_THRESHOLD 주석 참조).
 * C1 수정 덕에 이제 **마지막 강화가 최근이면 활성이 높아 보너스가 자동으로 빠진다** —
 * 종전에는 감쇠 시계가 created 고정이라 매일 쓰는 기억도 "어렵게 찾은" 것으로 쳤다.
 */
const HARD_RETRIEVAL_ACTIVATION = 0.5 - Math.log(1 / (1 - 0.5)); // ≈ -0.193
/**
 * 간격 게이트에 막힌 접근도 매번 디스크에 기록할지 (기본 false).
 * accessCount/lastAccessed 는 활성 계산에 쓰이지 않는 표시용 필드라, 조회마다 쓰면
 * git working tree·Obsidian 동기화·백업이 "읽기만 했는데" 변경을 감지한다(감사 B).
 * 접근수 통계를 정확히 원하면 BIGBRAIN_FLUSH_EVERY_ACCESS=1 로 켠다.
 */
const FLUSH_EVERY_ACCESS = /^(1|true|yes)$/i.test(process.env.BIGBRAIN_FLUSH_EVERY_ACCESS ?? "");
/**
 * overlap 임계 3종 (감사 D3). 분모를 min → 자카드로 바꾸면서 함께 재보정했다.
 * 같은 크기 집합 기준 환산: min 0.45→0.29, 0.5→0.33, 0.75→0.60.
 */
const SIMILAR_THRESHOLD = 0.3; // remember 의 유사 기억 보고 (종전 0.45)
const RIF_THRESHOLD = 0.35; // 회상 순위 측면억제 (종전 0.5)
const DUPLICATE_THRESHOLD = 0.6; // reflect 의 중복 후보 (종전 0.75)
/** 이보다 토큰이 적은 집합은 유사도 판단 근거가 부족하다고 보고 비교하지 않는다 */
const MIN_OVERLAP_TOKENS = 3;
/** 동의어로만 맞은 토큰의 가중 — 정확히 일치한 기억이 여전히 위로 오게 한다 (감사 D1) */
const SYNONYM_WEIGHT = 0.6;
/** 직접 매칭 0건일 때 쓰는 2차(느슨한 접두) 패스의 토큰당 점수 (감사 D2) */
const FALLBACK_KEYWORD_WEIGHT = 1.5;
/**
 * 확장 간격 계수 (P3, 감사 C3). 필요 간격이 `α · 나이 / n` 으로 늘어난다.
 * 0 이면 종전의 고정 창 동작. 기본 0.1 = 나이의 10% 를 n 으로 나눈 만큼.
 */
const SPACING_ALPHA = (() => {
  const v = Number(process.env.BIGBRAIN_SPACING_ALPHA);
  return Number.isFinite(v) && v >= 0 ? v : 0.1;
})();
/** reflect 의 weakened 유예기간 — 이보다 어린 기억은 "약해졌다" 고 보지 않는다 (P6, 감사 C2) */
const WEAKENED_GRACE_MS = (() => {
  const v = Number(process.env.BIGBRAIN_WEAKENED_GRACE_H);
  return (Number.isFinite(v) && v >= 0 ? v : 72) * HOUR_MS; // 기본 72시간
})();
/** weakened 로 제시할 상한 비율 — 활성 하위 이만큼만 (0 이면 기능 끄기) */
const WEAKENED_RATIO = (() => {
  const v = Number(process.env.BIGBRAIN_WEAKENED_RATIO);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.2; // 기본 하위 20%
})();
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

/**
 * 한↔영 도메인 용어 사전 (감사 D1).
 *
 * 검색이 표층 부분문자열 매칭이라 "배포" 로 저장한 기억을 `deploy` 로 찾으면 0건이었다.
 * 0건이면 에이전트는 "기억이 없다" 고 결론 내리고 같은 사실을 재학습·중복 저장한다 —
 * RECALL FIRST 수칙의 실효를 깎는 최전선 결함이었다. 임베딩 없이도 가장 흔한
 * 한↔영 혼용만은 메우도록 질의 토큰을 확장한다.
 *
 * 양방향으로 전개되며, 사용자 사전은 BIGBRAIN_SYNONYMS 로 덧붙일 수 있다
 * (형식: "배포=deploy,릴리스;설정=config" — 그룹은 `;`, 항목은 `,`, 좌변은 대표어).
 */
const BUILTIN_SYNONYMS: string[][] = [
  ["배포", "deploy", "deployment", "디플로이", "release", "릴리스", "릴리즈", "출시"],
  ["설정", "config", "configuration", "설정값", "환경설정"],
  ["서버", "server"],
  ["빌드", "build", "컴파일", "compile"],
  ["테스트", "test", "testing", "검증"],
  ["오류", "에러", "error", "실패", "failure", "fail"],
  ["버그", "bug", "결함", "defect"],
  ["인증", "auth", "authentication", "로그인", "login"],
  ["권한", "authorization", "permission", "퍼미션"],
  ["데이터베이스", "db", "database", "디비"],
  ["메모리", "memory", "기억"],
  ["경로", "path", "패스", "디렉터리", "directory", "폴더", "folder"],
  ["파일", "file"],
  ["보안", "security", "시큐리티"],
  ["성능", "performance", "perf", "속도", "speed"],
  ["캐시", "cache", "캐싱", "caching"],
  ["로그", "log", "logging", "로깅"],
  ["의존성", "dependency", "dependencies", "패키지", "package"],
  ["마이그레이션", "migration", "migrate", "이관"],
  ["스키마", "schema"],
  ["포트", "port"],
  ["인스톨러", "installer", "설치", "install", "setup"],
  ["사용자", "user", "유저", "계정", "account"],
  ["문서", "docs", "documentation", "문서화"],
];

/** 토큰 → 동의어 집합. 소문자 키. */
const SYNONYM_INDEX: Map<string, string[]> = (() => {
  const groups = BUILTIN_SYNONYMS.map((g) => [...g]);
  // 사용자 사전 병합
  for (const raw of (process.env.BIGBRAIN_SYNONYMS ?? "").split(";")) {
    const [head, rest] = raw.split("=");
    if (!head || !rest) continue;
    const words = [head, ...rest.split(",")].map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.length >= 2) groups.push(words);
  }
  const idx = new Map<string, string[]>();
  for (const g of groups) {
    for (const w of g) {
      const key = w.toLowerCase();
      idx.set(key, [...new Set([...(idx.get(key) ?? []), ...g.map((x) => x.toLowerCase())])]);
    }
  }
  return idx;
})();

/** 질의 토큰을 동의어까지 확장한다 (원 토큰은 항상 포함) */
function expandTokens(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (const t of tokens) for (const syn of SYNONYM_INDEX.get(t) ?? []) out.add(syn);
  return [...out];
}

/**
 * 링크 메타데이터를 본문에서 제거한다 (감사 D6).
 * link() 는 본문에 `## 연관 기억` 섹션과 `[[슬러그]]` 를 주입하는데, 이것이 검색
 * 대상에 포함되면 링크만 걸린 무관한 기억이 상대 기억의 제목 토큰 질의에
 * **직접 매칭**으로 잡히고 `include_linked: false` 로도 배제되지 않았다.
 * 링크가 많은 허브 기억일수록 무관 질의에 끌려나오고 강화 오염도 커진다.
 */
function stripLinkSection(body: string): string {
  return body
    .replace(/\n#{1,6}\s*연관 기억[\s\S]*$/u, "")
    .replace(/\[\[[^\]]+\]\]/gu, "")
    .trim();
}

/** 한국어 조사 — 긴 것부터 (부분 스트립 방지) */
const PARTICLES = [
  "으로서", "으로써", "에게서", "이라도", "으로", "에서", "부터", "까지", "에게", "한테",
  "보다", "처럼", "이나", "라도", "조차", "마저", "밖에", "라는", "이란",
  "을", "를", "이", "가", "은", "는", "에", "의", "로", "와", "과", "도", "만", "나",
];

/** 조사를 떼어낸 어간. 남는 길이가 2 미만이면 원형을 유지한다 */
function stripParticle(t: string): string {
  for (const p of PARTICLES) {
    if (t.length - p.length >= 2 && t.endsWith(p)) return t.slice(0, -p.length);
  }
  return t;
}

/**
 * 토큰 동일성 — 조사 변화를 흡수하되 **단어 경계는 지킨다** ("모드를" ≈ "모드").
 *
 * 종전에는 무제한 양방향 접두 일치라 단어 경계 개념이 없었다(감사 D3):
 * "서버리스"≈"서버", "인증서"≈"인증", "부산물"≈"부산" 이 모두 참이 되어
 * 무관한 기억이 similar 로 보고되고(→ instructions 가 revise 병합을 유도) RIF 로
 * 순위가 반토막 났다.
 *
 * 흡수하려던 것은 조사뿐이므로 조사를 **명시적으로 떼어내** 비교한다.
 * 그 밖의 복합어 접두는 짧은 쪽 3자 이상 + 길이차 2 이하일 때만 인정한다
 * ("릴리스노트"≈"릴리스" 는 통과, "서버리스"≈"서버" 는 차단).
 */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const na = stripParticle(a);
  const nb = stripParticle(b);
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 3 && long.length - short.length <= 2 && long.startsWith(short);
}

/**
 * overlap 계수 — **자카드**(합집합 대비 겹침).
 *
 * 종전 분모는 min(|A|,|B|) 라, 비교 대상 한쪽이 1~2 토큰으로 희소하기만 하면
 * 토큰 하나만 겹쳐도 유사도가 0.5~1.0 으로 치솟았다(감사 D3). 제목이 짧은 메모 하나가
 * 그 토큰을 공유하는 볼트 전체를 매 질의마다 RIF 로 억제하는 구조였다
 * (실측: 무관한 빌드 문서 3건이 11.52 → 5.76 으로 반토막, overlap 1.0 vs 자카드 0.10).
 * 자카드는 한쪽이 희소해도 부풀지 않아 "근접 중복만 누른다" 는 P5 의도에 맞다.
 *
 * 추가 안전장치: 비교 집합이 3 토큰 미만이면 판단 근거가 부족하므로 0 을 돌려준다.
 */
function overlap(a: string[], b: string[]): number {
  const sa = [...new Set(a)];
  const sb = [...new Set(b)];
  if (sa.length < MIN_OVERLAP_TOKENS || sb.length < MIN_OVERLAP_TOKENS) return 0;
  let inter = 0;
  for (const t of sa) if (sb.some((u) => tokenMatch(t, u))) inter++;
  const union = sa.length + sb.length - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * ACT-R 기저활성 (거듭제곱 망각) — 리포트 P2, **최근 연습항 분리형**.
 *
 *   B = ln( (n−1)·L^−d / (1−d)  +  t_last^−d )
 *   n = 저장강도(빈도), L = 생성 후 경과[시], t_last = 마지막 강화 후 경과[시], d = 0.5
 *
 * 종전에는 순수 optimized-learning 근사식 `ln(n/(1−d)) − d·ln(L)` 을 썼는데,
 * 이 식은 **연습이 생애 전체에 균등 분포한다**는 전제 위에서만 성립한다.
 * 실사용은 불균등하게 강화되므로 전제가 깨지고, 그 결과 감쇠 시계가 사실상
 * "생성 시각"에만 묶여 최근성이 랭킹에 전혀 반영되지 않았다(감사 C1):
 * created 와 n 이 같으면 **어제 강화한 기억과 1년 방치한 기억의 활성이 완전히 동일**했고
 * (실측 둘 다 −2.2364), 어제 5회 쓴 핵심 기억이 몇 초 전 저장한 잡메모에 밀렸다
 * (5.75 vs 7.68). 도구 설명이 광고하던 "frequency+recency" 중 recency 는 허위였다.
 *
 * 이제 **마지막 1회를 정확항 t_last^−d 로 분리**하고 나머지 n−1 회만 근사한다
 * (Petrov 2006 하이브리드 근사의 k=1 형태). 정확식 B = ln(Σ t_j^−d) 의 방향·간격을
 * 잘 따라간다 — 위 시나리오에서 정확식 −1.40/−2.93 대비 이 식은 −1.24/−2.34 로
 * 순서와 격차를 모두 복원한다. 스키마 변경은 없다(lastReinforced 는 이미 저장 중).
 *
 * n=1 일 때는 tail 이 0 이라 B = −d·ln(t_last) 로, 정확식과 **완전히 일치**한다.
 * (종전 근사식은 이 구간에서 +ln(2)≈0.69 만큼 과대평가했다)
 */
function baseLevelActivation(storageStrength: number, ageMs: number, sinceLastReinforceMs: number): number {
  const n = Math.max(1, storageStrength);
  const L = Math.max(ageMs, 60_000) / HOUR_MS; // 최소 1분 → 0 나눗셈/음수 폭주 방지
  // 마지막 강화는 생성보다 앞설 수 없다. 값이 깨졌으면 생성 시각으로 폴백.
  const raw = Number.isFinite(sinceLastReinforceMs) ? Math.min(sinceLastReinforceMs, ageMs) : ageMs;
  const tLast = Math.max(raw, 60_000) / HOUR_MS;
  const tail = ((n - 1) * L ** -DECAY_D) / (1 - DECAY_D);
  return Math.log(tail + tLast ** -DECAY_D);
}

/**
 * 다음 강화까지 필요한 간격 — **확장 간격**(expanding spacing, 감사 C3).
 *
 * 종전에는 고정 10분 창이라 "10분짜리 벼락치기" 가 그대로 통과했다:
 * 11분 주기로 기계적으로 recall 하면 회당 +1 씩 상한 없이 부풀릴 수 있었고
 * (실측 30회 → 저장강도 1→31), 저장강도는 감소 경로가 없어 그 값이 영구히 남는다.
 * 하루 144회면 n=145 가 되어 그 기억은 reflect 의 weakened 에서 수십 년간 면제된다.
 * 간격효과 이론이 요구하는 것은 **간격의 확대**이지 고정 rate limit 이 아니다.
 *
 * 필요 간격 = max(기본창, α · 기억의 나이 / n).
 * 이미 n 번 강화된 기억은 그만큼 더 긴 간격을 요구하므로, 반복 질의로 강도를
 * 무한히 끌어올릴 수 없다. ACT-R 의 합리적 분석(연습 간격이 기억의 생애에 비례해
 * 벌어진다)과도 정합적이다.
 */
function requiredSpacing(m: MemoryRecord, now: number): number {
  const ageMs = Math.max(0, now - Date.parse(m.created));
  const n = Math.max(1, m.storageStrength);
  const expanding = (SPACING_ALPHA * ageMs) / n;
  return Math.max(SPACING_WINDOW_MS, expanding);
}

/** 레코드로부터 기저활성을 계산 — 감쇠 시계 인자를 한 곳에서만 조립한다 */
function activationOf(m: MemoryRecord, now: number = Date.now()): number {
  return baseLevelActivation(
    m.storageStrength,
    now - Date.parse(m.created),
    now - Date.parse(m.lastReinforced),
  );
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
      project: input.project,
      links: [],
      history: [`${today()}: created${input.source ? ` (source: ${input.source})` : ""}`],
      body: input.content.trim(),
    };

    // 유사 기억 탐지 — 중복 저장 대신 revise를 유도하기 위한 신호 (P8: 파괴적 자동병합 금지)
    const titleTokens = tokenize(input.title + " " + record.description);
    const similar = this.loadAll()
      .filter((m) => m.status === "active")
      .filter((m) => overlap(titleTokens, tokenize(m.title + " " + m.description)) >= SIMILAR_THRESHOLD);

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
   * 프로젝트 스코프 필터 (감사 E2).
   * `project` 가 없는 기억은 **전역**이라 어느 프로젝트에서도 통과한다.
   * opts.project 가 없으면 필터 자체를 적용하지 않는다(전체 조회).
   */
  private inScope(m: MemoryRecord, project?: string): boolean {
    if (!project) return true;
    return !m.project || m.project === project;
  }

  /**
   * 회상 — 키워드 점수 × 진실성 가중 × 기저활성 가중 (P2).
   * 회상은 능동 인출로 간주해 상위 기억을 강화하고(P4),
   * 같은 클러스터의 경쟁 유사 기억은 순위에서만 완만히 억제한다(P5, RIF).
   * 질의 토큰은 한↔영 동의어로 확장되고, 직접 매칭이 0건이면 느슨한 2차 패스로
   * 연상 확산의 시드를 만든다(D1/D2).
   */
  /** 결과 배열만 필요할 때 쓰는 편의 래퍼 (컷오프 정보가 필요하면 searchDetailed) */
  search(
    query: string,
    opts?: { type?: MemoryType; limit?: number; includeLinked?: boolean; project?: string },
  ): SearchResult[] {
    return this.searchDetailed(query, opts).results;
  }

  searchDetailed(
    query: string,
    opts?: { type?: MemoryType; limit?: number; includeLinked?: boolean; project?: string },
  ): SearchOutcome {
    const tokens = tokenize(query);
    if (tokens.length === 0) return { results: [], totalMatched: 0 };
    const limit = opts?.limit ?? 5;
    const all = this.loadAll(true);
    const now = Date.now();

    // 질의 토큰을 한↔영 동의어까지 확장한다(감사 D1). 원 토큰은 만점,
    // 동의어는 가중을 낮춰 정확히 일치하는 기억이 여전히 위로 오게 한다.
    const expanded = expandTokens(tokens);
    const exact = new Set(tokens);

    const candidates = all.filter(
      (m) => !(opts?.type && m.type !== opts.type) && this.inScope(m, opts?.project),
    );

    const finish = (m: MemoryRecord, keyword: number): SearchResult => {
      const activation = activationOf(m, now);
      let score = keyword;
      score *= 0.5 + 0.5 * m.confidence; // P1: 진실성 가중 (인출과 독립)
      score *= 0.55 + 0.9 * retrievalStrength(activation); // P2: 기저활성(빈도·최근성) 가중
      if (m.status !== "active") score *= 0.2; // 망각/대체된 기억은 희미하게
      return { record: m, score, activation, snippet: this.snippet(m, expanded) };
    };

    const scored: SearchResult[] = [];
    for (const m of candidates) {
      let keyword = 0;
      // 필드를 **사전 토큰화**해 비교한다(감사 D4). 종전에는 includes/indexOf 라
      // 토큰 경계가 없어 'cat' 질의가 Concatenation·concat·category 를 포함한
      // 무관한 기억을 고득점(7.68/3.84)으로 끌어왔고, 반환된 결과는 능동 인출로
      // 강화까지 받아 오탐이 시간이 갈수록 더 잘 회상되는 방향으로 드리프트했다.
      // 조사 흡수는 tokenMatch 가 담당하므로 한국어 회수율 손실은 없다.
      const titleT = tokenize(m.title);
      const descT = tokenize(m.description);
      const bodyT = tokenize(stripLinkSection(m.body)); // 링크 메타데이터 제외 (D6)
      const tagT = tokenize(m.tags.join(" "));
      for (const t of expanded) {
        const w = exact.has(t) ? 1 : SYNONYM_WEIGHT;
        if (titleT.some((u) => tokenMatch(t, u))) keyword += 5 * w;
        if (tagT.some((u) => tokenMatch(t, u))) keyword += 4 * w;
        if (descT.some((u) => tokenMatch(t, u))) keyword += 3 * w;
        let hits = 0;
        for (const u of bodyT) {
          if (hits >= 3) break;
          if (tokenMatch(t, u)) hits++;
        }
        keyword += hits * w;
      }
      if (keyword === 0) continue;
      scored.push(finish(m, keyword));
    }

    // 2차 패스 — 직접 매칭이 0건이면 제목·태그를 토큰화해 **느슨한 접두 비교**로
    // 시드를 만든다(감사 D2). 종전에는 0건이면 연상(1-hop) 확산도 시드가 없어
    // 진입 자체가 불가능했다 — link() 에 투자한 연상 네트워크가 정작 표층 어휘가
    // 어긋난 질의에서 아무 도움이 못 됐다.
    if (scored.length === 0) {
      for (const m of candidates) {
        const fieldTokens = tokenize(`${m.title} ${m.tags.join(" ")} ${m.description}`);
        const hits = expanded.filter((t) => fieldTokens.some((u) => tokenMatch(t, u))).length;
        if (hits === 0) continue;
        scored.push(finish(m, hits * FALLBACK_KEYWORD_WEIGHT));
      }
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
          ) >= RIF_THRESHOLD,
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
          // 연상으로도 스코프 밖 기억이 새어 들어오면 안 된다
          if (found && found.record.status === "active" && this.inScope(found.record, opts?.project)) {
            have.add(linkSlug);
            const act = activationOf(found.record, now);
            assoc.push({
              record: found.record,
              score: r.score * 0.3,
              activation: act,
              snippet: `(연상: [[${r.record.slug}]] 와 연결됨) ${found.record.description}`,
            });
          }
        }
      }
      // 연상 상한도 limit 에 비례시킨다 — 종전 고정 3건은 limit 을 올려도 그대로였다 (D5)
      results = results.concat(assoc.slice(0, Math.max(1, Math.ceil(limit / 2))));
    }

    // P4: 능동 회상 → 상위 결과 강화 (연상으로만 딸려온 것은 약하게)
    const direct = new Set(results.filter((r) => !r.snippet.startsWith("(연상")).map((r) => r.record.slug));
    for (const r of results) {
      const isDirect = direct.has(r.record.slug);
      this.reinforce(r.record, { active: isDirect, preActivation: r.activation });
    }
    return { results, totalMatched: kept.length };
  }

  /** 기억을 읽으면 강화되지만, 능동 인출(recall)보다 약하다 (P4, 검사효과) */
  read(idOrSlug: string): MemoryRecord | null {
    const found = this.resolve(idOrSlug);
    if (!found) return null;
    const act = activationOf(found.record);
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
    // 되돌릴 수 없는 덮어쓰기를 막는다 — 내용이 실제로 바뀔 때만 구본을 남긴다 (A7)
    if (contentChanged) {
      this.vault.snapshotRevision(m.slug, found.archived);
    }
    if (input.title !== undefined) m.title = input.title;
    if (input.description !== undefined) m.description = input.description;
    if (input.content !== undefined) m.body = input.content.trim();
    if (input.tags !== undefined) m.tags = input.tags;
    if (input.confidence !== undefined) m.confidence = Math.min(1, Math.max(0, input.confidence));
    if (input.source !== undefined) m.source = input.source;
    if (input.project !== undefined) m.project = input.project || undefined; // 빈 문자열 = 전역으로 되돌리기
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

    // 기저활성이 임계 τ 미만 = 오래 안 쓰여 약해진(회상 곤란) 기억.
    //
    // 절대 임계만으로는 신생 볼트에서 전원이 걸린다(감사 C2): n=1 기억은 생성 16.2시간이면
    // τ 를 밑돌아, 저장만 하고 하루 지난 멀쩡한 기억이 전부 "정리 대상" 으로 뜬다.
    // instructions 가 주기적 reflect 후 정리를 지시하므로 오탐이 실제 삭제로 이어질 수 있다.
    // 두 겹으로 완화한다:
    //   (a) 유예기간 — 갓 만든 기억은 아직 "잊혔다" 고 볼 수 없다
    //   (b) 상대 분위 — 볼트에서 상대적으로 가장 약한 것만 고른다. 볼트가 작으면
    //       정리할 것도 없으므로 자연히 0건이 된다(절대 임계만 쓰던 종전의 노이즈 제거)
    const withAct = active.map((m) => ({
      m,
      act: activationOf(m, now),
      matured: now - Date.parse(m.created) >= WEAKENED_GRACE_MS,
    }));
    const brief = (x: (typeof withAct)[number]) => ({
      slug: x.m.slug,
      title: x.m.title,
      activation: Number(x.act.toFixed(2)),
      confidence: x.m.confidence,
    });
    const faded = withAct.filter((x) => x.matured && x.act < RETRIEVAL_THRESHOLD).sort((a, b) => a.act - b.act);
    const cap = Math.floor(active.length * WEAKENED_RATIO);
    const weakened = faded.slice(0, cap).map(brief);
    // 망각 후보 = 약해졌고(활성 낮음) + 확신도도 낮음 (적응적 망각 후보, 실제 삭제는 AI 판단).
    // 확신도 게이트가 이미 강력한 필터라 분위 상한은 걸지 않되, 유예기간은 동일하게 적용한다.
    const forgetCandidates = faded.filter((x) => x.m.confidence < 0.5).map(brief);

    const lowConfidence = active.filter((m) => m.confidence < 0.4);
    const duplicates: [string, string][] = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const sim = overlap(
          tokenize(active[i].title + " " + active[i].description),
          tokenize(active[j].title + " " + active[j].description),
        );
        if (sim >= DUPLICATE_THRESHOLD) duplicates.push([active[i].slug, active[j].slug]);
      }
    }
    const orphans = active.filter((m) => m.links.length === 0);
    return { counts: { total: all.length, byType, byStatus }, weakened, forgetCandidates, lowConfidence, duplicates, orphans };
  }

  list(opts?: { type?: MemoryType; status?: MemoryStatus; project?: string }): MemoryRecord[] {
    return this.loadAll(true)
      .filter((m) => (opts?.type ? m.type === opts.type : true))
      .filter((m) => (opts?.status ? m.status === opts.status : m.status === "active"))
      .filter((m) => this.inScope(m, opts?.project))
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
    let md = "# BigBrainMemory 인덱스\n\n> 자동 생성 파일입니다. 직접 수정하지 마세요.\n";
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
    const gateOpen = sinceReinforce >= requiredSpacing(m, now);
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

    // 간격 게이트가 닫혀 있으면 저장강도가 안 오르므로, 디스크에 반영할 실질 변화가
    // accessCount/lastAccessed 뿐이다. 이 둘은 활성 계산에 쓰이지 않는 표시용 필드인데
    // 매 조회마다 파일을 통째로 재직렬화하면 git/Obsidian/백업이 조회만으로 변경을
    // 감지하고, 비원자 구간을 불필요하게 자주 연다(감사 B). 게이트가 열릴 때 함께
    // 반영되므로 여기서는 쓰기를 생략한다.
    if (delta === 0 && !FLUSH_EVERY_ACCESS) return;

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

  /**
   * 스니펫 — **질의 토큰을 가장 많이 덮는 구간**을 고른다 (감사 D7).
   *
   * 종전에는 토큰 배열 순서대로 훑어 첫 매칭 토큰의 첫 등장 위치만 잘랐다.
   * 그래서 두 토큰이 모두 있는 결론 문장이 본문에 있어도 서두의 일반론이 나왔고,
   * 질의 어순만 바꿔도 결과가 달라졌다("타임아웃 30초" vs "30초 타임아웃").
   * 고정 폭 윈도를 후보 위치마다 대보고 서로 다른 토큰을 가장 많이 포함하는 곳을 쓴다.
   *
   * 링크 메타데이터(`## 연관 기억` 섹션과 [[위키링크]])는 검색·스니펫 대상에서
   * 제외한다 — link() 가 본문에 주입하는 것이라 콘텐츠가 아니다 (감사 D6).
   */
  private snippet(m: MemoryRecord, tokens: string[]): string {
    const body = stripLinkSection(m.body);
    if (!body) return m.description;
    const lower = body.toLowerCase();

    // 토큰별 등장 위치 수집
    const spots: { at: number; token: string }[] = [];
    for (const t of tokens) {
      let idx = -1;
      let seen = 0;
      while (seen < 5 && (idx = lower.indexOf(t, idx + 1)) !== -1) {
        spots.push({ at: idx, token: t });
        seen++;
      }
    }
    if (spots.length === 0) return m.description;

    // 각 등장 위치를 시작점 후보로 삼아 윈도가 덮는 고유 토큰 수를 센다
    // 동점일 때는 **앞선 위치**를 택한다 — 순회 순서(=질의 어순)로 승자가 갈리면
    // "타임아웃 30초" 와 "30초 타임아웃" 의 결과가 달라진다.
    const WIN = 150;
    let best = { start: 0, covered: -1 };
    for (const s of spots) {
      const start = Math.max(0, s.at - 60);
      const end = start + WIN;
      const covered = new Set(spots.filter((x) => x.at >= start && x.at < end).map((x) => x.token)).size;
      if (covered > best.covered || (covered === best.covered && start < best.start)) {
        best = { start, covered };
      }
    }
    const end = Math.min(body.length, best.start + WIN);
    return (
      (best.start > 0 ? "…" : "") +
      body.slice(best.start, end).replace(/\s+/g, " ").trim() +
      (end < body.length ? "…" : "")
    );
  }
}
