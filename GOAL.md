# GOAL — 네이티브 메모리 완전 대체

> 이 파일은 `/bbm-goal` 커맨드(유저 스코프: `C:\Users\rapae\.claude\commands\bbm-goal.md` — 어느 프로젝트에서든 실행 가능)의
> 실행 계획서다. ※ `/goal` 은 Claude Code 내장 명령(목표 조건 설정)이라 이름을 피했다.
> 각 작업의 **무엇을 / 왜 / 어떻게 / 검증** 을 담고,
> 체크박스로 세션 간 진행 상태를 추적한다. 근거는 전부 [docs/native-parity-audit.md](docs/native-parity-audit.md)
> (2026-07-18 교차검증 감사, 47건 전건 재현 확정) — 아래 각 작업의 (A1) 같은 표기는 그 문서의 절 번호다.

## 최종 목표 (what)

BigBrainMemory 가 Claude Code 네이티브 메모리를 **완전 대체**한다:
모든 세션이 볼트 인덱스를 보고 시작하고, 기억은 어떤 실패 모드에서도 조용히 소실되지 않으며,
프로젝트별 격리와 교차 프로젝트 공유가 양립하고, 낡은 기억은 낡았다고 표시된다.

**대체 선언 조건: Phase P0 + P1 전부 완료.** P2 는 품질, P3 는 선택.

## 왜 (why — 감사 결론 요약)

- 파일 저장·강화·연상·이력은 BBM 이 이미 네이티브보다 우월하다. 막힌 곳은 두 가지뿐:
  1. **신뢰성** — 손상 파일 1개로 서버 부팅 불능(critical), 비원자 쓰기·무락 동시성으로 조용한 데이터 손실 경로 다수 실증. "기억을 절대 잃지 않는다"는 대체의 전제가 현재는 성립하지 않는다.
  2. **회상 트리거** — 네이티브의 본질은 "매 세션 자동 주입되는 인덱스"인데 BBM 은 볼트 내용이 어떤 경로로도 자동 노출되지 않아 recall 이 모델 자발성에 100% 의존한다.
- 상세 근거·실측 수치·기각된 대안은 감사 문서의 "대체 전략" 절과 A~F 절 참조.

## 공통 규칙 (모든 작업에 적용)

1. **라이브 볼트 보호**: `vault/` 는 운영 데이터다. 테스트는 반드시 임시 디렉터리 볼트(`BIGBRAIN_VAULT` 지정)로.
2. **게이트**: 작업 완료 = `npm run build` 성공 + `npm test` 통과 + 해당 작업의 신규 회귀 테스트 통과.
3. **회귀 테스트 승격**: 감사의 재현 시나리오를 `scripts/smoke-test.mjs` 에 추가하거나 `scripts/regress-*.mjs` 로 신설한다. "재현됐던 버그가 이제 재현되지 않음"을 테스트로 고정.
4. **하위 호환**: frontmatter 스키마 변경 시 `fromFrontmatter` 기본값으로 구버전 노트가 깨지지 않아야 한다.
5. **커밋 단위**: 작업(Txx) 1개 = 커밋 1개. 메시지에 작업 ID 포함 (예: `fix(vault): T1 손상 파일 파싱 격리 (A1/A2)`).
6. **완료 처리**: 체크박스 `[x]` + 하단 진행 로그에 한 줄 추가.
7. 머신 설정(훅 등 저장소 밖 변경)은 사용자에게 확인 후 진행.

---

## Phase T0 — 즉시 (5분)

- [x] **T0. 저장소 .mcp.json 죽은 경로 수정** (E3) — 완료 2026-07-18
  - 무엇: `.mcp.json` 이 존재하지 않는 `D:/BigBrainMemory` 를 가리킨다 — 이 레포를 프로젝트로 열면 서버가 무소음으로 안 뜬다.
  - 왜: spawn 즉사('Cannot find module')가 에러 노출 없이 "도구 없음"으로 보인다. 실측 확정.
  - 어떻게: `"args": ["dist/index.js"]` 상대경로로, `env.BIGBRAIN_VAULT` 삭제 (기본값이 이미 `<repo>/vault` — index.ts:12-14 — 라 저장소 이동에 자동 추종).
  - 검증: 이 레포에서 Claude Code 재시작 → `/mcp` 에 bigbrainmemory 연결 확인.

## Phase P0 — 데이터 안전 (대체 선언의 전제)

- [x] **T1. 손상 파일 파싱 격리** (A1 + A2) — 완료 2026-07-18
  - 무엇: 깨진 frontmatter 1개가 서버 부팅을 막고(process.exit), 재접근 시 gray-matter 캐시가 기본값 레코드로 세탁해 메타데이터를 덮어쓴다.
  - 왜: critical — 단일 파일 손상 = 전체 기억 접근 불능 + 조용한 메타데이터 파괴. 둘 다 재현 확정.
  - 어떻게: ① `Vault.read`(vault.ts:53-55) 를 try/catch — 실패 시 stderr 경고 + null 반환 (loadAll 은 이미 null 스킵) ② 손상 파일은 `vault/quarantine/` 으로 이동 ③ `main()`(index.ts:261) 의 regenerateIndex 도 try/catch ④ `fromFrontmatter` 가 id 부재 시 손상 간주 null ⑤ 파싱 유래 불확실 레코드는 write 금지 (캐시 세탁 차단).
  - 검증: 임시 볼트에 정상 1 + 손상 1 → 서버 기동 성공, 정상 기억 조회 가능, 손상 파일 quarantine 이동, 원본 바이트 무변형.

