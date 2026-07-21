// L1 회귀 테스트 — 깨진 위키링크(dangling link) 보고.
//
// 고정하는 버그:
//   존재하지 않는 슬러그를 가리키는 [[위키링크]]가 아무 검증 없이 저장되고,
//   remember 도 reflect 도 그 사실을 알리지 않았다. 모델은 주입된 인덱스나
//   기억나는 이름을 보고 링크를 그냥 쓰기 때문에, 볼트 A 의 인덱스가 컨텍스트에
//   있는 상태로 볼트 B 에 저장하면 통째로 깨진다.
//   실볼트 관측: 기억 2건짜리 라이브 볼트에 이미 깨진 링크 1건이 들어 있었다.
//
// 설계 판단: **차단하지 않고 보고만 한다.** 아직 안 쓴 기억을 미리 가리키는 선행
// 참조는 정상적인 사용법이므로(remember 설명이 링크를 권장한다) 저장을 막으면
// 그 정상 경로까지 죽는다.
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
function freshStore() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-link-"));
  cleanups.push(d);
  return new MemoryStore(new Vault(d));
}

console.log("1) remember 가 깨진 링크를 보고한다");
{
  const s = freshStore();
  const r = s.remember({
    title: "배포는 blue-green",
    description: "무중단 배포 절차",
    content: "자세한 내용. 관련: [[존재하지-않는-기억]] 과 [[memories/이것도-없음]].",
    type: "procedural",
  });
  check("깨진 링크 2건 검출", r.dangling.length === 2, JSON.stringify(r.dangling));
  check("본문 링크를 잡음", r.dangling.includes("존재하지-않는-기억"), JSON.stringify(r.dangling));
  check("memories/ 접두사도 같은 대상으로 봄", r.dangling.includes("이것도-없음"), JSON.stringify(r.dangling));
  check("저장 자체는 막지 않음", r.record.slug !== undefined && s.list().length === 1);
}

console.log("2) 실제로 존재하는 링크는 보고하지 않는다");
{
  const s = freshStore();
  const first = s.remember({ title: "첫 기억", description: "설명", content: "본문", type: "semantic" });
  const second = s.remember({
    title: "둘째 기억",
    description: "설명",
    content: `앞의 것을 참조: [[${first.record.slug}]]`,
    type: "semantic",
  });
  check("존재하는 대상은 깨진 링크가 아님", second.dangling.length === 0, JSON.stringify(second.dangling));

  // link() 로 맺은 정상 연결도 오탐이 나면 안 된다 — 본문에 위키링크가 주입된다
  s.link(first.record.slug, second.record.slug, "같은 주제");
  const rep = s.reflect();
  check("link() 로 맺은 연결은 오탐 아님", rep.danglingLinks.length === 0, JSON.stringify(rep.danglingLinks));
}

console.log("3) reflect 가 볼트 전체의 깨진 링크를 모은다");
{
  const s = freshStore();
  s.remember({ title: "가", description: "설명", content: "[[없는-대상-1]]", type: "semantic" });
  s.remember({ title: "나", description: "설명", content: "정상 본문", type: "semantic" });
  s.remember({ title: "다", description: "설명", content: "[[없는-대상-1]] [[없는-대상-2]]", type: "semantic" });
  const rep = s.reflect();
  check("깨진 링크를 가진 기억만 2건", rep.danglingLinks.length === 2, JSON.stringify(rep.danglingLinks));
  const all = rep.danglingLinks.flatMap((x) => x.targets);
  check("대상 3건 모두 열거", all.length === 3, JSON.stringify(all));
  check("멀쩡한 기억은 목록에 없음", !rep.danglingLinks.some((x) => x.slug.includes("나")), JSON.stringify(rep.danglingLinks));
}

console.log("4) supersede 는 깨진 링크로 오인되지 않는다");
{
  // supersedes/supersededBy 는 아카이브로 옮겨진 기억을 가리킬 수 있다.
  // listSlugs(true) 로 아카이브까지 보므로 오탐이 나면 안 된다.
  const s = freshStore();
  const old = s.remember({ title: "옛 결론", description: "설명", content: "본문", type: "semantic" });
  const neo = s.remember({
    title: "새 결론",
    description: "설명",
    content: "본문",
    type: "semantic",
    supersedes: old.record.slug,
  });
  check("supersedes 링크는 오탐 아님", neo.dangling.length === 0, JSON.stringify(neo.dangling));
  s.forget(old.record.slug, "낡음");
  const rep = s.reflect();
  check("아카이브된 대상을 가리켜도 오탐 아님", rep.danglingLinks.length === 0, JSON.stringify(rep.danglingLinks));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\n깨진 링크 보고 회귀 테스트 통과 ✔");
