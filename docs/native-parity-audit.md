# BigBrainMemory 교차검증 감사 — 네이티브 메모리 대체를 위한 결함 목록과 로드맵

감사일: 2026-07-18
방법: 다중 에이전트 적대적 교차검증 (Claude Code Workflow, 총 100 에이전트)

- **발굴**: 6개 차원 병렬 — ① 선행 주장 재검증 ② 정합성/견고성 ③ 동시성/운영 ④ 설계원칙(P1~P8) 충실도 ⑤ 검색 품질 ⑥ 네이티브 패리티 → **47건 발굴**
- **검증**: 발견마다 2개 렌즈(정적 분석 회의론자 / 동적 재현 회의론자)가 독립 반증 시도. 의견 분열 시 tiebreaker 예정이었으나 **47건 전건에서 두 렌즈 판정 일치 — 기각 0건, tiebreak 0회**
- 단, 검증자들이 다수 항목에서 **과장 정정·조건 한정**을 붙였고 본 문서에 전부 반영했다
- 재현: 라이브 볼트는 읽기 전용으로 보호. 모든 실험은 임시 볼트에 `dist/` 모듈을 직접 import 하여 수행. 수치 주장은 node 재계산으로 검산
- 관련 문서: [memory-model-report.md](memory-model-report.md) (설계 원칙 P1~P8)

---

## ⚠ 상태 갱신 (2026-07-21) — 이 문서의 33건은 전부 종결됐다

**A1~A8 · B · C1~C6 · D1~D7 · E1~E6 · F1~F4 전건 FIXED. OPEN/PARTIAL 0건.**
로드맵 H절 21개 작업도 전부 완료 또는 근거 있는 기각(19번 로컬 임베딩 = T22 에서 비용/이익 분석 후 기각).
각 항목의 수정 위치와 이를 고정하는 회귀 단언은 [GOAL.md](../GOAL.md) 진행 로그를 참조할 것.

**따라서 이 문서의 A~F 절은 이제 "현재 결함 목록" 이 아니라 이력이다.** 재조사할 때
여기 있는 항목을 다시 결함으로 올리지 말 것 — 아래 §N 이 현행 목록이다.

이 감사가 놓친 것은 결함 자체가 아니라 **범위**였다. 감사는 "볼트가 이미 BBM 볼트일 때"
를 전제로 데이터 안전·검색·패리티를 훑었고, **대체로 넘어가는 전환 경로 자체**는
검사하지 않았다. 그 경로에서 새 결함 5건이 나왔다(§N).

### N. 대체 전환 경로 결함 (2026-07-21 조사)

조사 방법: 실제 네이티브 코퍼스(이 머신 10개 프로젝트 · 노트 23건) 계약 확정 →
사용자가 취할 마이그레이션 경로를 임시 디렉터리에 복제해 실행 → 결과 관측.

| # | 결함 | 심각도 | 상태 |
|---|---|---|---|
| N1 | 네이티브 memory 디렉터리를 볼트로 지정하면 **인덱스를 파괴하고 2회차부터 침묵**한다 | **critical** | ✅ FIXED |
| N2 | 주 채널(훅 주입)에 나이·검증 지시가 없다 — recall 응답에만 있는 비대칭 | high | ✅ FIXED |
| N3 | 이관 시 사람이 읽는 제목이 슬러그로 퇴화한다 | medium | ✅ FIXED |
| N4 | 이관된 `project` 스코프가 경로 슬러그 그대로다 | medium | ✅ FIXED |
| N5 | 대체의 주 채널이 Claude Code 전용이다 | medium | 한계로 수용 (T30) |

#### N1. 네이티브 디렉터리 오지정이 파괴적이고 자기침묵한다 ★critical — FIXED

"내장 메모리를 대체한다" 는 목표에서 사용자가 **가장 자연스럽게 취하는 행동**이
`BIGBRAIN_VAULT` 를 네이티브 memory 디렉터리로 지정하는 것이다. 그 경로가 파괴적이었다.

임시 디렉터리에 네이티브 레이아웃을 복제해 서버를 3회 기동한 실측:

```
1회차: instructions 경고=있음  stderr 경고=있음  마커=생성됨
2회차: instructions 경고=**없음**  stderr 경고=**없음**
3회차: instructions 경고=**없음**  stderr 경고=**없음**

네이티브 기억 파일: 그대로 있음 (단 서버에는 0건으로 보임)
네이티브 인덱스 제목: **파괴됨**
```

네 겹으로 나빴다:
1. 네이티브는 평면 구조(`<memory>/*.md`)인데 BBM 은 `memories/` 만 보므로 **기억이 0건으로 보인다**.
2. `regenerateIndex()` 가 `MEMORY.md` 를 자기 형식으로 **덮어쓴다** — 하필 그 파일이
   네이티브가 매 세션 자동 주입하는 **인덱스 본체**다. 즉 대체하려다 대체 대상의 핵심 기능을 없앤다.
3. 경고 문구가 "경로 오타/드라이브 이동 의심" 이라 **오진**이다. 경로는 정확하고, 형식이 다를 뿐이다.
4. 1회차에 `.bigbrain-vault` 마커가 박히고 `computeVaultWarning()` 이 `hasMarker` 에서
   조기 반환하므로 **2회차부터 완전히 침묵**한다. 사고가 사고를 은폐한다.

이 저장소의 개발 머신에서 실제로 발생했다 — 2026-07-20,
`~/.claude/projects/D--BigBrainMemory/memory/MEMORY.md` 가 BBM 생성 헤더로 덮어써져
포인터가 전부 소실된 상태로 발견됐다.

**수정**: `Vault` 가 생성 시점에 루트의 네이티브 노트를 **내용으로** 판별한다
(frontmatter 의 `node_type: memory` / `originSessionId` — 실측 코퍼스 23/23 보유).
판별되면 `writeIndex()` 와 `markVault()` 가 아무것도 쓰지 않고, 경고는 마커 검사보다
**앞에서** 나가며 실제 상황과 `import:native` 조치를 말한다. 마커를 신뢰하지 않는 것이
핵심이다. 회귀 `scripts/regress-native-guard.mjs` 1~3절.

#### N2. 주 채널에 나이·검증 지시가 없다 ★high — FIXED

`age_days`/`stale_hint` 는 **도구 응답**(recall·read_memory·list)에만 있었다.
그런데 60회 대조 실험이 특정한 주 채널은 도구가 아니라 **훅 주입**이다. 즉 행동을
가장 많이 좌우하는 경로에만 시간 정보가 없었다.

두 방향에서 같은 결론이 나왔다:
- **네이티브의 대응**: 메모리 파일을 Read 하면 하네스가 자동으로 붙인다 —
  "This memory is N days old. Memories are point-in-time observations, not live state …
  Verify against current code before asserting as fact." 즉 네이티브는 이 위험을 알고 막고 있었다.
