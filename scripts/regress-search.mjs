// T15 회귀 테스트 — 동의어 확장과 0건 폴백.
//
// 고정하는 버그:
//   D1 검색이 표층 부분문자열 매칭이라 "배포" 로 저장한 기억을 deploy 로 찾으면 0건.
//      에이전트는 "기억이 없다" 고 결론 내리고 같은 사실을 재학습·중복 저장한다.
//   D2 직접 매칭이 0건이면 연상(1-hop) 확산도 시드가 없어 진입 자체가 불가능했다.
//      link() 에 투자한 연상 네트워크가 정작 표층 어휘가 어긋난 질의에서 무력했다.
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-search-"));
  cleanups.push(d);
  return d;
}
const slugs = (rs) => rs.map((r) => r.record.slug);

// ── 1. 한↔영 동의어 (감사 실측 실패 사례)
console.log("1) 한↔영 동의어 교차 검색 (D1)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "배포 절차 메모", description: "배포 방법", content: "프로덕션 배포 순서.", type: "procedural", tags: ["배포"] });
  s.remember({ title: "설정값 정리", description: "환경 설정", content: "서버 설정 항목.", type: "semantic" });

  const q = new MemoryStore(new Vault(dir));
  check("deploy → 배포 기억을 찾음 (종전 0건)", slugs(q.search("deploy")).includes("배포-절차-메모"), slugs(q.search("deploy")).join(","));
  check("디플로이 → 배포 기억을 찾음", slugs(q.search("디플로이")).includes("배포-절차-메모"));
  check("release → 배포 기억을 찾음", slugs(q.search("release")).includes("배포-절차-메모"));
  check("config → 설정 기억을 찾음 (종전 0건)", slugs(q.search("config")).includes("설정값-정리"));
  check("원 키워드는 여전히 동작", slugs(q.search("배포")).includes("배포-절차-메모"));
}

// ── 2. 역방향 (영어로 저장 → 한국어로 질의)
console.log("2) 역방향 교차 검색");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "deploy pipeline runbook", description: "release steps", content: "how to deploy.", type: "procedural" });
  const q = new MemoryStore(new Vault(dir));
  check("배포 → 영어 기억을 찾음 (종전 0건)", slugs(q.search("배포")).includes("deploy-pipeline-runbook"), slugs(q.search("배포")).join(","));
}

// ── 3. 정확 일치가 동의어 일치보다 상위
console.log("3) 정확 일치 우선 순위 유지");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "deploy 정확 일치", description: "deploy 로 저장됨", content: "deploy deploy deploy.", type: "semantic" });
  s.remember({ title: "배포 동의어 일치", description: "배포 로 저장됨", content: "배포 배포 배포.", type: "semantic" });
  const r = new MemoryStore(new Vault(dir)).search("deploy");
  check("둘 다 회상됨", r.length === 2, slugs(r).join(","));
  check("정확 일치 쪽이 1위", r[0].record.slug === "deploy-정확-일치", slugs(r).join(","));
}

// ── 4. 사용자 사전 (BIGBRAIN_SYNONYMS)
console.log("4) 사용자 동의어 사전");
{
  const prev = process.env.BIGBRAIN_SYNONYMS;
  process.env.BIGBRAIN_SYNONYMS = "크로스넷=crossnet,사내망;웹메일=webmail";
  try {
    const { MemoryStore: Fresh } = await import(`${distUrl("store.js")}?syn=1`);
    const dir = freshDir();
    const s = new Fresh(new Vault(dir));
    s.remember({ title: "크로스넷 토폴로지", description: "내부망 구조", content: "망분리 구성.", type: "semantic" });
    const q = new Fresh(new Vault(dir));
    check("crossnet → 크로스넷 기억", slugs(q.search("crossnet")).includes("크로스넷-토폴로지"), slugs(q.search("crossnet")).join(","));
    check("사내망 → 크로스넷 기억", slugs(q.search("사내망")).includes("크로스넷-토폴로지"));
  } finally {
    if (prev === undefined) delete process.env.BIGBRAIN_SYNONYMS;
    else process.env.BIGBRAIN_SYNONYMS = prev;
  }
}

