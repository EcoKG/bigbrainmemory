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

// ── 2. 빈 볼트는 비어 있다고 명시한다
console.log("2) 빈 볼트 표기");
{
  const dir = freshDir();
  const { instructions } = await boot(dir);
  check("EMPTY 안내 노출", /vault is currently EMPTY/i.test(instructions), instructions.slice(-300));
  check("행동수칙은 그대로", instructions.includes("RECALL FIRST"));
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

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT7 회상 트리거 회귀 테스트 통과 ✔");
