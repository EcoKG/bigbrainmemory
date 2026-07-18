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

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT15 검색 확장 회귀 테스트 통과 ✔");