// ── 5. 0건 폴백 — 연상 확산 진입 (감사 실측 실패 사례)
console.log("5) 0건 시 2차 패스 + 연상 확산 (D2)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "배포 절차", description: "배포 순서", content: "알파 본문.", type: "procedural" });
  s.remember({ title: "릴리스 노트 작성법", description: "노트 쓰는 법", content: "브라보 본문.", type: "procedural" });
  s.link("배포-절차", "릴리스-노트-작성법", "연관");

  const q = new MemoryStore(new Vault(dir));
  // "릴리스노트" — 붙여 쓴 형태. 부분문자열로는 어디에도 안 걸리고(제목엔 공백이 있다),
  // 동의어 사전에도 없다. 오직 2차 패스의 느슨한 접두 비교로만 시드가 만들어진다.
  const direct = q.search("릴리스노트");
  const got = slugs(direct);
  check("표층 미스매치 질의가 0건이 아님 (종전 0건)", got.length > 0, `got=${got.join(",")}`);
  check("2차 패스가 제목 토큰으로 시드를 만듦", got.includes("릴리스-노트-작성법"), got.join(","));
  check("그 시드에서 연상이 링크된 기억까지 확산", got.includes("배포-절차"), got.join(","));
  // 대조군: 링크망·직접 검색 자체는 정상
  check("직접 키워드는 정상 동작(대조군)", new MemoryStore(new Vault(dir)).search("배포").length >= 1);
}

// ── 6. 2차 패스가 무관한 기억을 끌어오지 않는다 (오탐 방지)
console.log("6) 폴백 오탐 방지");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "고양이 사진 정리", description: "반려동물 앨범", content: "찰리 본문.", type: "episodic" });
  const r = new MemoryStore(new Vault(dir)).search("쿼크플럭스존재하지않는단어");
  check("완전히 무관한 질의는 0건 유지", r.length === 0, slugs(r).join(","));
}

// ── 7. 직접 매칭이 있으면 2차 패스는 돌지 않는다 (정밀도 보존)
console.log("7) 직접 매칭 시 폴백 미작동");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "정확한 제목", description: "델타 설명", content: "델타 본문.", type: "semantic" });
  s.remember({ title: "델타 비슷한 것", description: "느슨 매칭 후보", content: "무관 본문.", type: "semantic" });
  const r = new MemoryStore(new Vault(dir)).search("델타");
  check("직접 매칭만 반환 (느슨 매칭 남발 없음)", r.length === 2, slugs(r).join(","));
  check("점수가 폴백 수준(1.5×)이 아닌 정상 키워드 점수", r[0].score > 3, `score=${r[0]?.score}`);
}

// ── 8. 토큰 경계 — 'cat' 이 concatenate 를 잡지 않는다 (D4)
console.log("8) 토큰 경계 오탐 차단 (D4)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "Concatenation helpers", description: "string joining", content: "concat and concatenate utilities.", type: "semantic" });
  s.remember({ title: "문자열 유틸 정리", description: "category 분류", content: "concatenate, concat, category 정리.", type: "semantic" });
  const r = new MemoryStore(new Vault(dir)).search("cat");
  check("'cat' 이 concatenate/category 를 끌어오지 않음 (종전 2건 7.68/3.84)", r.length === 0, slugs(r).join(","));
}

// ── 9. 조사 흡수는 유지 (한국어 회수율 보존)
console.log("9) 조사 흡수 유지");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "배포 모드 설명", description: "모드 종류", content: "프로덕션 모드 본문.", type: "semantic" });
  const q = new MemoryStore(new Vault(dir));
  check("'모드를' 로 검색해도 '모드' 기억을 찾음", slugs(q.search("모드를")).includes("배포-모드-설명"), slugs(q.search("모드를")).join(","));
  check("'배포는' 도 동작", slugs(q.search("배포는")).includes("배포-모드-설명"));
}

