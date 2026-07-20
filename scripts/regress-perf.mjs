// T21 회귀 테스트 — 성능·이식성 (감사 F1~F4).
//
// 고정하는 문제:
//   F1 resolve(id) 가 볼트 전체를 읽어 파싱 (1000건 볼트에서 418ms, 없는 id 도 384ms).
//      revise/forget/link/read_memory 가 id 를 받을 때마다 이 비용을 치렀다.
//   F2 today() 가 UTC 라 KST 사용자는 자정~오전 9시에 history 날짜가 하루 어긋났다.
//   F3 makeSlug 가 Windows 예약 장치명(con/nul/com1…)을 거르지 않았다.
//   F4 history 에 상한이 없어 무한 누적됐다 (재확인 110회 → 935B에서 7,426B).
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-perf-"));
  cleanups.push(d);
  return d;
}

// ── 1. resolve(id) 캐시 (F1)
console.log("1) id 조회 캐시 (F1)");
{
  const dir = freshDir();
  const seed = new MemoryStore(new Vault(dir));
  const ids = [];
  for (let i = 0; i < 300; i++) {
    ids.push(seed.remember({ title: `성능 기억 ${i}`, content: `본문 ${i}.`, type: "semantic" }).record.id);
  }
  const s = new MemoryStore(new Vault(dir));
  const target = ids[ids.length - 1];

  const t0 = Date.now();
  const first = s.resolve(target);
  const coldMs = Date.now() - t0;
  check("첫 조회 성공", first?.record?.id === target);

  const t1 = Date.now();
  for (let i = 0; i < 50; i++) s.resolve(ids[i]);
  const warmMs = (Date.now() - t1) / 50;
  console.log(`    콜드 ${coldMs}ms / 캐시 후 평균 ${warmMs.toFixed(2)}ms (50회)`);
  check("캐시 후 조회가 훨씬 빠름", warmMs < coldMs / 5, `cold=${coldMs} warm=${warmMs.toFixed(2)}`);
  check("캐시 후에도 정확한 레코드 반환", s.resolve(ids[0])?.record?.id === ids[0]);

  const t2 = Date.now();
  const missing = s.resolve("mem-존재하지않는id");
  const missMs = Date.now() - t2;
  console.log(`    없는 id ${missMs}ms`);
  check("없는 id 는 null", missing === null);
  check("없는 id 도 풀스캔 없이 빠름 (볼트 무변화 시)", missMs < coldMs / 5, `miss=${missMs} cold=${coldMs}`);
}

// ── 2. 캐시 정확성 — 볼트가 변하면 스스로 갱신 (F1 안전성)
console.log("2) 캐시 무효화 정확성");
{
  const dir = freshDir();
  const a = new MemoryStore(new Vault(dir));
  const r1 = a.remember({ title: "선행 기억", content: "본문.", type: "semantic" }).record;
  a.resolve(r1.id); // 캐시 구축

  // 다른 프로세스(=별도 스토어)가 기억을 추가
  const b = new MemoryStore(new Vault(dir));
  const r2 = b.remember({ title: "나중 기억", content: "본문.", type: "semantic" }).record;

  check("캐시를 가진 A 가 새 기억도 id 로 찾음", a.resolve(r2.id)?.record?.id === r2.id, "캐시 무효화 실패");

  // forget 으로 위치가 바뀌어도 찾아야 한다
  b.forget(r1.slug, "이동 확인");
  const moved = a.resolve(r1.id);
  check("archive 로 옮겨진 기억도 id 로 찾음", moved?.record?.id === r1.id, JSON.stringify(moved?.archived));
  check("archived 플래그가 정확", moved?.archived === true);

  // 파일을 직접 지우면 null
  const c = new MemoryStore(new Vault(dir));
  // unlinkSync 를 쓴다(rmSync 아님) — Node v24.13.0(win32) 은 **비ASCII 경로에 단일 파일**
  // fs.rmSync 를 호출하면 JS 예외 없이 프로세스가 즉사한다(0xC0000409 fail-fast).
  // 이 볼트의 슬러그는 한글이라 정확히 그 경로를 밟아 테스트가 통째로 죽었다.
  // 디렉터리 재귀 삭제({recursive:true})는 다른 코드 경로라 영향 없다.
  fs.unlinkSync(path.join(dir, "archive", `${r1.slug}.md`));
  check("삭제된 기억은 null", c.resolve(r1.id) === null);
}

