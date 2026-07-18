import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { MemoryRecord, MemoryStatus, MemoryType } from "./types.js";

const VALID_TYPES: MemoryType[] = ["episodic", "semantic", "procedural", "preference"];
const VALID_STATUS: MemoryStatus[] = ["active", "superseded", "archived"];

/**
 * gray-matter 는 **옵션 없이** 호출되면 파싱 *전에* 원문을 모듈 캐시에 넣는다
 * (node_modules/gray-matter/index.js 의 `if (!options) { ... matter.cache[...] = file }`).
 * 그래서 깨진 파일의 1차 파싱이 예외로 죽어도 캐시에는 빈 file 객체가 남고,
 * 같은 프로세스의 2차 파싱은 그 캐시를 히트해 "빈 frontmatter" 로 조용히 성공한다.
 * 이 레코드가 그대로 디스크에 write 되면 confidence/storage_strength/created/history 가
 * 전부 기본값으로 세탁된다(감사 A2 — 재현 확정).
 *
 * 옵션 객체를 넘기면 캐시 경로 자체를 타지 않으므로 세탁 벡터가 구조적으로 사라진다.
 * (부수 효과: 파일 내용 전체를 키로 쓰는 무제한 캐시의 메모리 누수도 함께 제거)
 */
const MATTER_OPTIONS: Record<string, never> = {};

/**
 * 절단 감지 — 여는 `---` 는 있는데 닫는 `---` 가 없는 파일.
 * gray-matter 는 이 경우 **예외 없이** 파일 전체를 frontmatter 로 보고 body='' 를
 * 돌려주므로(감사 A3), 여기서 막지 않으면 빈 본문이 정상 파일로 고착된다.
 */
