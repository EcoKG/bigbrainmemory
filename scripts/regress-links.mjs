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

// ── 4-b. 코드 안의 예시 표기를 링크으로 오인하지 않는다
//
// 실사용에서 즉시 터진 오탐이다: 링크 표기법을 **설명하는** 메모리를 저장하자 그 설명문
// 자체가 깨진 링크로 보고됐다. 문서 성격의 기억은 상시 broken 으로 잡힌다.
// 오탐은 침묵보다 나쁘다 — 매번 깨졌다고 하는 검증기는 무시당하고, 그러면 진짜 깨진
// 링크도 함께 묻힌다.
console.log("4-b) 코드 스팬·블록 제외");
{
  const s = freshStore();
  const r = s.remember({
    title: "위키링크 표기법 안내",
    description: "설명",
    type: "procedural",
    content:
      "링크는 `[[슬러그]]` 형식으로 씁니다.\n\n" +
      "```js\n" +
      'const t = body.match(/\\[\\[([^\\]]+)/); // [[예시-대상]]\n' +
      "```\n\n" +
      "~~~\n[[틸드-블록-예시]]\n~~~\n",
  });
  // ★ 패치 전 실패: `[[슬러그]]`·[[예시-대상]]·[[틸드-블록-예시]] 가 전부 깨진 링크로 잡혔다
  check("인라인 코드 스팬 안은 링크 아님", !r.dangling.includes("슬러그"), JSON.stringify(r.dangling));
  check("펜스 코드 블록 안은 링크 아님", !r.dangling.includes("예시-대상"), JSON.stringify(r.dangling));
  check("틸드 코드 블록 안도 링크 아님", !r.dangling.includes("틸드-블록-예시"), JSON.stringify(r.dangling));
  check("오탐이 하나도 없음", r.dangling.length === 0, JSON.stringify(r.dangling));

  // 산문 안의 진짜 깨진 링크는 여전히 잡아야 한다 — 오탐을 없애려다 검증을 끄면 안 된다
  const r2 = s.remember({
    title: "진짜 깨진 링크 포함",
    description: "설명",
    type: "semantic",
    content: "본문에서 `[[코드안]]` 은 예시고, 이건 진짜 링크입니다: [[정말-없는-대상]]",
  });
  check("산문의 깨진 링크는 여전히 검출", r2.dangling.includes("정말-없는-대상"), JSON.stringify(r2.dangling));
  check("같은 본문의 코드 스팬은 제외", !r2.dangling.includes("코드안"), JSON.stringify(r2.dangling));
}

// ── 4-c. 본문 위키링크가 연상망에 반영된다
//
// 종전에는 `links` 인자로 넘긴 것만 연결돼, Obsidian 에서는 연결로 보이는데 recall 의
// 확산에는 안 잡혔다. 실사용에서 이관한 27건이 전부 orphan 으로 남았다.
console.log("4-c) 본문 위키링크 → 연상망");
{
  const s = freshStore();
  const target = s.remember({ title: "연결 대상", description: "설명", content: "본문", type: "semantic" });
  const src = s.remember({
    title: "본문에서 링크하는 기억",
    description: "설명",
    type: "semantic",
    content: `관련: [[${target.record.slug}]] 을 참고.`,
  });
  // ★ 패치 전 실패: links 가 비어 orphan 이었다
  check("본문 링크가 links 에 반영됨", src.record.links.includes(target.record.slug), JSON.stringify(src.record.links));
  check("orphan 이 아님", s.reflect().orphans.every((m) => m.slug !== src.record.slug), s.reflect().orphans.map((m) => m.slug).join(","));

  // 대상 파일은 건드리지 않는다 — 기억 하나를 저장했더니 남의 파일이 바뀌면 안 된다
  const t = s.read(target.record.slug);
  check("대상 파일은 수정되지 않음(단방향)", !t.links.includes(src.record.slug), JSON.stringify(t.links));

  // 없는 대상은 링크로 넣지 않는다 (깨진 링크 보고로만 남긴다)
  const bad = s.remember({ title: "없는 대상 링크", description: "설명", content: "[[없는-대상-xyz]]", type: "semantic" });
  check("존재하지 않는 대상은 links 에 안 들어감", bad.record.links.length === 0, JSON.stringify(bad.record.links));
  check("대신 깨진 링크로 보고", bad.dangling.includes("없는-대상-xyz"), JSON.stringify(bad.dangling));

  // 코드 안의 예시는 연상망에도 안 들어간다
  const codeOnly = s.remember({
    title: "코드 예시만 있는 기억",
    description: "설명",
    type: "semantic",
    content: `\`[[${target.record.slug}]]\` 는 표기 예시일 뿐입니다.`,
  });
  check("코드 스팬 예시는 링크로 안 잡힘", codeOnly.record.links.length === 0, JSON.stringify(codeOnly.record.links));
}

// ── 4-d. 슬러그를 제목과 분리할 수 있다
console.log("4-d) 슬러그 분리");
{
  const s = freshStore();
  const m = s.remember({
    title: "한국어 제목을 그대로 쓰고 싶다",
    slug: "stable-ascii-target",
    description: "설명",
    content: "본문",
    type: "semantic",
  });
  // ★ 패치 전: 링크 대상을 안정적으로 두려면 제목 자체를 영문으로 바꿔야 했다
  check("슬러그는 지정한 값", m.record.slug === "stable-ascii-target", m.record.slug);
  check("제목은 한국어 그대로", m.record.title === "한국어 제목을 그대로 쓰고 싶다", m.record.title);
  check("지정한 슬러그로 조회됨", s.read("stable-ascii-target") !== null);

  const auto = s.remember({ title: "슬러그 미지정", description: "설명", content: "본문", type: "semantic" });
  check("생략하면 종전대로 제목에서 파생", auto.record.slug === "슬러그-미지정", auto.record.slug);
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
