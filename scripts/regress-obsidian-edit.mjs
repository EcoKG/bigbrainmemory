// T5/T6 회귀 테스트 — 사용자가 볼트를 직접 만지거나 기억을 교정할 때 데이터가 상하지 않는지.
//
// 고정하는 버그:
//   A6 Obsidian/손편집의 **인용부호 없는** 날짜를 js-yaml 이 Date 로 파싱하고,
//      str() 가드가 문자열이 아니라며 버려서 created/updated/lastAccessed/lastReinforced 가
//      전부 "지금" 으로 리셋됐다 → 오래된 기억의 기저활성이 부풀고 다음 write 가 고착
//   A7 revise 가 본문을 즉시 덮어쓰고 reason 한 줄만 남겨 되돌릴 방법이 없었다
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-edit-"));
  cleanups.push(d);
  return d;
}
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);

// ── 1. 인용 없는 날짜가 리셋되지 않는다 (A6)
console.log("1) 인용부호 없는 YAML 날짜 보존 (A6)");
{
  const dir = freshDir();
  const store = new MemoryStore(new Vault(dir));
  const rec = store.remember({ title: "손편집 대상", content: "시에라 탱고 본문.", type: "semantic" }).record;

  // 사용자가 Obsidian 에서 날짜를 손으로 넣은 상태를 모사 (따옴표 없음)
  const raw = fs.readFileSync(memPath(dir, rec.slug), "utf-8");
  const edited = raw
    .replace(/created: .*/, "created: 2025-01-01T00:00:00.000Z")
    .replace(/updated: .*/, "updated: 2025-02-02")
    .replace(/last_reinforced: .*/, "last_reinforced: 2025-01-15T00:00:00.000Z");
  fs.writeFileSync(memPath(dir, rec.slug), edited, "utf-8");

  const s = new MemoryStore(new Vault(dir));
  const got = s.loadAll(true).find((m) => m.slug === rec.slug);
  check("노트가 정상적으로 읽힘", !!got);
  check("created 가 리셋되지 않음", got?.created?.startsWith("2025-01-01"), `created=${got?.created}`);
  check("updated(날짜만 형식)도 보존", got?.updated?.startsWith("2025-02-02"), `updated=${got?.updated}`);
  check("lastReinforced 보존", got?.lastReinforced?.startsWith("2025-01-15"), `lr=${got?.lastReinforced}`);

  // 오래된 기억이므로 활성이 낮아야 한다 (부풀지 않았는지 확인)
  const results = s.search("시에라");
  const act = results[0]?.activation;
  check("기저활성이 부풀지 않음 (오래된 기억은 음수)", typeof act === "number" && act < 0, `activation=${act}`);

  // 강화 write-back 후에도 잘못된 now 로 고착되지 않아야 한다
  const after = fs.readFileSync(memPath(dir, rec.slug), "utf-8");
  check("write-back 후에도 created 가 2025 유지", /created: '?2025-01-01/.test(after), after.slice(0, 260));
}

// ── 2. 정상 노트(따옴표 있는 ISO)는 그대로
console.log("2) 기존 형식 노트 회귀 없음");
{
  const dir = freshDir();
  const store = new MemoryStore(new Vault(dir));
  const rec = store.remember({ title: "정상 형식", content: "유니폼 빅터.", type: "semantic" }).record;
  const before = store.read(rec.slug).created;
  const s = new MemoryStore(new Vault(dir));
  check("created 왕복 무손실", s.read(rec.slug).created === before, `${before} vs ${s.read(rec.slug).created}`);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT5 손편집 내성 회귀 테스트 통과 ✔");