function hasClosingDelimiter(raw: string): boolean {
  if (!/^---\r?\n/.test(raw)) return true; // frontmatter 가 없는 파일은 판정 대상 아님
  return /\n---\s*(\r?\n|$)/.test(raw.slice(3));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 원자적 파일 쓰기 — 같은 디렉터리의 임시 파일에 완전히 쓴 뒤 rename 으로 교체한다.
 * rename 은 같은 볼륨 안에서 원자적이므로, 다른 프로세스나 크래시가
 * "반쯤 쓰인 파일" 을 관측하는 창 자체가 사라진다(감사 A3/A8).
 *
 * 기존의 writeFileSync 직접 덮어쓰기는 닫는 `---` 앞에서 잘린 파일을 남길 수 있었고,
 * 그런 파일은 gray-matter 가 예외 없이 body='' 로 읽어 다음 write 가 고착시켰다.
 */
function writeFileAtomic(fp: string, text: string): void {
  const tmp = `${fp}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, fp);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 임시 파일 정리 실패는 원 오류를 가리지 않도록 무시 */
    }
    throw err;
  }
}

/**
 * 마크다운 볼트(Obsidian 호환)에 대한 저수준 파일 입출력.
 * vault/
 *   memories/  — 활성 기억 (*.md)
 *   archive/   — 망각된 기억 (*.md)
 *   MEMORY.md  — 자동 생성 인덱스
 */
export class Vault {
  readonly root: string;
  readonly memoriesDir: string;
  readonly archiveDir: string;
  /** 손상 파일 격리소 — 삭제하지 않고 여기로 옮긴다(원본 바이트 보존) */
  readonly quarantineDir: string;

  constructor(root: string) {
    this.root = root;
    this.memoriesDir = path.join(root, "memories");
    this.archiveDir = path.join(root, "archive");
    this.quarantineDir = path.join(root, "quarantine");
    fs.mkdirSync(this.memoriesDir, { recursive: true });
    fs.mkdirSync(this.archiveDir, { recursive: true });
  }

  listSlugs(includeArchived = false): { slug: string; archived: boolean }[] {
    const out: { slug: string; archived: boolean }[] = [];
    for (const f of fs.readdirSync(this.memoriesDir)) {
      if (f.endsWith(".md")) out.push({ slug: f.slice(0, -3), archived: false });
    }
    if (includeArchived) {
      for (const f of fs.readdirSync(this.archiveDir)) {
        if (f.endsWith(".md")) out.push({ slug: f.slice(0, -3), archived: true });
      }
    }
    return out;
  }

  filePath(slug: string, archived = false): string {
    return path.join(archived ? this.archiveDir : this.memoriesDir, `${slug}.md`);
  }

  exists(slug: string): boolean {
    return fs.existsSync(this.filePath(slug)) || fs.existsSync(this.filePath(slug, true));
  }

  /**
   * 기억 1건 읽기. 손상 파일은 **예외를 던지지 않고** null 을 반환하고 격리한다 —
   * 파일 1개의 손상이 서버 기동(regenerateIndex→loadAll)이나 전체 회상을
   * 마비시키지 않도록(감사 A1). loadAll/resolve 는 이미 null 을 건너뛴다.
   */
  read(slug: string, archived = false): MemoryRecord | null {
    const fp = this.filePath(slug, archived);
    if (!fs.existsSync(fp)) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(fp, "utf-8");
    } catch (err) {
      console.error(`[BigBrainMemory] 읽기 실패(건너뜀): ${slug} — ${errText(err)}`);
      return null;
    }

    if (raw.trim() === "") {
      this.quarantine(slug, archived, "빈 파일");
      return null;
    }
    if (!hasClosingDelimiter(raw)) {
      this.quarantine(slug, archived, "닫는 frontmatter 구분자(---) 없음 — 쓰기 중 절단 의심");
      return null;
    }

    try {
      const { data, content } = matter(raw, MATTER_OPTIONS);
      return this.fromFrontmatter(slug, data, content.trim());
    } catch (err) {
      this.quarantine(slug, archived, `frontmatter 파싱 실패: ${errText(err)}`);
      return null;
    }
  }

  /**
   * 손상 파일을 quarantine/ 으로 **이동**한다(삭제 아님, 원본 바이트 그대로).
   * 격리에 실패해도 던지지 않는다 — 읽기 경로가 죽으면 A1 이 재발한다.
   */
  private quarantine(slug: string, archived: boolean, reason: string): void {
    const from = this.filePath(slug, archived);
    try {
      fs.mkdirSync(this.quarantineDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const to = path.join(this.quarantineDir, `${slug}.${stamp}.md`);
      fs.renameSync(from, to);
      console.error(`[BigBrainMemory] 손상 파일 격리: ${slug} — ${reason} → ${to}`);
    } catch (err) {
      console.error(
        `[BigBrainMemory] 손상 파일 격리 실패(건너뜀): ${slug} — ${reason} / ${errText(err)}`,
      );
    }
  }

  /** slug를 memories/ → archive/ 순으로 찾는다 */
  find(slug: string): { record: MemoryRecord; archived: boolean } | null {
    const active = this.read(slug, false);
    if (active) return { record: active, archived: false };
    const archived = this.read(slug, true);
    if (archived) return { record: archived, archived: true };
    return null;
  }

  write(record: MemoryRecord, archived = false): void {
    const fm: Record<string, unknown> = {
      id: record.id,
      title: record.title,
      description: record.description,
      type: record.type,
      tags: record.tags,
      confidence: record.confidence,
      storage_strength: Number(record.storageStrength.toFixed(3)),
      status: record.status,
      created: record.created,
      updated: record.updated,
      last_accessed: record.lastAccessed,
      last_reinforced: record.lastReinforced,
      access_count: record.accessCount,
      links: record.links,
      history: record.history,
    };
    if (record.source) fm.source = record.source;
    if (record.supersedes) fm.supersedes = record.supersedes;
    if (record.supersededBy) fm.superseded_by = record.supersededBy;
    if (record.archiveReason) fm.archive_reason = record.archiveReason;
    const text = matter.stringify(`\n${record.body}\n`, fm);
    writeFileAtomic(this.filePath(record.slug, archived), text);
  }

  /** 활성 기억을 archive/로 이동 */
  moveToArchive(slug: string): void {
    const from = this.filePath(slug, false);
    const to = this.filePath(slug, true);
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }

  writeIndex(markdown: string): void {
    writeFileAtomic(path.join(this.root, "MEMORY.md"), markdown);
  }

  /** 제목에서 Windows/Obsidian 호환 파일명 slug 생성 (한글 등 유니코드 유지) */
  makeSlug(title: string): string {
    let base = title
      .trim()
      .replace(/[\\/:*?"<>|#^[\]{}]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 80);
    if (!base) base = "memory";
    let slug = base;
    let n = 2;
    while (this.exists(slug)) {
      slug = `${base}-${n++}`;
    }
    return slug;
  }

  private fromFrontmatter(slug: string, data: Record<string, unknown>, body: string): MemoryRecord {
    const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
    const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    const type = VALID_TYPES.includes(data.type as MemoryType) ? (data.type as MemoryType) : "semantic";
    const status = VALID_STATUS.includes(data.status as MemoryStatus) ? (data.status as MemoryStatus) : "active";
    const now = new Date().toISOString();
    const created = str(data.created, now);
    return {
      id: str(data.id, `mem-${slug}`),
      slug,
      title: str(data.title, slug),
      description: str(data.description),
      type,
      tags: arr(data.tags),
      confidence: Math.min(1, Math.max(0, num(data.confidence, 0.7))),
      // 구버전 노트 호환: storage_strength 없으면 access_count(≥1)로 근사
      storageStrength: Math.max(1, num(data.storage_strength, Math.max(1, num(data.access_count, 1)))),
      status,
      created,
      updated: str(data.updated, now),
      lastAccessed: str(data.last_accessed, now),
      lastReinforced: str(data.last_reinforced, created),
      accessCount: num(data.access_count, 0),
      source: str(data.source) || undefined,
      links: arr(data.links),
      supersedes: str(data.supersedes) || undefined,
      supersededBy: str(data.superseded_by) || undefined,
      archiveReason: str(data.archive_reason) || undefined,
      history: arr(data.history),
      body,
    };
  }
}
