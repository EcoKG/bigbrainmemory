#!/usr/bin/env node
// BigBrainMemory — 세션 훅 도우미. setup-hook.mjs 가 등록하는 두 훅의 실제 본체다.
//
//   --start : 세션 시작 시점의 기억 수를 마커에 기록하고, MEMORY.md 를 컨텍스트에 주입한다.
//   --stop  : 세션 동안 새로 저장된 기억이 0건이면 경고한다.
//
// 왜 셸 one-liner 가 아니라 Node 스크립트인가:
//   Stop 훅은 "세션 시작 시점과 지금을 비교" 하는 상태 비교가 필요하다. 이를 Windows
//   PowerShell 과 POSIX sh 양쪽에서 안전하게 쓰려면 문법이 갈리고, 따옴표·변수 치환
//   사고가 나기 쉽다(실제로 `$` 변수를 쓴 첫 시도가 호스트 셸 치환으로 깨졌다).
//   Node 는 이미 이 서버의 필수 의존성이므로, 로직을 한 곳에 두고 훅은 이 파일을
//   호출만 하게 한다 — OS 분기도, 셸 이스케이프도 구조적으로 사라진다.
//
// 원칙: **어떤 경우에도 세션을 방해하지 않는다.** 실패하면 조용히 종료하고,
//       종료 코드는 항상 0 이다(Stop 훅이 0 이 아니면 세션 종료를 막을 수 있다).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 세션 시작 시점의 기억 수를 담는 마커 (볼트 루트, 점 파일이라 Obsidian 에서 숨겨진다) */
const MARKER = ".bbm-session-start";
/** 주입할 MEMORY.md 최대 줄 수 — 볼트가 커져도 컨텍스트 예산을 넘지 않게 하는 안전장치 */
const MAX_LINES = 200;
/**
 * 이 줄 수보다 짧은 트랜스크립트에서는 무저장 경고를 띄우지 않는다.
 * Stop 은 **매 턴** 발화하므로, 첫 턴부터 "저장할 게 없느냐" 고 묻는 건 소음이다.
 * 한두 마디 묻고 끝나는 대화에는 애초에 남길 durable 한 사실이 없다.
 */
const MIN_TRANSCRIPT_LINES = (() => {
  const v = Number(process.env.BIGBRAIN_STOP_MIN_LINES);
  return Number.isFinite(v) && v >= 0 ? v : 25;
})();
/** 훅 입력(stdin) 을 기다리는 한계 시간 — 넘기면 없는 셈 치고 진행한다(행 방지) */
const STDIN_TIMEOUT_MS = 250;

const argv = process.argv.slice(2);
const mode = argv.includes("--stop") ? "stop" : "start";
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
/** 자동탐지가 실패했을 때만 쓰는 폴백 (설치 시점 자동 감지값) */
const vaultArg = argValue("--vault");
/** 사용자가 설치 시 명시한 경로 — 자동탐지보다 우선한다 */
const vaultForced = argValue("--vault-force");