- [x] **T2. 원자적 쓰기** (A3 + A8) — 완료 2026-07-18
  - 무엇: `vault.write`/`writeIndex`(vault.ts:90,101) 가 writeFileSync 직접 덮어쓰기 — 크래시 시 찢긴 파일이 예외 없이 body='' 로 읽혀 고착된다.
  - 왜: high — 진짜 데이터 손실이 무음으로 일어나고 다음 write 가 확정한다. Obsidian 동시 저장이 현실적 트리거.
  - 어떻게: `fp + '.tmp-' + process.pid` 에 쓰고 `fs.renameSync(tmp, fp)` (동일 볼륨 = 원자적). read 경로에 최소 무결성 검증(닫는 `---` 존재) 실패 시 write-back 생략.
  - 검증: 절단 파일 3종(F1 frontmatter 절단 / F2 따옴표 중간 / F3 빈 파일) 이 고착되지 않음 — 감사 재현 스크립트 시나리오를 회귀 테스트로.

- [x] **T3. reinforce 재읽기 + 증분 적용** (A4) — 완료 2026-07-18
  - 무엇: search/read 의 강화 write-back 이 loadAll **스냅샷 전체를 재직렬화**해 동시 revise 를 되돌리고(무흔적), forget 된 기억을 부활시키고(split-brain), 강화 84~99.5% 를 소실시킨다. 3종 전부 재현 확정.
  - 왜: high — 가장 빈번한 연산(recall)이 기억 교정을 무효화한다. 다중 세션(데스크톱+Code) 이 실사용 조건.
  - 어떻게: `reinforce`(store.ts:423) 시작에서 `const fresh = this.vault.find(m.slug)` — 파일이 없거나 archive 로 이동했으면 write 생략, 있으면 fresh.record 에 delta(accessCount+1, 조건부 strength)만 적용해 write. 스냅샷 레코드를 직접 쓰지 않는다.
  - 검증: 감사의 결정적 인터리브 3종(revise 보존 / forget 유지 / 2프로세스 300회 강화 소실률 <5%) 회귀 테스트.

- [x] **T4. remember 원자적 생성** (A5) — 완료 2026-07-18
  - 무엇: makeSlug 의 exists() 와 write 사이 TOCTOU — 동시 동일 제목 remember 가 같은 slug 를 받아 한쪽이 무흔적 소실.
  - 왜: high — 두 세션이 같은 교훈을 동시에 저장하는 상관 시나리오에서 발생. 재현 확정.
  - 어떻게: vault 에 `createNew(record)` 신설 — `writeFileSync(fp, text, { flag: 'wx' })`, EEXIST 면 `-2, -3…` 접미 재시도 루프. remember 경로에서 makeSlug+write 를 이것으로 교체.
  - 검증: 동시 remember 인터리브에서 두 파일 모두 생존 + 각자 id 로 resolve 성공.

- [x] **T5. YAML Date 허용** (A6) — 완료 2026-07-18
  - 무엇: Obsidian/수동 편집의 비인용 날짜가 Date 객체로 파싱 → str() 가드가 버림 → created 등 4개 필드가 "지금"으로 리셋되어 활성이 부풀고(실측 −2.96→+3.84) 고착된다.
  - 왜: medium — Obsidian 호환을 표방하면서 사용자가 볼트를 만지는 순간 랭킹이 오염된다.
  - 어떻게: `str()`(vault.ts:122) 이 `v instanceof Date → v.toISOString()` 허용. (대안: yaml JSON_SCHEMA 파싱)
  - 검증: 비인용 날짜(`2025-01-01` / ISO) 노트 read → created 보존 확인.

- [x] **T6. revise 구본 스냅샷** (A7) — 완료 2026-07-18
  - 무엇: revise 가 body 를 즉시 덮어쓰고 reason 한 줄만 남긴다 — undo 불가. instructions 가 revise 를 권장해 파괴 경로가 기본이다.
  - 왜: medium — AI 환각 revise 한 번이 원본 지식을 영구 소실시킨다.
  - 어떻게: 덮어쓰기 전 원본 파일을 `vault/archive/revisions/<slug>.<updated-ts>.md` 로 복사, slug 당 최근 3세대 보존(초과분 삭제). README 에 볼트 git 관리 권고 1줄.
  - 검증: revise 2회 → revisions 에 2세대 존재, 4회 → 3세대 유지.

## Phase P1 — 대체 가능 조건 (트리거·스코핑·안전망)

- [x] **T7. 회상 트리거 삼중화** (E1, 대체 전략 ①) — 완료 2026-07-18
  - 무엇: 볼트에 "무엇이 저장돼 있는지"가 어떤 경로로도 자동 노출되지 않는다 — recall 이 모델 자발성에 100% 의존.
  - 왜: high — 대체의 최대 관문. 네이티브는 MEMORY.md 가 매 세션 주입된다.
  - 어떻게: ① index.ts 기동 시 instructions 끝에 `store.list().slice(0,40).map(m => '- ['+m.type+'] '+m.title+' — '+m.description)` 부착 ② 사용자 확인 후 Claude Code `SessionStart` 훅 등록 — `vault/MEMORY.md` 를 stdout 출력 (머신 설정 — 공통 규칙 7) ③ 브리지 파일(네이티브 memory/MEMORY.md) 패턴을 README 에 공식 문서화.
  - 검증: 새 세션에서 시스템 컨텍스트에 인덱스 항목이 보이는지 실확인 (①은 /mcp 재연결로, ②는 새 세션으로).

