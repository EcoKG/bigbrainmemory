// 세션 훅 회귀 테스트 — session-guard.mjs 의 볼트 해석과 무저장 감지.
//
// 고정하는 문제:
//   H1 훅이 설치 시점 경로를 박아두면, 프로젝트마다 BIGBRAIN_VAULT 로 볼트를 나누는
//      순간 훅만 옛 볼트를 계속 본다. 그러면 한 세션에서
//        훅  : "볼트에 이런 기억들이 있다"(볼트 B)
//        서버: "COLD START — this vault is EMPTY"(볼트 A)
//      라는 모순된 두 신호가 동시에 주입되고, 모델은 인덱스만 보고 저장을 건너뛴다.
//      실제로 그 분열이 관측돼(훅 3건 / 서버 빈 볼트) 실험이 통째로 무효화됐다.
//   H2 주입 블록이 출처를 안 밝히면 위 모순이 조용히 지나간다.
//   H3 Stop 훅이 세션 종료를 막으면 안 된다(종료 코드는 항상 0).
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
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
function freshDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bbm-hook-${name}-`));
  cleanups.push(d);
  return d;
}

/** 볼트 하나를 만들고 기억 n건을 채운다 */
function makeVault(root, label, n) {
  const v = path.join(root, label);
  fs.mkdirSync(path.join(v, "memories"), { recursive: true });
  fs.writeFileSync(path.join(v, "MEMORY.md"), `# 인덱스 ${label}\n`, "utf-8");
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(v, "memories", `${label}-${i}.md`), "본문", "utf-8");
  }
  return v;
}

/** guard 실행 — { out, code } */
function run(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [guard, ...args], {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
    });
    return { out, code: 0 };
  } catch (err) {
    return { out: err.stdout ?? "", code: err.status ?? -1 };
  }
}

// ── 1. 실행 시점 볼트 해석 (H1)
console.log("1) 실행 시점 볼트 해석 — 프로젝트 설정을 따라간다");
{
  const root = freshDir("resolve");
  const vaultA = makeVault(root, "A", 0); // 설치 시점 값
  const vaultB = makeVault(root, "B", 2); // 프로젝트가 실제로 쓰는 볼트
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".mcp.json"),
    JSON.stringify({ mcpServers: { bigbrainmemory: { env: { BIGBRAIN_VAULT: vaultB } } } }),
    "utf-8",
  );

  const auto = run(["--start", "--vault", vaultA], proj);
  check("프로젝트 .mcp.json 의 볼트를 따라감", auto.out.includes(vaultB.replace(/\\/g, "/")), auto.out.slice(0, 200));
  check("설치 시점 볼트를 쓰지 않음", !auto.out.includes(`vault="${vaultA.replace(/\\/g, "/")}"`));

  // 사용자가 명시한 경우엔 그 의도가 이긴다
  const forced = run(["--start", "--vault-force", vaultA], proj);
  check("--vault-force 는 자동탐지를 이김", forced.out.includes(`vault="${vaultA.replace(/\\/g, "/")}"`), forced.out.slice(0, 200));
}

// ── 2. 주입 블록이 출처를 밝힌다 (H2)
console.log("2) 주입 블록의 출처 표기");
{
  const root = freshDir("attr");
  const v = makeVault(root, "V", 3);
  const { out } = run(["--start", "--vault-force", v], root);
  check("볼트 경로 표기", out.includes(`vault="${v.replace(/\\/g, "/")}"`), out.slice(0, 200));
  check("기억 건수 표기", out.includes('memories="3"'), out.slice(0, 200));
  check("불일치 시 서버를 신뢰하라는 안내", /different vault|EMPTY/.test(out));
  check("인덱스 본문 포함", out.includes("# 인덱스 V"));
}

// ── 3. 무저장 감지 (Stop)
console.log("3) 무저장 감지");
{
  const root = freshDir("stop");
  const v = makeVault(root, "S", 1);

  const start = run(["--start", "--vault-force", v], root);
  check("start 종료코드 0", start.code === 0);
  check("마커 기록됨", fs.readFileSync(path.join(v, ".bbm-session-start"), "utf-8").trim() === "1");

  const noSave = run(["--stop", "--vault-force", v], root);
  check("저장 0건이면 경고", /0건입니다/.test(noSave.out), noSave.out.slice(0, 200));
  check("경고해도 종료코드 0 (세션을 막지 않음)", noSave.code === 0);

  fs.writeFileSync(path.join(v, "memories", "새기억.md"), "z", "utf-8");
  const saved = run(["--stop", "--vault-force", v], root);
  check("저장이 있으면 침묵", saved.out.trim() === "", saved.out.slice(0, 200));
  check("침묵해도 종료코드 0", saved.code === 0);
}

// ── 4. 설정이 어긋나도 세션을 방해하지 않는다 (H3)
console.log("4) 실패 시 침묵 + 종료코드 0");
{
  const root = freshDir("silent");
  const missing = path.join(root, "없는볼트");

  const start = run(["--start", "--vault-force", missing], root);
  check("없는 볼트 — start 침묵", start.out.trim() === "", start.out.slice(0, 200));
  check("없는 볼트 — 종료코드 0", start.code === 0);

  const stop = run(["--stop", "--vault-force", missing], root);
  check("마커 없으면 stop 침묵(근거 없는 경고 금지)", stop.out.trim() === "", stop.out.slice(0, 200));
  check("종료코드 0", stop.code === 0);

  const noArgs = run(["--start"], root);
  check("볼트 인자 자체가 없어도 종료코드 0", noArgs.code === 0);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\n세션 훅 회귀 테스트 통과 ✔");
