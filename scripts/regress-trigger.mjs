// T7/T9/T10 회귀 테스트 — 회상 트리거와 상태 가시성.
//
// 고정하는 버그:
//   E1 볼트 내용이 어떤 경로로도 자동 노출되지 않아, 모델이 "무엇이 저장돼 있는지"
//      모른 채 recall 키워드를 추측해야 했다 (네이티브는 MEMORY.md 가 매 세션 주입됨)
//   E3 잘못된 BIGBRAIN_VAULT 는 조용히 빈 볼트를 새로 만들고 경고가 없어,
//      "기억 전무" 가 정상처럼 보이고 볼트가 분열됐다
//   E4 recall 결과에 시간 정보가 0개라 120일 방치 기억이 아무 표시 없이 등장했다
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-trig-"));
  cleanups.push(d);
  return d;
}

/** 설정 그대로 서버를 띄우고 {instructions, stderr, tools} 를 돌려준다 */
async function boot(vaultDir, extraEnv = {}) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, BIGBRAIN_VAULT: vaultDir, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "regress-trigger", version: "0.0.1" });
  await client.connect(transport);
  transport.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  const { tools } = await client.listTools();
  await new Promise((r) => setTimeout(r, 120)); // stderr 플러시 대기
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { instructions, stderr, tools };
}

// ── 1. 인덱스가 instructions 에 실린다 (E1)
console.log("1) 기억 인덱스 자동 노출 (E1)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({
    title: "빌드는 corepack pnpm 으로",
    description: "pnpm 이 PATH 에 없어 corepack 을 거쳐야 한다",
    content: "상세 본문.",
    type: "procedural",
  });
  s.remember({
    title: "프로덕션은 I 드라이브",
    description: "설치본은 I:\\Program Files\\SimpleMailServer",
    content: "상세 본문.",
    type: "semantic",
  });

  const { instructions } = await boot(dir);
  check("기본 행동수칙이 유지됨", instructions.includes("RECALL FIRST"));
  check("인덱스 헤더 노출", /Vault index — 2 memories/.test(instructions), instructions.slice(-400));
  check("1번 기억 제목 노출", instructions.includes("빌드는 corepack pnpm 으로"));
  check("2번 기억 제목 노출", instructions.includes("프로덕션은 I 드라이브"));
  check("설명도 함께 노출", instructions.includes("pnpm 이 PATH 에 없어"));
  check("타입 표기 포함", instructions.includes("[procedural]") && instructions.includes("[semantic]"));
}

// ── 2. 빈 볼트(콜드 스타트)는 비어 있다고 명시하고, 오히려 지시를 강하게 준다
//
// 종전에는 빈 볼트일 때 한 문장만 내보냈고, 조기 반환 탓에 스코프 안내까지 통째로
// 빠졌다 — 설득이 가장 필요한 콜드 스타트에서 가장 약하게 말하는 역전이었다.
// 여기서는 (a) 비었다는 사실, (b) 빈 recall 을 "불필요" 로 오해하지 말라는 지시,
// (c) 즉시 저장하라는 행동 지시, (d) 스코프 안내 누락 없음 을 모두 고정한다.
console.log("2) 빈 볼트(콜드 스타트) 표기");
{
  const dir = freshDir();
  const { instructions } = await boot(dir);
  check("EMPTY 사실 노출", /vault is EMPTY/i.test(instructions), instructions.slice(-400));
  check("콜드 스타트로 명시", /COLD START/i.test(instructions), instructions.slice(-400));
  check(
    "빈 recall 을 '기억 불필요' 로 오해하지 말라는 지시",
    /NOT evidence that memory is unneeded/i.test(instructions),
    instructions.slice(-400),
  );
  check(
    "즉시 저장 행동 지시(끝까지 미루지 말 것)",
    /rather than deferring to the end of the session/i.test(instructions),
    instructions.slice(-400),
  );
  check("행동수칙은 그대로", instructions.includes("RECALL FIRST"));
}

// ── 2-b. 빈 볼트여도 프로젝트 스코프 안내가 사라지지 않는다 (조기 반환 버그 회귀 방지)
console.log("2-b) 빈 볼트 + 프로젝트 스코프");
{
  const dir = freshDir();
  const { instructions } = await boot(dir, { BIGBRAIN_PROJECT: "acme" });
  check("EMPTY 사실 노출", /vault is EMPTY/i.test(instructions));
  check(
    "스코프 안내가 빈 볼트에서도 실린다",
    instructions.includes('Current project scope: "acme"'),
    instructions.slice(-500),
  );
  check(
    "스코프별 저장 지침도 함께",
    /omit `project` for knowledge that should follow the user everywhere/.test(instructions),
    instructions.slice(-500),
  );
}