// ── 10. 단어 경계 — 서버리스/서버, 인증서/인증 오탐 차단 (D3)
console.log("10) 접두 오탐 차단 (D3)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const first = s.remember({
    title: "서버 성능 튜닝",
    description: "물리 서버 CPU 메모리 조정 방법",
    content: "물리 장비 튜닝 절차.",
    type: "procedural",
  });
  const second = s.remember({
    title: "서버리스 비용 분석",
    description: "람다 함수 호출당 과금 계산",
    content: "서버리스 요금 구조.",
    type: "semantic",
  });
  check("'서버리스 비용' 이 '서버 성능' 을 similar 로 오보고하지 않음", second.similar.length === 0, second.similar.map((m) => m.slug).join(","));
  check("(전제) 첫 기억은 정상 저장됨", !!first.record.slug);

  const r = new MemoryStore(new Vault(dir)).search("성능 비용");
  const inhibited = r.filter((x) => x.inhibited).map((x) => x.record.slug);
  check("무관한 두 기억이 RIF 로 서로 억제되지 않음", inhibited.length === 0, inhibited.join(","));
}

// ── 11. 짧은 제목 메모가 볼트 전체를 억제하지 않는다 (D3 min 분모 문제)
console.log("11) 희소 토큰 대량 억제 차단 (D3)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "빌드", description: "빌드", content: "빌드", type: "episodic" }); // 극단적으로 짧은 메모
  s.remember({ title: "인스톨러 서명 빌드", description: "코드 서명 절차", content: "인증서로 서명한다.", type: "procedural" });
  s.remember({ title: "CI 캐시 빌드", description: "캐시 전략", content: "레이어 캐시를 쓴다.", type: "procedural" });
  s.remember({ title: "도커 멀티스테이지 빌드", description: "이미지 축소", content: "멀티스테이지로 줄인다.", type: "procedural" });

  const r = new MemoryStore(new Vault(dir)).search("빌드");
  const inhibited = r.filter((x) => x.inhibited).map((x) => x.record.slug);
  check("서로 다른 주제의 빌드 문서가 억제되지 않음 (종전 3건 반토막)", inhibited.length === 0, inhibited.join(","));
  check("네 건 모두 회상됨", r.length === 4, `len=${r.length}`);
}

// ── 12. 진짜 근접 중복은 여전히 잡는다 (P5 기능 보존)
console.log("12) 진짜 중복은 계속 탐지");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "타입스크립트 strict 모드 선호", description: "코드 리뷰에서 strict true 를 요구함", content: "본문 A.", type: "preference" });
  const dup = s.remember({ title: "타입스크립트 strict 모드 선호함", description: "코드 리뷰에서 strict true 를 요구함", content: "본문 B.", type: "preference" });
  check("근접 중복은 similar 로 보고됨", dup.similar.length >= 1, dup.similar.map((m) => m.slug).join(","));

  const rep = new MemoryStore(new Vault(dir)).reflect();
  check("reflect 의 중복 후보로도 잡힘", rep.duplicates.length >= 1, JSON.stringify(rep.duplicates));

  const r = new MemoryStore(new Vault(dir)).search("타입스크립트 strict");
  check("근접 중복은 RIF 로 억제됨 (P5 유지)", r.some((x) => x.inhibited), r.map((x) => `${x.record.slug}:${x.inhibited}`).join(","));
}

