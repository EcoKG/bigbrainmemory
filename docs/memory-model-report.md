# 인간 기억·행동 이론의 정제 리포트 — BigBrainMemory 설계 근거

작성일: 2026-07-16
목적: 인간 기억/행동에 관한 주요 이론을 조사하고, 이론 간 **모순·과장·부적합**을 걸러낸 뒤, AI 영속 기억 시스템에 **선별 반영**할 원칙을 도출한다. 핵심 원칙은 "인간 기억을 그대로 복제하지 않는다" — 인간 기억의 **강점(적응적 망각·강화·연상)은 취하되 약점(오기억·출처혼동·왜곡)은 의도적으로 배제**한다.

---

## 1. 조사한 이론 요약

| # | 이론 | 핵심 주장 | 출처 |
|---|---|---|---|
| A | **ACT-R 선언적 기억 활성화** | 청크의 회상 가능성 = 기저활성(base-level, 빈도·최근성) + 확산활성(연상) + 부분일치 + 노이즈. 망각은 **거듭제곱 법칙(power law)** 을 따른다. | act-r.psy.cmu.edu |
| B | **Bjork 신(新)불용 이론** | 모든 기억은 **저장강도(storage strength, 단조 증가)** 와 **인출강도(retrieval strength, 변동)** 라는 *독립된 두 축* 을 갖는다. 망각은 기능적이다. | Bjork & Bjork (1992) |
| C | **바람직한 어려움(desirable difficulties)** | 인출이 **어려울 때 성공한 회상**이 저장강도를 더 크게 올린다. 간격·인출연습·생성이 대표. | Bjork & Bjork |
| D | **에빙하우스 망각곡선 / 간격효과 / 검사효과** | 복습 없으면 급격히 망각. **분산 학습**·**능동적 인출**이 재학습보다 장기파지에 우월. | Ebbinghaus; Karpicke & Roediger |
| E | **재공고화(reconsolidation)** | 회상 시 기억이 일시적으로 불안정(labile)해지고, 재안정화 과정에서 **새 정보로 갱신**될 수 있다. | Nader; Lee, Nader & Schiller (2017) |
| F | **간섭 이론(interference)** | 망각은 시간 경과가 아니라 **경쟁 기억의 간섭**(순행·역행)이 주원인. | Baddeley & Hitch |
| G | **인출유도망각(RIF, 적응적 망각)** | 특정 기억을 인출하면 **경쟁하는 관련 기억이 억제**되어 미래 간섭이 준다. 이는 결함이 아니라 **적응적 기능**. | Anderson; Nature Comms (2018) |
| H | **재구성적 기억 / 오기억(gist·DRM·출처혼동)** | 인간 기억은 verbatim이 아닌 **요지(gist) 기반 재구성** → 스키마 왜곡, 출처 혼동, 허위기억 생성. | Roediger–McDermott; source-monitoring |

---

## 2. 모순·과장·부적합 지점 (그대로 반영하면 안 되는 것)

### 모순 1 — 망각의 원인: 시간 감쇠(decay) vs 간섭(interference)
- A/D는 **시간 경과**(거듭제곱 감쇠)를, F는 **경쟁 간섭**을 망각의 원인으로 본다. 오래 상충해 온 논쟁이다.
- **정제:** 최신 견해는 *양립*이다. 부호화 시 간섭이 클수록 트레이스 수는 줄지만 남은 것은 더 견고해 감쇠가 느려진다(생존편향). → **두 메커니즘을 모두** 반영: 회상 순위는 (시간감쇠 기반 활성) × (간섭에 따른 측면억제)로 계산한다. 어느 한쪽만 쓰는 현재 설계는 불완전.

### 모순 2 — "확신도" 하나로 뭉뚱그림 (Bjork의 2축 위반)
- 현재 BigBrainMemory는 `confidence` 단일 값에 "얼마나 옳은가"와 "얼마나 잘 떠오르는가"를 뒤섞었다. 이는 B(저장강도≠인출강도)와 정면 충돌한다.
- **정제:** **세 축으로 분리**한다.
  1. **진실성(confidence)** — 이 기억이 옳다고 믿는 정도. `revise`로만 변한다. 접근으로 변하지 않는다.
  2. **저장강도(storageStrength)** — 단조 증가. 간격을 둔 능동 회상으로만 오른다.
  3. **인출강도(retrieval strength)** — 저장하지 않고 **질의 시점에 계산**한다(빈도·최근성 → 기저활성). 변동값을 파일에 박제하던 방식은 폐기.

