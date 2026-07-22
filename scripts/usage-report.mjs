#!/usr/bin/env node
// 사용 계측 리포트 (T33) — .bbm-usage.jsonl 을 A/B 에 쓸 수 있는 지표로 집계한다.
//
// 왜 필요한가: 실사용 기저선을 재려고 트랜스크립트 1,492개를 전수 grep 해야 했다.
// 저장소 안에 저장률도 회상률도 재는 수단이 없었기 때문이다. 이 스크립트가 그 수단이다.
//
// 사용법:
//   node scripts/usage-report.mjs                    # 기본 볼트
//   node scripts/usage-report.mjs --vault <경로>
//   node scripts/usage-report.mjs --since 2026-07-01 # 기간 한정
//   node scripts/usage-report.mjs --json             # 기계 판독용
//
// ★ 천장효과 주의: 훅 ON 조건의 저장률은 실측 29/30(97%)이다. 그 조건에서
//   "세션당 저장>0" 을 A/B 1차 지표로 쓰면 팔당 30회로는 어떤 개선도 탐지할 수 없다.
//   1차 지표는 아래 `저장까지_걸린_턴` 같은 연속량을 쓰거나 양팔 훅 OFF 로 고정할 것.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const VAULT = arg("--vault", process.env.BIGBRAIN_VAULT || path.join(repo, "vault"));
const SINCE = arg("--since", null);
const AS_JSON = process.argv.includes("--json");

const logPath = path.join(VAULT, ".bbm-usage.jsonl");
let lines = [];
try {
  lines = fs.readFileSync(logPath, "utf-8").split("\n");
} catch {
  console.error(`사용 로그가 없습니다: ${logPath}`);
  console.error("아직 아무것도 기록되지 않았거나 BIGBRAIN_USAGE_LOG=0 으로 꺼져 있습니다.");
  process.exit(1);
}

const events = [];
let malformed = 0;
for (const line of lines) {
  if (line.trim() === "") continue;
  try {
    const e = JSON.parse(line);
    if (SINCE && typeof e.ts === "string" && e.ts < SINCE) continue;
    events.push(e);
  } catch {
    malformed++; // 동시 append 로 찢긴 줄 — 버리고 수를 보고한다(조용히 삼키지 않는다)
  }
}

// ── 세션 단위 (훅이 기록) — 저장률의 분모는 세션이다
const starts = events.filter((e) => e.event === "session_start");
// 한 세션이 session_end 를 두 번 남길 수 있다: 먼저 "저장 0" 으로 경고하고, 그 경고를 보고
// 저장하면 "저장 n" 을 한 번 더 남긴다. **최종 결과는 최대값이다** — 먼저 온 기록을 쓰면
// 경고가 유도한 저장이 통계에서 사라져, 우리가 재려는 개선을 지표가 못 잡는다.
const endBySession = new Map();
for (const e of events) {
  if (e.event !== "session_end") continue;
  const key = e.sessionId ?? `anon-${endBySession.size}`;
  const prev = endBySession.get(key);
  if (!prev || (e.stored ?? 0) > (prev.stored ?? 0)) endBySession.set(key, e);
}
const ends = [...endBySession.values()];
const workSessions = ends.filter((e) => !e.belowGate);
const storedSessions = workSessions.filter((e) => (e.stored ?? 0) > 0);
// 경고를 받고 나서 저장한 세션 — Stop 훅 넛지가 실제로 작동했는지의 직접 지표다
const storedAfterWarning = storedSessions.filter((e) => e.warned === true);
const lossEvents = starts.filter((e) => (e.lost ?? 0) > 0);

// ── 도구 단위 (서버가 기록)
const byTool = {};
for (const e of events) {
  if (!e.tool) continue;
  byTool[e.tool] = byTool[e.tool] ?? { calls: 0, failed: 0 };
  byTool[e.tool].calls++;
  if (e.ok === false) byTool[e.tool].failed++;
}
const recalls = events.filter((e) => e.tool === "recall");
const zeroHits = recalls.filter((e) => e.zeroHit);
const remembers = events.filter((e) => e.tool === "remember");
const withDangling = remembers.filter((e) => (e.danglingCount ?? 0) > 0);
const withSimilar = remembers.filter((e) => (e.similarCount ?? 0) > 0);

