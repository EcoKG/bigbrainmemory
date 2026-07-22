// T35 회귀 테스트 — 공고화(에피소드 → 의미)와 그 P8 안전장치.
//
// 사람의 뇌는 휴식·수면 중 해마의 개별 에피소드를 재생해 신피질의 의미기억으로 추상화한다.
// BBM 에는 그 전이 경로가 아예 없었다 — `type` 은 생성 시 한 번 정해지고 어디서도 바뀌지
// 않았으며(오분류조차 교정 불가), reflect 는 위생점검만 했다.
//
// **P8 긴장의 처리 — 공고화 3조.**
// 추상화 자체는 P8 위반이 아니다. *추상화가 원본을 대체하는 것*이 위반이다.
// 인간 기억의 버그는 원본 에피소드가 소실되고 스키마만 남아 없던 세부를 재생성하는 것인데,
// 다중흔적 이론은 사람에게도 원본 흔적이 남는다고 보므로 "원본 완전 보존형 공고화" 는
// 인간 문헌 안에서도 지지되는 입장이다. 그것을 코드 계약으로 못박는다:
//   ① 바이트 불변 — 파생물 생성이 기존 파일을 단 1바이트도 바꾸지 않는다
//   ② 출처 영속 — derivedFrom 이 frontmatter 에 남아 revise 로도 지워지지 않는다
//   ③ 인출면 우선순위 — 파생물이 자기 근거를 RIF 로 누르지 않는다
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir().

import crypto from "node:crypto";
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
function freshStore() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-consol-"));
  cleanups.push(d);
  return { dir: d, store: new MemoryStore(new Vault(d)) };
}

/**
 * 볼트 전체의 경로 → SHA-256 맵.
 * "근거 3개 파일만 확인" 으로는 부족하다 — ensureBodyLinks·link() 같은 간접 쓰기가
 * 다른 파일을 건드릴 수 있으므로 **볼트 전체**를 봐야 P8 회귀로 성립한다.
 */
