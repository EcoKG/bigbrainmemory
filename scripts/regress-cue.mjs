// T34 회귀 테스트 — 부호화 큐 (UserPromptSubmit).
//
// 사람은 "이걸 기억해야지" 하고 기억하지 않는다. 놀라움·정정·완결 같은 계기가 그 자리에서
// 부호화를 유발한다. BBM 의 부호화 경로는 명시적 remember 호출뿐이었고, 유일한 넛지는
// Stop 훅이라 **세션이 끝날 때** 나왔다 — 그때는 맥락이 압축됐을 수 있고, 그러면 요약에서
// 재구성해 저장하게 되는데 그건 P8 이 금지하는 요지 기반 재구성이다.
//
// 고정하는 계약:
//   · 큐는 턴 **시작** 시점에 나간다 (UserPromptSubmit — stdout 이 컨텍스트가 되는 확인된 이벤트)
//   · **자동 저장 경로를 만들지 않는다** — 훅은 큐만 내고 판단은 모델이 한다
//   · 큐는 스스로 기계 휴리스틱임을 밝히고 출처·타입을 지정하지 않는다
//   · 세션당 1회 (경보 피로 방지)
//   · prompt 필드가 없는 환경에서도 동작한다 (미확인 계약에 의존하지 않는다)
//
// 라이브 볼트는 건드리지 않는다.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const guard = path.join(here, "session-guard.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const cleanups = [];
function freshVault(tag, n = 1) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bbm-cue-${tag}-`));
  cleanups.push(d);
  fs.mkdirSync(path.join(d, "memories"), { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, "memories", `m${i}.md`), "x", "utf-8");
  fs.writeFileSync(path.join(d, "MEMORY.md"), "# idx\n", "utf-8");
  return d;
}
const run = (args, cwd, input, env = {}) => {
  try {
    return execFileSync(process.execPath, [guard, ...args], {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      input,
      env: { ...process.env, ...env },
    });
  } catch (err) {
    return err.stdout ?? "";
  }
};
const startEv = (o = {}) => JSON.stringify({ hook_event_name: "SessionStart", ...o });
const promptEv = (o = {}) => JSON.stringify({ hook_event_name: "UserPromptSubmit", ...o });
const marker = (v) => JSON.parse(fs.readFileSync(path.join(v, ".bbm-session-start"), "utf-8"));

// ── 1. 정정 어휘가 큐를 유발한다
console.log("1) 정정 어휘 감지");
{
  const v = freshVault("lex");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C1", source: "startup" }));
  const out = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C1", prompt: "아니야 그게 아니라 8080 포트를 쓰라고" }));
  check("정정 발화에 큐 발생", /<bigbrainmemory-cue/.test(out), out.slice(0, 300));
  check("기계 휴리스틱임을 명시", /regex guess, not an observation/.test(out), out.slice(0, 400));
  check("지금 저장하라고 지시", /now/.test(out) && /remember/.test(out), out.slice(0, 400));
  check("원문이 살아있을 때 저장하라고", /verbatim/.test(out), out.slice(0, 500));
  check("출처·타입을 스스로 정하라고", /pick .type. yourself/.test(out) && /do not infer either from this cue/.test(out), out.slice(0, 600));
  check("도구 이름을 정확히 지목", /mcp__[\w-]+__remember/.test(out), out.slice(0, 400));
  check("무시해도 된다고 명시", /ignore this and continue/.test(out), out.slice(-300));

  // 평범한 발화에는 조용하다
  const v2 = freshVault("plain");
  run(["--start", "--vault-force", v2], v2, startEv({ session_id: "C2", source: "startup" }));
  const quiet = run(["--prompt", "--vault-force", v2], v2, promptEv({ session_id: "C2", prompt: "이 파일 좀 읽어줘" }));
  check("평범한 발화에는 침묵", quiet.trim() === "", quiet.slice(0, 200));
}

// ── 2. 세션당 1회 (경보 피로 방지)
console.log("2) 세션당 1회");
{
  const v = freshVault("once");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C3", source: "startup" }));
  const outs = [];
  for (let i = 0; i < 4; i++) {
    outs.push(run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C3", prompt: "아니야 틀렸어" })).trim());
  }
  check("4턴 정정에도 큐는 1회", outs.filter((o) => o !== "").length === 1, `발화 ${outs.filter((o) => o !== "").length}회`);
  check("첫 턴에 나옴", outs[0] !== "");
}

// ── 3. prompt 필드가 없어도 동작한다 (미확인 계약 의존 금지)
console.log("3) prompt 부재 시 턴 기반 폴백");
{
  const v = freshVault("fallback");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C4", source: "startup" }));
  const outs = [];
  for (let i = 0; i < 3; i++) {
    // prompt 없이 온다 — 문서로 확정되지 않은 필드이므로 이 경로가 실제 환경일 수 있다
    outs.push(run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C4" }), { BIGBRAIN_CUE_TURNS: "3" }).trim());
  }
  check("임계 전에는 침묵", outs[0] === "" && outs[1] === "", outs.map((o) => o.length).join(","));
  check("임계 턴에 큐 발생", outs[2] !== "", outs[2].slice(0, 200));
  check("턴 근거를 밝힘", /3 turns into this session/.test(outs[2]), outs[2].slice(0, 200));
  check("턴 수가 마커에 누적됨", marker(v).turns === 3, JSON.stringify(marker(v)));
}

// ── 4. 이미 저장한 세션에는 말을 걸지 않는다
console.log("4) 저장한 세션에는 침묵");
{
  const v = freshVault("stored");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C5", source: "startup" }));
  fs.writeFileSync(path.join(v, "memories", "새기억.md"), "x", "utf-8"); // 부호화가 이미 일어났다
  const out = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C5", prompt: "아니야 틀렸어" }));
  check("이미 저장했으면 침묵", out.trim() === "", out.slice(0, 200));
}

// ── 5. 자동 저장 경로를 만들지 않는다 (P6 의 대칭)
console.log("5) 자동 저장 없음");
{
  const v = freshVault("noauto");
  const before = fs.readdirSync(path.join(v, "memories")).length;
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C6", source: "startup" }));
  run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C6", prompt: "아니야 그게 아니라" }));
  const after = fs.readdirSync(path.join(v, "memories")).length;
  check("훅이 기억을 만들지 않음", before === after, `${before} → ${after}`);
  check("아카이브도 건드리지 않음", !fs.existsSync(path.join(v, "archive")) || fs.readdirSync(path.join(v, "archive")).length === 0);
}

// ── 6. 세션을 방해하지 않는다
console.log("6) 무해성");
{
  const v = freshVault("safe");
  // 기준선이 없으면(세션 시작을 못 봤으면) 조용히 종료
  const orphan = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C7", prompt: "아니야" }));
  check("마커 없으면 침묵", orphan.trim() === "", orphan.slice(0, 200));

  // 다른 세션의 프롬프트면 판정하지 않는다
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C8", source: "startup" }));
  const other = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "다른세션", prompt: "아니야 틀렸어" }));
  check("다른 세션이면 침묵", other.trim() === "", other.slice(0, 200));

  // stdin 이 아예 없어도 죽지 않는다
  let code = 0;
  try {
    execFileSync(process.execPath, [guard, "--prompt", "--vault-force", v], { cwd: root, encoding: "utf-8", timeout: 15000, input: "" });
  } catch (err) {
    code = err.status ?? -1;
  }
  check("stdin 없어도 종료코드 0", code === 0, `code=${code}`);

  // 깨진 stdin 도 마찬가지
  let code2 = 0;
  try {
    execFileSync(process.execPath, [guard, "--prompt", "--vault-force", v], { cwd: root, encoding: "utf-8", timeout: 15000, input: "JSON 아님{{{" });
  } catch (err) {
    code2 = err.status ?? -1;
  }
  check("깨진 stdin 이어도 종료코드 0", code2 === 0, `code=${code2}`);
}

// ── 7. 계측에 남는다
console.log("7) 계측 기록");
{
  const v = freshVault("log");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C9", source: "startup" }));
  run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C9", prompt: "아니야 그게 아니라" }));
  const log = fs
    .readFileSync(path.join(v, ".bbm-usage.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const cue = log.find((e) => e.event === "cue");
  check("큐 발생이 기록됨", cue !== undefined, JSON.stringify(log));
  check("발동 사유가 기록됨", cue?.reason === "lexical", JSON.stringify(cue));
  // 내용 비기록 원칙은 여기서도 지킨다
  check("사용자 발화가 로그에 없음", !fs.readFileSync(path.join(v, ".bbm-usage.jsonl"), "utf-8").includes("그게 아니라"));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT34 부호화 큐 회귀 테스트 통과 ✔");