- **관측된 피해**: 주입된 한 줄을 근거로 모델이 저장소를 **확인하지 않고 단정**한 사례가
  보고됐다. 사용자가 친 문자열이 기억의 템플릿에 우연히 맞자 "이 프로젝트는 X 로 되어
  있으므로" 라고 답한 뒤 그 다음에 grep 을 시작했다. 같은 주입 블록 맨 위에 확신도 0.99 로
  "검증 없는 단정 금지" 가 있었는데도 발화하지 않았다.

확신도만 표기되고 나이가 없으면 **권위만 전달되고 불확실성은 전달되지 않는다.**

**수정**: ① `regenerateIndex()` 라인에 나이 부착 — `(확신도 0.95 · 3일 전)`,
임계 초과 시 `· 90일 전, 대조 필요`(`BIGBRAIN_STALE_DAYS` 공유).
② 훅 주입 블록에 검증 지시 — 시점 관측임 / 단정 전 현재 소스 확인 / 어긋나면 revise /
한 줄 요약은 기억 전문이 아니므로 recall 하라. 회귀 `regress-native-guard.mjs` 4~5절.

> 채널 ②(instructions 인덱스)에는 **일부러 넣지 않았다.** 2048자 예산에서 40줄 × 약 6자 =
> 240자를 나이에 쓰면 행동수칙이나 인덱스 건수를 깎아야 한다. 그 채널의 나이 해석 지침은
> 이미 도구 description 에 있고(예산 밖), recall 응답이 `age_days` 를 직접 준다.

#### N3. 이관 시 사람이 읽는 제목이 슬러그로 퇴화한다 — medium, FIXED

실측(네이티브 23건 미리보기): 제목이 `toast-notify-deliverable` 로 들어간다.
사람이 읽는 제목 `ToastNotify deliverable` 은 네이티브 **MEMORY.md 인덱스에만** 있고
노트의 `name:` 필드는 슬러그이기 때문이다.

주입 채널이 제목을 그대로 보여주므로, 이관 후 인덱스 가독성이 통째로 떨어진다.

**다만 이건 의도된 절충이다** — T20 이 "제목을 원본 `name` 그대로 써 본문 `[[위키링크]]`
보존" 을 명시적으로 선택했다. BBM 은 slug 를 title 에서 파생하므로, 제목을 사람이 읽는
형태로 바꾸면 slug 가 바뀌고 노트 간 위키링크가 전부 깨진다.

**수정**: 인덱스의 `- [제목](파일.md)` 을 파싱해 제목을 복원하고(없으면 `fm.name` 폴백),
링크는 **예측이 아니라 실제 확정된 slug** 로 치환한다 — 전부 저장한 뒤 후처리 패스에서
`[[원본name]]` → `[[실제slug]]` 로 revise(사유 기록). 동명 충돌로 `-2` 가 붙어도 정확하고,
앞 노트가 뒤 노트를 가리키는 경우도 처리된다. 이관 직후 `reflect().danglingLinks` 를
스스로 확인해 결과를 출력한다. 회귀 `regress-import.mjs` 8절.

실측(실제 코퍼스 23건): `ToastNotify deliverable`, `SQLite 비ASCII 경로 크래시`,
`log.error 는 exitCode=1 설정` 등 전건 복원.

#### N4. 이관된 project 스코프가 경로 슬러그 그대로다 — medium, FIXED

실측: `project=C--Users-ruinp-OneDrive-------Discord-CLI-bot`.
`BIGBRAIN_PROJECT` 를 **이 뭉개진 문자열과 정확히 같게** 설정해야만 스코프가 맞는다.
사람이 손으로 쓸 수 있는 값이 아니고, 프로젝트를 옮기면 조용히 어긋난다.

**문자열 정규화로는 풀리지 않는다.** 슬러그는 실제 경로에서 영숫자가 아닌 문자를 전부
`-` 로 바꾼 것이라(`D:\BigBrainMemory` → `D--BigBrainMemory`) 하이픈이 경로 구분자이자
이름 문자를 겸한다. `E--Project-Go-reversproxy` 가 `Project-Go-reversproxy` 인지
`reversproxy` 인지 알 방법이 없고, 한글 디렉터리는 `-------` 로 뭉개져 정보가 아예 없다.
처음 세웠던 "마지막 의미 구간" 휴리스틱은 이 때문에 폐기했다.

**수정 — 역매핑**: `~/.claude.json` 의 `projects` 키가 실제 절대경로이므로, 같은 규칙으로
뭉갠 값이 슬러그와 일치하는 경로를 찾아 basename 을 쓴다. 추정이 아니라 정확 복원이다.
`--project-map <슬러그>=<이름>` 으로 덮어쓸 수 있고, 실패하면 슬러그를 유지하며 이유를
출력한다(조용한 손실 금지). 회귀 `regress-import.mjs` 9절.

실측(이 머신 10개 프로젝트): **9개 정확 복원**, 공백·한글 이름까지 살아남았다 —
`공유폴더 에브리띵`, `Discord CLI bot`, `design_handoff_mfc_toast`. 여러 경로가 걸리는
경우는 `D:\x` 와 `D:/x` 처럼 표기만 다른 같은 디렉터리라 basename 이 하나로 모인다(10/10).
나머지 1개는 설정에 항목이 없어 슬러그를 유지했다.

#### N5. 대체의 주 채널이 Claude Code 전용이다 — medium, 한계로 수용

네이티브의 인덱스 주입은 **하네스 수준**이라 네이티브 메모리가 동작하는 모든 곳에서 작동한다.
BBM 의 등가물은 `SessionStart` 훅이고, 훅은 Claude Code CLI 와 데스크톱 **Code 탭**에만 있다.
데스크톱 일반 채팅이나 다른 MCP 클라이언트에서는 채널 ①(instructions)만 남는데,
그 조건의 실측 저장률은 57%(17/30)다.

서버가 고칠 수 있는 문제가 아니다. **완화책**: 그런 환경에서는 채널 ④(네이티브
`memory/MEMORY.md` 브리지 파일)를 유지한다 — 네이티브 자동 주입에 편승하는 경로라
훅 없이도 인덱스가 전달된다. 단 N1 때문에 **브리지 파일을 볼트로 지정하면 안 된다**
(이제 서버가 막는다).

---

## 요약 — 세 줄 결론

1. **가장 취약한 곳은 이론이 아니라 신뢰성 계층이다.** 손상 파일 1개로 서버가 부팅 불능(critical), 비원자 쓰기·무락 동시성으로 조용한 데이터 손실 경로가 다수 실증됐다. "기억은 절대 잃지 않는다"가 대체의 전제인데 현재는 그 반대다.
2. **검색은 표층 부분문자열 매칭이 전부다.** 동의어·한↔영 교차가 0건을 만들고, 0건이면 애써 만든 연상 네트워크(1-hop 확산)도 진입 자체가 불가능하다.
3. **네이티브 대비 최대 격차는 "무엇이 저장돼 있는지"의 자동 노출이다.** MCP instructions 는 매 세션 주입되지만 볼트 내용 인덱스는 주입되지 않아, recall 호출이 모델의 자발성에 100% 의존한다.