// ── 13. 컷오프가 숨겨지지 않는다 (D5)
console.log("13) 누락 가시화 (D5)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  for (let i = 0; i < 20; i++) {
    s.remember({ title: `메일 주제 ${i}`, description: `메일 관련 ${i}`, content: `메일 본문 ${i}.`, type: "semantic" });
  }
  const q = new MemoryStore(new Vault(dir));
  const out = q.searchDetailed("메일");
  check("직접 매칭 총 20건이 보고됨", out.totalMatched === 20, `total=${out.totalMatched}`);
  check("기본 limit 으로는 5건만 표시", out.results.filter((r) => !r.snippet.startsWith("(연상")).length === 5, `len=${out.results.length}`);
  const wide = q.searchDetailed("메일", { limit: 20 });
  check("limit 을 올리면 전부 반환", wide.results.length === 20, `len=${wide.results.length}`);
  check("limit 을 올려도 totalMatched 는 동일", wide.totalMatched === 20);
}

// ── 14. 연상 상한이 limit 에 비례한다 (D5)
console.log("14) 연상 상한 비례화");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "허브 기억", description: "중심", content: "노벰버 본문.", type: "semantic" });
  for (let i = 0; i < 6; i++) {
    s.remember({ title: `이웃 ${i}`, description: `이웃 설명 ${i}`, content: `무관 본문 ${i}.`, type: "semantic" });
    s.link("허브-기억", `이웃-${i}`, "연결");
  }
  const q = new MemoryStore(new Vault(dir));
  const small = q.searchDetailed("노벰버", { limit: 1 }).results.filter((r) => r.snippet.startsWith("(연상")).length;
  const big = q.searchDetailed("노벰버", { limit: 10 }).results.filter((r) => r.snippet.startsWith("(연상")).length;
  check("limit 이 크면 연상도 더 많이 (종전 고정 3)", big > small, `small=${small} big=${big}`);
}

// ── 15. 위키링크가 검색을 오염시키지 않는다 (D6)
console.log("15) 링크 메타데이터 검색 제외 (D6)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "배포 절차서", description: "배포 순서", content: "배포 관련 본문.", type: "procedural" });
  s.remember({ title: "커피 원두 취향", description: "에티오피아 선호", content: "커피 이야기.", type: "preference" });
  s.link("커피-원두-취향", "배포-절차서", "무관하지만 연결됨");

  const q = new MemoryStore(new Vault(dir));
  const got = slugs(q.search("절차서", { includeLinked: false }));
  check("링크만 걸린 무관 기억이 직접 매칭되지 않음", !got.includes("커피-원두-취향"), got.join(","));
  check("본래 기억은 정상 매칭", got.includes("배포-절차서"), got.join(","));
  const withLink = q.search("절차서", { includeLinked: true });
  check("include_linked 를 켜면 연상으로는 나옴", withLink.some((r) => r.record.slug === "커피-원두-취향" && r.snippet.startsWith("(연상")));
}

// ── 16. 스니펫이 질의 토큰을 가장 많이 덮는 구간을 고른다 (D7)
console.log("16) 스니펫 다중 토큰 커버리지 (D7)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({
    title: "타임아웃 가이드",
    description: "팀 위키 요약",
    content:
      "팀 위키 일반론: 타임아웃 값은 상황마다 달라 정답이 없다는 논의가 길게 이어졌다. " +
      "여러 사례를 검토했고 합의에 이르지 못한 채 보류되었다. " +
      "결론: DB 커넥션 타임아웃은 반드시 30초로 설정한다.",
    type: "semantic",
  });
  const q = new MemoryStore(new Vault(dir));
  const a = q.search("타임아웃 30초")[0].snippet;
  const b = q.search("30초 타임아웃")[0].snippet;
  check("어순 A 에서 결론 문장이 포함됨", a.includes("30초로 설정"), a);
  check("어순 B 에서도 결론 문장이 포함됨", b.includes("30초로 설정"), b);
  check("질의 어순에 따라 결과가 달라지지 않음", a === b, `A=${a}\n       B=${b}`);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT15/T16/T17 검색 회귀 테스트 통과 ✔");
