import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { MemoryRecord, MemoryStatus, MemoryType } from "./types.js";

const VALID_TYPES: MemoryType[] = ["episodic", "semantic", "procedural", "preference"];
const VALID_STATUS: MemoryStatus[] = ["active", "superseded", "archived"];

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

  constructor(root: string) {
    this.root = root;
    this.memoriesDir = path.join(root, "memories");
    this.archiveDir = path.join(root, "archive");
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

  read(slug: string, archived = false): MemoryRecord | null {
    const fp = this.filePath(slug, archived);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf-8");
    const { data, content } = matter(raw);
    return this.fromFrontmatter(slug, data, content.trim());
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
    fs.writeFileSync(this.filePath(record.slug, archived), text, "utf-8");
  }

  /** 활성 기억을 archive/로 이동 */
  moveToArchive(slug: string): void {
    const from = this.filePath(slug, false);
    const to = this.filePath(slug, true);
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }

  writeIndex(markdown: string): void {
    fs.writeFileSync(path.join(this.root, "MEMORY.md"), markdown, "utf-8");
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