심각도 분포: critical 1 / high 17 / medium 15 / low 14 (원 발굴 47건, 본 문서는 중복 병합 후 33개 항목으로 정리)

---

## 대체 전략 — 트리거 재현 + 안전성 확보

> 이 절은 아래 결함 목록(A~F)과 로드맵(H)을 "네이티브를 어떻게 대체하는가" 관점으로 꿴 요약이다.

**핵심 통찰: 네이티브 메모리의 본질은 저장소가 아니라 "매 세션 자동 주입되는 인덱스"다.** 파일 저장 자체는 BBM 이 이미 우월하다(강화·감쇠·연상·이력·출처·supersede). 대체가 막히는 지점은 하나 — 네이티브는 모델이 "무엇이 저장돼 있는지" 항상 보고 시작하는데, BBM 은 모델이 자발적으로 recall 을 불러야만 보인다. 따라서 대체 = **① 회상 트리거 재현 + ② 네이티브 수준의 견고성 확보**.

### ① 회상 트리거 — 단일 자동 주입을 4중 체인으로 재현

| 채널 | 방법 | 상태 |
|---|---|---|
| 1. MCP instructions | "RECALL FIRST" 수칙 — 매 세션 주입 실증됨 | ✅ 작동 중 |
| 2. instructions 에 인덱스 부착 | 기동 시 `store.list()` 상위 40건 요약을 instructions 끝에 첨부 (E1-1) | 코드 1곳 |
| 3. SessionStart 훅 | `vault/MEMORY.md` 를 stdout 출력 → 항상 최신 인덱스가 컨텍스트에 (E1-2) | 설정 1블록 |
| 4. 브리지 파일 | 네이티브 `memory/MEMORY.md`(자동 주입됨)에 주제 인덱스 + "전체는 recall 로" (E1-3) | ✅ **실증됨** — 2026-07-18 세션에서 이 채널만으로 recall 유도 성공 |

채널 2는 서버 spawn 시점 스냅샷이라 약간 낡을 수 있고, 채널 3이 가장 확실하다(항상 최신). 셋을 병행하면 실패 조건은 "모델이 전 채널을 무시할 때"로 좁혀진다.

### ② 스코핑 — 격리와 공유의 양립 (네이티브를 넘어서는 지점)

네이티브의 프로젝트별 완전 분리는 장점이자 한계다(교차 프로젝트 지식 공유 불가 — BBM 존재 이유). 대체안은 `project` frontmatter 필드 + recall 필터 `!m.project || m.project === opts.project` — 전역 기억(선호·습관)은 항상 통과, 프로젝트 기억은 자기 것만. 프로젝트별 `.mcp.json` env `BIGBRAIN_PROJECT` 로 기본값 주입 (상세 E2, 볼트 분리안 기각 사유 포함).

### ③ 견고성 — "파일이라 안 죽는" 네이티브만큼

네이티브는 서버가 없어 실패 모드 자체가 없다. 등가 견고성의 조건 = P0 6건 (A1~A7: 파싱 격리·원자적 쓰기·재읽기 증분·wx 생성·Date 허용·revise 스냅샷) + 네이티브의 숨은 기능 2개 재현: **staleness 리마인더**("N일 전 기억" — E4 의 age_days/stale_hint) 와 **실패의 가시화**(조용한 빈 볼트 생성 → 마커·기동 로그·경고로 시끄럽게, E3).

### ④ 마이그레이션 — 이미 실증됨

2026-07-18 에 수행한 절차가 곧 검증이다: 네이티브 5건 이관(슬러그 보존 → 위키링크 무손상, source 에 출처, 타입 매핑) + 세션 마이닝 13건 + 네이티브 MEMORY.md 브리지 전환 + 원본 아카이브. 남은 것은 이 매핑의 코드화(`scripts/import-native.mjs`, 멱등) 뿐 (E5).

### 정직한 한계 2개

1. **데스크톱 채팅에는 훅이 없다** — 채널 3 불가, 채널 1·2 만 작동. Code 세션 대비 채팅 쪽 회상률은 낮을 것.
2. **검색 품질은 트리거와 별개의 후반전** — 인덱스가 주입돼도 recall('deploy') 이 '배포' 기억을 못 찾으면(D1) 소용없다. P2 의 동의어 확장 + 0건 시 2차 확산(D2)이 대체 품질을 완성한다. 임시 완화: 태그 한/영 병기(태그 매칭 교차 검색은 실증됨).

### 대체 공식 — 기능별 대응표

| 네이티브 기능 | 대체 수단 | 근거 절 |
|---|---|---|
| 자동 인덱스 주입 | 채널 2+3+4 삼중화 | E1 |
| 프로젝트 격리 | `project` 필드 필터 (교차 공유는 유지) | E2 |
| 파일 수준 견고성 | P0 6건 | A1~A7 |
| staleness 리마인더 | `age_days` + `stale_hint` | E4 |
| consolidate-memory 스킬 | `registerPrompt('consolidate')` | E6 |
| 기존 기억 이관 | `import-native.mjs` (매핑 규칙 고정, 멱등) | E5 |

**대체 선언 가능 조건: P0(안전) → P1(트리거·스코핑·staleness) 완료.** P2 는 품질, P3 는 선택.

---

## A. 데이터 신뢰성 — P0 (대체 선언 전 필수 수정)

### A1. 손상 .md 파일 1개가 서버 부팅을 막는다 ★critical
`src/vault.ts:54`, `src/store.ts:99`, `src/index.ts:261,268-271`

`Vault.read()` 가 `matter(raw)` 를 try/catch 없이 호출한다. `memories/` 에 깨진 frontmatter 파일이 1개라도 있으면 기동 시 `regenerateIndex()→loadAll()→matter()` 가 YAMLException 으로 죽고 `main().catch` 가 `process.exit(1)` — **8개 도구 전부 사용 불능**. 재현 확정 (신규 프로세스는 항상 첫 파싱에서 사망; `archive/` 의 손상 파일은 부팅을 막지 않음).

트리거는 현실적이다: 전원 차단 중 부분 쓰기(A3), Obsidian/수동 편집 실수 — README 가 볼트를 Obsidian 으로 열라고 권장하므로 노출면이 넓다.

**수정**: ① `Vault.read` 를 try/catch 로 감싸 파싱 실패 시 stderr 경고 후 null 반환 (loadAll 은 이미 null 스킵) ② 손상 파일은 `quarantine/` 으로 이동 ③ `main()` 의 `regenerateIndex` 도 try/catch.

### A2. gray-matter 캐시가 손상 파일을 "빈 레코드 덮어쓰기"로 세탁한다 ★high
`src/store.ts:259,436`, gray-matter `index.js:47`

A1의 후속 붕괴. gray-matter 는 **파싱 전에** 내용을 모듈 캐시에 넣으므로, 1차 접근은 YAML 예외(isError 응답)지만 **같은 프로세스의 2차 접근은 캐시 히트로 "빈 frontmatter" 레코드가 조용히 성공**한다. 에이전트의 자연스러운 재시도(2차 recall)가 search 히트 → reinforce → `vault.write` 로 이어져, `confidence 0.95 / storage_strength 12 / created 2025` 였던 원본 메타데이터가 **전부 기본값(0.7/1/now)으로 디스크에 고착**된다. 재현 확정.

