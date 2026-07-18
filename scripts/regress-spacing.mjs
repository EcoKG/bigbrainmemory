// T14 회귀 테스트 — 확장 간격(expanding spacing).
//
// 고정하는 버그(감사 C3):
//   간격 게이트가 "마지막 강화 후 고정 10분" 단일 기준이라 11분 주기로 기계적으로
//   recall 하면 회당 +1 씩 상한 없이 부풀릴 수 있었다(실측 30회 → 저장강도 1→31).
//   저장강도는 감소 경로가 없어 값이 영구히 남고, 하루 144회면 n=145 가 되어
//   그 기억은 reflect 의 weakened 에서 수십 년간 면제된다.
//   간격효과 이론이 요구하는 것은 간격의 **확대**이지 고정 rate limit 이 아니다.
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-space-"));
  cleanups.push(d);
  return d;
}
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);
const strengthOf = (dir, slug) =>
  Number(/storage_strength: ([\d.]+)/.exec(fs.readFileSync(memPath(dir, slug), "utf-8"))[1]);
/** last_reinforced 를 n분 전으로 되감아 "그만큼 기다린" 상태를 만든다 */
function waited(dir, slug, minutes) {
  const fp = memPath(dir, slug);
  const iso = new Date(Date.now() - minutes * 60_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/last_reinforced: .*/, `last_reinforced: '${iso}'`), "utf-8");
}
/** created 를 n시간 전으로 되감는다 */
function aged(dir, slug, hours) {
  const fp = memPath(dir, slug);
  const iso = new Date(Date.now() - hours * 3_600_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/created: .*/, `created: '${iso}'`), "utf-8");
}

// ── 1. 11분 주기 기계적 반복이 더 이상 무한 부풀리지 못한다
console.log("1) 11분 주기 벼락치기 차단 (C3)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "부풀리기 대상", content: "오스카 파파 본문.", type: "semantic" });
  aged(dir, "부풀리기-대상", 24); // 하루 된 기억

  // 감사 재현: 11분 간격 recall 30회
  for (let i = 0; i < 30; i++) {
    waited(dir, "부풀리기-대상", 11);
    new MemoryStore(new Vault(dir)).search("오스카");
  }
  const n = strengthOf(dir, "부풀리기-대상");
  // 하루 된 기억의 필요 간격은 α·24h/1 = 2.4시간이므로 11분 주기는 전부 막힌다.
  // 이것이 의도된 결과다 — 벼락치기는 저장강도를 올리지 못한다.
  check("종전 1→31 이던 부풀리기가 완전 차단", n === 1, `strength=${n}`);
  console.log(`    저장강도 실측: 1 → ${n} (종전 31)`);

  // 다만 영구 잠금은 아니다 — 요구되는 간격만큼 실제로 기다리면 열린다
  waited(dir, "부풀리기-대상", 3 * 60);
  new MemoryStore(new Vault(dir)).search("오스카");
  check("필요 간격(2.4h)을 채우면 정상 강화 — 영구 잠금 아님", strengthOf(dir, "부풀리기-대상") > 1, `strength=${strengthOf(dir, "부풀리기-대상")}`);
}

// ── 2. 필요 간격이 n 에 따라 실제로 늘어난다
console.log("2) 간격이 강도에 따라 확대");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "간격 확대 확인", content: "퀘벡 로미오 본문.", type: "semantic" });
  aged(dir, "간격-확대-확인", 240); // 10일 된 기억 → α·240h/n = 24h/n

  // n=1: 필요 간격 24시간 → 1시간 대기로는 안 열린다
  waited(dir, "간격-확대-확인", 60);
  new MemoryStore(new Vault(dir)).search("퀘벡");
  check("n=1·1시간 대기로는 게이트가 안 열림", strengthOf(dir, "간격-확대-확인") === 1, `strength=${strengthOf(dir, "간격-확대-확인")}`);

  // 25시간 대기 → 열린다
  waited(dir, "간격-확대-확인", 25 * 60);
  new MemoryStore(new Vault(dir)).search("퀘벡");
  const after = strengthOf(dir, "간격-확대-확인");
  check("충분히 기다리면 열림", after > 1, `strength=${after}`);
}

// ── 3. 신생 기억에는 기본 창(10분)이 그대로 적용된다 (하한 보장)
console.log("3) 신생 기억은 기본 창 유지");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "신생 간격", content: "시에라 본문.", type: "semantic" });
  // 갓 만든 기억 → α·나이/n 이 0 에 가까우므로 기본 10분 창이 하한으로 작동
  waited(dir, "신생-간격", 11);
  new MemoryStore(new Vault(dir)).search("시에라");
  check("11분 대기로 강화됨 (기본 창 하한)", strengthOf(dir, "신생-간격") > 1, `strength=${strengthOf(dir, "신생-간격")}`);
}

// ── 4. α=0 이면 종전 고정 창 동작
console.log("4) BIGBRAIN_SPACING_ALPHA=0 로 종전 동작 복원");
{
  const prev = process.env.BIGBRAIN_SPACING_ALPHA;
  process.env.BIGBRAIN_SPACING_ALPHA = "0";
  try {
    const { MemoryStore: Fresh } = await import(`${distUrl("store.js")}?alpha=0`);
    const dir = freshDir();
    const s = new Fresh(new Vault(dir));
    s.remember({ title: "알파 제로", content: "탱고 본문.", type: "semantic" });
    aged(dir, "알파-제로", 240);
    for (let i = 0; i < 5; i++) {
      waited(dir, "알파-제로", 11);
      new Fresh(new Vault(dir)).search("탱고");
    }
    const n = strengthOf(dir, "알파-제로");
    check("α=0 이면 11분 주기로 매번 강화 (종전 동작)", n >= 5, `strength=${n}`);
  } finally {
    if (prev === undefined) delete process.env.BIGBRAIN_SPACING_ALPHA;
    else process.env.BIGBRAIN_SPACING_ALPHA = prev;
  }
}

// ── 5. 정상적인 간격 둔 사용은 계속 강화된다 (P3 취지 보존)
console.log("5) 정상 사용은 정상 강화");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "정상 사용", content: "위스키 본문.", type: "semantic" });
  // 하루에 한 번 쓰는 패턴을 5일치 모사 (나이도 함께 늘린다)
  for (let day = 1; day <= 5; day++) {
    aged(dir, "정상-사용", day * 24);
    waited(dir, "정상-사용", 24 * 60);
    new MemoryStore(new Vault(dir)).search("위스키");
  }
  const n = strengthOf(dir, "정상-사용");
  check("매일 쓰면 꾸준히 강화됨", n >= 4, `strength=${n}`);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT14 확장 간격 회귀 테스트 통과 ✔");