// ── 3. history 상한 (F4)
console.log("3) history 상한 (F4)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "이력 누적", content: "1세대.", type: "semantic" }).record;
  const fp = path.join(dir, "memories", `${rec.slug}.md`);
  const openGate = () => {
    const past = new Date(Date.now() - 3600_000 * 24 * 400).toISOString();
    fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/last_reinforced: .*/, `last_reinforced: '${past}'`), "utf-8");
  };

  for (let i = 0; i < 80; i++) {
    openGate();
    new MemoryStore(new Vault(dir)).revise(rec.slug, { reason: `교정 ${i}`, content: `${i + 2}세대 본문.` });
  }
  const m = new MemoryStore(new Vault(dir)).list()[0];
  check("history 가 상한(50) 이하", m.history.length <= 50, `len=${m.history.length}`);
  check("접힌 줄 수가 표시됨", /이전 이력 \d+줄 생략/.test(m.history[0]), m.history[0]);
  check("최신 이력은 보존", m.history[m.history.length - 1].includes("교정 79"), m.history[m.history.length - 1]);
  const bytes = fs.statSync(fp).size;
  console.log(`    80회 교정 후 파일 크기 ${bytes}B (상한 없었으면 약 6KB+)`);
  check("파일이 비대해지지 않음", bytes < 6000, `${bytes}B`);

  // 접힌 수가 누적되는지
  for (let i = 0; i < 20; i++) {
    openGate();
    new MemoryStore(new Vault(dir)).revise(rec.slug, { reason: `추가 ${i}`, content: `추가 ${i} 본문.` });
  }
  const m2 = new MemoryStore(new Vault(dir)).list()[0];
  const folded = Number(/이전 이력 (\d+)줄 생략/.exec(m2.history[0])?.[1] ?? 0);
  check("접힌 줄 수가 누적됨", folded > 31, `folded=${folded}`);
  check("여전히 상한 이하", m2.history.length <= 50, `len=${m2.history.length}`);
}

// ── 4. 로컬 날짜 (F2)
console.log("4) history 날짜가 로컬 기준 (F2)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "날짜 확인", content: "본문.", type: "semantic" }).record;
  const line = rec.history[0];
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const localToday = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  check("history 날짜 = 로컬 오늘", line.startsWith(localToday), `${line} vs ${localToday}`);
  check("저장 타임스탬프는 UTC ISO 유지", /Z$/.test(rec.created), rec.created);
}

// ── 5. Windows 예약 파일명 (F3)
console.log("5) 예약 장치명 회피 (F3)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  for (const [title, expect] of [
    ["CON", "con_"],
    ["nul", "nul_"],
    ["com1", "com1_"],
    ["LPT9", "lpt9_"],
    ["aux", "aux_"],
  ]) {
    const r = s.remember({ title, content: `${title} 본문.`, type: "semantic" }).record;
    check(`"${title}" → ${expect}`, r.slug === expect, `slug=${r.slug}`);
  }
  // 예약어를 포함할 뿐인 정상 제목은 건드리지 않는다
  const ok = s.remember({ title: "console 로그 정리", content: "본문.", type: "semantic" }).record;
  check("예약어를 포함한 정상 제목은 그대로", ok.slug === "console-로그-정리", ok.slug);
  // 끝 마침표·공백 제거
  const dot = s.remember({ title: "설정.", content: "본문.", type: "semantic" }).record;
  check("끝 마침표 제거", dot.slug === "설정", dot.slug);
  check("모든 노트가 실제로 읽힘", new MemoryStore(new Vault(dir)).loadAll(true).length === 7);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT21 성능·이식성 회귀 테스트 통과 ✔");