정정(검증자): "영구 삭제"는 과장 — 원본 raw 전문이 새 body 안에 verbatim 보존되어 수동 복구는 가능. 소실되는 것은 메타데이터와 레코드 정체성.

**수정**: A1 수정이 선행되면 자동 해소. 추가로 ① `fromFrontmatter` 가 필수 필드(id) 부재 시 손상으로 간주해 null ② 파싱 유래가 불확실한 레코드는 write 금지 플래그 ③ 파싱 시 gray-matter 캐시 우회 옵션.

### A3. 모든 쓰기가 비원자적 — 찢긴 파일이 예외 없이 빈 body 로 읽히고 고착된다 ★high
`src/vault.ts:90,101`

`writeFileSync` 직접 덮어쓰기(tmp+rename 없음). 닫는 `---` 앞에서 잘린 파일은 gray-matter 가 **전체를 frontmatter 로 해석해 예외 없이 `body=''`** 를 반환한다 (`confidence: 0.` 같은 줄 경계 절단이 흔한 클래스). 이후 reinforce 가 매 조회마다 재기록하므로 빈 body 가 정상 형식으로 **고착화되어 손상 흔적까지 소멸**. 재현 확정 (F1: 절단→무예외 body 손실 고착 / F2: 따옴표 중간 절단→YAML 예외 / F3: 빈 파일→id 재생성된 빈 레코드 영구 저장).

조회가 곧 쓰기(B1)라 손상 창이 상시 열려 있고, Obsidian 동시 저장이 현실적 트리거다.

**수정**: `vault.write`/`writeIndex` 를 원자화 — `fp+'.tmp-'+pid` 에 쓰고 `renameSync` (동일 볼륨이라 원자적). read 경로에서 최소 무결성 검증(닫는 구분자·id 존재) 실패 시 write-back 생략.

### A4. recall 의 write-back 이 동시 작업을 소리 없이 되돌린다 (3종 실증) ★high
`src/store.ts:180,256-264,436`, `src/vault.ts:59-65,94-98`

search 는 시작 시 `loadAll` 스냅샷을 뜨고, 끝에서 그 **스냅샷 전체를 재직렬화해 덮어쓴다**. 재읽기·버전검사·파일락이 전무해 다중 프로세스(데스크톱 채팅 + Code 세션 N개가 같은 볼트)에서 세 가지 lost-update 가 결정적으로 재현됐다:

| 시나리오 | 실측 결과 |
|---|---|
| **revise 소실** — A의 search 창 안에 B가 revise | body·confidence·history 가 이전 상태로 복귀, revise 흔적 0 |
| **forget 부활** — A의 search 창 안에 B가 forget | `memories/`와 `archive/`에 동일 slug 병존(split-brain), find() 는 active 반환, 이후 recall 마다 자가 강화 |
| **강화 소실** — 2개 OS 프로세스가 각 300회 recall | access_count 증가 600회 중 **84~99.5% 소실** (재실행별 변동) |

정정(검증자): 위험 창은 볼트 스캔 1회 길이(41파일 기준 ~16.5ms)로 "상시 발생"은 과장 — 그러나 창은 볼트 크기에 O(N) 비례로 넓어지고, 발생 시 탐지 불가능한 무음 손실이라는 본질은 그대로.

**수정**: reinforce 가 스냅샷을 쓰지 말고 **쓰기 직전 재읽기 후 증분만 적용** (`fresh = vault.find(slug)` → delta 적용). 또는 볼트 단위 파일락. 근본적으로는 강화 통계를 append-only 사이드카(`vault/.access.log`)로 분리하면 경합 자체가 소멸.

### A5. 동일 제목 동시 remember — slug TOCTOU 로 한쪽이 무흔적 소실 ★high
`src/vault.ts:90,115`, `src/store.ts:118,142-144,160`

`makeSlug` 의 `exists()` 검사와 write 사이에 유사기억 탐지용 **전체 볼트 재독**이 끼어 있어 창이 넓다. 두 프로세스가 같은 제목을 remember 하면 같은 slug 를 배정받고 나중 write 가 앞 기억을 덮는다. 재현 확정: 양쪽 모두 성공 응답을 받았으나 파일은 1개, 패자의 id·본문은 어디에도 없음. 정정(검증자): 패자의 id 로 후속 revise 는 not-found 로 실패한다 (엉뚱한 레코드에 적용되지는 않음 — resolve 는 id 불일치 시 null).

**수정**: 신규 생성 경로에서 `writeFileSync(fp, text, { flag: 'wx' })` + EEXIST 시 `-2, -3…` 재시도 루프로 makeSlug/write 를 하나의 원자적 `createNew()` 로 통합.

### A6. 비인용 YAML 날짜가 created 를 "지금"으로 리셋한다 (Obsidian 편집 즉시 발병) — medium
`src/vault.ts:122,128`

Obsidian/수동 편집에서 흔한 비인용 날짜(`created: 2025-01-01` 또는 ISO)는 js-yaml 이 **Date 객체**로 파싱하는데, `str()` 가드가 문자열이 아니라며 버리고 now 로 대체한다. 재현: 563일 된 기억의 활성이 −2.96 → **+3.84** 로 부풀고(랭킹 최상위 오염), 다음 write 가 잘못된 now 를 고착. created/updated/lastAccessed/lastReinforced 4개 필드 전부 해당.

**수정**: `str()` 이 `v instanceof Date → v.toISOString()` 허용. 또는 yaml JSON_SCHEMA 로 파싱해 타임스탬프를 문자열로 유지.

### A7. revise 에 undo 가 없다 — 이전 본문은 어디에도 남지 않는다 — medium
`src/store.ts:288,298-300`

revise 는 body 를 즉시 덮어쓰고 history 에는 `revised — <reason>` 한 줄만 남긴다. P7 이 내세우는 "이력 보존"은 reason 뿐이라 감사·복구 모두 불가. 비파괴 경로는 forget(archive 이동)과 remember+supersedes(구본 보존)가 있지만, **MCP instructions 가 중복 발견 시 revise 를 우선하라고 유도**해 파괴적 경로가 기본이 된다. AI 가 환각으로 옳은 기억을 "정정"하면 원본 영구 소실.

**수정**: 덮어쓰기 전 구본을 `archive/revisions/<slug>.<ts>.md` 로 복사(2~3세대 보존). 최소한 README 에 볼트 git 관리 권고 명시.

### A8. MEMORY.md 동시 재생성 — stale last-wins — low
`src/store.ts:392-417`, `src/vault.ts:100-102`

두 프로세스의 변이가 겹치면 늦게 쓴 쪽의 (자기 시점) 스냅샷이 이겨 인덱스가 일시적으로 실재 노트와 불일치. 파생 파일이라 다음 변이에서 자가 치유 — 실질 피해 낮음. A3 원자화 + 인덱스 lazy 재생성으로 해소.