- [x] **T8. 프로젝트 스코핑** (E2, 대체 전략 ②) — 완료 2026-07-18
  - 무엇: 전역 단일 볼트에 recall/list 하드 필터가 없다 — 타 프로젝트 기억이 동점 1위로 끼어든다 (재현 확정, tags 는 가산점일 뿐 배제 불가).
  - 왜: high — 볼트가 다프로젝트로 성장하면 정밀도 단조 하락. 볼트 분리안은 교차 공유(BBM 존재 이유)를 죽여서 기각.
  - 어떻게: types.ts `project?: string` → vault.ts 직렬화/파싱(기본값 undefined = 전역) → store.search/list 에 `opts.project` 필터 `!m.project || m.project === opts.project` → index.ts remember/recall/list 스키마에 project 추가 → env `BIGBRAIN_PROJECT` 로 서버 기본값.
  - 검증: 프로젝트 A/B 기억 + 전역 기억 → A 필터 시 B 배제·전역 통과. 구버전 노트(project 없음) 파싱 무손상.

- [x] **T9. 실패의 가시화** (E3) — 완료 2026-07-18
  - 무엇: 잘못된 BIGBRAIN_VAULT 는 조용히 빈 볼트를 새로 만들고(경고 0), 기동 로그는 기억 수를 안 찍는다 — "기억 전무"가 정상처럼 보이고 볼트가 분열된다.
  - 왜: high — 드라이브 이동/오타 하나로 무소음 전체 소실. 네이티브(순수 파일)에는 없는 실패 모드.
  - 어떻게: ① 기동 로그에 `memories=<수>` 출력 ② writeIndex 시 `.bigbrain-vault` 마커 생성 ③ BIGBRAIN_VAULT 명시됐는데 마커도 기억도 없으면 stderr 경고 + instructions 첫 줄에 동일 경고 부착 (모델에게도 보이게).
  - 검증: 오타 경로 기동 → 경고 출력 + instructions 에 경고 포함 확인.

- [x] **T10. staleness 노출** (E4) — 완료 2026-07-18
  - 무엇: recall 결과에 시간 정보가 0개 — 120일 방치 기억이 아무 표시 없이 등장한다 (실측).
  - 왜: high — 모델이 낡은 코드 구조 기억을 최신으로 인용하는, 가장 조용히 사고 내는 격차. 네이티브의 "N days old" 리마인더 재현.
  - 어떻게: index.ts `brief()` 에 `age_days = floor((now − updated)/86400000)` + `stale_hint` (기본 30일 이상, `BIGBRAIN_STALE_DAYS` env). brief 를 searchHit/full 이 공유하므로 recall/read/list 일괄 반영.
  - 검증: updated 120일 전 노트 recall → age_days=120 + stale_hint 존재, 어제 노트 → hint 없음.

- [x] **T11. 조회 write 절감** (B) — 완료 2026-07-18
  - 무엇: 간격 게이트가 닫혀 있어도 조회마다 최대 8개 파일 재기록 + 서버 기동만 해도 MEMORY.md 재작성 — git/Obsidian/백업 churn, 손상 창 상시 개방.
  - 왜: medium — T2/T3 이후에도 불필요한 쓰기 자체가 위험면이자 소음.
  - 어떻게: ① 게이트 닫힘 + strength 무변경이면 write 생략 (accessCount/lastAccessed 는 다음 게이트 통과 시 일괄 반영 — 정확도 손실은 표시용 필드라 허용) ② MEMORY.md 는 타임스탬프 제외 내용 비교 후 변경 시에만 쓰기, 기동 시 regenerateIndex 는 인덱스 부재 시에만.
  - 검증: 게이트 내 조회 3회 → 파일 바이트 무변화. 기동 2회 → MEMORY.md mtime 불변.

## Phase P2 — 랭킹·검색 품질

- [x] **T12. 감쇠 시계에 최근성 복원** (C1 — 최대 이론 결함) — 완료 2026-07-18
  - 무엇: 활성 계산 4곳 전부 `now − created` — lastAccessed 는 어디서도 안 읽힌다. "어제 강화"와 "1년 방치"가 활성 완전 동일(−2.2364, 실측). 도구 설명의 "recency" 는 허위.
  - 왜: high — 오래됐지만 활발히 쓰는 핵심 기억이 방금 저장한 잡메모에 밀린다(5.75 vs 7.68 실측). reflect 도 어제 쓴 기억을 weakened 오분류.
  - 어떻게: 마지막 연습 항 분리 — `B = ln((n−1)·L^−d/(1−d) + t_last^−d)`, L=created 경과[h], t_last=lastReinforced 경과[h]. 실측 검증됨(A=−1.24, B=−2.34 — 정확식 방향·간격 근사, 순서 복원). 4개 호출처(store.ts:202,242,272,358) 일괄 교체. C4(어려움 보너스 오발동)는 자동 해소.
  - 검증: 감사 EXP1 시나리오 — 어제 강화 > 1년 방치 순위 역전 확인, reflect 오분류 해소.