/** JSON 파일을 조용히 읽는다 (없거나 깨졌으면 null) */
function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** mcpServers 맵에서 bigbrain 계열 서버의 BIGBRAIN_VAULT 를 찾는다 */
function vaultFromServers(servers) {
  if (!servers || typeof servers !== "object") return null;
  for (const [name, cfg] of Object.entries(servers)) {
    if (!/bigbrain/i.test(name)) continue;
    const v = cfg?.env?.BIGBRAIN_VAULT;
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/** mcpServers 맵에서 bigbrain 계열 서버의 **등록 키 이름** 을 찾는다 */
function serverNameFromServers(servers) {
  if (!servers || typeof servers !== "object") return null;
  for (const name of Object.keys(servers)) if (/bigbrain/i.test(name)) return name;
  return null;
}

/**
 * 주입문에 박을 MCP 도구 이름의 서버 키를 해석한다 (`mcp__<서버키>__remember`).
 *
 * 왜 이름을 박아야 하는가:
 *   클라이언트가 MCP 도구를 **지연 로드(deferred)** 하면 스키마가 컨텍스트에 없어서,
 *   모델은 도구를 "쓸지 말지" 판단하기 전에 먼저 이름으로 지목해 불러와야 한다.
 *   "기억하세요" 라고만 쓰면 무엇을 로드해야 하는지 알 수 없다. 관측된 콜드 스타트
 *   실패에서 모델은 저장을 판단하고 안 한 게 아니라 **도구 탐색 자체를 하지 않았다.**
 *   등록 키는 사용자마다 다를 수 있으므로 설정에서 실제 값을 찾아 쓴다.
 */
function resolveServerName() {
  const cwd = process.cwd();
  const fromProject = serverNameFromServers(readJson(path.join(cwd, ".mcp.json"))?.mcpServers);
  if (fromProject) return fromProject;
  const userCfg = readJson(path.join(os.homedir(), ".claude.json"));
  return (
    serverNameFromServers(userCfg?.projects?.[cwd]?.mcpServers) ??
    serverNameFromServers(userCfg?.mcpServers) ??
    "bigbrainmemory"
  );
}

/**
 * **실행 시점**에 볼트를 해석한다 — 이것이 이 스크립트의 핵심이다.
 *
 * 설치 시점 경로를 훅에 박아두면, 프로젝트마다 BIGBRAIN_VAULT 로 볼트를 나누는
 * 순간 훅만 옛 볼트를 계속 바라본다. 그러면 한 세션 안에서
 *   훅  : "볼트에 이런 기억들이 있다" (볼트 B 내용)
 *   서버: "COLD START — this vault is EMPTY" (볼트 A 기준)
 * 라는 **정면으로 모순된 두 신호**가 동시에 주입된다. 모델은 인덱스에 내용이
 * 보이면 "메모리는 이미 잘 돌고 있다" 고 판단해 저장을 건너뛰기 쉽다.
 * 실제로 그 분열이 관측됐다(훅은 실제 볼트 3건, 서버는 빈 테스트 볼트).
 *
 * 그래서 서버와 **같은 근거**를 같은 우선순위로 다시 읽는다.
 * 훅은 프로젝트 디렉터리에서 실행되므로 cwd 가 기준점이다.
 */
function resolveVault(fallback, forced) {
  const cwd = process.cwd();

  // 사용자가 설치 시 --vault 로 **명시**했다면 그 의도가 자동탐지를 이긴다
  if (forced) return { dir: path.resolve(forced), source: "설치 시 명시(--vault)" };

  if (process.env.BIGBRAIN_VAULT?.trim()) {
    return { dir: path.resolve(process.env.BIGBRAIN_VAULT), source: "BIGBRAIN_VAULT 환경변수" };
  }
  // 프로젝트 스코프가 사용자 전역보다 우선한다
  const fromProject = vaultFromServers(readJson(path.join(cwd, ".mcp.json"))?.mcpServers);
  if (fromProject) return { dir: path.resolve(cwd, fromProject), source: "프로젝트 .mcp.json" };

  const userCfg = readJson(path.join(os.homedir(), ".claude.json"));
  const fromUserProject = vaultFromServers(userCfg?.projects?.[cwd]?.mcpServers);
  if (fromUserProject) {
    return { dir: path.resolve(fromUserProject), source: "~/.claude.json (이 프로젝트)" };
  }
  const fromUserGlobal = vaultFromServers(userCfg?.mcpServers);
  if (fromUserGlobal) return { dir: path.resolve(fromUserGlobal), source: "~/.claude.json (전역)" };

  if (fallback) return { dir: path.resolve(fallback), source: "설치 시점 기본값" };
  return null;
}

const resolved = resolveVault(vaultArg, vaultForced);
// 어디서도 볼트를 못 찾으면 침묵 종료 — 설정이 어긋났다고 세션을 시끄럽게 만들지 않는다
if (!resolved) process.exit(0);

const vaultDir = resolved.dir;
const memoriesDir = path.join(vaultDir, "memories");
const markerPath = path.join(vaultDir, MARKER);

/** 활성 기억 파일 수. 볼트가 아직 없으면 0 */
function countMemories() {
  try {
    return fs.readdirSync(memoriesDir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * 훅 입력 JSON 을 stdin 에서 읽는다 — `session_id`, `source`, `transcript_path` 가 온다.
 *
 * **절대 멈추면 안 된다.** stdin 이 닫히지 않는 파이프로 상속될 수 있고, Stop 훅은 매 턴
 * 실행되므로 한 번의 지연이 대화 전체에 곱해진다. 그래서 타임아웃을 두고, 넘으면
 * 입력이 없는 셈 치고 진행한다(그 경우 종전 동작으로 자연히 퇴화한다).
 */
async function readHookInput() {
  const empty = { sessionId: null, source: null, transcriptPath: null };
  if (process.stdin.isTTY) return empty;
  const raw = await new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.pause();
      } catch {
        /* 무시 */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(buf), STDIN_TIMEOUT_MS);
    try {
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => done(buf));
      process.stdin.on("error", () => done(""));
    } catch {
      done("");
    }
  });
  try {
    const o = JSON.parse(raw);
    return {
      sessionId: typeof o?.session_id === "string" ? o.session_id : null,
      source: typeof o?.source === "string" ? o.source : null,
      transcriptPath: typeof o?.transcript_path === "string" ? o.transcript_path : null,
    };
  } catch {
    return empty;
  }
}

/**
 * 마커 읽기. 신형은 JSON, 구형은 숫자 하나 — 둘 다 받는다.
 * (구형 마커를 남긴 채 업그레이드해도 경고가 깨지지 않아야 한다)
 */
function readMarker() {
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf-8").replace(/^﻿/, "").trim();
  } catch {
    return null;
  }
  if (raw === "") return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      return {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : null,
        count: Number.isFinite(o.count) ? o.count : Number.NaN,
        warned: o.warned === true,
      };
    }
  } catch {
    /* 구형 포맷 — 아래에서 숫자로 해석 */
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? { sessionId: null, count: n, warned: false } : null;
}