---

## B. "조회가 곧 쓰기" — 운영 부작용 (medium, 통합)

`src/store.ts:425-426,436`, `src/store.ts:407`, `src/index.ts:261`

- **간격 게이트가 닫혀 있어도** reinforce 는 accessCount/lastAccessed 를 항상 갱신하고 `vault.write` 는 게이트 if 블록 **밖**이라 무조건 실행 — recall 1회로 히트+연상 최대 8개 파일 재기록. read_memory 도 동일. 순수 조회는 `list_memories` 와 `reflect` 뿐 (실측: 이 둘은 전 파일 바이트 동일).
- MEMORY.md 는 본문에 생성 시각을 박아 **서버 기동만 해도** 재작성 — MCP 클라이언트를 켜기만 해도 diff 발생.
- 사용자가 손으로 다듬은 frontmatter 서식·커스텀 키는 첫 조회에 **통째로 소실** (화이트리스트 재직렬화).
- 결과: git 관리 시 검색만으로 working tree 오염, Obsidian 열림 파일과 충돌(A3 트리거), 자주 검색되는 기억만 강화되는 부익부 편향.

**수정**: 가변 통계(access_count/last_accessed/storage_strength/last_reinforced)를 노트에서 분리해 사이드카에 저장하고 노트는 내용 변경 시에만 쓰기. 차선: 게이트 닫힘 시 write 생략 + MEMORY.md 는 내용 비교 후 변경 시에만 쓰기 + 기동 시 regenerateIndex 제거.

---

## C. 랭킹·ACT-R 모델 충실도

### C1. 감쇠 시계가 created 에 고정 — "recency" 는 실제로 없다 ★high (이번 감사 최대 이론 결함)
`src/store.ts:202,242,272,358` (활성 계산 4곳 전부), `src/index.ts:35,127`

`baseLevelActivation(n, now − created)` — **lastAccessed 는 코드 어디에서도 읽히지 않고**, lastReinforced 는 간격 게이트에만 쓰인다. 도구 설명이 광고하는 "frequency+**recency**" 중 최근성은 미구현.

실측: created 1년 전·n=5 동일 조건에서 "어제 5번째 강화된 기억"과 "1년 전 5회 강화 후 방치"의 활성이 **−2.2364 로 완전 동일** (차이 < 1e-12). ACT-R 정확식 `B=ln(Σt^−0.5)` 로는 −1.40 vs −2.93 (e^Δ≈4.6배 차이가 나야 정상). 랭킹 실전 왜곡: 어제 5회 쓴 핵심 기억(키워드 9점)이 몇 초 전 저장된 잡메모(키워드 6점)에 5.75 vs 7.68 로 **패배**. reflect 는 방금 접근한 기억도 weakened 로 오분류.

채택식(optimized learning 근사)은 "연습이 생애에 균등 분포" 전제의 표준식이라 L=created 자체는 오귀속이 아니다 — 문제는 실사용(불균등 강화)에서 전제가 깨지는데 설명은 recency 를 약속한다는 것.

**수정** (스키마 변경 불필요, 실측 검증됨): 마지막 연습 항 분리 —
```
B = ln( (n−1)·L^−d/(1−d) + t_last^−d )    L=created 경과[h], t_last=lastReinforced 경과[h]
```
실측: A=−1.24, B=−2.34 로 정확식(−1.40/−2.93)의 방향·간격을 근사하고 A>B 순서 복원. 더 정밀하게는 최근 k회 강화 타임스탬프 배열 보관(Petrov 2006 하이브리드). 당장 못 바꾸면 최소한 도구 설명의 "recency" 를 "age" 로 정정할 것.

### C2. weakened 임계 τ=−0.7 절대 고정 — 신생 볼트에서 하루 만에 전원 weakened ★high
`src/store.ts:18,360-363`

n=1 기억은 **생성 16.22시간**이면 임계 하회 (n=2→2.7일, n=5→16.9일). 재현: 신규 볼트 3건의 created 를 17h/24h/3d 로 되감고 reflect → **3/3 전건 weakened**. 정확식으로도 마찬가지(17h 에 B=−1.42)라 C1 수정과 별개로 τ 자체가 신생 볼트에 과민하다. instructions 가 "주기적 reflect 후 정리"를 지시하므로 하루 된 멀쩡한 기억을 정리 대상으로 오인시킬 유도가 생긴다. (forget_candidates 는 `confidence<0.5` AND 게이트 덕에 오발동 안 함 — C6 참조.)

**수정**: ① created 후 유예기간(72h) 내 weakened 제외 ② lastAccessed 최근(7일) 제외 ③ 절대 τ 대신 하위 분위 병용. C1 수정 선행 시 ②는 자연 해소.

### C3. 간격 게이트가 "고정 10분 rate limit" — 기계적 반복으로 무한 부풀리기 가능 — medium
`src/store.ts:20-23,427-435`

간격효과 이론은 **간격 확대**를 요구하는데 구현은 고정 창이라 "10분짜리 벼락치기"가 통과한다. 실측: 11분 간격 recall 30회 → storage_strength 1→31 (상한 없음, 감소 경로 없음). 하루 144회면 n=145, 활성가중 1.443 로 포화 — 이 기억은 reflect weakened 에서 **약 39년간 면제**. 완화 요소: 랭킹 왜곡 자체는 로지스틱 압축으로 최대 2.64배 캡.

**수정**: 확장 간격 — `required = max(SPACING_MS, α·(now−created)/n)` 또는 지수 백오프 `SPACING_MS·2^min(n−1,10)`. 최소한 일일 상한(Δn ≤ 3/일).

### C4. "바람직한 어려움" 보너스가 사실상 상시 발동 — medium
`src/store.ts:25,202→262,430`

preActivation 판정이 C1의 created 고정 활성을 상속. 면제엔 `n ≥ 0.824·√L[h]` 이 필요해 (24h→n≥4, 1주→10.7, 1달→22.1) **주 1회 이하 접근하는 통상적 장기 기억에는 항상 +0.5 보너스**가 붙는다. 재현: 7일·n=5·어제 강화된 기억이 delta 1.5 수령. 판별 기능 상실 — 능동 강화가 사실상 상수 1.5. 정정(검증자): 매일 recall 되는 기억은 ~1주에 면제 도달하므로 "전부 상시"는 아님. **수정**: C1 활성 함수 교체만으로 자동 해소 (별도 코드 불요).

### C5. RIF 로 억제한 경쟁자를 같은 루프에서 동일 강화 — low
`src/store.ts:256-264`

direct 판정이 "스니펫이 `(연상` 으로 시작하는가" 뿐이라 inhibited=true 인 경쟁자도 active:true 로 +1(저활성 시 +1.5) 강화. 재현: 근사중복 2건이 나란히 1→2.5. 순위만 억제하는 것 자체는 P5 의 의도된 안전 설계지만, **억제와 동시에 동일 적립**이라 경쟁자 저장강도가 영원히 동률로 가고 RIF 의 목적(미래 간섭 감소)이 세션 간 실현되지 않는다. **수정**: inhibited 결과와 연상 결과는 reinforce 제외(또는 접근 기록만).