- [x] **T13. weakened 임계 완화** (C2) — 완료 2026-07-18
  - 무엇: τ=−0.7 절대 고정 — n=1 은 16.2시간이면 weakened. 신생 볼트에서 reflect 가 하루 만에 전원 등재(3/3 실측).
  - 어떻게: created 후 72h 유예 + lastAccessed 7일 이내 제외 (T12 선행 시 후자는 자연 해소) + 절대 τ 와 하위 20% 분위 AND.
  - 검증: 신생 볼트 24h 후 reflect → weakened 0건, 진짜 방치(30일+무접근)만 등재.

- [x] **T14. 간격 게이트 확장형** (C3) — 완료 2026-07-18
  - 무엇: 고정 10분 창이라 11분 주기 기계 반복으로 강도 무한 부풀리기 가능 (30회→+30 실측, 감소 경로 없음).
  - 어떻게: `required = max(SPACING_MS, α·(now−created)/n)` (α≈0.1) 또는 지수 백오프. 최소 일일 상한 Δn≤3.
  - 검증: 11분 주기 30회 → Δn ≤ 상한 확인.

- [x] **T15. 검색 — 동의어·0건 폴백** (D1 + D2) — 완료 2026-07-18
  - 무엇: 표층 부분문자열 매칭이라 한↔영 교차(배포↔deploy) 0건, 0건이면 연상 확산도 진입 불가(시드 없음). 둘 다 재현 확정.
  - 왜: high — RECALL FIRST 의 실효를 깎는 최전선. 0건 응답이 remember 를 유도해 중복 생성까지 부추긴다.
  - 어떻게: ① 소형 한↔영 도메인 사전(배포:[deploy,deployment,release], 설정:[config], 서버:[server], 빌드:[build]...) 으로 질의 토큰 확장 ② keyword 0건 시 2차 패스 — 질의 vs 제목/태그 토큰을 tokenMatch 로 느슨 비교, overlap>0 을 시드로 1-hop 확산 ③ 0건 노트 문구를 "동의어/태그로 재질의하라" 로 교체 ④ remember 도구 설명에 "태그 한/영 병기" 지침.
  - 검증: '배포' 기억에 search('deploy') ≥1건, 링크망 있는 볼트에 search('출시') 가 연상 경유 반환.

- [x] **T16. 유사도·매칭 정밀화** (D3 + D4) — 완료 2026-07-18
  - 무엇: overlap 의 min 분모 + 무제한 양방향 접두 일치 → 1~2토큰 기억이 유사도 1.0, RIF 가 무관 기억을 반토막(11.52→5.76 실측), remember 가 무관 병합을 유도. 본문 indexOf 는 'cat'→concatenate 오탐(7.68점).
  - 어떻게: ① overlap 분모를 자카드로 + 세 소비처 임계 재보정(0.45/0.5/0.75 → ~0.3/0.35/0.55 실측 기반 조정) ② `min(|A|,|B|)<3` 이면 비교 스킵 ③ 접두 일치는 짧은 쪽 ≥3자 && 길이차 ≤2 ④ title/desc/tags/body 를 사전 토큰화해 tokenMatch 비교 (indexOf 제거).
  - 검증: 감사 오탐 사례 4종('부산/부산물', '서버리스/서버', 1토큰 RIF, 'cat') 전부 해소 + 조사 흡수('배포를'→'배포') 는 유지.

- [x] **T17. recall 응답 개선** (D5 + D6 + D7) — 완료 2026-07-18
  - 어떻게: ① `totalMatched`(컷오프 전 총 매칭 수) 응답 포함 + 연상 상한 `ceil(limit/2)` ② 스코어링·스니펫 전에 body 에서 `[[위키링크]]`/'## 연관 기억' 제거 사본 사용 ③ 스니펫은 토큰 커버 최대 윈도 선택.
  - 검증: 20건 볼트 기본 질의 응답에 totalMatched=20, include_linked:false 에서 링크 유래 매칭 0건.

- [x] **T18. 강화 정밀화** (C5 + C6) — 완료 2026-07-18
  - 어떻게: ① inhibited 결과·연상 결과는 reinforce 제외 ② revise 강화를 간격 게이트 뒤로 + 순수 메타데이터 편집(내용·confidence 무변경) 은 강화 제외 ③ reflect 출력에 "confidence 높아 후보 제외된 장기 방치 N건" 카운트 추가 (C6 의도 유지하며 실효 보강).
  - 검증: 근사중복 검색 시 패자 강도 불변, 연속 revise 2회 → +1 만.

## Phase P3 — 선택