function writeMarker(m) {
  try {
    fs.writeFileSync(markerPath, JSON.stringify(m), "utf-8");
  } catch {
    /* 볼트 미생성 등 — 무시 */
  }
}

const hookInput = await readHookInput();

if (mode === "start") {
  const count = countMemories();

  // 1) 비교 기준 기록.
  //
  // **매번 덮어쓰면 안 된다.** SessionStart 는 세션당 한 번이 아니라 startup/resume/
  // clear/compact 네 경우에 각각 발화한다. 종전처럼 무조건 현재 건수를 써버리면,
  // 세션 중간에 컨텍스트가 압축될 때 기준선이 "그때까지 저장한 만큼" 으로 리셋되고,
  // 그 전에 성실히 저장한 기억이 통째로 없던 일이 된다 → 종료 시 오탐 경고.
  // 재현: startup(0) → 2건 저장 → compact(기준선 2) → 종료 시 "0건" 경고.
  // 그래서 session_id 가 같으면 기존 기준선을 **보존**한다.
  const prev = readMarker();
  const sameSession =
    hookInput.sessionId && prev?.sessionId
      ? hookInput.sessionId === prev.sessionId
      : // session_id 를 못 받았을 때의 차선책 — 재개/압축은 이어지는 세션으로 본다
        !!prev && (hookInput.source === "resume" || hookInput.source === "compact");
  if (!sameSession) writeMarker({ sessionId: hookInput.sessionId, count, warned: false });

  // 볼트 디렉터리 자체가 없으면 침묵한다. 이건 콜드 스타트가 아니라 **설정이 어긋난**
  // 상태이고(경로 오타, 아직 이 프로젝트에 붙이지 않음), 그걸 매 세션 떠들면 노이즈다.
  if (!fs.existsSync(vaultDir)) process.exit(0);

  const attrs = `vault="${vaultDir.replace(/\\/g, "/")}" memories="${count}"`;
  // 지연 로드된 도구는 정확한 이름으로만 불러올 수 있다 — 이름을 그대로 노출한다.
  const tool = (n) => `mcp__${resolveServerName()}__${n}`;
  const toolLines =
    `Load these by name when you need them (they may be lazily loaded and thus invisible until asked for):\n` +
    `  ${tool("recall")}   — search memory before answering from assumption\n` +
    `  ${tool("remember")} — store a durable fact, decision, preference, or lesson\n`;

  // 2) 볼트 상태 주입 (회상 트리거 채널 ②).
  //
  // 콜드 스타트에도 **반드시** 주입한다. 예전에는 MEMORY.md 본문이 비면 침묵했는데,
  // 그 침묵이 자기강화 루프를 만들었다: 볼트가 비어 있음 → 주입할 인덱스가 없음 →
  // 모델이 메모리의 존재를 인지 못 함 → 저장 0건 → 다음 세션도 비어 있음.
  // 대조 실험에서 이 루프가 실증됐다. 서버 instructions 의 COLD START 문구는 두 세션
  // 모두 온전히(1842자, 무절단) 도착했는데도 행동을 만들지 못했고, 갈린 변수는
  // **훅이 컨텍스트에 무언가를 넣었는가** 하나뿐이었다. 즉 instructions 만으로는
  // 부족하고 이 주입이 실제 트리거다.
  if (count === 0) {
    process.stdout.write(
      `<bigbrainmemory-index ${attrs}>\n` +
        `COLD START — this vault holds 0 memories. That is expected on a fresh vault and is NOT ` +
        `evidence that memory is unneeded; it means seeding the vault is part of this session's job.\n` +
        toolLines +
        `Call remember the moment a trigger fires — a decision settles, the user states a preference ` +
        `or corrects you, you find a non-obvious root cause — not at the end of the session.\n` +
        `</bigbrainmemory-index>\n`,
    );
    process.exit(0);
  }

  let body = "";
  try {
    // BOM 제거 — 주입되는 컨텍스트 첫머리에 보이지 않는 문자가 섞이지 않게 한다
    const md = fs.readFileSync(path.join(vaultDir, "MEMORY.md"), "utf-8").replace(/^﻿/, "");
    body = md.split(/\r?\n/).slice(0, MAX_LINES).join("\n").trimEnd();
  } catch {
    /* 인덱스 파일이 없거나 못 읽음 — 아래에서 건수만으로 대체한다 */
  }
  // 기억이 있는데 인덱스를 못 읽었다면 침묵이 아니라 건수라도 알린다.
  // 여기서 침묵하면 "기억이 있는 볼트" 가 "빈 볼트" 와 구분되지 않는다.
  if (body === "") body = `(index unavailable — ${count} memories are stored; use recall to reach them)`;

  // 출처(볼트 경로·건수)를 함께 밝힌다 — 서버가 다른 볼트를 보고 있으면
  // "인덱스엔 기억이 있는데 서버는 EMPTY" 라는 모순이 눈에 보여야 한다.
  // 밝히지 않으면 모델은 인덱스만 보고 "메모리가 잘 돌고 있다" 고 오판한다.
  process.stdout.write(
    `<bigbrainmemory-index ${attrs}>\n${body}\n</bigbrainmemory-index>\n` +
      toolLines +
      `(This index was injected by a SessionStart hook reading the vault above. ` +
      `If the bigbrainmemory server reports a different vault or says the vault is EMPTY, ` +
      `the two are pointing at different paths — trust the server's tools, and tell the user about the mismatch.)\n`,
  );
  process.exit(0);
}