### C6. revise 가 간격 게이트를 우회 (+ 검증된 소소한 사실들) — low

- `src/store.ts:294`: revise 는 게이트 없이 무조건 +1, lastReinforced 도 리셋. 몇 초 안 2회 revise → 1→3. instructions 가 revise 를 권장하므로 정상 경로에서 과적립. **수정**: reinforce 와 동일 게이트 적용, 순수 메타데이터 편집(내용·confidence 무변경)은 강화 제외.
- `src/store.ts:366`: forget_candidates 의 `confidence<0.5` AND 게이트는 **문서화된 의도적 설계**(P6, report:70) — 기본 확신도(0.8) 기억은 절대 자동 망각 후보에 오르지 않음. 유지 타당하나, reflect 출력에 "confidence 높아 후보 제외된 장기 방치 N건" 카운트를 노출하면 실효성 개선.
- history 는 revise/forget/supersede 시에만 증가(recall/read 는 안 늘림). 무상한 — reconfirm 110회에 935→7,426B. 캡(최근 50개) 권장.

---

## D. 검색 품질

### D1. 표층 부분문자열 매칭 — 동의어·한↔영 교차 0건 ★high
`src/store.ts:191-199`, `package.json` (임베딩/형태소 라이브러리 없음)

가중치: 제목 +5 / 태그 +4 / 설명 +3 / 본문 토큰당 최대 +3 (전부 `includes`/`indexOf`). 실측: "배포" 로 저장 → `search('deploy')`=0, `search('디플로이')`=0. 역방향(영어 기억에 한국어 질의)도 0. **조사 흡수용 접두 매칭(tokenMatch)조차 검색에는 미적용** — `search('배포를')`=0 (유사도 판정에만 쓰임).

0건이면 에이전트는 "기억이 없다"고 결론 내리고 같은 사실을 재학습·중복 저장한다 — RECALL FIRST 수칙의 실효를 깎는 최전선 결함. 완화 실증: 이중언어 태그가 있으면 태그 매칭으로 교차 검색 성공 (단 `tag.includes(query)` 방향이라 'deployment' 질의는 'deploy' 태그를 못 잡음).

**수정 단계별**: ① remember 도구 설명에 "태그 한/영 병기" 지침(즉시) ② 소형 도메인 동의어 사전으로 질의 토큰 확장 ③ keyword 0건 시 벡터 폴백(로컬 임베딩 하이브리드).

### D2. 직접 매칭 0건이면 연상 확산도 진입 불가 ★high
`src/store.ts:200,236`

확산은 `results.slice(0,3)` — 직접 매칭 결과 — 에서만 출발한다. 재현: '배포 절차'↔'릴리스 노트 작성법' 링크 상태에서 `search('출시')` → **0건** (링크망 자체는 '배포' 질의로 정상 작동 확인). 표층 어휘가 어긋난 질의 — 확산이 정작 필요한 순간 — 에 완전히 죽는다. link() 투자가 recall 실패를 전혀 보완하지 못함. MCP 계층의 0건 노트는 재질의가 아닌 **remember 를 유도**해 중복 생성을 부추긴다.

**수정**: 0건 시 2차 패스 — 질의 토큰과 제목/태그 토큰을 tokenMatch 로 느슨히 비교해 overlap>0 기억을 시드로 1-hop 확산. 응답 노트도 "동의어/태그로 재질의" 로 교체.

### D3. overlap 의 min 분모 + 무제한 양방향 접두 일치 — 오탐 클러스터 ★high~medium (3건 통합)
`src/store.ts:48-50,53-60`, 소비처: remember 유사감지 0.45 / RIF 0.5 / reflect 중복 0.75

- `tokenMatch('서버리스','서버')=true`, `('인증서','인증')=true` — 단어 경계 없음.
- 분모가 `min(|A|,|B|)` 라 **한쪽만 토큰이 희소해도** 유사도가 부푼다. 재현: 1토큰 제목 메모가 1위일 때 무관한 빌드 문서 3건 전부 inhibited (11.52→5.76, overlap=1.0 — 자카드로는 0.10), '부산 여행' vs '부산물 처리 공정' similar 오탐, remember('서버리스 비용') 이 '서버 성능'(물리서버 튜닝)을 similar 로 보고.
- 위험 증폭: instructions 가 "similar 보고 시 revise 우선"이라 **무관 기억으로의 병합 오염을 시스템이 능동 유도**.

한정(검증자): 발동엔 비교쌍의 title+description 합산 토큰이 ~2개 수준으로 짧아야 하며(description 은 content 첫 줄 자동 파생), 현재 라이브 볼트 18건에는 해당 쌍 0건 — **잠재 결함**. 단문 메모가 쌓이면 실제 발병.

**수정**: 분모를 자카드(합집합)로 + 임계 재보정(~0.3), `min(|A|,|B|)<3` 이면 비교 스킵, 접두 일치는 "짧은 쪽 길이 ≥3 && 길이차 ≤2"(조사 1~2자 흡수엔 충분)로 제한. 세 소비처(0.45/0.5/0.75) 동시 재보정 필수.

### D4. 토큰 경계 없는 본문 매칭 — 'cat' 이 concatenate 를 잡는다 — medium
`src/store.ts:192-198`

재현: 고양이와 무관한 두 기억만 있는 볼트에서 `search('cat')` → 'Concatenation' 제목 기억 7.68점, body 에 concat/category 있는 기억 3.84점 (기대 0건). 더 나쁜 건 **강화 오염**: 반환 결과가 능동 인출로 적립돼 무관 기억이 점점 잘 회상되는 방향으로 드리프트 (간격 게이트로 10분당 1회 제한). **수정**: 필드를 사전 토큰화해 `tokenize(m.title).some(u => tokenMatch(t,u))` 비교로 교체 (indexOf 제거).

### D5. limit 5+연상 3 상한 — 누락을 알 방법이 없다 — medium
`src/store.ts:179,252`, `src/index.ts:131,135-139`

재현: 관련 20건 볼트에서 기본 질의 → **6건 반환, 14건(70%) 무음 누락**. limit 은 20까지 올릴 수 있지만 응답에 컷오프 전 총 매칭 수가 없어 에이전트는 올릴 계기가 없다. 반환분만 강화돼 rich-get-richer. **수정**: `totalMatched` 를 응답에 포함 ("5/20건 표시 — limit 재질의 가능"), 연상 상한을 `ceil(limit/2)` 로 비례화.

### D6. link() 의 본문 위키링크 주입이 검색을 오염 — low
`src/store.ts:453-462`