- [x] **T19. consolidate 프롬프트** (E6) — 완료 2026-07-19: `server.registerPrompt('consolidate', ...)` — reflect→비교→병합→forget→link→재확인 절차. Claude Code 에서 `/mcp__bigbrainmemory__consolidate` 로 노출.
- [x] **T20. import-native.mjs** (E5) — 완료 2026-07-19: 매핑 고정(user→preference, feedback→procedural|preference, project→semantic|episodic, reference→semantic+source), `project:` 태그 부여(T8 연동), 동일 source 스킵(멱등).
- [x] **T21. 성능·이식성** (F1~F4) — 완료 2026-07-19: 기동 시 id→slug 인덱스(1000건 볼트 resolve 418ms→상수시간), history 최근 50개 캡, today() 로컬 날짜, makeSlug 예약명 회피(`con_`).
- [ ] **T22. 로컬 임베딩 하이브리드** (D1 장기): keyword 0건 시 벡터 유사도 폴백.

---

## 진행 로그

| 날짜 | 작업 | 결과 |
|---|---|---|
| 2026-07-18 | 감사 완료 (47건 확정) + 본 계획 수립 | docs/native-parity-audit.md |
| 2026-07-18 | 네이티브 5건 이관 + 브리지 전환 (SimpleMailServer) | 대체 전략 ④ 실증 |
| 2026-07-19 | **T21** 성능·이식성 | F1 `resolve(id)` 에 id→slug 캐시 — 실측 **140ms → 0.56ms**(250배), 없는 id 는 384ms → **1ms**. 캐시 미스가 "정말 없음" 인지 "다른 프로세스가 추가함" 인지 구분하려고 전량 재파싱 대신 **파일 수만 세어**(readdir 2회) 볼트 변화를 감지 — 정확성을 지키면서 부정 조회도 빠르다(테스트로 신규 추가·forget 이동·삭제 3종 검증). F4 history 상한 50줄 + 접힌 줄 수 누적 표시(80회 교정 후 2,354B). F2 `today()` 로컬 날짜(저장 타임스탬프는 UTC ISO 유지 — 활성 계산이 쓰므로). F3 Windows 예약 장치명 `con_` 회피 + 끝 마침표·공백 제거(예약어를 포함할 뿐인 정상 제목은 무영향). 회귀 `scripts/regress-perf.mjs` 신설(24건) — 전체 363✔/0✘ |
| 2026-07-19 | **T20** import-native.mjs | 매핑 고정(user→preference, feedback→procedural\|preference 본문 판단, project→semantic\|episodic 본문 판단, reference→procedural) + 판단 근거 출력. `project` 스코프에 프로젝트 슬러그 부여(T8 연동), `source: native:<프로젝트>/<파일>` 로 **멱등**(재실행 시 건너뜀). **계획 대비 강화**: `--apply` 없이는 쓰지 않는 미리보기가 기본값(안전 기본값), `--projects-dir`/`--vault` 주입으로 테스트 가능. 제목을 원본 `name` 그대로 써 본문 `[[위키링크]]` 보존. 회귀 `scripts/regress-import.mjs` 신설(32건, 라이브 볼트·네이티브 양쪽 무접촉). 실환경 미리보기 실행 결과 대상 0건(브리지 MEMORY.md 는 제외 대상) — 전체 337✔/0✘ |
| 2026-07-19 | **T19** consolidate 프롬프트 | `server.registerPrompt('consolidate')` — Claude Code 에서 `/mcp__bigbrainmemory__consolidate` 로 노출. reflect 의 **모든 출력 항목**(duplicates/forget_candidates/trusted_but_faded/low_confidence/orphans)에 대한 처리 지침 + 파괴적 조치 안전장치(애매하면 forget 대신 revise) + staleness 대조 지침 + 재확인 단계. 회귀 `scripts/regress-prompt.mjs` 신설(26건, 실제 스폰 후 listPrompts/getPrompt 검증) — 전체 305✔/0✘ |
| 2026-07-18 | **P2 완료** — 랭킹·검색 품질 7/7 | T12~T18. 회귀 테스트 10종 279✔/0✘ |
| 2026-07-18 | **T18** 강화 정밀화 | RIF 로 억제된 경쟁자와 연상 이웃을 강화에서 제외(C5) — 종전에는 순위를 눌러놓고 같은 델타를 줘서 중복 쌍이 영원히 동률로 갔다. revise 가 간격 게이트를 준수하도록 변경(C6, 종전 몇 초 안 2회면 1→3) + 순수 메타데이터 편집(태그만 변경)은 강화 제외. reflect 에 `trustedButFaded` 노출 — 약해졌지만 확신도가 높아 망각 후보에서 제외된 건수(P6 보수 설계는 유지하되 정리 판단 재료 제공). 회귀 6~9절 추가 — 전체 279✔/0✘ |
| 2026-07-18 | **T17** recall 응답 개선 | `searchDetailed()` 가 `{results, totalMatched}` 반환 → MCP 응답에 `total_matched` 와 컷오프 시 `truncated` 안내(20건 중 5건 표시 실측). 연상 상한을 `ceil(limit/2)` 로 비례화(종전 고정 3). `stripLinkSection()` 으로 `## 연관 기억`·`[[위키링크]]` 를 검색·스니펫에서 제외(D6) — 링크만 걸린 무관 기억이 직접 매칭되던 문제 해소. 스니펫은 첫 토큰 첫 등장 → **토큰 커버리지 최대 윈도**(150자), 동점 시 앞선 위치로 결정적 선택. **버그 하나 잡음**: 초기 구현이 `spots` 순회 순서로 동점을 갈라 어순 의존이 남아 있었다(A≠B). 기존 49개 `search()` 호출부를 지키려 배열 반환 편의 래퍼를 유지 — 기계적 수정 49곳의 위험 회피. 회귀 13~16절 추가 — 전체 268✔/0✘ |
| 2026-07-18 | **T16** 유사도·매칭 정밀화 | overlap 분모 min → **자카드**, 3종 임계 재보정(0.45/0.5/0.75 → 0.3/0.35/0.6, 같은 크기 집합 환산값), 3토큰 미만 집합은 비교 제외. tokenMatch 는 무제한 접두 → **조사 명시 스트리핑**(34개) + 복합어는 3자·길이차2 제한. 검색 필드를 사전 토큰화(includes/indexOf 제거). **계획 대비 판단**: 감사가 제안한 "짧은 쪽 3자 이상" 단독 규칙은 `배포를→배포` 같은 2글자 조사 흡수를 깨뜨려, 감사의 다른 제안인 조사 스트리핑을 채택. 감사 오탐 4종 전부 해소(`cat`→concatenate, 서버리스/서버, 부산/부산물, 1토큰 메모의 대량 억제) + 진짜 근접 중복은 similar·duplicates·RIF 모두 계속 탐지. 회귀 8~12절 추가 — 전체 257✔/0✘ |
| 2026-07-18 | **T15** 검색 동의어·0건 폴백 | 24개 그룹 한↔영 도메인 사전 + `BIGBRAIN_SYNONYMS` 사용자 사전으로 질의 토큰 확장(동의어는 0.6 가중이라 정확 일치가 상위 유지). 직접 매칭 0건이면 제목·태그·설명을 토큰화해 **느슨한 접두 비교**로 시드를 만들어 연상 확산 진입(D2) — 종전에는 0건이면 링크망이 있어도 확산 자체가 불가능했다. recall 0건 응답 문구를 remember 유도 → **재질의 유도**로 교체(중복 저장 방지). 감사 실패 사례 전부 해소: `deploy`/`디플로이`/`release`→배포 기억, `config`→설정 기억, 역방향 `배포`→영어 기억. 회귀 `scripts/regress-search.mjs` 신설(18건, 오탐 방지·정밀도 보존 포함) — 전체 246✔/0✘ |
| 2026-07-18 | **T14** 간격 게이트 확장형 | 고정 10분 창 → `required = max(기본창, α·나이/n)` (α 기본 0.1, `BIGBRAIN_SPACING_ALPHA`, 0 이면 종전 동작). 감사 재현(하루 된 기억에 11분 주기 30회): **1→31 이던 부풀리기가 1→1 로 완전 차단**. 영구 잠금이 아님도 고정(필요 간격 2.4h 를 채우면 정상 강화). 매일 쓰는 정상 패턴은 계속 강화됨(5일 → n≥4). **연쇄 수정**: 확장 간격이 T12 4절의 전제(게이트가 열려 delta 관측 가능)를 깨뜨려, 두 시나리오 모두 게이트가 열리도록 재설계(created 24h·n=10·20분 대기 vs 1년·n=5·1년 방치). 회귀 `scripts/regress-spacing.mjs` 신설(8건) — 전체 228✔/0✘ |
| 2026-07-18 | **T13** weakened 임계 완화 | 절대 τ 단일 조건 → **유예기간(기본 72h, `BIGBRAIN_WEAKENED_GRACE_H`) + 활성 하위 분위(기본 20%, `BIGBRAIN_WEAKENED_RATIO`)** 를 AND. 감사 재현 조건(17h/24h/3일 신생 3건)에서 **3/3 전원 등재 → 0건**. 볼트가 작으면 분위 상한이 0이라 자연히 조용해지고, 10건 볼트에서는 방치 2건을 정확히 집는다. `forgetCandidates` 는 확신도 게이트가 이미 강하므로 분위 상한은 빼고 유예기간만 적용. T12 3절의 "방치 탐지" 단언은 분위 상한과 충돌해(2건 볼트→상한 0) C1 고유 성질(활성 순서)만 보도록 정리하고, 분류기 검증은 8절(10건 볼트)로 이관. 회귀 8·9절 추가 — 전체 220✔/0✘ |
| 2026-07-18 | **T12** 감쇠 시계 최근성 복원 | `B = ln((n−1)·L^−d/(1−d) + t_last^−d)` 로 교체, 호출 4곳을 `activationOf(m, now)` 헬퍼로 통일. 실측: 어제 강화 −1.24 vs 1년 방치 −2.34 (종전 둘 다 −2.2364로 동일) — 감사 산출값과 일치. **계획에 없던 필수 동반 수정**: 새 식은 n=1 구간에서 종전 근사식의 상수항 `ln(2)` 가 빠져 척도가 통째로 내려간다. τ(−0.7)와 어려움 임계(0.5)를 **같은 폭만큼** 내려 종전 판정을 보존했다(검산: n=1 이 τ 를 밑도는 시점이 종전과 동일한 16.2시간). 이 재보정 없이는 reflect 가 어제 쓴 기억까지 weakened 로 오분류한다. C4(어려움 보너스)는 최근성 반영으로 해소 — 동일 created·n 에서 마지막 강화 시점만으로 판정이 갈리는 것을 테스트로 고정. **사고 1건**: PowerShell 텍스트 치환으로 store.ts 의 UTF-8 한글이 깨져 `git checkout` 으로 복원 후 Edit 도구로 재작업(이후 소스 편집은 Edit 도구만 사용). 회귀 `scripts/regress-activation.mjs` 신설(17건) — 전체 212✔/0✘ |
| 2026-07-18 | **P1 완료 — 대체 선언 가능** | P0+P1 11/11. 회귀 테스트 8종 195✔/0✘ |
| 2026-07-18 | **T11** 조회 write 절감 | 간격 게이트가 닫혀 delta=0 이면 `reinforce` 가 쓰기를 생략(`BIGBRAIN_FLUSH_EVERY_ACCESS=1` 로 종전 동작 복원 가능). `MEMORY.md` 본문의 생성 시각 제거 + 내용 동일 시 `writeIndex` 생략 → 서버 기동만으로 diff 생기던 문제 해소. **테스트 강화**: 게이트가 닫히면 A 가 아예 안 써서 A4 경쟁 테스트가 공허해지므로, `raceOnce` 가 `last_reinforced` 를 되감아 **실제로 write-back 이 일어나는 위험 경로**를 검증하도록 수정. 소실률 측정도 부수효과 없는 파일 직접 읽기로 변경(기대 600/실측 600). 회귀 `scripts/regress-quiet-read.mjs` 신설(10건) — 전체 195✔/0✘ |
| 2026-07-18 | **T10** staleness 노출 | `ageInfo()` 가 `updated`/`age_days`/`stale_hint`(기본 30일, `BIGBRAIN_STALE_DAYS`) 를 `brief()` 에 주입 → recall·read_memory·list_memories 일괄 반영. instructions 에 "기억은 시점 관측이지 현재 상태가 아니다 — 코드/경로/버전 인용 시 대조 후 사용" 지침 추가. **버그 하나 잡음**: `Number(env) \|\| 기본값` 이 `0` 을 falsy 로 먹어 임계 0 설정이 무시됐다 — 저장소가 `SPACING_WINDOW_MS` 에서 쓰는 관용구로 통일(`INDEX_LIMIT` 도 동일 수정, 0 이면 인덱스 생략). 회귀 `scripts/regress-staleness.mjs` 신설(17건) — 전체 185✔/0✘ |
| 2026-07-18 | **T9** 실패의 가시화 | 기동 로그에 `memories=N archived=N quarantined=N(!) project=X`, `.bigbrain-vault` 마커(`writeIndex` 시 생성), `vault.inspect()` 진단. BIGBRAIN_VAULT 가 지정됐는데 기억 0 + 마커 없음이면 stderr **와 instructions 첫머리** 양쪽에 경고("중복 저장 금지"). 격리 파일 존재 시 별도 알림. **버그 하나 잡음**: `regenerateIndex`→`writeIndex`→`markVault` 가 main 의 경고 판정보다 먼저 실행돼 stderr 경고가 사라졌다 — 기동 시점에 한 번만 계산(`VAULT_WARNING` 상수)해 두 채널을 일치시킴. 회귀 4~7절 추가(오타 경로/정상 볼트 오경보/마커 있는 빈 볼트/격리 알림) — 전체 168✔/0✘ |
| 2026-07-18 | **T8** 프로젝트 스코핑 | `project?: string` 필드 + `inScope()` 필터(`!m.project \|\| m.project === scope`) 를 search·연상확산·list 에 적용, remember/recall/list/revise 스키마에 노출, `BIGBRAIN_PROJECT` 서버 기본값. **계획 대비 판단**: remember 에서 `project` 생략 시 서버 스코프를 **몰래 씌우지 않음** — 씌우면 "전역이면 생략" 이라는 도구 설명과 모순되고 사용자 선호 같은 범용 지식이 한 프로젝트에 갇혀 조용히 회상되지 않는다. 대신 instructions 에 현재 스코프와 저장 지침을 실어 모델이 명시적으로 판단하게 함. 회귀 `scripts/regress-scoping.mjs` 신설(24건, 구버전 노트 하위 호환·연상 누수 차단·MCP 계층 포함) — 전체 155✔/0✘ |
| 2026-07-18 | **T7** 회상 트리거 삼중화 | ① `memoryIndexLines()` 가 기동 시 기억 인덱스(제목+설명+타입)를 instructions 에 부착, `BIGBRAIN_INDEX_LIMIT`(기본 40) 상한·총건수 안내·빈 볼트 명시. ② **사용자 승인 후** `~/.claude/settings.json` 에 SessionStart 훅 추가 — `vault/MEMORY.md` 를 `<bigbrainmemory-index>` 태그로 감싸 주입(`head -c 8000` 상한). 기존 Orca 훅 10종 무변경, 백업 `settings.json.bak-bbm-20260718`. 실제 실행해 3,224자 출력 확인. ③ README 에 3중 채널 문서화 + 죽은 `D:/` 경로 정리. 회귀 `scripts/regress-trigger.mjs` 신설(12건, `client.getInstructions()` 로 실제 스폰 검증) — 전체 131✔/0✘ |
| 2026-07-18 | **P0 완료** — 데이터 안전 6/6 | T1~T6 전부 통과. 회귀 테스트 4종 118✔/0✘ 로 감사 재현 시나리오 고정 |
| 2026-07-18 | **T6** revise 구본 스냅샷 | `vault.snapshotRevision()` — 덮어쓰기 전 `archive/revisions/<slug>.<ts>.md` 로 복사, slug 당 최근 3세대 유지(사전순=시간순 정렬로 만료). **내용이 실제로 바뀔 때만** 스냅샷(재확인 revise 는 낭비 안 함). 같은 밀리초 충돌 시 접미로 회피. 스냅샷 실패는 교정을 막지 않음(경고만). `listSlugs` 가 archive 를 재귀 탐색하지 않아 기억 목록·검색·reflect 에 안 섞임을 테스트로 고정. README 에 볼트 git 백업 권고 + 디렉터리 구조 갱신. 회귀 3·4절 추가 — 전체 118✔/0✘ |
| 2026-07-18 | **T5** YAML Date 허용 | `str()` 가 `Date` 인스턴스를 `toISOString()` 으로 수용(Invalid Date 는 기본값). 회귀 `scripts/regress-obsidian-edit.mjs` 신설(1·2절) — 인용 없는 `created: 2025-01-01T…`·날짜만 형식 `2025-02-02` 모두 보존, 기저활성 부풀림 없음, write-back 후에도 고착 안 됨, 기존 형식 왕복 무손실. 전체 105✔/0✘ |
| 2026-07-18 | **T4** remember 원자적 생성 | `vault.createNew()` 신설 — 직렬화를 `serialize()` 로 분리하고, 임시 파일에 내용을 다 쓴 뒤 `linkSync` 로 거는 방식(대상 존재 시 EEXIST)으로 **배타성과 내용 완전성을 동시에** 확보. `flag:'wx'` 직접 쓰기는 "빈 파일→내용" 창에 다른 프로세스가 절단으로 오인·격리할 수 있어 채택하지 않음. **추가 발견·수정**: supersede 블록이 최종 slug 확정 **전에** `supersededBy` 를 기록해, 충돌로 `-2` 가 붙으면 존재하지 않는 파일을 가리켰다 — 순서를 분리(신규 쪽 표시는 생성 전, 구 기억 역참조는 생성 후). 회귀 5·6절 추가 — 전체 97✔/0✘ |
| 2026-07-18 | **T3** reinforce 재읽기+증분 | 스냅샷 재직렬화 → 쓰기 직전 `vault.find` 재읽기 후 델타만 적용. 파일이 사라졌으면 write 생략(부활 방지), archive 로 이동했으면 그쪽에 기록. 강화를 **best-effort** 로 전환(쓰기 실패해도 회상은 계속 — T2 발견 사항 해소). 무의미해진 `opts.archived` 파라미터 제거. 회귀 `scripts/regress-concurrency.mjs` 신설(4절) — **강화 소실률 84~99.5% → 0.0%** (2프로세스×300회, 기대 602/실측 602), revise·forget 경쟁 보존 확인. 전체 83✔/0✘ |
| 2026-07-18 | **T2** 원자적 쓰기 | `writeFileAtomic`(같은 디렉터리 tmp → `renameSync`) 도입, `vault.write`/`writeIndex` 교체. 절단 감지는 T1 에서 선반영됨. 회귀 2절 추가(잔재 없음 / rename 실패 주입 시 원본 바이트 무변형) — 전체 67✔/0✘. **발견**: `MemoryStore.read` 가 내부 reinforce 의 쓰기 실패로 **조회 자체를 던진다**(디스크 만실·읽기전용 시 recall 전면 실패). 강화는 best-effort 여야 하므로 T3 에서 함께 처리 |
| 2026-07-18 | **T1** 손상 파일 파싱 격리 | `Vault.read` 가 예외 대신 null 반환 + `quarantine/` 이동(원본 바이트 보존), 빈 파일·절단 파일 사전 감지, `main()` regenerateIndex try/catch. **계획 대비 변경 2건**: ④ "id 부재 시 손상 간주"는 **미채택** — gray-matter 에 옵션 객체를 넘겨 캐시 경로 자체를 차단(A2 세탁 벡터가 구조적으로 소멸)했고, id 부재 판정은 frontmatter 없는 손수 작성 Obsidian 노트를 격리해버려 Obsidian 호환을 해친다(회귀 테스트 5번이 이를 방어). ⑤ "불확실 레코드 write 금지"는 read 가 null 을 반환하게 되어 자동 해소. 회귀 `scripts/regress-corruption.mjs` 21건 신설 — 전체 59✔/0✘ |
| 2026-07-18 | **T0** .mcp.json 죽은 경로 수정 | `D:/BigBrainMemory/dist/index.js` → `./dist/index.js`, `env.BIGBRAIN_VAULT` 제거(기본값 `<repo>/vault` 위임). 회귀 테스트 `scripts/regress-mcp-config.mjs` 신설 + `npm test` 에 편입 — 스모크 22 + 설정 11 전부 통과. 라이브 볼트 무변형(19건 유지) 확인. ※ 검증란의 "Claude Code 재시작 → /mcp 확인"은 세션 내 불가라 **동일 스폰 계약(cwd=저장소 루트, 같은 command/args)을 프로그램으로 재현**해 8개 도구 등록까지 확인하는 방식으로 대체함 — 사용자가 이 레포를 프로젝트로 열 때 최종 육안 확인 필요 |