### 모순 3 — 회상=강화(검사효과) vs 인출유도망각(RIF)
- D/C는 회상하면 강해진다 하고, G는 회상하면 **경쟁 기억은 약해진다** 한다. 현재 설계는 전자만 반영(회상된 기억만 +1).
- **정제:** 둘 다 반영하되 **안전하게** — 회상 시 상위 기억은 강화하고, 같은 클러스터의 경쟁(유사) 기억은 **순위에서만** 완만히 억제한다(측면억제). 저장된 진실성·저장강도는 절대 자동으로 깎지 않는다(오삭제 위험 차단).

### 모순 4 — 강화의 등가성 (검사효과·간격효과·바람직한 어려움 위반)
- 현재는 능동 회상(`recall`)과 수동 열람(`read`)을 동일하게 +1 하고, 같은 세션에서 여러 번 접근해도 매번 강화한다.
- **정제:** (a) **능동 인출 > 수동 열람**(검사효과), (b) **간격 게이트** — 직전 강화로부터 일정 시간이 지나야 저장강도가 오른다(간격효과, 벼락치기 억제), (c) **바람직한 어려움** — 인출강도가 낮아 *어렵게* 찾아낸 회상은 보너스 가중.

### 모순 5 — 에빙하우스의 지수 vs 거듭제곱, 그리고 구체 수치의 과일반화
- 에빙하우스는 지수 감쇠·"24시간 67% 망각" 같은 수치를 냈지만, 이는 **무의미 철자** 실험이라 일반화 부적합. 현대 합의는 **거듭제곱 법칙**.
- **정제:** 지수식과 구체 수치는 버리고, **ACT-R 기저활성(거듭제곱)** 을 채택한다.

### 부적합(의도적 배제) — 재구성적 오기억(H)
- 인간 기억의 **약점**을 "충실히" 복제하면 AI 기억엔 **버그**다: 요지 기반 재구성 → 허위기억, 출처 혼동은 신뢰성을 파괴한다.
- **정제(역발상):** 인간 약점을 **거꾸로 보완**한다.
  - 기억은 **verbatim 저장**(마크다운 원문 보존) — 요지로 덮어쓰지 않는다.
  - **출처(source) 필드 추가** — 출처혼동(source-monitoring error)의 인공 버전을 방지.
  - 파괴적 자동 병합 금지 — 병합은 이력이 남는 `revise`로만.

### 부적합(부분 배제) — 재공고화의 가소성(E)
- 재공고화는 회상 때 기억을 malleable하게 만들어 **오염**될 수도 있다(양날의 검).
- **정제:** 가소성의 **유용한 절반만** 취한다 — `revise` 시 (1) 전체 이력 보존(감사 가능), (2) 재확인은 진실성·저장강도를 올린다, (3) 내용이 실질 변경되면 최근성 시계를 갱신. **자동 오염 경로는 만들지 않는다.**

---

## 3. 도출된 설계 원칙 (리팩토링 지침)

| 원칙 | 근거 이론 | 구현 |
|---|---|---|
| P1. 3축 분리 | B | `confidence`(진실성) / `storageStrength`(저장) / 계산된 인출강도 |
| P2. 거듭제곱 기저활성으로 회상 순위 | A, D | ACT-R **optimized learning** 근사식 `B = ln(n / (1−d)) − d·ln(L)` (n=저장강도, L=경과시간[시], d=0.5). 정확식 `B = ln(Σ t_j^−d)`의 저비용 근사(Anderson & Lebiere 1998). 순위 = 키워드점수 × 진실성가중 × 활성가중 |
| P3. 간격 게이트 강화 | D(간격) | 직전 강화 후 `SPACING_WINDOW`가 지나야 저장강도 증가 (벼락치기 차단) |
| P4. 능동>수동 + 바람직한 어려움 | C, D(검사) | `recall`(능동) 강화량 > `read`(수동); 인출강도 낮을 때 성공 회상은 보너스 |
| P5. 측면억제(RIF)는 순위에만 | F, G | 경쟁 유사 기억은 순위에서 완만히 억제. 저장 상태는 불변 |
| P6. 적응적 망각 제안, 자동삭제 금지 | B, G, E | `reflect`가 활성 τ 미만·저확신 기억을 **망각 후보**로 제시. 실제 `forget`은 archive 이동(가역) |
| P7. 재공고화의 안전한 절반 | E | `revise`: 이력 보존 + 재확인 강화 + 최근성 갱신. 자동 오염 없음 |
| P8. 인간 약점 역보완 | H | verbatim 저장, `source` 출처 필드, 파괴적 자동병합 금지 |

### 채택하지 않은 것 (명시적 배제)
- 지수 망각곡선·에빙하우스 구체 수치 (거듭제곱으로 대체)
- 요지 기반 재구성/허위기억 생성 (신뢰성 저해 — 배제)
- 완전한 확산활성 fan 튜닝(S_ji 학습) — 과설계. 1-hop 연상으로 근사
- 회상 시 경쟁 기억의 진실성·저장강도 자동 하향 (오삭제 위험 — 순위 억제로 한정)

