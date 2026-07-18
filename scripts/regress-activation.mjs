// T12 회귀 테스트 — 기저활성의 최근성 반영.
//
// 고정하는 버그(감사 C1):
//   활성 계산이 now − created 에만 의존해, created 와 n 이 같으면
//   "어제 강화한 기억" 과 "1년 방치한 기억" 의 활성이 완전히 동일했다(둘 다 −2.2364).
//   그 결과 어제 5회 쓴 핵심 기억(키워드 9점)이 몇 초 전 저장한 잡메모(키워드 6점)에
//   5.75 vs 7.68 로 밀렸고, reflect 는 방금 접근한 기억도 weakened 로 오분류했다.
//   도구 설명의 "frequency+recency" 중 recency 는 미구현이었다.
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
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

const cleanups = [];
function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-act-"));
  cleanups.push(d);
  return d;
}
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);

/** frontmatter 를 직접 조정해 원하는 나이·강도·마지막강화 상태를 만든다 */
function shape(dir, slug, { agoHours, strength, reinforcedAgoHours }) {
  const fp = memPath(dir, slug);
  const iso = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  let t = fs.readFileSync(fp, "utf-8");
  t = t.replace(/created: .*/, `created: '${iso(agoHours)}'`);
  t = t.replace(/updated: .*/, `updated: '${iso(reinforcedAgoHours)}'`);
  t = t.replace(/last_reinforced: .*/, `last_reinforced: '${iso(reinforcedAgoHours)}'`);
  t = t.replace(/storage_strength: .*/, `storage_strength: ${strength}`);
  fs.writeFileSync(fp, t, "utf-8");
}

const YEAR_H = 8760;

// ── 1. 감사 실측 시나리오 — 최근성이 활성에 반영된다
console.log("1) 최근 강화 vs 장기 방치 (C1 핵심)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "최근 강화 기억", content: "알파 델타 자주 쓰는 기억.", type: "semantic" });
  s.remember({ title: "장기 방치 기억", content: "알파 에코 안 쓰는 기억.", type: "semantic" });
  // 둘 다 1년 전 생성 · n=5 · 마지막 강화만 다르게 (어제 vs 1년 전)
  shape(dir, "최근-강화-기억", { agoHours: YEAR_H, strength: 5, reinforcedAgoHours: 24 });
  shape(dir, "장기-방치-기억", { agoHours: YEAR_H, strength: 5, reinforcedAgoHours: YEAR_H });

  const r = new MemoryStore(new Vault(dir)).search("알파");
  const fresh = r.find((x) => x.record.slug === "최근-강화-기억");
  const stale = r.find((x) => x.record.slug === "장기-방치-기억");
  check("두 기억 모두 회상됨(전제 확인)", !!fresh && !!stale);
  check("활성이 더 이상 동일하지 않음", fresh.activation !== stale.activation, `${fresh?.activation} vs ${stale?.activation}`);
  check("최근 강화 쪽 활성이 더 높음", fresh.activation > stale.activation, `${fresh?.activation} vs ${stale?.activation}`);
  check("감사 산출값 −1.24 근사", near(fresh.activation, -1.24, 0.03), `act=${fresh?.activation}`);
  check("감사 산출값 −2.34 근사", near(stale.activation, -2.34, 0.03), `act=${stale?.activation}`);
  check("격차가 정확식 방향(약 1.1)과 일치", near(fresh.activation - stale.activation, 1.1, 0.05), `Δ=${fresh?.activation - stale?.activation}`);
  check("최근 강화 쪽이 순위도 위", r.indexOf(fresh) < r.indexOf(stale));
}

// ── 2. 자주 쓰는 구기억이 방금 저장한 잡메모에 밀리지 않는다
console.log("2) 랭킹 역전 해소 (C1 실사용 영향)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  // 핵심 기억: 제목·설명·본문에 모두 키워드 → 키워드 점수 우위
  s.remember({ title: "브라보 배포 절차", description: "브라보 배포 방법", content: "브라보 배포 브라보 절차 상세.", type: "procedural" });
  // 잡메모: 본문에만 스침
  s.remember({ title: "오늘 메모", description: "잡생각", content: "브라보 관련 잡메모.", type: "episodic" });
  shape(dir, "브라보-배포-절차", { agoHours: 30 * 24, strength: 5, reinforcedAgoHours: 24 });

  const r = new MemoryStore(new Vault(dir)).search("브라보");
  const core = r.find((x) => x.record.slug === "브라보-배포-절차");
  const junk = r.find((x) => x.record.slug === "오늘-메모");
  check("둘 다 회상됨(전제 확인)", !!core && !!junk);
  check("어제 쓴 핵심 기억이 방금 만든 잡메모보다 상위", core.score > junk.score, `core=${core?.score} junk=${junk?.score}`);
}

