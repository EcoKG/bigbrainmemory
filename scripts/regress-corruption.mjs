// T1/T2 회귀 테스트 — 파일 손상이 볼트 전체를 마비시키거나 조용히 데이터를 파괴하지 않는지.
//
// 고정하는 버그:
//   A1 손상 frontmatter 1개 → regenerateIndex→loadAll→matter() 예외 → main().catch →
//      process.exit(1) → 서버 기동 불능 → 8개 도구 전부 사용 불가
//   A2 gray-matter 모듈 캐시가 2차 파싱을 "빈 frontmatter" 로 성공시키고,
//      reinforce 의 write-back 이 그 빈 레코드를 디스크에 고착 (메타데이터 세탁)
//   A3 비원자적 쓰기로 절단된 파일이 예외 없이 body='' 로 읽히고 고착
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트에서 dist 모듈로 수행.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { Vault } = await import(`file://${path.join(root, "dist", "vault.js").replace(/\\/g, "/")}`);
const { MemoryStore } = await import(`file://${path.join(root, "dist", "store.js").replace(/\\/g, "/")}`);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

function freshVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-corrupt-"));
  return { dir, store: new MemoryStore(new Vault(dir)) };
}
function memPath(dir, slug) {
  return path.join(dir, "memories", `${slug}.md`);
}
function quarantined(dir, slug) {
  const q = path.join(dir, "quarantine");
  if (!fs.existsSync(q)) return [];
  return fs.readdirSync(q).filter((f) => f.startsWith(`${slug}.`));
}

const CORRUPT = "---\nid: mem-broken\ntitle: [unclosed\nbad:\t\t: {{\n---\n\n본문\n";
const cleanups = [];

// ── 1. 손상 파일이 있어도 볼트 전체가 살아있다 (A1)
console.log("1) 손상 frontmatter 1개 — 볼트 전체 기능 유지 (A1)");
{
  const { dir, store } = freshVault();
  cleanups.push(dir);
  store.remember({ title: "정상 기억", content: "알파 브라보 유지되어야 한다.", type: "semantic" });
  fs.writeFileSync(memPath(dir, "corrupt"), CORRUPT, "utf-8");

  // 새 프로세스의 콜드 스타트와 동일한 경로: 새 스토어 인스턴스로 전량 재파싱
  const cold = new MemoryStore(new Vault(dir));
  let boots = true;
  try {
    cold.regenerateIndex(); // 서버 기동 시 main() 의 첫 동작
  } catch {
    boots = false;
  }
  check("regenerateIndex 가 예외로 죽지 않음 (= 서버 기동 성공)", boots);

  let results = null;
  try {
    results = cold.search("알파");
  } catch (err) {
    check("search 가 예외로 죽지 않음", false, String(err?.message ?? err));
  }
  check("정상 기억이 여전히 회상됨", (results ?? []).some((r) => r.record.slug === "정상-기억"));
  check("list_memories 동작", cold.list().length === 1, `len=${cold.list().length}`);
  check("reflect 동작", typeof cold.reflect()?.counts?.total === "number");
  check("손상 파일이 quarantine 으로 격리됨", quarantined(dir, "corrupt").length === 1);
  check("손상 파일이 memories 에서 제거됨", !fs.existsSync(memPath(dir, "corrupt")));

  const qFile = path.join(dir, "quarantine", quarantined(dir, "corrupt")[0]);
  check("격리된 원본 바이트 무변형", fs.readFileSync(qFile, "utf-8") === CORRUPT);
}

// ── 2. 캐시 세탁 방지 — 재접근이 메타데이터를 기본값으로 덮어쓰지 않는다 (A2)
console.log("2) 손상 파일 재접근 — 메타데이터 세탁 없음 (A2)");
{
  const { dir, store } = freshVault();
  cleanups.push(dir);
  const rec = store.remember({
    title: "귀중한 기억",
    content: "찰리 델타 — 오래 강화된 핵심 기억.",
    type: "semantic",
    confidence: 0.95,
  }).record;
  // 오래 강화된 상태를 모사
  const good = fs.readFileSync(memPath(dir, rec.slug), "utf-8").replace("storage_strength: 1", "storage_strength: 12");
  fs.writeFileSync(memPath(dir, rec.slug), good, "utf-8");
  const before = fs.readFileSync(memPath(dir, rec.slug), "utf-8");

  // 손상시킨 뒤 1차·2차 접근 (2차가 캐시 히트로 세탁되던 경로)
  fs.writeFileSync(memPath(dir, rec.slug), CORRUPT, "utf-8");
  const s = new MemoryStore(new Vault(dir));
  const first = s.read(rec.slug);
  const second = s.read(rec.slug);
  check("1차 접근이 null (예외 아님)", first === null, `first=${JSON.stringify(first)?.slice(0, 80)}`);
  check("2차 접근도 null — 캐시 세탁 없음", second === null, `second=${JSON.stringify(second)?.slice(0, 80)}`);

  const q = quarantined(dir, rec.slug);
  check("손상본이 격리됨", q.length >= 1);
  check(
    "격리본은 손상 원문 그대로 (기본값 레코드로 덮어써지지 않음)",
    fs.readFileSync(path.join(dir, "quarantine", q[0]), "utf-8") === CORRUPT,
  );
  check("memories 에 기본값 레코드가 남지 않음", !fs.existsSync(memPath(dir, rec.slug)));
  check("원본은 손상 전 강화 상태였음(대조군)", before.includes("storage_strength: 12"));
}