function vaultHashes(dir) {
  const out = {};
  const walk = (d, rel = "") => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else out[r] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const ep = (store, title, tags, body) =>
  store.remember({ title, description: `${title} 설명`, content: body, type: "episodic", tags });

// ── 1. reflect 가 공고화 후보를 찾아낸다
console.log("1) 공고화 후보 탐지");
{
  const { store } = freshStore();
  ep(store, "A 프로젝트 빌드 실패", ["빌드"], "2026-01-01 에 경로 문제로 빌드가 깨졌다.");
  ep(store, "B 프로젝트 빌드 실패", ["빌드"], "2026-02-01 에 같은 경로 문제로 깨졌다.");
  ep(store, "C 프로젝트 빌드 실패", ["빌드"], "2026-03-01 에 또 경로 문제였다.");
  ep(store, "회식 있었음", ["잡담"], "2026-03-02 회식.");

  const r = store.reflect();
  const build = r.consolidationCandidates.find((c) => c.theme === "빌드");
  check("3건 이상 모인 테마를 후보로", build !== undefined, JSON.stringify(r.consolidationCandidates));
  check("근거 슬러그를 전부 제시", build?.slugs.length === 3, JSON.stringify(build));
  check("3건 미만 테마는 후보 아님", !r.consolidationCandidates.some((c) => c.theme === "잡담"), JSON.stringify(r.consolidationCandidates));

  // 의미기억은 이미 추상화된 것이므로 후보가 아니다
  store.remember({ title: "이미 일반화된 사실", description: "설명", content: "본문", type: "semantic", tags: ["빌드"] });
  const r2 = store.reflect();
  check("semantic 은 후보에 섞이지 않음", r2.consolidationCandidates.find((c) => c.theme === "빌드")?.slugs.length === 3, JSON.stringify(r2.consolidationCandidates));
}

// ── 2. ★ 공고화 3조 ① — 바이트 불변
console.log("2) 파생물 생성이 원본을 바꾸지 않는다 (조 ①)");
{
  const { dir, store } = freshStore();
  const a = ep(store, "가 빌드 실패", ["빌드"], "경로 문제.");
  const b = ep(store, "나 빌드 실패", ["빌드"], "같은 경로 문제.");
  const c = ep(store, "다 빌드 실패", ["빌드"], "또 경로 문제.");
  const before = vaultHashes(dir);

  const derived = store.remember({
    title: "빌드는 경로 문제로 깨진다",
    description: "세 프로젝트에서 반복 관측",
    content: "상대 경로 가정이 원인이다.",
    type: "semantic",
    tags: ["빌드"],
    derivedFrom: [a.record.slug, b.record.slug, c.record.slug],
  });
  const after = vaultHashes(dir);

  // MEMORY.md 는 파생물 추가로 당연히 바뀐다 — 허용 목록으로 명시한다
  const changed = Object.keys(before).filter((k) => before[k] !== after[k] && k !== "MEMORY.md");
  const added = Object.keys(after).filter((k) => !(k in before));
  check("기존 파일이 한 바이트도 안 바뀜", changed.length === 0, `바뀐 파일: ${changed.join(", ")}`);
  check("추가된 것은 파생물 1개뿐", added.length === 1 && added[0].endsWith(".md"), added.join(", "));
  check("근거 에피소드가 그대로 살아있음", [a, b, c].every((x) => store.read(x.record.slug) !== null));
  check("근거의 타입이 episodic 그대로", [a, b, c].every((x) => store.read(x.record.slug)?.type === "episodic"));

  // ── 공고화 3조 ② — 출처 영속
  console.log("3) 출처가 frontmatter 에 영속한다 (조 ②)");
  const raw = fs.readFileSync(path.join(dir, "memories", `${derived.record.slug}.md`), "utf-8");
  check("derived_from 이 frontmatter 에 기록", /^derived_from:/m.test(raw), raw.slice(0, 400));
  check("근거 3건 모두 기록", derived.record.derivedFrom?.length === 3, JSON.stringify(derived.record.derivedFrom));

  // ★ 본문을 통째로 갈아엎어도 출처는 살아남아야 한다.
  // 본문에만 적어뒀다면 revise 한 번에 사라져 손으로 쓴 단정문과 구별 불가능해진다.
  store.revise(derived.record.slug, { content: "완전히 다른 본문으로 교체", reason: "테스트" });
  const afterRevise = store.read(derived.record.slug);
  check("revise 로 본문을 갈아도 출처 유지", afterRevise?.derivedFrom?.length === 3, JSON.stringify(afterRevise?.derivedFrom));

  // 파일에서 다시 읽어도(왕복) 유지된다
  const reloaded = new MemoryStore(new Vault(dir)).read(derived.record.slug);
  check("디스크 왕복 후에도 출처 유지", reloaded?.derivedFrom?.length === 3, JSON.stringify(reloaded?.derivedFrom));

  // 공고화된 에피소드는 다시 후보로 오르지 않는다
  const r = store.reflect();
  check("공고화된 에피소드는 후보에서 빠짐", !r.consolidationCandidates.some((x) => x.theme === "빌드"), JSON.stringify(r.consolidationCandidates));
}

// ── 4. ★ 공고화 3조 ③ — 파생물이 자기 근거를 누르지 않는다
console.log("4) 파생물이 근거를 RIF 로 누르지 않는다 (조 ③)");
{
  const { store } = freshStore();
  // 제목·설명이 크게 겹치도록 만들어 RIF 임계를 확실히 넘긴다
  const a = store.remember({
    title: "타임아웃 설정 오류 사고",
    description: "타임아웃 설정 오류로 배포가 실패했다",
    content: "1차 사고.",
    type: "episodic",
    tags: ["타임아웃"],
  });
  const b = store.remember({
    title: "타임아웃 설정 오류 재발",
    description: "타임아웃 설정 오류로 배포가 또 실패했다",
    content: "2차 사고.",
    type: "episodic",
    tags: ["타임아웃"],
  });
  const derived = store.remember({
    title: "타임아웃 설정 오류 일반 규칙",
    description: "타임아웃 설정 오류는 배포 실패의 반복 원인이다",
    content: "규칙.",
    type: "semantic",
    tags: ["타임아웃"],
    derivedFrom: [a.record.slug, b.record.slug],
  });

  const { results } = store.searchDetailed("타임아웃 설정 오류 배포", { limit: 10 });
  const byslug = Object.fromEntries(results.map((r) => [r.record.slug, r]));
  check("파생물과 근거가 모두 회상됨", results.length >= 3, results.map((r) => r.record.slug).join(","));

  // 계약은 "**파생물이** 근거를 누르지 않는다" 다. 근거끼리 서로 누르는 것은 정상적인
  // P5 동작이므로(둘은 실제로 근접 중복이다) inhibited 만 봐서는 계약을 검사할 수 없다.
  // 억제 주체를 보고 판정한다.
  // ★ 패치 전 실패: 근거들이 파생물(derived)에 눌려 inhibitedBy 가 파생물 슬러그였다
  const dslug = derived.record.slug;
  check("근거 1을 파생물이 누르지 않음", byslug[a.record.slug]?.inhibitedBy !== dslug, `inhibitedBy=${byslug[a.record.slug]?.inhibitedBy}`);
  check("근거 2를 파생물이 누르지 않음", byslug[b.record.slug]?.inhibitedBy !== dslug, `inhibitedBy=${byslug[b.record.slug]?.inhibitedBy}`);
  check(
    "파생물 자신도 근거에 눌리지 않음",
    ![a.record.slug, b.record.slug].includes(byslug[dslug]?.inhibitedBy ?? ""),
    `inhibitedBy=${byslug[dslug]?.inhibitedBy}`,
  );
  // 근거끼리의 억제는 P5 그대로 살아 있어야 한다 — 예외가 RIF 를 통째로 끄면 안 된다
  check(
    "근거끼리의 정상 억제는 유지",
    [a.record.slug, b.record.slug].some((s) => {
      const by = byslug[s]?.inhibitedBy;
      return by !== undefined && by !== dslug;
    }),
    results.map((r) => `${r.record.slug}<-${r.inhibitedBy ?? "-"}`).join(", "),
  );

  // 예외는 파생 관계에만 적용된다 — 무관한 근접 중복은 여전히 눌려야 한다(P5 유지)
  store.remember({
    title: "타임아웃 설정 오류 무관 메모",
    description: "타임아웃 설정 오류로 배포가 실패했다",
    content: "파생 관계가 없는 근접 중복.",
    type: "episodic",
    tags: ["타임아웃"],
  });
  const { results: r2 } = store.searchDetailed("타임아웃 설정 오류 배포", { limit: 10 });
  check("파생 관계가 없는 근접 중복은 여전히 억제됨", r2.some((r) => r.inhibited === true), r2.map((r) => `${r.record.slug}:${r.inhibited}`).join(","));
}

// ── 5. 유형 교정 (episodic → semantic 전이 경로)
console.log("5) 유형 교정");
{
  const { store } = freshStore();
  const m = store.remember({ title: "분류 시험", description: "설명", content: "본문", type: "episodic" });
  check("생성 시 episodic", m.record.type === "episodic");

  // ★ 패치 전 실패: ReviseInput 에 type 이 없어 오분류조차 고칠 수 없었다
  const revised = store.revise(m.record.slug, { type: "semantic", reason: "반복 경험이 일반 지식이 됨" });
  check("revise 로 semantic 이 됨", revised?.type === "semantic", revised?.type);
  check("재분류가 이력에 남음", revised?.history.some((h) => /reclassified episodic → semantic/.test(h)), JSON.stringify(revised?.history));

  const reloaded = store.read(m.record.slug);
  check("디스크에도 반영", reloaded?.type === "semantic", reloaded?.type);

  // 같은 타입으로 재지정하면 이력을 더럽히지 않는다
  const again = store.revise(m.record.slug, { type: "semantic", reason: "변화 없음" });
  check("같은 타입이면 재분류 이력 없음", again?.history.filter((h) => /reclassified/.test(h)).length === 1, JSON.stringify(again?.history));
}

// ── 6. 존재하지 않는 근거는 기록하지 않는다
console.log("6) 허위 출처 차단");
{
  const { store } = freshStore();
  const real = ep(store, "실제 에피소드", ["x"], "본문");
  const d = store.remember({
    title: "출처 섞인 파생물",
    description: "설명",
    content: "본문",
    type: "semantic",
    derivedFrom: [real.record.slug, "존재하지-않는-슬러그"],
  });
  // 없는 슬러그를 근거로 남기면 "출처가 있는 것처럼 보이는데 확인 불가" 라는 최악의 상태가 된다
  check("실재하는 근거만 남음", d.record.derivedFrom?.length === 1, JSON.stringify(d.record.derivedFrom));
  check("실재하는 쪽이 남음", d.record.derivedFrom?.[0] === real.record.slug, JSON.stringify(d.record.derivedFrom));

  const none = store.remember({
    title: "전부 허위 출처",
    description: "설명",
    content: "본문",
    type: "semantic",
    derivedFrom: ["없음1", "없음2"],
  });
  check("전부 없으면 필드 자체를 안 만듦", none.record.derivedFrom === undefined, JSON.stringify(none.record.derivedFrom));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT35 공고화 회귀 테스트 통과 ✔");