// ── 3. reflect 가 최근 강화된 기억을 weakened 로 오분류하지 않는다
console.log("3) reflect 오분류 해소");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "어제 쓴 기억", content: "폭스트롯 최근 사용.", type: "semantic" });
  s.remember({ title: "진짜 방치 기억", content: "골프 오래 방치.", type: "semantic" });
  shape(dir, "어제-쓴-기억", { agoHours: YEAR_H, strength: 6, reinforcedAgoHours: 20 });
  shape(dir, "진짜-방치-기억", { agoHours: YEAR_H, strength: 6, reinforcedAgoHours: YEAR_H });

  const rep = new MemoryStore(new Vault(dir)).reflect();
  const weak = rep.weakened.map((w) => w.slug);
  check("어제 쓴 기억은 weakened 아님", !weak.includes("어제-쓴-기억"), weak.join(","));
  check("진짜 방치 기억은 weakened", weak.includes("진짜-방치-기억"), weak.join(","));
}

// ── 4. P4 '바람직한 어려움' 보너스가 최근 강화 기억에는 안 붙는다 (C4 자동 해소)
console.log("4) 어려움 보너스 오발동 해소 (C4)");
{
  function deltaAfterSearch({ reinforcedAgoHours }) {
    const dir = freshDir();
    const s = new MemoryStore(new Vault(dir));
    s.remember({ title: "호텔 보너스 대상", content: "호텔 인디아 본문.", type: "semantic" });
    shape(dir, "호텔-보너스-대상", { agoHours: 7 * 24, strength: 5, reinforcedAgoHours });
    const before = Number(/storage_strength: ([\d.]+)/.exec(fs.readFileSync(memPath(dir, "호텔-보너스-대상"), "utf-8"))[1]);
    new MemoryStore(new Vault(dir)).search("호텔");
    const after = Number(/storage_strength: ([\d.]+)/.exec(fs.readFileSync(memPath(dir, "호텔-보너스-대상"), "utf-8"))[1]);
    return after - before;
  }
  // 핵심: **동일한 created·n 인데 마지막 강화 시점만 다르면** 보너스 판정이 갈려야 한다.
  // 종전에는 감쇠 시계가 created 고정이라 두 경우가 항상 같은 판정을 받았다(C4).
  const recent = deltaAfterSearch({ reinforcedAgoHours: 2 });
  const stale = deltaAfterSearch({ reinforcedAgoHours: YEAR_H });
  check("방금 강화한 기억은 delta 1 (보너스 미발동)", recent === 1, `delta=${recent}`);
  check("장기 방치 기억은 delta 1.5 (보너스 발동)", stale === 1.5, `delta=${stale}`);
  check("최근성만 다른데 판정이 갈림 (C4 해소)", recent !== stale, `${recent} vs ${stale}`);
}

// ── 5. n=1 은 정확식과 일치한다
console.log("5) n=1 정확식 일치");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "줄리엣 신규", content: "줄리엣 갓 만든 기억.", type: "semantic" });
  shape(dir, "줄리엣-신규", { agoHours: 100, strength: 1, reinforcedAgoHours: 100 });
  const r = new MemoryStore(new Vault(dir)).search("줄리엣");
  const exact = -0.5 * Math.log(100); // B = ln(t^-0.5) = -0.5 ln t
  check("n=1 활성이 정확식 −0.5·ln(t) 와 일치", near(r[0].activation, exact, 0.01), `got=${r[0]?.activation} exact=${exact.toFixed(4)}`);
}

// ── 6. 강화하면 활성이 즉시 올라간다 (기능 보존)
console.log("6) 강화 → 활성 상승");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "킬로 상승 확인", content: "킬로 본문.", type: "semantic" });
  shape(dir, "킬로-상승-확인", { agoHours: YEAR_H, strength: 3, reinforcedAgoHours: YEAR_H });
  const before = new MemoryStore(new Vault(dir)).search("킬로")[0].activation;
  // 위 search 가 간격 게이트를 통과해 강화했으므로 lastReinforced 가 방금으로 갱신됨
  const after = new MemoryStore(new Vault(dir)).search("킬로")[0].activation;
  check("강화 직후 활성이 상승", after > before, `${before} → ${after}`);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT12 기저활성 최근성 회귀 테스트 통과 ✔");
