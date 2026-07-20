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
import path from "node:path";

/** 세션 시작 시점의 기억 수를 담는 마커 (볼트 루트, 점 파일이라 Obsidian 에서 숨겨진다) */
const MARKER = ".bbm-session-start";
/** 주입할 MEMORY.md 최대 줄 수 — 볼트가 커져도 컨텍스트 예산을 넘지 않게 하는 안전장치 */
const MAX_LINES = 200;

const argv = process.argv.slice(2);
const mode = argv.includes("--stop") ? "stop" : "start";
const vaultFlagIdx = argv.indexOf("--vault");
const vaultArg = vaultFlagIdx >= 0 ? argv[vaultFlagIdx + 1] : undefined;

// 경로가 없으면 침묵 종료 — 설정이 어긋났다고 세션을 시끄럽게 만들지 않는다
if (!vaultArg) process.exit(0);

const vaultDir = path.resolve(vaultArg);
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

if (mode === "start") {
  // 1) 비교 기준 기록. 볼트가 아직 없으면 쓸 수 없으므로 조용히 넘어간다.
  try {
    fs.writeFileSync(markerPath, String(countMemories()), "utf-8");
  } catch {
    /* 볼트 미생성 등 — 무시 */
  }

  // 2) MEMORY.md 주입 (회상 트리거 채널 ②). 아직 없으면 아무것도 내보내지 않는다.
  try {
    // BOM 제거 — 주입되는 컨텍스트 첫머리에 보이지 않는 문자가 섞이지 않게 한다
    const md = fs.readFileSync(path.join(vaultDir, "MEMORY.md"), "utf-8").replace(/^﻿/, "");
    const body = md.split(/\r?\n/).slice(0, MAX_LINES).join("\n").trimEnd();
    if (body !== "") {
      process.stdout.write(`<bigbrainmemory-index>\n${body}\n</bigbrainmemory-index>\n`);
    }
  } catch {
    /* MEMORY.md 없음 — 콜드 스타트. 서버 instructions 가 그 상황을 따로 안내한다 */
  }
  process.exit(0);
}

// ── stop: 무저장 세션 감지
//
// 왜 "파일 수 증가" 로 판정하는가:
//   mtime 비교(-newer)를 쓰면 recall 의 강화 쓰기까지 "저장됨" 으로 잡혀,
//   정작 잡아야 할 무저장 세션이 조용히 통과한다(거짓 음성).
//   remember 로 새 노트가 생겼는지만 보는 편이 목적에 정확하다.
let before = Number.NaN;
try {
  before = Number.parseInt(fs.readFileSync(markerPath, "utf-8").trim(), 10);
} catch {
  /* 마커 없음 — SessionStart 훅이 안 걸렸거나 볼트가 없다 */
}

// 비교 기준이 없으면 침묵한다 — 근거 없는 경고는 노이즈일 뿐이다
if (!Number.isFinite(before)) process.exit(0);

const after = countMemories();
if (after > before) process.exit(0); // 저장됐다 — 조용히 통과

process.stdout.write(
  `BigBrainMemory: 이 세션에서 새로 저장된 기억이 0건입니다 (${before}건 그대로).\n` +
    `지속될 사실·결정·선호·교훈을 배웠다면 지금 \`remember\` 로 남기세요. ` +
    `이번 대화에서만 쓸 내용이었다면 무시해도 됩니다.\n`,
);
process.exit(0); // 경고일 뿐 — 세션 종료를 막지 않는다