// ── 2-c. REMEMBER 규칙에 관측 가능한 이벤트 앵커가 있다
//
// "after learning a durable fact" 는 경계가 없어 모델이 저장 시점을 판정할 수 없었다
// (무저장 세션의 주원인). RECALL 의 "at the start of a task" 처럼 감지 가능한 사건이어야 한다.
console.log("2-c) REMEMBER 이벤트 앵커");
{
  const dir = freshDir();
  const { instructions } = await boot(dir);
  check("관측 가능 사건으로 명시", /OBSERVABLE events/.test(instructions), instructions.slice(0, 900));
  for (const anchor of [
    "wrote or edited a durable doc",
    "corrected you",
    "unfamiliar codebase",
    "non-obvious root cause",
  ]) {
    check(`앵커 포함: ${anchor}`, instructions.includes(anchor));
  }
  check(
    "내장 메모리와 별개 저장소임을 선언",
    instructions.includes("SEPARATE STORE"),
    instructions.slice(0, 1200),
  );
}

// ── 3. 상한 초과 시 총건수와 표시건수를 함께 알린다
console.log("3) 인덱스 상한 처리");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  for (let i = 0; i < 7; i++) {
    s.remember({ title: `기억 번호 ${i}`, description: `설명 ${i}`, content: `본문 ${i}`, type: "semantic" });
  }
  const { instructions } = await boot(dir, { BIGBRAIN_INDEX_LIMIT: "3" });
  check("총건수 7 표기", /7 memories stored/.test(instructions), instructions.slice(-400));
  check("표시건수 3 표기", /3 most recently updated shown/.test(instructions));
  const listed = (instructions.match(/^- \[semantic\] 기억 번호 /gm) ?? []).length;
  check("실제로 3건만 나열", listed === 3, `listed=${listed}`);
  check("누락분 안내 문구 포함", /anything not listed/.test(instructions));
}

// ── 4. 잘못된 볼트 경로가 조용히 넘어가지 않는다 (E3)
console.log("4) 볼트 경로 오타 가시화 (E3)");
{
  const wrong = path.join(freshDir(), "오타난", "경로");
  const { instructions, stderr } = await boot(wrong);
  check("stderr 에 경고 출력", /WARNING: BIGBRAIN_VAULT points at/.test(stderr), stderr.slice(0, 300));
  check("instructions 첫머리에 경고 부착", instructions.startsWith("WARNING:"), instructions.slice(0, 120));
  check("중복 저장 금지 안내 포함", /do NOT start storing duplicates/.test(instructions));
  check("기동 로그에 기억 수 표기", /memories=0/.test(stderr), stderr.slice(0, 300));
  check("도구는 정상 등록 (기동 자체는 성공)", true);
}

// ── 5. 정상 볼트에는 경고가 없다 (거짓 양성 방지)
console.log("5) 정상 볼트 — 오경보 없음");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "정상 기억", description: "설명", content: "본문.", type: "semantic" });
  const { instructions, stderr } = await boot(dir);
  check("경고 없음", !/WARNING/.test(instructions), instructions.slice(0, 200));
  check("기동 로그에 memories=1", /memories=1/.test(stderr), stderr.slice(0, 300));
  check("정상 안내로 시작", instructions.startsWith("BigBrainMemory is a persistent"));
}

// ── 6. 마커가 있으면 빈 볼트여도 경고하지 않는다 (의도적으로 비운 경우)
console.log("6) 마커 있는 빈 볼트 — 경고 없음");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "곧 지울 기억", description: "설명", content: "본문.", type: "semantic" }).record;
  fs.unlinkSync(path.join(dir, "memories", `${rec.slug}.md`)); // 사용자가 비운 상태
  check("마커 파일 생성돼 있음", fs.existsSync(path.join(dir, ".bigbrain-vault")));
  const { instructions, stderr } = await boot(dir);
  check("경고 없음", !/WARNING/.test(instructions));
  check("기동 로그는 memories=0", /memories=0/.test(stderr), stderr.slice(0, 200));
}

// ── 7. 격리 파일이 있으면 알린다
console.log("7) 격리 파일 존재 알림");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "멀쩡한 기억", description: "설명", content: "본문.", type: "semantic" });
  fs.writeFileSync(path.join(dir, "memories", "깨진것.md"), "---\nbad:\t: {{\n---\n", "utf-8");
  new MemoryStore(new Vault(dir)).loadAll(true); // 격리 유발

  const { stderr } = await boot(dir);
  check("기동 로그에 quarantined 표기", /quarantined=1/.test(stderr), stderr.slice(0, 300));
  check("확인 요청 메시지 출력", /vault\/quarantine\/ 확인 필요/.test(stderr));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT7/T9 트리거·가시성 회귀 테스트 통과 ✔");