---

## 4. 출처

- ACT-R 선언적 기억/기저활성: [act-r.psy.cmu.edu](http://act-r.psy.cmu.edu/), [PythonACT-R Declarative Memory](https://sites.google.com/site/pythonactr/reference-material/declarative-memory). 채택한 optimized learning 근사식은 Anderson & Lebiere(1998) — 정확식은 Anderson & Schooler(1991)의 합리적 분석 기반. (참고: [Petrov 2006 하이브리드 근사](http://alexpetrov.com/pub/iccm06/)는 이를 개선한 *별개의* 식으로, 본 구현이 쓴 식이 아님)
- Bjork 신불용 이론/바람직한 어려움: [A new theory of disuse (ResearchGate)](https://www.researchgate.net/publication/281322665_A_new_theory_of_disuse_and_an_old_theory_of_stimulus_fluctuation), [Bjork & Bjork, Introducing Desirable Difficulties (UNH)](https://www.unh.edu/teaching-learning-resource-hub/sites/default/files/media/2023-06/itow-introducing-desirable-difficulties-into-practice-and-instruction-bjork-and-bjork.pdf)
- 망각곡선/간격·검사효과: [Forgetting curve (Grokipedia)](https://grokipedia.com/page/Forgetting_curve), [Spaced repetition (Skycak)](https://www.justinmath.com/cognitive-science-of-learning-spaced-repetition/)
- 재공고화: [Lee, Nader & Schiller, An update on memory reconsolidation updating (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5605913/), [Nader 2010 (Wiley)](https://nyaspubs.onlinelibrary.wiley.com/doi/abs/10.1111/j.1749-6632.2010.05443.x)
- 간섭 이론: [Interference Theory (ScienceDirect)](https://www.sciencedirect.com/topics/neuroscience/interference-theory), [Survival of the fittest — encoding competition (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6357916/)
- 인출유도망각/적응적 망각: [Retrieval induces adaptive forgetting (PubMed)](https://pubmed.ncbi.nlm.nih.gov/25774450/), [A retrieval-specific mechanism of adaptive forgetting (Nature Comms)](https://www.nature.com/articles/s41467-018-07128-7), [Active Forgetting: Adaptation of Memory by Prefrontal Control (Anderson 2021)](https://memorycontrol.net/2021Anderson.pdf)
- 재구성적 기억/오기억: [False memory (Wikipedia)](https://en.wikipedia.org/wiki/False_memory), [Source-monitoring error (Wikipedia)](https://en.wikipedia.org/wiki/Source-monitoring_error), [Cognitive and neural mechanisms underlying false memories (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10567586/)

---

## 5. 재검증 로그 (Claude Fable 5, 2026-07-16)

1차 조사(Opus)가 블로그·2차 출처에서 끌어온 **구체 수치·수식 귀속**을 독립 재검증했다.

| 항목 | 1차 표현 | 재검증 결과 | 조치 |
|---|---|---|---|
| 기저활성 근사식 귀속 | "Petrov 2006 최적화 근사" | **오귀속.** `B = ln(n/(1−d))−d·ln(L)`은 Anderson & Lebiere(1998)의 표준 optimized learning 근사식. Petrov(2006)는 이를 개선한 *별개* 하이브리드 근사식. 수식 자체·`d=0.5` 기본값은 정확. | 코드 주석·리포트 귀속 정정 |
| "24시간 67% 망각" | (검색결과에 등장) | **왜곡 확인.** 에빙하우스는 피험자 1명·무의미 철자 실험. 실제 파지율은 맥락따라 0~94% 편차(Thalheimer). 곡선 *형태*는 Murre & Dros(2015)가 재현. | 리포트 본문에 애초 미포함 — 배제 유지 |
| "검사효과 150% 향상" | (검색결과에 등장) | **과장 확인.** 실제는 Roediger & Karpicke(2006) 1주 후 재인출 61% vs 재읽기 40% = 약 1.5배(=50% 더). "150% 향상"은 블로그 과장. | 리포트 본문에 수치 미포함 — 정성 서술 유지 |
| 지수 vs 거듭제곱 망각 | 거듭제곱 채택 | **타당 확인.** 현대 합의는 거듭제곱(power-law). 에빙하우스 지수식 배제 근거 유효. | 유지 |

**결론:** 실질 수정 1건(수식 귀속). 나머지 의심 항목은 1차 리포트가 이미 정성 서술로만 처리해(구체 수치 미기재) 정정 불필요. 설계 원칙 P1~P8은 재검증 후에도 그대로 유효.
