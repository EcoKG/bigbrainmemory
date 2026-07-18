#!/usr/bin/env node
// Claude Code 네이티브 프로젝트 메모리를 BigBrainMemory 볼트로 이관한다 (감사 E5).
//
// 네이티브는 프로젝트별로 저장소가 갈리고(~/.claude/projects/<슬러그>/memory/*.md)
// 분류 체계도 다르다(user/feedback/project/reference vs episodic/semantic/procedural/preference).
// 수작업 이관은 타입이 임의로 배정돼 type 필터 회상의 정밀도를 깎으므로, 매핑 규칙을
// 고정하고 멱등하게 만든다.
//
// 사용법:
//   node scripts/import-native.mjs                 # 미리보기 (아무것도 쓰지 않음)
//   node scripts/import-native.mjs --apply         # 실제 이관
//   node scripts/import-native.mjs --apply --vault D:/vault --projects-dir /경로
//
// 안전 기본값: --apply 없이는 **쓰지 않는다**. 무엇이 어떤 타입으로 들어갈지 먼저 보여준다.
// 멱등: 같은 원본 파일에서 온 기억이 이미 있으면(source 일치) 건너뛴다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APPLY = process.argv.includes("--apply");
const PROJECTS_DIR = arg(
  "--projects-dir",
  path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects"),
);
const VAULT = arg("--vault", process.env.BIGBRAIN_VAULT || path.join(repo, "vault"));

/**
 * 네이티브 타입 → BBM 타입 매핑.
 * 두 체계가 1:1 이 아니라서 일부는 본문을 보고 갈라야 한다 — 판단 근거를 항상 출력해
 * 사람이 확인·정정할 수 있게 한다.
 */
function mapType(nativeType, body, name) {
  const t = (nativeType || "").toLowerCase();
  if (t === "user") return { type: "preference", why: "user = 사용자 정체·선호" };
  if (t === "feedback") {
    // "How to apply:" / "적용" 같은 실행 지침이 있으면 절차, 아니면 취향
    return /how to apply|적용 방법|적용:|하도록|할 것/i.test(body)
      ? { type: "procedural", why: "feedback + 실행 지침 문구" }
      : { type: "preference", why: "feedback + 취향 서술" };
  }
  if (t === "project") {
    // 특정 시점의 사건·결정이면 일화, 지속적 사실·구조면 의미
    return /\d{4}-\d{2}-\d{2}|했다|였다|결정했|하기로/.test(body)
      ? { type: "episodic", why: "project + 시점/사건 표현" }
      : { type: "semantic", why: "project + 지속적 사실" };
  }
  if (t === "reference") return { type: "procedural", why: "reference = 참조 절차·자료" };
  return { type: "semantic", why: `알 수 없는 타입(${nativeType || "없음"}) → 기본값` };
}

/** ~/.claude/projects/<슬러그>/memory/*.md 를 수집 (인덱스 MEMORY.md 제외) */
function collect(projectsDir) {
  const out = [];
  if (!fs.existsSync(projectsDir)) return out;
  for (const proj of fs.readdirSync(projectsDir)) {
    const memDir = path.join(projectsDir, proj, "memory");
    if (!fs.existsSync(memDir)) continue;
    for (const f of fs.readdirSync(memDir)) {
      if (!f.endsWith(".md") || f === "MEMORY.md") continue;
      out.push({ project: proj, file: path.join(memDir, f) });
    }
  }
  return out;
}

const found = collect(PROJECTS_DIR);
console.log(`네이티브 메모리 스캔: ${PROJECTS_DIR}`);
console.log(`  대상 ${found.length}건 / 볼트 ${VAULT}`);
console.log(APPLY ? "  모드: 실제 이관(--apply)\n" : "  모드: 미리보기 — 아무것도 쓰지 않습니다. 실제 이관은 --apply\n");

if (found.length === 0) {
  console.log("이관할 파일이 없습니다.");
  process.exit(0);
}

const { Vault } = await import(`file://${path.join(repo, "dist", "vault.js").replace(/\\/g, "/")}`);
const { MemoryStore } = await import(`file://${path.join(repo, "dist", "store.js").replace(/\\/g, "/")}`);
const store = new MemoryStore(new Vault(VAULT));

// 멱등성: 이미 같은 원본에서 온 기억이 있으면 건너뛴다
const existingSources = new Set(
  store
    .loadAll(true)
    .map((m) => m.source)
    .filter(Boolean),
);

let imported = 0;
let skipped = 0;
let failed = 0;

for (const { project, file } of found) {
  const rel = path.basename(file);
  let parsed;
  try {
    parsed = matter(fs.readFileSync(file, "utf-8"), {});
  } catch (err) {
    console.log(`  ✘ ${project}/${rel} — frontmatter 파싱 실패: ${err.message}`);
    failed++;
    continue;
  }
  const fm = parsed.data ?? {};
  const body = (parsed.content ?? "").trim();
  const name = String(fm.name || rel.replace(/\.md$/, ""));
  const source = `native:${project}/${rel}`;

  if (existingSources.has(source)) {
    console.log(`  · ${project}/${rel} — 이미 이관됨(건너뜀)`);
    skipped++;
    continue;
  }
  if (!body) {
    console.log(`  ✘ ${project}/${rel} — 본문이 비어 있음(건너뜀)`);
    failed++;
    continue;
  }

  const nativeType = fm.metadata?.type ?? fm.type;
  const { type, why } = mapType(nativeType, body, name);
  const description = String(fm.description || body.split("\n")[0].slice(0, 120));

  console.log(`  + ${project}/${rel}`);
  console.log(`      제목: ${name}`);
  console.log(`      타입: ${nativeType || "(없음)"} → ${type}  (${why})`);
  console.log(`      스코프: project=${project}`);

  if (!APPLY) {
    imported++;
    continue;
  }
  try {
    // 제목을 원본 name 그대로 쓴다 — 본문의 [[위키링크]] 가 그대로 해석되도록
    const { record, similar } = store.remember({
      title: name,
      description,
      content: body,
      type,
      project,
      source,
      tags: ["native-import"],
    });
    if (similar.length > 0) {
      console.log(`      ⚠ 유사 기억 ${similar.length}건: ${similar.map((m) => m.slug).join(", ")} — 나중에 consolidate 로 정리 권장`);
    }
    if (record.slug !== name.toLowerCase().replace(/\s+/g, "-")) {
      console.log(`      슬러그: ${record.slug}`);
    }
    imported++;
  } catch (err) {
    console.log(`      ✘ 저장 실패: ${err.message}`);
    failed++;
  }
}

console.log("");
console.log(APPLY ? `이관 ${imported}건 / 건너뜀 ${skipped}건 / 실패 ${failed}건` : `이관 예정 ${imported}건 / 건너뜀 ${skipped}건 / 실패 ${failed}건`);
if (!APPLY && imported > 0) console.log("실제로 이관하려면 --apply 를 붙여 다시 실행하세요.");
if (APPLY && imported > 0) {
  console.log("");
  console.log("이관 후 권장: 원본을 지우지 말고 아카이브해 두고,");
  console.log("네이티브 memory/MEMORY.md 는 'recall 로 조회' 안내로 바꿔 브리지로 남기세요(README 참조).");
}
process.exit(failed > 0 ? 1 : 0);