'## 연관 기억\n- [[배포-절차]]' 가 body 에 들어가므로, 링크만 걸린 무관 기억(커피 취향)이 '배포' 질의에 **직접 매칭**으로 잡히고 `include_linked:false` 로도 배제 불가 + 능동 강화까지 받는다. 재현 확정. **수정**: 스코어링·스니펫 계산 전 `body.replace(/\[\[[^\]]+\]\]/g,'')` 사본 사용 (또는 '## 연관 기억' 이후 제외).

### D7. 스니펫이 첫 토큰의 첫 등장 위치만 — 질의 어순에 따라 품질이 바뀐다 — low
`src/store.ts:464-476`

재현: `search('타임아웃 30초')` 스니펫은 서두 일반론("정답이 없다는 논의…"), `search('30초 타임아웃')` 은 결론 문장("반드시 30초로 설정") — 동일 기억·동일 토큰 집합. 랭킹은 무관(점수 계산은 순서 독립), 표시 품질만의 문제. **수정**: 고정 폭 윈도 슬라이드로 서로 다른 토큰 커버 수 최대 위치 선택.

---

## E. 네이티브 메모리 패리티 격차

### 패리티 매트릭스

| 네이티브 기능 | BBM 현황 | 격차 |
|---|---|---|
| MEMORY.md 인덱스가 **매 세션 시스템 프롬프트에 자동 주입** | vault/MEMORY.md 생성만 하고 어떤 경로로도 재노출 없음 (grep: 읽는 코드 0건) | ★E1 |
| 프로젝트별 격리 저장소 | 전역 단일 볼트, recall/list 에 project/tags 하드 필터 없음 | ★E2 |
| 파일 직접 접근 — 서버 실패 모드 자체가 없음 | node 프로세스/경로 실패 시 조용히 "기억 전무"로 보임 | ★E3 |
| Read 시 staleness 경고 자동 부착 ("N days old") | brief() 에 시간 필드 0개, full() 도 raw ISO 만 | ★E4 |
| type: user/feedback/project/reference | episodic/semantic/procedural/preference — 매핑 규칙·임포트 스크립트 없음 | E5 |
| consolidate-memory 스킬 (슬래시 호출 워크플로) | reflect 는 정적 suggestion 문자열뿐, registerPrompt 0건 | E6 |
| — (네이티브에 없음) | 강화/감쇠 동역학, 이력, 출처, supersede, 아카이브, 연상 링크 | BBM 우위 |

### E1. 세션 시작 시 "무엇이 저장돼 있는지" 주입 부재 ★high — 대체의 최대 관문

MCP instructions("RECALL FIRST")는 매 세션 주입됨이 실증됐다 — 즉 볼트의 **존재**는 전달된다. 없는 것은 **내용 인덱스**: 모델이 저장된 주제를 모른 채 recall 키워드를 추측해야 하고, D1(동의어 무능)과 결합하면 첫 질의가 0건일 확률이 높다.

**수정 3단** (병행 가능):
1. **저장소 내 최소 수정**: `index.ts` 기동 시 instructions 끝에 인덱스 요약 부착 —
   `store.list().slice(0,40).map(m => '- ['+m.type+'] '+m.title+' — '+m.description)` (서버 spawn 시점 스냅샷이 자동 노출됨).
2. **확실한 방법**: Claude Code `SessionStart` 훅으로 `vault/MEMORY.md` 를 stdout 출력 (SessionStart stdout 은 컨텍스트에 추가됨; UserPromptSubmit 은 매 턴 중복이라 부적합).
3. **브리지 공식화**: 네이티브 memory/MEMORY.md(자동 주입됨)에 BBM 핵심 항목 목록 + "전체는 recall 로" 한 줄 유지 — 현재 SimpleMailServer 프로젝트에 이미 적용된 패턴.

### E2. 프로젝트 스코핑 부재 ★high

recall/list 스키마에 project/tags 필터가 없다 (tags 는 +4 가산점일 뿐 **배제 불가** — opts 에 넣어도 조용히 무시됨을 실측). 재현: 두 프로젝트의 '빌드 방법' 기억 중 타 프로젝트 것이 동점 1위. 현 라이브 볼트는 ~90% 단일 프로젝트라 현재 피해는 미미 — 볼트 성장 시 정밀도 단조 하락.

**수정 (3안 비교 후 (b) 권장)**: (a) 프로젝트별 BIGBRAIN_VAULT 분리 — 완전 격리지만 교차 프로젝트 기억(작업 선호 등, 이 시스템의 핵심 가치) 공유 불가. **(b) frontmatter `project` 필드 + recall 필터** — `!m.project || m.project===opts.project` 로 전역 기억은 항상 통과, 프로젝트별 `.mcp.json` env `BIGBRAIN_PROJECT` 로 기본값 지정. 격리+공유 양립. (c) `project:` 태그 관례 — 강제 불가라 오염 재발.

### E3. 서버/경로 실패 = 무소음 전체 소실 ★high — 그리고 **저장소의 .mcp.json 이 지금 죽어 있다**

실측: 이 저장소의 `.mcp.json` 은 **존재하지 않는 `D:/BigBrainMemory`** 를 가리킨다 (이전 경로; spawn 즉사 'Cannot find module'). 또 잘못된 BIGBRAIN_VAULT 는 `mkdirSync(recursive)` 가 **조용히 빈 볼트를 새로 만들어** loadAll()=0건 — 경고 0. 기동 로그는 경로만 찍고 기억 수를 안 찍는다. 모델은 빈 recall 을 "기억 없음"으로 해석해 중복 remember 를 시작 → 볼트 분열.

**수정**: ① `.mcp.json` 을 상대경로로 (`"args":["dist/index.js"]`, env 제거 — 기본값이 `<repo>/vault` 라 이동 자동 추종) ② 기동 로그에 기억 수 출력 ③ `.bigbrain-vault` 마커 파일 — BIGBRAIN_VAULT 명시됐는데 마커도 기억도 없으면 stderr + instructions 첫 줄에 경고 부착 (모델에게도 보이게).

### E4. staleness(나이) 미노출 ★high

recall 결과(brief)에 created/updated 자체가 없다. 실측: 120일 방치 기억이 score 7.72 로 정상 등장 — 낡았다는 표시 전무. confidence 는 진실성 축이라 시간 경과를 표현하지 않는다(설계상 올바름 — 그래서 보완재가 못 됨). 모델이 6개월 전 코드 구조를 최신으로 인용하는, **가장 조용히 사고 내는 격차**.

**수정** (brief() 3줄): `age_days` + `stale_hint: ageDays>=30 ? '이 기억은 N일 전 갱신됨 — 현재 코드/사실과 대조 후 사용' : undefined`. brief 를 searchHit/full 이 공유하므로 recall/read/list 일괄 반영. 임계는 `BIGBRAIN_STALE_DAYS` env.

### E5. 타입 체계 매핑 — low (긴급도 소멸, 예방 가치만)