const pct = (n, d) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

const report = {
  vault: VAULT,
  window: { since: SINCE, events: events.length, malformedLines: malformed },
  sessions: {
    started: starts.length,
    ended: ends.length,
    belowToolGate: ends.length - workSessions.length,
    workSessions: workSessions.length,
    // ★ A/B 1차 지표 후보 (단, 천장효과 주의 — 파일 머리 참고)
    storedAtLeastOne: storedSessions.length,
    storeRate: pct(storedSessions.length, workSessions.length),
    // Stop 훅 넛지가 실제로 저장을 유도했는가 (T31 이 전달 경로를 고친 뒤의 효과 측정)
    storedAfterWarning: storedAfterWarning.length,
    memoryLossEvents: lossEvents.length,
  },
  tools: byTool,
  recall: {
    calls: recalls.length,
    zeroHit: zeroHits.length,
    zeroHitRate: pct(zeroHits.length, recalls.length),
    // 회상이 "실패" 한 것과 "아예 안 불린" 것은 완전히 다른 문제다 — 분리해서 본다
    sessionsWithAnyRecall: new Set(recalls.map((e) => e.pid)).size,
  },
  remember: {
    calls: remembers.length,
    withSimilarWarning: withSimilar.length,
    withBrokenLinks: withDangling.length,
  },
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`볼트: ${VAULT}`);
console.log(`이벤트 ${events.length}건${SINCE ? ` (${SINCE} 이후)` : ""}${malformed > 0 ? ` · 손상 줄 ${malformed}건 무시` : ""}`);
console.log("");
console.log("── 세션 (훅 기록)");
console.log(`  시작 ${starts.length} · 종료 ${ends.length} · 게이트 미만(잡담) ${report.sessions.belowToolGate}`);
console.log(`  작업 세션 ${workSessions.length} 중 저장 있음 ${storedSessions.length}  →  저장률 ${report.sessions.storeRate}`);
if (storedAfterWarning.length > 0) console.log(`  그중 Stop 훅 경고를 받고 나서 저장한 세션 ${storedAfterWarning.length}건`);
if (lossEvents.length > 0) console.log(`  ⚠ 볼트 손실 감지 ${lossEvents.length}회 — 총 ${lossEvents.reduce((s, e) => s + e.lost, 0)}건 소실`);
console.log("");
console.log("── 도구 호출");
if (Object.keys(byTool).length === 0) {
  console.log("  (도구 호출 기록 없음 — 서버가 한 번도 도구를 처리하지 않았습니다)");
} else {
  for (const [t, v] of Object.entries(byTool).sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`  ${t.padEnd(15)} ${String(v.calls).padStart(5)}회${v.failed > 0 ? `  (실패 ${v.failed})` : ""}`);
  }
}
console.log("");
console.log("── 회상 품질");
console.log(`  recall ${recalls.length}회 중 0건 ${zeroHits.length}  →  0건 비율 ${report.recall.zeroHitRate}`);
console.log(`  recall 이 한 번이라도 불린 서버 프로세스 ${report.recall.sessionsWithAnyRecall}개`);
console.log("");
console.log("── 저장 품질");
console.log(`  remember ${remembers.length}회 · 유사 경고 동반 ${withSimilar.length} · 깨진 링크 동반 ${withDangling.length}`);
console.log("");
if (workSessions.length > 0 && storedSessions.length === 0) {
  console.log("진단: 작업 세션이 있는데 저장이 0건입니다 — 부호화가 일어나지 않고 있습니다.");
} else if (recalls.length === 0 && remembers.length > 0) {
  console.log("진단: 저장은 되는데 회상이 0건입니다 — 주입이 회상을 유발하지 못하거나 대체하고 있습니다.");
}
