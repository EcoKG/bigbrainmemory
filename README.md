# BigBrainMemory 🧠

**Claude Code + Obsidian에서 영감을 받은, 사람처럼 기억하는 MCP 서버**

Claude Code가 세션을 넘어 기억하고, 회상하고, 잘못된 기억을 교정하며, 기억 사이를 연상으로 오갈 수 있게 하는 영속 기억(persistent memory) MCP 서버입니다. 모든 기억은 **Obsidian에서 그대로 열리는 마크다운 볼트**에 저장됩니다.

> **회상은 자동이 아닙니다.** MCP 서버에는 도구를 강제로 호출하는 장치가 없어서, `recall`은 모델이 스스로 부를 때만 실행됩니다. 그래서 "볼트에 무엇이 있는지"를 세션 컨텍스트에 노출하는 3중 채널을 씁니다 — [회상 트리거](#회상-트리거--무엇이-저장돼-있는지-알리기) 참조. 이게 이 프로젝트에서 가장 중요한 설정입니다.

## 이론적 기반

인간 기억·행동 연구(ACT-R, Bjork 신불용 이론, 재공고화, 간섭 이론, 인출유도망각, 오기억 등)를 조사해 **모순·과장·부적합을 걸러낸** 정제 리포트를 먼저 작성하고([docs/memory-model-report.md](docs/memory-model-report.md)), 그 원칙(P1~P8)에 따라 설계했습니다. 핵심은 **"인간 기억을 그대로 복제하지 않는다"** — 강점(적응적 망각·강화·연상)은 취하고 약점(오기억·출처혼동·왜곡)은 의도적으로 배제합니다.

이후 [교차검증 감사](docs/native-parity-audit.md)에서 47건의 결함이 확인돼 구현이 크게 바뀌었습니다(활성 수식, 간격 게이트, 검색, 파일 안전성). **리포트는 원칙 문서이고, 아래 표와 코드가 현행 동작입니다.** 진행 이력은 [GOAL.md](GOAL.md)에 있습니다.

## 핵심 개념 — 사람의 기억처럼, 그러나 더 낫게

| 인간의 기억 | BigBrainMemory 구현 | 근거 |
|---|---|---|
| 기억 유형 | `episodic` · `semantic` · `procedural` · `preference` | 다중기억체계 |
| **3축 분리** | ① `confidence` 진실성(revise로만 변경) ② `storage_strength` 저장강도(단조 증가) ③ 인출강도(저장하지 않고 질의 때 계산) — 자주 안 떠올라도 신뢰할 수 있고 그 반대도 성립 | Bjork 저장강도 ≠ 인출강도 |
| 거듭제곱 망각 | 기저활성 `B = ln( (n−1)·L^−d/(1−d) + t_last^−d )` — n=저장강도, L=생성 후 경과[시], t_last=**마지막 강화 후** 경과[시], d=0.5. 마지막 1회를 정확항으로 분리해 **빈도와 최근성이 함께** 반영된다 | ACT-R (지수식·에빙하우스 수치는 배제) |
| 회상 순위 | 키워드 점수 × 진실성 가중 `0.5+0.5·confidence` × 활성 가중 `0.55+0.9·σ(B)` | — |
| 간격효과 강화 | 필요 간격이 **확장**된다: `max(10분, α · 기억의 나이 / n)` (α 기본 0.1). 오래된 기억일수록 다음 강화까지 더 긴 간격을 요구한다 | 간격효과·검사효과 |
| 바람직한 어려움 | **능동 회상**(`recall`)이고 활성이 낮을 때만 +0.5 보너스. 최근 강화된 기억은 활성이 높아 자동으로 제외된다 | Bjork desirable difficulties |
| 적응적 망각 | 경쟁 유사 기억은 회상 순위에서 억제되고 **그 회상에서 강화도 받지 않는다**(저장된 값은 깎지 않음) | 인출유도망각(RIF) |
| 연상 작용 | `[[위키링크]]` 양방향. 확산은 상위 3건을 시드로 1-hop, 최대 `ceil(limit/2)`건. 연상으로 딸려온 기억은 강화하지 않는다 | 확산활성 |
| 재공고화 | `revise` — 덮어쓰기 **전에 구본을 스냅샷**(최근 3세대), 이력 보존. 강화는 간격 게이트를 지키고, 내용·확신도가 안 바뀐 편집은 강화하지 않는다 | 재공고화의 안전한 절반 |
| 망각 | `forget` — 삭제가 아닌 `archive/` 이동, 복원 가능 | 가역적 망각 |
| **인간 약점 역보완** | verbatim 저장 + `source` 출처 필드 + 파괴적 자동병합 금지 | 오기억/출처혼동 배제 |
| 메타인지 | `reflect` — 약해진 기억(유예 72h + 활성 하위 20% **동시 충족**)·망각 후보·중복·고립 점검. 제안만 하고 자동삭제 없음 | — |

## 저장 구조 (Obsidian 볼트)

```
vault/
├── MEMORY.md              # 자동 생성 인덱스 (Obsidian 허브 노트)
├── .bigbrain-vault        # 볼트 마커 — 경로 오타 감지에 쓰임
├── memories/              # 활성 기억 — 기억 1건 = 마크다운 1개
│   └── 사용자는-typescript-strict-모드를-선호한다.md
├── archive/               # 망각된 기억 (사유 기록, 복원 가능)
│   └── revisions/         # revise 직전 구본 (기억당 최근 3세대) — 필요할 때 생성
└── quarantine/            # 손상 감지된 파일 (원본 바이트 보존) — 필요할 때 생성
```

`memories/`와 `archive/`는 첫 실행에 만들어지고, `revisions/`·`quarantine/`은 해당 상황이 생겨야 만들어집니다.

실제로 생성되는 노트:

```markdown
---
id: mem-mrqiibrg9btj
title: 사용자는 TypeScript strict 모드를 선호한다
description: '코드 리뷰에서 항상 strict: true 설정을 요구했다.'
type: preference
tags:
  - typescript
  - 코딩스타일
confidence: 0.75
storage_strength: 1
status: active
created: '2026-07-18T15:19:01.899Z'
updated: '2026-07-18T15:19:01.933Z'
last_accessed: '2026-07-18T15:19:01.899Z'
last_reinforced: '2026-07-18T15:19:01.899Z'
access_count: 0
links:
  - bigbrainmemory-프로젝트-구조
history:
  - '2026-07-18: created (source: 코드 리뷰 대화)'
source: 코드 리뷰 대화
---

사용자는 기본적으로 strict: true를 선호하지만, 레거시 프로젝트에서는 예외를 허용한다.

## 연관 기억
- [[bigbrainmemory-프로젝트-구조]] — 같은 프로젝트 맥락
```

조건부로만 붙는 키: `source`(출처), `project`(스코프), `supersedes`/`superseded_by`(대체 관계), `archive_reason`(망각 사유).

`vault/`를 Obsidian 볼트로 열면 `memories/`의 연상 네트워크를 그래프 뷰로 볼 수 있습니다. `archive/`·`quarantine/`의 노트도 함께 보이므로, 활성 기억만 보려면 그래프 필터에서 제외하세요.

## 볼트를 직접 편집할 때

**편집해도 됩니다** — 그게 마크다운으로 저장하는 이유입니다. 다만 몇 가지를 알아두세요.

- **인용부호 없는 날짜는 안전합니다.** `created: 2025-01-01` 처럼 써도 보존됩니다.
- **알려진 키만 읽습니다.** 직접 추가한 임의 frontmatter 키(예: Obsidian 플러그인이 넣는 `cssclass`)는 다음 쓰기 때 사라집니다. 보존이 필요한 정보는 본문에 두세요.
- **`MEMORY.md`는 손대지 마세요.** 쓰기 연산마다 전량 재생성됩니다.
- **손상되면 자동 격리됩니다.** 빈 파일, 닫는 `---`가 없는 파일(쓰기 도중 절단), frontmatter 파싱 실패 — 세 경우에 해당 파일이 `quarantine/<slug>.<타임스탬프>.md`로 **이동**합니다. 원본 바이트는 그대로 보존되고, 나머지 기억과 서버는 정상 동작합니다. 서버 기동 로그에 `quarantined=N(!)`으로 알립니다. 고친 뒤 `memories/`로 되돌리면 다시 읽힙니다.

### 잘못된 교정 되돌리기

`revise`는 본문을 즉시 덮어씁니다. 모델이 옳은 기억을 잘못 "정정"할 수 있으므로 **덮어쓰기 직전 원본을 스냅샷**으로 남깁니다.

- 위치: `vault/archive/revisions/<slug>.<타임스탬프>.md` (파일명 사전순 = 시간순)
- 보관: **기억당 최근 3세대**. 4번째 교정이 들어오면 가장 오래된 것이 지워집니다
- 본문이 실제로 바뀔 때만 남깁니다 — 확신도만 조정하는 재확인은 스냅샷을 만들지 않습니다
- 되돌리려면 원하는 세대를 `memories/<slug>.md`로 복사하면 됩니다

> **백업 권고** — 볼트는 순수 파일이므로 `git init` 후 주기적으로 커밋해 두면 어떤 교정도 되돌릴 수 있습니다. `archive/revisions/`는 3세대짜리 안전망이지 백업이 아닙니다.

## 제공 도구 (8개)

기억을 반환하는 **모든 응답**에 공통으로 실리는 필드: `id` · `slug` · `title` · `description` · `type` · `tags` · `confidence` · `storage_strength` · `status` · `access_count` · `source` · `project` · `links` · `updated` · **`age_days`** · 그리고 30일 이상 갱신되지 않았으면 **`stale_hint`**(현재 코드와 대조하라는 경고).

| 도구 | 파라미터 | 비고 |
|---|---|---|
| `remember` | `title` `content` `type` / `description` `tags` `links` `confidence` `source` `project` `supersedes` | 유사 기억이 있으면 `similar_existing_memories`로 알려 중복 대신 `revise`를 유도. **`project`를 생략하면 전역 기억**이 됩니다(서버 스코프를 자동으로 씌우지 않음) |
| `recall` | `query` / `type` `limit`(1~20, 기본 5) `include_linked`(기본 true) `project` | 응답에 `total_matched`(컷오프 전 총 건수)와 잘렸을 때 `truncated` 안내. 결과별로 `score` `activation` `inhibited` `snippet`. 0건이면 재질의를 유도하는 `note` |
| `read_memory` | `id` (슬러그 또는 id) | 전문(`body`)과 `history`까지. 읽으면 강화되지만 능동 회상보다 약합니다 |
| `revise` | `id` `reason` / `content` `title` `description` `tags` `confidence` `source` `project` | 사유 필수(이력에 기록). `project: ""`로 전역으로 되돌릴 수 있습니다 |
| `forget` | `id` `reason` | `archive/`로 이동, 사유 기록 |
| `link` | `source` `target` / `relation` | 양방향 위키링크. `relation`은 본문 `## 연관 기억`에 라벨로 남습니다 |
| `reflect` | (없음) | `weakened_hard_to_recall` · `forget_candidates` · **`trusted_but_faded`**(약해졌지만 확신도가 높아 후보에서 제외된 건수) · `low_confidence` · `possible_duplicates` · `orphans_without_links` |
| `list_memories` | `type` `status`(active/superseded/archived) `project` | 최근 갱신순 |

서버 `instructions`에는 행동 수칙(recall 먼저 → remember → 모순되면 revise/forget → 주기적 reflect)에 더해 **기억 인덱스**, 프로젝트 스코프 안내, 나이 해석 지침이 함께 실립니다.

### 정리 프롬프트

`reflect`는 후보만 내놓습니다. 실제 정리(중복 병합·낡은 사실 교정·고아 연결)까지 이어가려면 Claude Code에서 슬래시 커맨드를 부르세요:

```
/mcp__bigbrainmemory__consolidate
```

`reflect`의 모든 출력 항목에 대한 처리 절차가 로드됩니다 — 중복 쌍을 양쪽 다 읽고 비교해 병합, 망각 후보를 현재 사실과 대조, 고아를 연결, 마지막에 재확인. 파괴적 조치에는 안전장치가 걸려 있습니다(애매하면 `forget` 대신 `revise`로 확신도를 낮추도록).

## 회상 품질

검색은 임베딩 없는 토큰 매칭입니다. 그 한계를 메우는 장치가 셋 있습니다 — 그리고 임베딩을 쓰지 않는 것은 실측에 근거한 선택입니다.

**한↔영 동의어 자동 확장** — 내장 24개 그룹(배포↔deploy↔release↔출시, 설정↔config, 빌드↔build …)으로 질의 토큰을 넓힙니다. "배포"로 저장한 기억을 `deploy`로 찾아도 나옵니다. 조사가 붙어도 됩니다 — "배포를 하려면"도 어간으로 사전을 탑니다. 동의어로만 맞은 토큰은 0.6배 가중이라, 같은 조건이면 정확히 일치한 기억이 위로 옵니다. 팀·회사 고유 용어는 `BIGBRAIN_SYNONYMS`로 덧붙이세요.

**조사·복합어 흡수** — "모드를"은 "모드"에, "릴리스노트"는 "릴리스"에 붙습니다(짧은 쪽 3자 이상 + 길이차 2 이하). 단어 경계는 지키므로 "서버리스"가 "서버"를, "인증서"가 "인증"을 끌어오지는 않습니다. 그래도 0건이면 응답의 `note`가 **재질의를 유도**합니다(remember를 곧장 권하지 않습니다 — 표현만 어긋난 기억을 중복 저장하게 되니까요).

**낡음 표시** — 모든 결과에 `age_days`가 붙고, 30일(`BIGBRAIN_STALE_DAYS`) 이상 갱신되지 않았으면 `stale_hint`가 "현재 코드와 대조 후 사용하라"고 알립니다. 기억은 시점 관측이지 현재 상태가 아니기 때문입니다.

**임베딩은 쓰지 않습니다 — 재본 뒤 기각했습니다.** 2026-07-19 에 로컬 임베딩 도입을 실측 평가한 결과, 남은 검색 실패 중 임베딩이라야 잡히는 "순수 의미 격차"는 17건 중 3건뿐인 반면 비용은 설치 512MB·세션당 +1초였습니다(MCP 서버는 세션마다 새로 뜨므로 콜드스타트가 곧 체감 지연입니다). 작은 영어 모델로 가볍게 시작하는 절충안은 한국어에서 오작동해 봉쇄됩니다 — 한↔영 정답 쌍 10건이 전부 무관 쌍보다 낮게 나왔습니다. 근거와 재평가 조건은 [GOAL.md](GOAL.md) T22 참조.

## 설치 및 실행

```bash
npm install
npm run build
npm test          # 스모크 1종 + 회귀 14종 (총 363개 단언)
```

`npm test`는 실제 stdio MCP 서버를 띄우고 임시 볼트에 파일을 쓰므로 수십 초 걸립니다. 개별 실행:

```bash
npm run test:smoke        # 전체 기억 사이클
npm run test:hook         # 세션 훅 볼트 해석·무저장 감지
npm run test:config       # .mcp.json 스폰 계약
npm run test:corruption   # 손상 파일 내성
npm run test:concurrency  # 다중 프로세스 경합
npm run test:edit         # 손편집·revise 스냅샷
npm run test:trigger      # 회상 트리거·볼트 경고
npm run test:scoping      # 프로젝트 스코핑
npm run test:staleness    # 나이 노출
npm run test:quiet        # 조회 부작용
npm run test:activation   # 기저활성·임계
npm run test:spacing      # 확장 간격·강화
npm run test:search       # 동의어·조사 흡수·정밀도
npm run test:prompt       # consolidate 프롬프트
npm run test:import       # 네이티브 이관
npm run test:perf         # id 캐시·이력 상한·예약명
```

## 네이티브 메모리에서 이관

Claude Code의 프로젝트별 메모리(`~/.claude/projects/<슬러그>/memory/*.md`)를 볼트로 옮깁니다.

```bash
npm run import:native              # 미리보기 — 아무것도 쓰지 않습니다
npm run import:native -- --apply   # 실제 이관
```

- 타입 매핑: `user`→preference, `feedback`→procedural(실행 지침이 있으면)/preference, `project`→episodic(시점·사건)/semantic, `reference`→procedural. **왜 그 타입이 됐는지 항상 출력**하므로 확인하고 `revise`로 고칠 수 있습니다.
- 프로젝트 슬러그가 `project` 스코프로 들어갑니다.
- `source`에 원본 경로를 남겨 **멱등**합니다 — 여러 번 돌려도 중복되지 않습니다.
- 제목은 원본 `name`을 그대로 써서 본문의 `[[위키링크]]`가 유지됩니다.
- 경로 지정: `--projects-dir <경로>` `--vault <경로>`

이관 후 원본은 지우지 말고 아카이브해 두고, 네이티브 `memory/MEMORY.md`는 "`recall`로 조회" 안내로 바꿔 [브리지](#회상-트리거--무엇이-저장돼-있는지-알리기)로 남기는 것을 권합니다.

## Claude Code에 등록

**이 프로젝트에서만** — 저장소의 [.mcp.json](.mcp.json)이 자동 적용됩니다.

**모든 프로젝트에서 (권장)** — 기억은 프로젝트를 넘나들 때 가치가 커집니다. `<저장소경로>`는 클론한 실제 경로로 바꾸세요:

```bash
claude mcp add --scope user bigbrainmemory -- node <저장소경로>/dist/index.js
```

**볼트 위치 변경** — 기존 Obsidian 볼트를 쓰려면 `BIGBRAIN_VAULT`를 지정합니다. 지정하지 않으면 `<저장소경로>/vault`가 기본값입니다:

```bash
claude mcp add --scope user -e BIGBRAIN_VAULT="C:/Users/me/MyObsidianVault/BigBrain" bigbrainmemory -- node <저장소경로>/dist/index.js
```

> 새 경로를 처음 지정하면 볼트가 비어 있으므로 **첫 실행에 경고가 뜹니다** — 정상입니다. 기억을 하나 저장하면 사라집니다. 이 경고는 경로 오타나 드라이브 이동으로 기억이 조용히 "사라진" 것처럼 보이는 상황을 잡기 위한 것입니다(stderr와 모델 컨텍스트 양쪽에 표시되고, "확인 전까지 중복 저장하지 말라"고 지시합니다). 볼트를 옮길 때는 **디렉터리 전체를 함께 옮기세요** — `MEMORY.md`와 마커 파일도 볼트 안에 있습니다.

## 프로젝트 스코핑 — 격리와 공유를 함께

기억은 하나의 볼트에 모이지만, 프로젝트별로 갈라 볼 수 있습니다.

- **`project` 없는 기억 = 전역** — 어느 프로젝트에서도 회상됩니다. 사용자 선호, 일반 워크플로처럼 따라다녀야 할 지식에 씁니다.
- **`project` 있는 기억 = 해당 프로젝트 전용** — 다른 프로젝트의 회상을 오염시키지 않습니다.
- `recall`·`list_memories`는 **그 프로젝트 기억 + 전역 기억**을 반환합니다. 나머지 도구(`read_memory`·`revise`·`forget`·`link`·`reflect`)는 슬러그·id로 직접 지정하거나 볼트 전체를 보므로 스코프를 적용하지 않습니다.

프로젝트별 `.mcp.json`에 기본 스코프를 지정합니다:

```json
{
  "mcpServers": {
    "bigbrainmemory": {
      "command": "node",
      "args": ["<저장소경로>/dist/index.js"],
      "env": { "BIGBRAIN_PROJECT": "my-app" }
    }
  }
}
```

- 스코프가 지정되면 서버 instructions에 현재 스코프와 저장 지침이 함께 실립니다.
- **`remember`는 예외입니다** — `project`를 생략하면 서버 스코프가 자동으로 붙지 **않고** 전역 기억이 됩니다. 이 프로젝트 전용 사실이면 모델이 `project`를 명시해야 합니다. 반대로 하면(자동으로 씌우면) 사용자 선호 같은 범용 지식이 한 프로젝트에 갇혀 다른 곳에서 조용히 회상되지 않습니다.
- 전체 프로젝트를 뒤지려면 `recall`·`list_memories`에 `project: ""`를 넘깁니다.
- `BIGBRAIN_PROJECT`를 지정하지 않으면 전체가 조회됩니다.

볼트를 프로젝트마다 따로 두는 방법(`BIGBRAIN_VAULT` 분리)도 있지만, 그러면 교차 프로젝트 지식을 공유할 수 없습니다 — 그게 이 서버를 쓰는 이유이므로 권장하지 않습니다.

## 회상 트리거 — "무엇이 저장돼 있는지" 알리기

저장해도 **꺼내 쓰지 않으면 없는 것과 같습니다.** `recall`은 모델이 스스로 부를 때만 실행되므로, 볼트 내용을 세션 컨텍스트에 노출하는 3중 채널을 씁니다. 하나만 써도 되지만 병행할수록 확실합니다.

**① 서버 instructions (자동, 설정 불필요)**
서버가 기동할 때 기억 인덱스(제목 + 한 줄 설명 + 타입)를 instructions 끝에 붙여 보냅니다. `BIGBRAIN_INDEX_LIMIT`(기본 40)으로 건수를 조절하고, `0`이면 목록을 생략합니다(스코프 안내는 유지). 스코프가 설정돼 있으면 그 프로젝트 기억과 전역 기억만 실립니다.
한계: **서버 기동 시점 스냅샷**이라 그 뒤에 저장한 기억은 재시작 전까지 인덱스에 없습니다(단, `recall`로는 즉시 조회됩니다).

볼트가 비어 있으면(콜드 스타트) 인덱스로 노출할 것이 없으므로, 그 자리를 **행동 지시로 대체**합니다 — "빈 `recall` 결과는 기억이 불필요하다는 증거가 아니다", "트리거가 걸리면 세션 끝까지 미루지 말고 그 즉시 저장하라". 종전에는 이 상황에서 한 문장만 나가고 스코프 안내마저 빠졌는데, 설득이 가장 필요한 시점에 가장 약하게 말하는 역전이었습니다.

**② 세션 훅 (항상 최신 + 무저장 감지) — 명령 한 번으로 설치**

```bash
npm run setup:hook                    # 설치 (백업 후 적용)
npm run setup:hook -- --dry-run       # 무엇이 바뀌는지만 확인
npm run setup:hook -- --remove        # 제거
npm run setup:hook -- --vault <경로>     # 볼트 경로 직접 지정
npm run setup:hook -- --settings <경로>  # 대상 settings.json 지정(프로젝트 스코프 등)
```

훅 **두 개**를 한 벌로 등록합니다.

| 훅 | 역할 |
|---|---|
| `SessionStart` | 매 세션 시작 시 `MEMORY.md`를 주입합니다. 채널 ①이 기동 시점 스냅샷인 반면 이쪽은 **항상 최신**입니다. |
| `Stop` | 세션 동안 **새로 저장된 기억이 0건이면 경고**합니다. 무저장 세션이 조용히 지나가지 않게 하는 안전망입니다. |

**Stop 훅이 중요한 이유:** 채널 ①②③은 전부 *회상* 쪽 대책이라, "저장돼 있는 걸 알아보게" 할 뿐 **저장을 일으키지는 않습니다.** 저장 쪽에는 강제 수단이 instructions 산문뿐이라, 실제로 durable한 결정을 여러 건 확정하고도 `remember`를 한 번도 부르지 않는 세션이 발생합니다. Stop 훅은 호스트가 강제 실행하므로 이를 잡아내는 **유일한 수단**입니다.

두 훅의 본체는 [`scripts/session-guard.mjs`](scripts/session-guard.mjs) 하나이며, 훅은 이 파일을 호출만 합니다. 셸 문법을 쓰지 않으므로 **OS 분기도, 따옴표 이스케이프도, `$` 치환 사고도 없습니다.** (`node`는 PATH 대신 절대 경로를 박습니다 — 호스트가 훅을 띄울 때 PATH가 비어 있을 수 있습니다.)

판정 기준은 **기억 파일 수의 증가**입니다. mtime 비교를 쓰면 `recall`의 강화 쓰기까지 "저장됨"으로 잡혀 정작 잡아야 할 무저장 세션이 통과합니다.

**볼트를 실행 시점에 다시 해석합니다 — 중요한 부분입니다.** 훅에 설치 시점 경로를 박아두면, 프로젝트마다 `BIGBRAIN_VAULT`로 볼트를 나누는 순간 **훅만 옛 볼트를 계속 봅니다.** 그러면 한 세션 안에서

- 훅: "볼트에 이런 기억들이 있다" (볼트 B 내용)
- 서버: "COLD START — this vault is EMPTY" (볼트 A 기준)

라는 **정면으로 모순된 두 신호**가 동시에 주입되고, 모델은 인덱스에 내용이 보이면 "메모리는 이미 잘 돌고 있다"고 판단해 저장을 건너뜁니다. 실제로 이 분열이 관측돼(훅은 실제 볼트 3건, 서버는 빈 테스트 볼트) 콜드 스타트 실험이 통째로 무효화된 적이 있습니다.

그래서 훅은 매 실행마다 서버와 **같은 근거를 같은 우선순위로** 다시 읽습니다: `BIGBRAIN_VAULT` 환경변수 → 프로젝트 `.mcp.json` → `~/.claude.json`(이 프로젝트 → 전역) → 설치 시점 폴백. `--vault`로 **명시**해 설치했다면 그 의도가 자동 탐지를 이깁니다.

또한 주입 블록이 **출처를 스스로 밝힙니다** — `<bigbrainmemory-index vault="..." memories="3">`. 서버가 다른 볼트를 보고 있으면 모순이 눈에 보이므로, 조용히 넘어가지 않습니다.

설치 스크립트가 처리하는 것:

- **볼트 경로 감지** — 등록된 MCP 서버 설정에서 실제 `BIGBRAIN_VAULT`를 읽어 폴백값으로 심습니다(위 실행 시점 해석이 우선).
- **기존 설정 병합** — 다른 훅을 쓰고 있어도 덮어쓰지 않고 항목만 더합니다. 재실행해도 중복되지 않습니다(멱등). 구버전 셸 훅도 인식해 깨끗이 교체합니다.
- **안전장치** — 쓰기 전에 두 명령을 실제로 실행해 검증하고, 타임스탬프 백업을 남기며, 쓴 뒤 JSON을 재파싱해 깨졌으면 백업에서 복구합니다. `settings.json`에 BOM이 있어도(메모장·PowerShell 편집 시 흔함) 정상 처리합니다.
- **세션을 절대 막지 않음** — 훅 본체는 어떤 실패에서도 종료 코드 0으로 끝납니다. Stop 훅이 0이 아니면 세션 종료를 막을 수 있기 때문입니다.

`postinstall`로 자동 실행하지 않는 이유: 전역 설정을 몰래 고치는 것은 나쁜 관행이고, Claude Code를 쓰지 않는 사용자나 CI에서도 실행되어 버립니다.

`UserPromptSubmit`이 아니라 `SessionStart`를 쓰는 이유: 전자는 매 턴 중복 주입돼 컨텍스트를 낭비합니다. 주입은 최대 200줄로 잘라 볼트가 커져도 예산을 넘지 않게 합니다.

**③ 네이티브 메모리 브리지**
Claude Code의 프로젝트별 메모리(`~/.claude/projects/<프로젝트>/memory/MEMORY.md`)는 매 세션 자동 주입됩니다. 이 파일에 "장기 기억은 bigbrainmemory의 `recall`로 조회"라는 안내와 핵심 항목 목록을 남겨두면 네이티브의 자동 주입에 편승할 수 있습니다. 프로젝트 단위로 다른 안내를 주고 싶을 때 유용합니다.

## 동시 사용 안전성

여러 Claude Code 세션(또는 데스크톱 앱과 CLI)이 **같은 볼트를 동시에 써도 됩니다.**

- 모든 쓰기가 원자적입니다(임시 파일 → `rename`). 다른 프로세스가 "반쯤 쓰인 파일"을 보는 창이 없습니다.
- 신규 기억은 배타적으로 생성됩니다. 두 세션이 같은 제목을 동시에 저장하면 한쪽이 `-2` 접미를 받고 **둘 다 살아남습니다**.
- 강화 기록은 쓰기 직전 파일을 다시 읽어 증분만 적용합니다. 그 사이 다른 세션이 한 `revise`·`forget`을 되돌리지 않습니다. 2 프로세스 × 300회 동시 회상에서 강화 소실 0건을 실측했습니다.
- 다만 read-modify-write 자체는 락이 아니라 **창을 좁힌** 것이라, 이론적 경합 가능성은 남습니다. 중요한 볼트는 git으로 관리하세요.

## 환경변수

모두 **서버 기동 시 한 번만** 읽습니다. 값을 바꾸면 MCP 서버를 재시작해야 반영됩니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `BIGBRAIN_VAULT` | `<저장소>/vault` | 볼트 디렉터리. 지정한 곳이 비어 있고 마커도 없으면 경고 |
| `BIGBRAIN_PROJECT` | (없음) | 이 서버의 기본 프로젝트 스코프. 미지정이면 전체 조회 |
| `BIGBRAIN_SYNONYMS` | (없음) | 동의어 사전 추가. `대표어=동의어1,동의어2;대표어2=동의어3` — 그룹은 `;`, 항목은 `,`. 내장 사전과 합쳐지고 양방향으로 전개됩니다. 예: `크로스넷=crossnet,사내망;웹메일=webmail` |
| `BIGBRAIN_INDEX_LIMIT` | `40` | instructions에 실을 기억 인덱스 최대 건수. `0`이면 목록 생략 |
| `BIGBRAIN_STALE_DAYS` | `30` | 이 일수 이상 갱신되지 않으면 `stale_hint`를 붙임 |
| `BIGBRAIN_SPACING_MS` | `600000` (10분) | 강화 사이 최소 간격의 **바닥값** |
| `BIGBRAIN_SPACING_ALPHA` | `0.1` | 확장 간격 계수. 필요 간격 = `max(바닥값, α·나이/n)`. `0`이면 고정 창 |
| `BIGBRAIN_WEAKENED_GRACE_H` | `72` (**시간** 단위) | 이보다 어린 기억은 reflect의 weakened에서 제외 |
| `BIGBRAIN_WEAKENED_RATIO` | `0.2` | weakened로 제시할 상한 비율(활성 하위). `0`이면 기능 끔. 0~1 밖이면 기본값 |
| `BIGBRAIN_FLUSH_EVERY_ACCESS` | `0` | `1`이면 간격 게이트에 막힌 조회도 매번 디스크에 기록 |

> **빈 문자열은 기본값이 아니라 `0`입니다.** 숫자형 변수는 `Number(값)`으로 파싱하는데 빈 문자열과 공백은 `0`으로 해석되어 그대로 적용됩니다. 기본값을 쓰려면 변수를 **아예 지정하지 마세요** — `.mcp.json`의 `env`에 빈 값으로 남겨두면 안 됩니다. 숫자가 아닌 값이나 음수는 무시되고 기본값으로 돌아갑니다.

### 조회의 디스크 부작용

`recall`·`read_memory`는 기억을 강화하므로 **간격 게이트가 열려 있으면 파일을 씁니다.** 게이트가 닫혀 있는 동안(기본 10분 이내 재조회, 확장 간격 적용 시 더 길게)은 쓰지 않으므로 연속 검색이 git working tree를 어지럽히지는 않습니다. `MEMORY.md`도 내용이 실제로 달라졌을 때만 다시 씁니다. `list_memories`와 `reflect`는 부작용이 전혀 없습니다.

## 기술 스택

- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) v1.x — `McpServer` + `StdioServerTransport`
- `gray-matter` — YAML frontmatter 파싱/직렬화 (Obsidian 호환)
- `zod` — 도구 입력 스키마
- 저장소는 순수 파일시스템 — DB 없음, 전부 사람이 읽을 수 있는 마크다운
