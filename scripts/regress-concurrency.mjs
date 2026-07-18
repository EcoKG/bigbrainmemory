// T3/T4 회귀 테스트 — 동시 접근이 조용히 데이터를 되돌리거나 잃지 않는지.
//
// 고정하는 버그:
//   A4 recall/read 의 강화 write-back 이 loadAll 스냅샷 전체를 재직렬화해서,
//      그 창 안에 착지한 다른 프로세스의 revise 를 되돌리고(무흔적),
//      forget 된 기억을 memories/ 에 부활시키고(split-brain),
//      2프로세스 300회 recall 시 강화의 84~99.5% 를 잃었다.
//   A5 makeSlug 의 exists() 와 write 사이 TOCTOU 로 동시 동일 제목 remember 시
//      한쪽 기억이 무흔적 소실됐다.
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import { spawnSync } from "node:child_process";
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-race-"));
  cleanups.push(d);
  return d;
}
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);
const arcPath = (dir, slug) => path.join(dir, "archive", `${slug}.md`);

/**
 * 경쟁 창을 결정적으로 재현한다.
 * A 가 레코드를 읽은 **직후·강화 기록 전에** B 의 변이를 착지시킨다.
 * (search 의 loadAll 스냅샷 → 다른 프로세스 변이 → 강화 write-back 과 동일 구조)
 */
function raceOnce(dir, slug, mutate) {
  const vaultA = new Vault(dir);
  const storeA = new MemoryStore(vaultA);
  const origFind = vaultA.find.bind(vaultA);
  let fired = false;
  vaultA.find = (s) => {
    const r = origFind(s);
    if (!fired) {
      fired = true;
      mutate(); // ← 창 안에 경쟁 프로세스가 착지
    }
    return r;
  };
  storeA.read(slug); // resolve(낡은 스냅샷) → reinforce(강화 기록)
  return fired;
}

// ── 1. 경쟁 revise 가 강화 write-back 에 덮이지 않는다 (A4)
console.log("1) 동시 revise 보존 (A4)");
{
  const dir = freshDir();
  const seed = new MemoryStore(new Vault(dir));
  const rec = seed.remember({
    title: "경쟁 대상",
    content: "원본 본문 ORIGINAL.",
    type: "semantic",
    confidence: 0.8,
  }).record;

  const storeB = new MemoryStore(new Vault(dir));
  const fired = raceOnce(dir, rec.slug, () =>
    storeB.revise(rec.slug, { reason: "경쟁 프로세스 교정", content: "교정 본문 REVISED.", confidence: 0.95 }),
  );
  check("경쟁 창이 실제로 열렸음(전제 확인)", fired);

  const after = fs.readFileSync(memPath(dir, rec.slug), "utf-8");
  check("B 의 본문 교정이 보존됨", after.includes("REVISED"), after.slice(0, 200));
  check("B 의 확신도 교정이 보존됨", /confidence: 0\.95/.test(after));
  check("B 의 이력이 보존됨", after.includes("revised"));
  check("A 의 강화도 함께 반영됨(접근수 증가)", /access_count: [1-9]/.test(after));
}

// ── 2. 경쟁 forget 이 부활하지 않는다 (A4 split-brain)
console.log("2) 동시 forget 유지 — 부활 없음 (A4)");
{
  const dir = freshDir();
  const seed = new MemoryStore(new Vault(dir));
  const rec = seed.remember({ title: "망각 대상", content: "폐기될 기억.", type: "semantic" }).record;

  const storeB = new MemoryStore(new Vault(dir));
  raceOnce(dir, rec.slug, () => storeB.forget(rec.slug, "경쟁 프로세스가 폐기"));

  check("memories/ 에 부활하지 않음", !fs.existsSync(memPath(dir, rec.slug)));
  check("archive/ 에 그대로 있음", fs.existsSync(arcPath(dir, rec.slug)));
  const arc = fs.readFileSync(arcPath(dir, rec.slug), "utf-8");
  check("상태가 archived 유지", /status: archived/.test(arc));
  check("망각 사유(이력) 보존", arc.includes("forgotten"));

  const s = new MemoryStore(new Vault(dir));
  check("활성 목록에 나타나지 않음", s.list().length === 0, `len=${s.list().length}`);
}

// ── 3. 강화 write-back 실패가 회상을 죽이지 않는다 (T2 에서 발견)
console.log("3) 강화 실패는 best-effort — 회상은 계속된다");
{
  const dir = freshDir();
  const seed = new MemoryStore(new Vault(dir));
  seed.remember({ title: "베스트에포트", content: "오스카 파파 회상되어야 한다.", type: "semantic" });

  const origRename = fs.renameSync;
  let results = null;
  let readOk = null;
  try {
    fs.renameSync = () => {
      throw new Error("주입된 쓰기 실패");
    };
    const s = new MemoryStore(new Vault(dir));
    results = s.search("오스카");
    readOk = s.read("베스트에포트");
  } catch (err) {
    check("회상이 예외로 죽지 않음", false, String(err?.message ?? err));
  } finally {
    fs.renameSync = origRename;
  }
  check("쓰기 실패에도 search 가 결과를 반환", (results ?? []).length === 1, `len=${results?.length}`);
  check("쓰기 실패에도 read_memory 가 동작", readOk !== null);
}

// ── 4. 2프로세스 동시 강화 — 소실률 (A4)
console.log("4) 2프로세스 동시 recall — 강화 소실률 (A4)");
{
  const dir = freshDir();
  const seed = new MemoryStore(new Vault(dir));
  const rec = seed.remember({ title: "경합 카운터", content: "퀘벡 로미오 경합 대상.", type: "semantic" }).record;
  const baseline = seed.read(rec.slug).accessCount; // seed 자신의 1회

  const N = 300;
  const child = path.join(dir, "child.mjs");
  fs.writeFileSync(
    child,
    `import { Vault } from ${JSON.stringify(distUrl("vault.js"))};
import { MemoryStore } from ${JSON.stringify(distUrl("store.js"))};
const s = new MemoryStore(new Vault(process.argv[2]));
for (let i = 0; i < ${N}; i++) s.search("퀘벡");
`,
    "utf-8",
  );

  const t0 = Date.now();
  const kids = [0, 1].map(() =>
    spawnSync(process.execPath, [child, dir], { encoding: "utf-8", env: { ...process.env, BIGBRAIN_SPACING_MS: "0" } }),
  );
  const elapsed = Date.now() - t0;
  check("자식 프로세스 2개 정상 종료", kids.every((k) => k.status === 0), kids.map((k) => k.stderr?.slice(0, 200)).join(" | "));

  const final = new MemoryStore(new Vault(dir)).read(rec.slug).accessCount;
  const expected = baseline + 2 * N + 1; // +1 은 방금 read
  const lost = expected - final;
  const lossRate = (lost / (2 * N)) * 100;
  console.log(`    기대 ${expected} / 실측 ${final} / 소실 ${lost} (${lossRate.toFixed(1)}%, ${elapsed}ms)`);
  check(`강화 소실률 < 5% (실측 ${lossRate.toFixed(1)}%)`, lossRate < 5, `lost=${lost}/${2 * N}`);
  check("파일이 손상되지 않음", new MemoryStore(new Vault(dir)).read(rec.slug) !== null);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT3 동시성 회귀 테스트 통과 ✔");