유일한 네이티브 코퍼스(SimpleMailServer 5건)는 2026-07-18 수작업 이관 완료 (타입 배정 합리적, source 보존, 원본 아카이브 확인). 남는 것: 향후/타 머신 대비 매핑 규칙 문서화 — `user→preference, feedback→procedural(행동지침)|preference(취향), project→semantic(사실)|episodic(사건), reference→semantic+source` — 와 멱등 `scripts/import-native.mjs` (동일 source 존재 시 skip, `project:` 태그 부여로 E2 연동). 참고: 미지 타입은 `vault.ts:125` 가 semantic 으로 **무경고 강등**함을 실증.

### E6. reflect → 실행 워크플로 부재 — low

registerPrompt 0건 (SDK 는 지원). suggestion 4문장이 절차를 요약하고는 있으나, 네이티브 consolidate-memory 스킬 같은 사용자 주도 호출 경로가 없다. **수정**: `server.registerPrompt('consolidate', …)` 등록 — Claude Code 에서 `/mcp__bigbrainmemory__consolidate` 슬래시 커맨드로 노출됨. 절차: reflect → duplicates 쌍 read_memory 비교 → 정확한 쪽 revise 병합 + 다른 쪽 forget("merged into [[slug]]") → forget_candidates 현실 대조 → orphans link → reflect 재확인.

---

## F. 기타 (성능·이식성)

| # | 결함 | 근거 | 실측 | 수정 |
|---|---|---|---|---|
| F1 | resolve(id)·remember·revise 가 전량 파일 재독 O(n), remember 는 regenerateIndex 포함 **사실상 2회 풀스캔** | store.ts:106-113,142,167 | 1,000건 볼트: resolve(id) 418ms, 없는 id 384ms(조기종료 불가), remember 732ms, revise(id) 652ms | 기동 시 id→slug 인덱스 1회 구성, 호출 단위 loadAll 캐시 |
| F2 | today() UTC — KST 자정~09:00 에 history 날짜 하루 어긋남 | store.ts:32-34 | KST 08:30 저장 → history '전날' 기록 | history 날짜만 로컬화 (저장은 UTC ISO 유지) |
| F3 | makeSlug 가 Windows 예약명(CON/NUL/COM1…) 미차단 | vault.ts:105-119 | Win11+Node22 에선 정상 동작 (구형 Win/SMB/서드파티 도구에서 잠재) — 트레일링 공백·점은 `.md` 접미 덕에 비결함으로 정정 | 예약 base명 접미 회피 (`con_`) |
| F4 | history 무상한 | store.ts:298 | reconfirm 110회 → 111줄, 7.4KB | 최근 50개 캡 + 초과 병합 |

---

## G. 선행 주장 검증 결과 (정정표)

이번 감사의 출발점이었던 8개 주장에 대한 판정:

| # | 주장 | 판정 |
|---|---|---|
| 1 | n=1 은 16.2h 에 weakened | ✅ 정확 (정밀값 16.221h = 4·e^1.4) |
| 2 | n=3→6일, 5→17일, 10→68일, **n≥23→1년+** | ⚠️ **부분 정정**: n=23 은 357.5일로 1년 미달. 1년+는 n≥23.24, 0.5 단위 체계상 실효 **n≥23.5** |
| 3 | forget_candidates 는 conf<0.5 필수 → 0.8대 기억은 절대 후보 안 됨 | ✅ 정확 — 단 P6 에 문서화된 **의도적 설계**로 확인 |
| 4 | recall/read 는 디스크에 쓴다; 순수 조회는 list/reflect 뿐 | ✅ 정확 + 강화: "상위 결과"가 아니라 **반환 전건**(연상 포함), 게이트 닫혀도 매번 재기록 |
| 5 | 부분문자열 매칭, 동의어 불가, 가중치 5/4/3/3 | ✅ 정확 (점수 실측 일치) + 조사 접두 흡수조차 검색엔 미적용이라 **주장보다 한 단계 더 취약** |
| 6 | 간격 게이트 10분, 게이트 내 강도 불변 | ✅ 정확 (access_count·last_accessed·파일은 매번 갱신) |
| 7 | 자동 호출 장치 전무 | ✅ 정확 — 단 instructions+브리지가 매 세션 이중 채널로 주입됨은 실증. 위험은 "모델이 둘 다 무시할 때"로 한정 |
| 8 | 감쇠 시계가 created 고정, recency 미구현 | ✅ 정확 — C1 로 승격, 이번 감사 최대 이론 결함 |

---

## H. 로드맵 — 네이티브 대체까지

### P0 · 데이터 안전 (대체 선언의 전제)
1. read 파싱 try/catch + 손상 격리 (A1, A2)
2. 원자적 쓰기 tmp+rename (A3, A8)
3. reinforce 재읽기+증분 적용 (A4)
4. remember `wx` 플래그 원자 생성 (A5)
5. YAML Date 허용 (A6)
6. revise 구본 스냅샷 (A7)

### P1 · 대체 가능 조건 (회상 트리거·스코핑·안전망)
7. instructions 에 볼트 인덱스 부착 + SessionStart 훅 (E1)
8. `project` 필드 + recall 필터 (E2)
9. `.mcp.json` 죽은 경로 수정 + 기동 로그 기억 수 + 볼트 마커 (E3)
10. `age_days`/`stale_hint` (E4)
11. 조회 write 절감 — 게이트 닫힘 시 생략 또는 통계 사이드카 (B)

### P2 · 랭킹·검색 품질
12. 감쇠 시계에 마지막 연습 항 분리 (C1 — C4 자동 해소)
13. weakened 유예기간 + 상대 임계 (C2)
14. 간격 게이트 확장형 (C3)
15. 질의 토큰 동의어 확장 + 0건 시 2차 확산 패스 (D1, D2)
16. overlap 자카드화 + 접두 제한 (D3), 필드 사전 토큰화 (D4)
17. totalMatched 노출 (D5), 위키링크 제외 (D6)
18. inhibited/연상 강화 제외 (C5), revise 게이트 (C6)

### P3 · 선택
19. 로컬 임베딩 하이브리드 (D1 장기)
20. consolidate 프롬프트 등록 (E6), import-native.mjs (E5)
21. F1~F4 (성능 인덱스, UTC, 예약명, history 캡)

---

## 부록 — 방법론 세부

- 발굴 47건 → 자동 dedupe 0건 병합(제목 상이로 미탐) → 검증 단계 전건 통과 → **본 문서에서 편집적으로 33항목으로 통합** (동일 근원 결함의 다차원 발견 다수: 예. 감쇠 시계 문제가 claims/model-fidelity 양쪽에서 독립 발굴됨 — 상호 재현 수치까지 일치)
- 기각 0건의 해석: 발굴 단계에 "코드에서 확인 못 한 추측은 버려라"를 강제한 결과로 보이며, 대신 검증자들이 **12개 항목에 과장 정정·조건 한정**을 부착 (본문에 "정정(검증자)" 로 표기)
- 재현 스크립트는 세션 스크래치패드에 생성되어 휘발성 — 회귀 방지가 필요한 항목(A1~A5, C1)은 `scripts/` 테스트로 승격 권장
- 라이브 볼트(`vault/`, 18건)는 감사 전 과정에서 읽기 전용 유지
