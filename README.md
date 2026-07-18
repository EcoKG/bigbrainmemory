# BigBrainMemory 🧠

**Claude Code + Obsidian에서 영감을 받은, 사람처럼 기억하는 MCP 서버**

Claude Code가 세션을 넘어 스스로 기억하고, 회상하고, 잘못된 기억을 교정하며, 기억 사이를 연상으로 오갈 수 있게 하는 영속 기억(persistent memory) MCP 서버입니다. 모든 기억은 **Obsidian에서 그대로 열리는 마크다운 볼트**에 저장됩니다.

## 이론적 기반 (정제 리포트)

인간 기억·행동 연구(ACT-R, Bjork 신불용 이론, 재공고화, 간섭 이론, 인출유도망각, 오기억 등)를 조사해 **모순·과장·부적합을 걸러낸** 정제 리포트를 먼저 작성하고([docs/memory-model-report.md](docs/memory-model-report.md)), 그 원칙에 따라 설계했습니다. 핵심은 **"인간 기억을 그대로 복제하지 않는다"** — 강점(적응적 망각·강화·연상)은 취하고 약점(오기억·출처혼동·왜곡)은 의도적으로 배제합니다.

## 핵심 개념 — 사람의 기억처럼, 그러나 더 낫게

| 인간의 기억 | BigBrainMemory 구현 | 근거 |
|---|---|---|
| 기억 유형 | `episodic` · `semantic` · `procedural` · `preference` | 다중기억체계 |
| **2축 분리** | `confidence`(진실성, revise로만) 와 인출강도(계산됨)를 **분리** — 자주 안 떠올라도 신뢰할 수 있고 그 반대도 성립 | Bjork 저장강도≠인출강도 |
| 거듭제곱 망각 | 회상 순위 = 키워드 × 진실성 × **기저활성** `ln(n/(1−d))−d·ln(L)` | ACT-R (지수식·에빙하우스 수치는 배제) |
| 간격효과 강화 | 간격을 둔 능동 회상만 저장강도를 올림(벼락치기 무효) | 간격효과·검사효과 |
| 바람직한 어려움 | 어렵게 찾아낸 회상은 더 크게 강화 | Bjork desirable difficulties |
| 적응적 망각 | 경쟁 유사 기억은 회상 **순위에서만** 억제(저장 상태는 불변) | 인출유도망각(RIF) |
| 연상 작용 | `[[위키링크]]` 양방향 1-hop 확산 | 확산활성 |
| 재공고화 | `revise` — 이력 보존 + 재확인 강화, 자동 오염 없음 | 재공고화의 안전한 절반 |
| 망각 | `forget` — 삭제가 아닌 `archive/` 이동, 복원 가능 | 가역적 망각 |
| **인간 약점 역보완** | verbatim 저장 + `source` 출처 필드 + 파괴적 자동병합 금지 | 오기억/출처혼동 배제 |
| 메타인지 | `reflect` — 약해진 기억·망각 후보·중복·고립 점검(제안만, 자동삭제 없음) | — |

## 저장 구조 (Obsidian 볼트)

```
vault/
├── MEMORY.md          # 자동 생성 인덱스 (Obsidian 허브 노트)
├── memories/          # 활성 기억 — 기억 1건 = 마크다운 1개
│   └── 사용자는-typescript-strict-모드를-선호한다.md
├── archive/           # 망각된 기억 (사유 기록, 복원 가능)
│   └── revisions/     # revise 직전 구본 스냅샷 (기억당 최근 3세대)
└── quarantine/        # 손상 감지된 파일 (자동 격리, 원본 바이트 보존)
```

> **백업 권고** — 볼트는 순수 파일이므로 `git init` 후 주기적으로 커밋해 두면
> 어떤 교정도 되돌릴 수 있습니다. `archive/revisions/` 는 최근 3세대만 보관하는
> 안전망이지 백업이 아닙니다.

기억 노트 예시:

```markdown
---
id: mem-xxxx
title: 사용자는 TypeScript strict 모드를 선호한다
description: '코드 리뷰에서 항상 strict: true 설정을 요구했다.'
type: preference
tags: [typescript, 코딩스타일]
confidence: 0.75
status: active
access_count: 3
links: [bigbrainmemory-프로젝트-구조]
history:
  - '2026-07-16: created'
  - '2026-07-16: revised — 레거시 프로젝트는 예외 허용으로 정정'
---

사용자는 기본적으로 strict: true를 선호하지만, 레거시 프로젝트에서는 예외를 허용한다.

## 연관 기억
- [[bigbrainmemory-프로젝트-구조]]
```

`vault/`를 Obsidian에서 볼트로 열면 그래프 뷰에서 Claude의 기억 네트워크를 그대로 볼 수 있습니다.

## 제공 도구 (8개)

| 도구 | 역할 |
|---|---|
| `remember` | 새 기억 저장. 유사 기억이 있으면 알려주어 중복 대신 `revise`를 유도. `supersedes`로 낡은 기억 대체 가능 |
| `recall` | 키워드 회상. 관련도 × 확신도 × 강화(빈도/최근성)로 순위화, 연결된 기억도 함께 반환 |
| `read_memory` | 기억 1건 전문 읽기 (읽으면 강화됨) |
| `revise` | 잘못되거나 낡은 기억 교정 — 사유 필수, 이력에 기록 |
| `forget` | 망각 — `archive/`로 이동, 사유 기록 |
| `link` | 두 기억을 양방향 위키링크로 연결 (연상 관계) |
| `reflect` | 기억 건강 점검 — 방치/저확신/중복/고립 기억 리포트 |
| `list_memories` | 유형/상태별 기억 목록 |

서버 `instructions`에 행동 수칙(작업 시작 시 recall 먼저 → 배운 것은 remember → 모순되면 revise/forget → 주기적으로 reflect)이 포함되어 있어, Claude가 자율적으로 기억을 운용합니다.

## 설치 및 실행

```bash
npm install
npm run build
npm test        # 전체 기억 사이클 스모크 테스트
```

## Claude Code에 등록

**이 프로젝트에서만** — 저장소의 [.mcp.json](.mcp.json)이 자동 적용됩니다.

**모든 프로젝트에서 (권장)** — 기억은 프로젝트를 넘나들 때 가치가 커집니다:

```bash
claude mcp add --scope user bigbrainmemory -- node D:/BigBrainMemory/dist/index.js
```

**볼트 위치 변경** — 기존 Obsidian 볼트를 쓰려면 환경변수를 지정합니다:

```bash
claude mcp add --scope user -e BIGBRAIN_VAULT="C:/Users/me/MyObsidianVault/BigBrain" bigbrainmemory -- node D:/BigBrainMemory/dist/index.js
```

## 기술 스택

- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) v1.x — `McpServer` + `StdioServerTransport`
- `gray-matter` — YAML frontmatter 파싱/직렬화 (Obsidian 호환)
- `zod` — 도구 입력 스키마
- 저장소는 순수 파일시스템 — DB 없음, 전부 사람이 읽을 수 있는 마크다운
