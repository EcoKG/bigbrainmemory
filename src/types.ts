/** 사람의 기억 분류를 본뜬 기억 유형 */
export type MemoryType = "episodic" | "semantic" | "procedural" | "preference";

/** active: 살아있는 기억 / superseded: 새 기억으로 대체됨 / archived: 망각(잘못된 기억 등) */
export type MemoryStatus = "active" | "superseded" | "archived";

/**
 * 기억 1건. 리포트(docs/memory-model-report.md) P1에 따라 세 축을 분리한다:
 *  - confidence      : 진실성 — 이 기억이 옳다고 믿는 정도 (revise로만 변함)
 *  - storageStrength : 저장강도 — 단조 증가. 간격 둔 능동 회상으로만 오름 (Bjork)
 *  - 인출강도        : 저장하지 않고 질의 시 기저활성으로 계산 (ACT-R power law)
 */
export interface MemoryRecord {
  id: string;
  /** 파일명(.md 제외). Obsidian 위키링크 대상 */
  slug: string;
  title: string;
  /** 회상 판단에 쓰이는 한 줄 요약 */
  description: string;
  type: MemoryType;
  tags: string[];
  /** 0.0 ~ 1.0 — 진실성(옳다고 믿는 정도). 접근으로 변하지 않는다 */
  confidence: number;
  /** 저장강도 n (Bjork). 기저활성 계산의 빈도항. 단조 증가 */
  storageStrength: number;
  status: MemoryStatus;
  created: string;
  updated: string;
  lastAccessed: string;
  /** 마지막으로 저장강도가 오른 시각 — 간격 게이트 기준 (간격효과) */
  lastReinforced: string;
  /** 원문 접근 총횟수 (정보용, 기저활성엔 미사용) */
  accessCount: number;
  /** 출처 — 인간의 출처혼동(source-monitoring error)을 역보완 (리포트 P8) */
  source?: string;
  /** 연결된 기억의 slug 목록 (연상 네트워크) */
  links: string[];
  supersedes?: string;
  supersededBy?: string;
  archiveReason?: string;
  /** 생성/수정/망각 이력 ("ISO날짜: 내용") */
  history: string[];
  /** frontmatter를 제외한 마크다운 본문 */
  body: string;
}

export interface RememberInput {
  title: string;
  content: string;
  description?: string;
  type: MemoryType;
  tags?: string[];
  links?: string[];
  confidence?: number;
  source?: string;
  supersedes?: string;
}

export interface ReviseInput {
  content?: string;
  title?: string;
  description?: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  reason: string;
}

export interface SearchResult {
  record: MemoryRecord;
  score: number;
  /** 질의 시점 기저활성 (인출강도의 로그) — 디버깅/설명용 */
  activation: number;
  snippet: string;
  /** 측면억제(RIF)로 순위가 눌렸는지 */
  inhibited?: boolean;
}
