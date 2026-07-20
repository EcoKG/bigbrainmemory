#!/usr/bin/env node
// BigBrainMemory — SessionStart 훅 설치 스크립트 (opt-in).
//
// 왜 이 스크립트가 필요한가:
//   MCP 서버는 호스트(Claude Code)의 설정 파일을 건드릴 수 없다 — stdio 로 격리된
//   별개 프로세스이고, 프로토콜에 "설정을 바꿔달라" 는 메시지 타입 자체가 없다.
//   그래서 훅은 구조적으로 자동 생성이 불가능하며, 사용자가 명시적으로 실행하는
//   이 스크립트가 그 간극을 메운다.
//
// 왜 postinstall 이 아닌가:
//   전역 설정을 몰래 고치는 것은 나쁜 관행이다. Claude Code 를 쓰지 않는 사용자,
//   CI 환경에서도 실행되어 버린다. 반드시 사용자가 직접 부른다.
//
// 처리하는 함정 4가지:
//   1) OS 분기 — POSIX(sh) 와 Windows(PowerShell) 는 문법이 완전히 다르다.
//   2) 셸 변수 회피 — 명령 문자열에 `$` 를 쓰면 호스트 셸이 먼저 치환해 명령이 깨진다.
//      양쪽 명령 모두 변수를 쓰지 않는다.
//   3) 볼트 경로 주입 — BIGBRAIN_VAULT 를 지정한 사용자는 훅도 그 경로를 봐야 한다.
//      등록된 MCP 서버 설정에서 실제 경로를 읽어와 일치시킨다.
//   4) 기존 설정 병합 — 다른 훅을 쓰고 있을 수 있으므로 덮어쓰지 않고 항목만 더한다.
//
// 사용법:
//   npm run setup:hook                 설치(기본) — 백업 후 적용
//   npm run setup:hook -- --dry-run    무엇이 바뀌는지만 출력, 쓰지 않음
//   npm run setup:hook -- --remove     제거
//   npm run setup:hook -- --vault <경로>     볼트 경로 직접 지정
//   npm run setup:hook -- --settings <경로>  대상 settings.json 직접 지정
//                                            (예: 저장소의 .claude/settings.json)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

/** 우리 훅을 식별하는 표식 — 이 문자열로 기존 항목을 찾아 갱신/제거한다 */
const HOOK_MARKER = "<bigbrainmemory-index>";
/** Windows: 주입할 최대 줄 수 (컨텍스트 예산 안전장치) */
const MAX_LINES = 200;
/** POSIX: 주입할 최대 바이트 수 */
const MAX_BYTES = 8000;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// ── 인자 파싱
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const DRY_RUN = hasFlag("--dry-run");
const REMOVE = hasFlag("--remove");
const settingsPath = path.resolve(
  valueOf("--settings") ?? path.join(os.homedir(), ".claude", "settings.json"),
);

let failed = false;
const fail = (msg) => {
  console.error(`  ✘ ${msg}`);
  failed = true;
};

/**
 * 볼트 경로 결정 (함정 3).
 * 우선순위: --vault > 등록된 MCP 서버의 env > BIGBRAIN_VAULT > <저장소>/vault
 * 등록된 서버 설정을 보는 이유: 훅이 서버와 다른 볼트를 가리키면 조용히
 * 빈 인덱스를 주입하게 되고, 사용자는 원인을 알기 어렵다.
 */
function resolveVault() {
  const flag = valueOf("--vault");
  if (flag) return { dir: path.resolve(flag), source: "--vault 플래그" };

  try {
    const cj = path.join(os.homedir(), ".claude.json");
    if (fs.existsSync(cj)) {
      const parsed = JSON.parse(fs.readFileSync(cj, "utf-8"));
      const fromEnv = parsed?.mcpServers?.bigbrainmemory?.env?.BIGBRAIN_VAULT;
      if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        return { dir: path.resolve(fromEnv), source: "등록된 MCP 서버 설정(~/.claude.json)" };
      }
    }
  } catch {
    /* 등록 정보를 못 읽어도 다음 후보로 넘어간다 */
  }

  if (process.env.BIGBRAIN_VAULT?.trim()) {
    return { dir: path.resolve(process.env.BIGBRAIN_VAULT), source: "BIGBRAIN_VAULT 환경변수" };
  }
  return { dir: path.join(repoRoot, "vault"), source: "기본값(<저장소>/vault)" };
}

/**
 * OS별 훅 명령 생성 (함정 1·2).
 * 양쪽 모두 `$` 변수를 쓰지 않는다 — 호스트 셸이 먼저 치환해 버리는 사고를 막는다.
 * 경로는 forward slash 로 통일한다(PowerShell 도 Windows 에서 이를 받아들인다).
 */
function buildCommand(vaultDir) {
  const md = `${vaultDir.replace(/\\/g, "/")}/MEMORY.md`;
  if (process.platform === "win32") {
    return (
      `powershell.exe -NoProfile -Command "if (Test-Path '${md}') { ` +
      `'${HOOK_MARKER}'; Get-Content '${md}' -Encoding utf8 -TotalCount ${MAX_LINES}; ` +
      `'</bigbrainmemory-index>' }"`
    );
  }
  return (
    `if [ -f '${md}' ]; then echo '${HOOK_MARKER}'; ` +
    `head -c ${MAX_BYTES} '${md}'; echo '</bigbrainmemory-index>'; fi`
  );
}

function loadSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, "utf-8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw); // 깨진 JSON 은 여기서 던져 상위에서 안내한다
}

/** SessionStart 배열에서 우리 항목의 인덱스 (없으면 -1) */
function findOurs(list) {
  return list.findIndex((entry) =>
    (entry?.hooks ?? []).some(
      (h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER),
    ),
  );
}

function backup() {
  if (!fs.existsSync(settingsPath)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dest = `${settingsPath}.bak-bbm-${stamp}`;
  fs.copyFileSync(settingsPath, dest);
  return dest;
}

// ── 본체
console.log("BigBrainMemory — SessionStart 훅 설치\n");

const vault = resolveVault();
const command = buildCommand(vault.dir);

console.log(`플랫폼    : ${process.platform === "win32" ? "Windows (PowerShell)" : "POSIX (sh)"}`);
console.log(`설정 파일 : ${settingsPath}`);
console.log(`볼트 경로 : ${vault.dir}`);
console.log(`  └ 출처  : ${vault.source}`);
if (!fs.existsSync(vault.dir)) {
  console.log(`  ⚠ 아직 존재하지 않습니다 — 첫 기억을 저장하면 생성됩니다.`);
}
console.log("");

let settings;
try {
  settings = loadSettings();
} catch (err) {
  console.error(`설정 파일을 파싱할 수 없습니다: ${settingsPath}`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error("  JSON 문법을 고친 뒤 다시 실행하세요. 아무것도 변경하지 않았습니다.");
  process.exit(1);
}

const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
const list = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
const existingIdx = findOurs(list);
const otherHookCount = list.length - (existingIdx >= 0 ? 1 : 0);

if (REMOVE) {
  // ── 제거
  if (existingIdx < 0) {
    console.log("설치된 BigBrainMemory 훅이 없습니다. 변경할 것이 없습니다.");
    process.exit(0);
  }
  list.splice(existingIdx, 1);
  if (list.length === 0) delete hooks.SessionStart;
  else hooks.SessionStart = list;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;

  console.log("제거할 항목을 찾았습니다.");
  if (DRY_RUN) {
    console.log("\n--dry-run 이므로 아무것도 쓰지 않았습니다.");
    process.exit(0);
  }
  const bak = backup();
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.log(`백업      : ${bak}`);
  console.log("✔ 훅을 제거했습니다. Claude 를 재시작하면 반영됩니다.");
  process.exit(0);
}

// ── 설치 / 갱신
const entry = { hooks: [{ type: "command", command, timeout: 5 }] };
const action = existingIdx >= 0 ? "갱신" : "추가";
if (existingIdx >= 0) {
  const before = list[existingIdx]?.hooks?.[0]?.command;
  if (before === command) {
    console.log("이미 동일한 설정으로 설치돼 있습니다. 변경할 것이 없습니다.");
    console.log("(볼트 경로를 바꿨다면 --vault 로 지정해 다시 실행하세요.)");
    process.exit(0);
  }
  list[existingIdx] = entry; // 경로/OS 가 바뀐 경우 제자리 갱신 — 중복 생성 방지
} else {
  list.push(entry);
}
hooks.SessionStart = list;
settings.hooks = hooks;

console.log(`동작      : SessionStart 훅 ${action}`);
console.log(`보존      : 기존 SessionStart 항목 ${otherHookCount}개, 그 외 설정 전부 유지`);
console.log(`\n등록할 명령:\n  ${command}\n`);

if (DRY_RUN) {
  console.log("--dry-run 이므로 아무것도 쓰지 않았습니다.");
  process.exit(0);
}

// 실제 동작하는 명령인지 먼저 확인 — 못 도는 명령을 설정에 남기지 않는다
console.log("명령 자체 검증:");
try {
  const out = execSync(command, { encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  if (out.includes(HOOK_MARKER)) {
    console.log(`  ✔ 정상 실행 — ${out.split(/\r?\n/).filter(Boolean).length}줄 주입 예정`);
  } else if (!fs.existsSync(path.join(vault.dir, "MEMORY.md"))) {
    console.log("  ✔ 정상 실행 — MEMORY.md 가 아직 없어 출력이 비어 있습니다(정상)");
  } else {
    fail("실행은 됐으나 예상한 표식이 출력되지 않았습니다");
  }
} catch (err) {
  fail(`실행 실패: ${err instanceof Error ? err.message : String(err)}`);
}

if (failed) {
  console.error("\n검증에 실패해 설정을 변경하지 않았습니다.");
  process.exit(1);
}

const bak = backup();
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

// 쓰고 나서 다시 읽어 유효성 확인 — 깨진 설정을 남기면 Claude 가 뜨지 않는다
try {
  JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
} catch (err) {
  console.error(`\n치명적: 쓴 설정이 유효한 JSON 이 아닙니다 — ${err}`);
  if (bak) {
    fs.copyFileSync(bak, settingsPath);
    console.error(`백업에서 복구했습니다: ${bak}`);
  }
  process.exit(1);
}

console.log(`\n백업      : ${bak ?? "(기존 파일 없음 — 새로 생성)"}`);
console.log(`✔ 설치 완료: ${settingsPath}`);
console.log("\n다음 단계: Claude 를 재시작하면 매 세션 시작 시 MEMORY.md 가 주입됩니다.");
console.log("되돌리려면: npm run setup:hook -- --remove");
