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

/** last_reinforced 를 과거로 되감아 간격 게이트를 연다 (강화가 실제로 기록되게) */
function openGate(dir, slug) {
  const fp = memPath(dir, slug);
  if (!fs.existsSync(fp)) return;
  const past = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/last_reinforced: .*/, `last_reinforced: '${past}'`), "utf-8");
}
/** 파일에서 access_count 를 직접 읽는다 (store.read 의 부수효과 없이) */
function diskAccessCount(dir, slug) {
  const fp = fs.existsSync(memPath(dir, slug)) ? memPath(dir, slug) : arcPath(dir, slug);
  return Number(/access_count: (\d+)/.exec(fs.readFileSync(fp, "utf-8"))?.[1] ?? -1);
}

/**
 * 경쟁 창을 결정적으로 재현한다.
 * A 가 레코드를 읽은 **직후·강화 기록 전에** B 의 변이를 착지시킨다.
 * (search 의 loadAll 스냅샷 → 다른 프로세스 변이 → 강화 write-back 과 동일 구조)
 */
function raceOnce(dir, slug, mutate) {
  // 간격 게이트를 연다. T11 이후 게이트가 닫혀 있으면 reinforce 가 아예 쓰지 않으므로
  // 경쟁 자체가 성립하지 않아 테스트가 공허해진다 — 실제로 write-back 이 일어나는
  // 위험한 경로를 검증해야 A4 회귀를 잡을 수 있다.
  openGate(dir, slug);
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
  // 부모 쪽 store.read 는 부수효과가 있으므로 파일에서 직접 읽는다
  const baseline = diskAccessCount(dir, rec.slug);

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

  const final = diskAccessCount(dir, rec.slug);
  const expected = baseline + 2 * N;
  const lost = expected - final;
  const lossRate = (lost / (2 * N)) * 100;
  console.log(`    기대 ${expected} / 실측 ${final} / 소실 ${lost} (${lossRate.toFixed(1)}%, ${elapsed}ms)`);
  check(`강화 소실률 < 5% (실측 ${lossRate.toFixed(1)}%)`, lossRate < 5, `lost=${lost}/${2 * N}`);
  check("파일이 손상되지 않음", new MemoryStore(new Vault(dir)).read(rec.slug) !== null);
}

// ── 5. 동시 동일 제목 remember — 무흔적 소실 없음 (A5)
console.log("5) 동시 동일 제목 remember (A5)");
{
  const dir = freshDir();
  const vaultA = new Vault(dir);
  const storeA = new MemoryStore(vaultA);
  const storeB = new MemoryStore(new Vault(dir));

  // A 가 slug 후보를 정한 직후·파일 생성 전에 B 가 같은 제목으로 완주하도록 창을 연다
  const origMakeSlug = vaultA.makeSlug.bind(vaultA);
  let fired = false;
  let bRec = null;
  vaultA.makeSlug = (title) => {
    const s = origMakeSlug(title);
    if (!fired) {
      fired = true;
      bRec = storeB.remember({ title, content: "B 의 본문 MARKER-BBB.", type: "semantic" }).record;
    }
    return s;
  };
  const aRec = storeA.remember({ title: "동시성 데모 제목", content: "A 의 본문 MARKER-AAA.", type: "semantic" }).record;

  check("경쟁 창이 실제로 열렸음(전제 확인)", fired);
  check("두 기억이 서로 다른 slug 를 받음", aRec.slug !== bRec.slug, `a=${aRec.slug} b=${bRec.slug}`);

  const files = fs.readdirSync(path.join(dir, "memories")).filter((f) => f.endsWith(".md"));
  check("파일 2개 모두 존재", files.length === 2, files.join(","));
  check("임시 파일 잔재 없음", fs.readdirSync(path.join(dir, "memories")).every((f) => !f.includes(".tmp-")));
  const all = files.map((f) => fs.readFileSync(path.join(dir, "memories", f), "utf-8"));
  check("A 의 본문 생존", all.some((t) => t.includes("MARKER-AAA")));
  check("B 의 본문 생존", all.some((t) => t.includes("MARKER-BBB")));

  const s = new MemoryStore(new Vault(dir));
  check("A 를 id 로 조회 가능", s.resolve(aRec.id)?.record?.id === aRec.id);
  check("B 를 id 로 조회 가능", s.resolve(bRec.id)?.record?.id === bRec.id);
  check("A 를 반환된 slug 로 조회 가능", s.resolve(aRec.slug)?.record?.id === aRec.id);
  check("B 를 반환된 slug 로 조회 가능", s.resolve(bRec.slug)?.record?.id === bRec.id);
}

// ── 6. slug 충돌 시에도 supersede 역참조가 실제 파일을 가리킨다
console.log("6) slug 충돌 + supersede 정합성");
{
  const dir = freshDir();
  const vaultA = new Vault(dir);
  const storeA = new MemoryStore(vaultA);
  const storeB = new MemoryStore(new Vault(dir));

  const old = storeA.remember({ title: "구 지식", content: "낡은 사실.", type: "semantic" }).record;

  const origMakeSlug = vaultA.makeSlug.bind(vaultA);
  let fired = false;
  vaultA.makeSlug = (title) => {
    const s = origMakeSlug(title);
    if (!fired) {
      fired = true;
      storeB.remember({ title, content: "B 가 선점.", type: "semantic" });
    }
    return s;
  };
  const neo = storeA.remember({
    title: "새 지식",
    content: "갱신된 사실.",
    type: "semantic",
    supersedes: old.slug,
  }).record;

  check("충돌로 접미가 붙었음(전제 확인)", neo.slug !== "새-지식", `slug=${neo.slug}`);
  const oldAfter = fs.readFileSync(memPath(dir, old.slug), "utf-8");
  const m = /superseded_by: (\S+)/.exec(oldAfter);
  check("구 기억에 superseded_by 기록됨", !!m, oldAfter.slice(0, 200));
  check("superseded_by 가 최종 slug 와 일치", m?.[1] === neo.slug, `by=${m?.[1]} final=${neo.slug}`);
  check("superseded_by 가 실제 존재하는 파일을 가리킴", fs.existsSync(memPath(dir, m?.[1] ?? "")));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT3/T4 동시성 회귀 테스트 통과 ✔");