// ── stop: 무저장 세션 감지
//
// 왜 "파일 수 증가" 로 판정하는가:
//   mtime 비교(-newer)를 쓰면 recall 의 강화 쓰기까지 "저장됨" 으로 잡혀,
//   정작 잡아야 할 무저장 세션이 조용히 통과한다(거짓 음성).
//   remember 로 새 노트가 생겼는지만 보는 편이 목적에 정확하다.
const m = readMarker();

// 비교 기준이 없으면 침묵한다 — 근거 없는 경고는 노이즈일 뿐이다
if (!m || !Number.isFinite(m.count)) process.exit(0);

// 마커를 남긴 세션과 지금 끝나는 세션이 다르면 비교가 성립하지 않는다.
// (여러 세션이 한 볼트를 공유하면 마커는 마지막 SessionStart 것이다)
if (hookInput.sessionId && m.sessionId && hookInput.sessionId !== m.sessionId) process.exit(0);

if (countMemories() > m.count) process.exit(0); // 저장됐다 — 조용히 통과

// **Stop 은 세션 끝이 아니라 매 턴 발화한다.** 그대로 두면 저장 전까지 모든 응답마다
// 같은 경고가 반복돼, 정작 봐야 할 신호가 소음에 묻힌다(경보 피로).
// 그래서 세션당 한 번만 알린다.
if (m.warned) process.exit(0);

// 짧은 대화에는 애초에 남길 durable 한 사실이 없다 — 트랜스크립트가 자랄 때까지 기다린다.
// 길이를 못 재면 종전대로 알린다(모른다고 침묵하면 안전망이 사라진다).
if (hookInput.transcriptPath && MIN_TRANSCRIPT_LINES > 0) {
  try {
    const lines = fs
      .readFileSync(hookInput.transcriptPath, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "").length;
    if (lines < MIN_TRANSCRIPT_LINES) process.exit(0);
  } catch {
    /* 못 읽음 — 게이트를 통과시킨다 */
  }
}

writeMarker({ ...m, warned: true });
process.stdout.write(
  `BigBrainMemory: 이 세션에서 새로 저장된 기억이 없습니다 (볼트 ${m.count}건 그대로).\n` +
    `지속될 사실·결정·선호·교훈을 배웠다면 지금 \`remember\` 로 남기세요. ` +
    `이번 대화에서만 쓸 내용이었다면 무시해도 됩니다. (이 알림은 세션당 한 번만 나옵니다)\n`,
);
process.exit(0); // 경고일 뿐 — 세션 종료를 막지 않는다
