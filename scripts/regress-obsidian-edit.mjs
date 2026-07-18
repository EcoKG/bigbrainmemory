// T5/T6 회귀 테스트 — 사용자가 볼트를 직접 만지거나 기억을 교정할 때 데이터가 상하지 않는지.
//
// 고정하는 버그:
//   A6 Obsidian/손편집의 **인용부호 없는** 날짜를 js-yaml 이 Date 로 파싱하고,
//      str() 가드가 문자열이 아니라며 버려서 created/updated/lastAccessed/lastReinforced 가
//      전부 "지금" 으로 리셋됐다 → 오래된 기억의 기저활성이 부풀고 다음 write 가 고착
//   A7 revise 가 본문을 즉시 덮어쓰고 reason 한 줄만 남겨 되돌릴 방법이 없었다
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distUrl = (f) => `file://${path.join(root, "dist", f).replace(/\\/g, "/")}`;
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore } = await import(distUrl("store.js"));

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const cleanups = [];
function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-edit-"));
  cleanups.push(d);
  return d;
}
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);

// ── 1. 인용 없는 날짜가 리셋되지 않는다 (A6)
console.log("1) 인용부호 없는 YAML 날짜 보존 (A6)");
{
  const dir = freshDir();
  const store = new MemoryStore(new Vault(dir));
  const rec = store.remember({ title: "손편집 대상", content: "시에라 탱고 본문.", type: "semantic" }).record;

  // 사용자가 Obsidian 에서 날짜를 손으로 넣은 상태를 모사 (따옴표 없음)
  const raw = fs.readFileSync(memPath(dir, rec.slug), "utf-8");
  const edited = raw
    .replace(/created: .*/, "created: 2025-01-01T00:00:00.000Z")
    .replace(/updated: .*/, "updated: 2025-02-02")
    .replace(/last_reinforced: .*/, "last_reinforced: 2025-01-15T00:00:00.000Z");
  fs.writeFileSync(memPath(dir, rec.slug), edited, "utf-8");

  const s = new MemoryStore(new Vault(dir));
  const got = s.loadAll(true).find((m) => m.slug === rec.slug);
  check("노트가 정상적으로 읽힘", !!got);
  check("created 가 리셋되지 않음", got?.created?.startsWith("2025-01-01"), `created=${got?.created}`);
  check("updated(날짜만 형식)도 보존", got?.updated?.startsWith("2025-02-02"), `updated=${got?.updated}`);
  check("lastReinforced 보존", got?.lastReinforced?.startsWith("2025-01-15"), `lr=${got?.lastReinforced}`);

  // 오래된 기억이므로 활성이 낮아야 한다 (부풀지 않았는지 확인)
  const results = s.search("시에라");
  const act = results[0]?.activation;
  check("기저활성이 부풀지 않음 (오래된 기억은 음수)", typeof act === "number" && act < 0, `activation=${act}`);

  // 강화 write-back 후에도 잘못된 now 로 고착되지 않아야 한다
  const after = fs.readFileSync(memPath(dir, rec.slug), "utf-8");
  check("write-back 후에도 created 가 2025 유지", /created: '?2025-01-01/.test(after), after.slice(0, 260));
}

// ── 2. 정상 노트(따옴표 있는 ISO)는 그대로
console.log("2) 기존 형식 노트 회귀 없음");
{
  const dir = freshDir();
  const store = new MemoryStore(new Vault(dir));
  const rec = store.remember({ title: "정상 형식", content: "유니폼 빅터.", type: "semantic" }).record;
  const before = store.read(rec.slug).created;
  const s = new MemoryStore(new Vault(dir));
  check("created 왕복 무손실", s.read(rec.slug).created === before, `${before} vs ${s.read(rec.slug).created}`);
}

// ── 3. revise 가 구본을 보존한다 (A7)
console.log("3) revise 구본 스냅샷 (A7)");
{
  const dir = freshDir();
  const store = new MemoryStore(new Vault(dir));
  // description 을 명시한다 — 기본값은 본문 첫 줄이라, 그대로 두면 1세대 문구가
  // 모든 스냅샷의 frontmatter 에 남아 "밀려남" 판정이 오탐한다
  const rec = store.remember({
    title: "교정 대상",
    description: "세대별 본문 교체 검증용",
    content: "1세대 본문 — 원본.",
    type: "semantic",
    confidence: 0.9,
  }).record;

  store.revise(rec.slug, { reason: "1차 교정", content: "2세대 본문." });
  store.revise(rec.slug, { reason: "2차 교정", content: "3세대 본문." });

  const revDir = path.join(dir, "archive", "revisions");
  check("revisions 디렉터리 생성됨", fs.existsSync(revDir));
  const gen2 = fs.readdirSync(revDir).filter((f) => f.startsWith(`${rec.slug}.`));
  check("2회 교정 → 스냅샷 2세대", gen2.length === 2, gen2.join(","));
  const texts = gen2.map((f) => fs.readFileSync(path.join(revDir, f), "utf-8"));
  check("1세대 원본 본문이 보존됨", texts.some((t) => t.includes("1세대 본문")));
  check("2세대 본문이 보존됨", texts.some((t) => t.includes("2세대 본문")));
  check("현재 파일은 최신 본문", fs.readFileSync(memPath(dir, rec.slug), "utf-8").includes("3세대 본문"));

  // 세대 상한 확인 (기본 3세대)
  store.revise(rec.slug, { reason: "3차", content: "4세대 본문." });
  store.revise(rec.slug, { reason: "4차", content: "5세대 본문." });
  const gen4 = fs.readdirSync(revDir).filter((f) => f.startsWith(`${rec.slug}.`));
  check("스냅샷이 최근 3세대로 제한됨", gen4.length === 3, `${gen4.length}세대: ${gen4.join(",")}`);
  const kept = gen4.map((f) => fs.readFileSync(path.join(revDir, f), "utf-8"));
  check("가장 오래된 1세대는 밀려남", !kept.some((t) => t.includes("1세대 본문")));
  check("최신 직전 세대(4세대)는 보존", kept.some((t) => t.includes("4세대 본문")));

  // 내용 미변경 재확인(reconfirm)은 스냅샷을 낭비하지 않는다
  const beforeCount = fs.readdirSync(revDir).filter((f) => f.startsWith(`${rec.slug}.`)).length;
  store.revise(rec.slug, { reason: "재확인만", confidence: 0.95 });
  const afterCount = fs.readdirSync(revDir).filter((f) => f.startsWith(`${rec.slug}.`)).length;
  check("내용 미변경 revise 는 스냅샷을 남기지 않음", afterCount === beforeCount, `${beforeCount} → ${afterCount}`);
}

// ── 4. revisions 가 기억 목록을 오염시키지 않는다
console.log("4) revisions 가 볼트 스캔에 섞이지 않음");
{
  const dir = freshDir();
  const store = new MemoryStore(new Vault(dir));
  const rec = store.remember({ title: "스캔 확인", content: "위스키 엑스레이.", type: "semantic" }).record;
  store.revise(rec.slug, { reason: "교정", content: "새 본문 위스키 유지." });

  const s = new MemoryStore(new Vault(dir));
  check("활성 기억 1건만", s.list().length === 1, `len=${s.list().length}`);
  check("아카이브 포함 스캔에도 1건", s.loadAll(true).length === 1, `len=${s.loadAll(true).length}`);
  check("검색 결과에 스냅샷이 안 섞임", s.search("위스키").length === 1, `len=${s.search("위스키").length}`);
  check("reflect 카운트에도 안 섞임", s.reflect().counts.total === 1, `total=${s.reflect().counts.total}`);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT5/T6 손편집·교정 회귀 테스트 통과 ✔");