// ── 3. 절단 파일이 빈 본문으로 고착되지 않는다 (A3)
console.log("3) 절단된 파일 — 빈 본문 고착 없음 (A3)");
{
  const { dir, store } = freshVault();
  cleanups.push(dir);
  const rec = store.remember({ title: "절단 대상", content: "에코 폭스트롯 본문이 길다.", type: "semantic" }).record;
  const full = fs.readFileSync(memPath(dir, rec.slug), "utf-8");

  // 닫는 --- 이전에서 잘라낸다 (전원차단/부분쓰기 모사)
  const cut = full.slice(0, full.indexOf("confidence:") + "confidence: 0.".length);
  check("절단본에 닫는 구분자가 없음(전제 확인)", !/\n---\s*(\r?\n|$)/.test(cut.slice(3)));
  fs.writeFileSync(memPath(dir, rec.slug), cut, "utf-8");

  const s = new MemoryStore(new Vault(dir));
  const got = s.read(rec.slug);
  check("절단 파일이 빈 본문 레코드로 파싱되지 않음", got === null, `body=${JSON.stringify(got?.body)}`);
  check("절단본이 격리됨", quarantined(dir, rec.slug).length === 1);
  check(
    "격리본 바이트 무변형",
    fs.readFileSync(path.join(dir, "quarantine", quarantined(dir, rec.slug)[0]), "utf-8") === cut,
  );
}

// ── 4. 빈 파일
console.log("4) 빈 파일 — 기본값 레코드 생성 없음");
{
  const { dir } = freshVault();
  cleanups.push(dir);
  fs.writeFileSync(memPath(dir, "empty"), "", "utf-8");
  const s = new MemoryStore(new Vault(dir));
  check("빈 파일이 null", s.read("empty") === null);
  check("빈 파일 격리됨", quarantined(dir, "empty").length === 1);
  check("loadAll 이 빈 파일을 기억으로 세지 않음", s.loadAll(true).length === 0);
}

// ── 5. 정상 파일에는 영향이 없어야 한다 (거짓 양성 방지)
console.log("5) 정상 파일 — 격리 오작동 없음");
{
  const { dir, store } = freshVault();
  cleanups.push(dir);
  store.remember({ title: "정상 A", content: "골프 호텔.", type: "semantic", tags: ["t1"] });
  store.remember({ title: "정상 B", content: "인디아 줄리엣.", type: "procedural" });
  // frontmatter 없는 손수 작성 노트(Obsidian 호환) 는 손상이 아니다
  fs.writeFileSync(memPath(dir, "손수-작성"), "# 제목\n\n프론트매터 없는 노트.\n", "utf-8");

  const s = new MemoryStore(new Vault(dir));
  check("정상 노트 2건 + 손수작성 1건 모두 읽힘", s.loadAll(true).length === 3, `len=${s.loadAll(true).length}`);
  check("격리 디렉터리가 생기지 않음", !fs.existsSync(path.join(dir, "quarantine")));
  check("손수 작성 노트도 보존됨", fs.existsSync(memPath(dir, "손수-작성")));
}

// ── 6. 원자적 쓰기 — 임시 파일 잔재 없음 (T2/A3)
console.log("6) 원자적 쓰기 — 잔재 없음");
{
  const { dir, store } = freshVault();
  cleanups.push(dir);
  for (let i = 0; i < 5; i++) {
    store.remember({ title: `원자 ${i}`, content: `킬로 리마 ${i} 번째 본문.`, type: "semantic" });
  }
  store.search("킬로"); // reinforce 로 인한 재기록 포함
  const stray = fs.readdirSync(path.join(dir, "memories")).filter((f) => f.includes(".tmp-"));
  const strayRoot = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
  check("memories/ 에 .tmp 잔재 없음", stray.length === 0, stray.join(","));
  check("볼트 루트에 .tmp 잔재 없음", strayRoot.length === 0, strayRoot.join(","));
  check(
    "모든 노트가 완전한 형식 (닫는 --- 존재)",
    fs
      .readdirSync(path.join(dir, "memories"))
      .every((f) => /\n---\s*(\r?\n|$)/.test(fs.readFileSync(path.join(dir, "memories", f), "utf-8").slice(3))),
  );
}

// ── 7. 쓰기 실패 시 원본 무손상 (T2 의 핵심 성질)
//    기존 writeFileSync 직접 덮어쓰기는 실패 시 대상 파일을 이미 파괴한 뒤였다.
//    tmp+rename 은 rename 이 실패하면 원본이 그대로 남는다.
console.log("7) 쓰기 실패 주입 — 원본 무손상");
{
  const { dir, store } = freshVault();
  cleanups.push(dir);
  const rec = store.remember({
    title: "무손상 대상",
    content: "마이크 노벰버 — 이 본문이 살아남아야 한다.",
    type: "semantic",
    confidence: 0.91,
  }).record;
  const fp = memPath(dir, rec.slug);
  const before = fs.readFileSync(fp, "utf-8");

  const origRename = fs.renameSync;
  let threw = false;
  try {
    fs.renameSync = () => {
      throw new Error("주입된 rename 실패");
    };
    const s = new MemoryStore(new Vault(dir));
    try {
      s.revise(rec.slug, { reason: "실패 주입", content: "덮어써지면 안 되는 새 본문" });
    } catch {
      threw = true;
    }
  } finally {
    fs.renameSync = origRename;
  }

  const after = fs.readFileSync(fp, "utf-8");
  check("쓰기 실패가 호출자에게 전파됨", threw);
  check("원본 파일 바이트 무변형", after === before);
  check("원본 본문 보존", after.includes("마이크 노벰버"));
  check("새 본문이 기록되지 않음", !after.includes("덮어써지면 안 되는"));
  const stray = fs.readdirSync(path.join(dir, "memories")).filter((f) => f.includes(".tmp-"));
  check("실패해도 .tmp 잔재 없음", stray.length === 0, stray.join(","));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT1/T2 손상 내성 회귀 테스트 통과 ✔");
