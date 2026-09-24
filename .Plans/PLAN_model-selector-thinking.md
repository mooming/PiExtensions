# Plan: model-selector에서 thinking 능력 측정·선언 (/select-model 프롬프트)

## 확인된 문제 (측정 근거)

| 사실 | 근거 |
| --- | --- |
| 익스텐션이 모든 모델을 `reasoning: false`로 등록 | `.pi/extensions/model-selector/index.ts:214` |
| `reasoning`이 fals면 Pi는 선택 수준을 `["off"]`로 제한 | `pi-ai/dist/models.js:551 getSupportedThinkingLevels` |
| 요청측 thinking 분기는 전부 `model.reasoning === true`를 요구 → 필드 미전송 | `pi-ai/dist/api/openai-completions.js:634-736` |
| 서버는 필드가 없으면 thinking을 켜므로 현재 thinking이 통제 없이 발생 | vLLM 실측: 무필드 3559자 vs `none` 0자 |
| vLLM Qwen3.8은 `minimal/high/max`를 HTTP 400으로 거부, `{none,low,medium,xhigh}`만 허용 | 실측 400 원문: "Supported types are xhigh (default), medium, and low." |
| Ollama는 7개 어휘를 모두 허용 | 실측: 전부 200 |
| `/v1/models`는 thinking 정보를 주지 않음 (vLLM: `max_model_len`만, Ollama: 식별자만) | 실측 응답 |
| Ollama `/api/show`는 `capabilities`에 `thinking`·`vision`을 포함하나, 이번 범위에서 제외 | 실측 응답 |

## 목표

`/select-model`이 모델의 thinking 능력을 **서버에 실제 요청을 보내 측정**하고, 결과를 이 익스텐션의
`model-capabilities.json`에 저장해 Pi에 `reasoning` + `thinkingLevelMap`으로 등록한다.
측정이 실패하면 프리셋 선택으로 폴백한다.

## 검증된 기대 결과

- `anav96/primitive-ai/Qwen3.8-Flash-Next-NVFP4` →
  `{off:"none", minimal:"low", low:"low", medium:"medium", high:"xhigh", xhigh:"xhigh", max:"xhigh"}`
  (수동 구성으로 이미 검증한 맵과 일치해야 함)
- `Local Ollama/qwen3.8:27b-mlx` → 자기 이름 동일 매핑 + `off:"none"`

## 구성

1. `.pi/extensions/model-selector/thinking-probe.ts` (신규)
   - `probeThinkingCapability(...)`: 기준 요청 + 7개 후보值 요청으로 허용/거부 관찰
   - `buildThinkingLevelMap(accepted, offValue)`: 순수 함수, Pi 수준 → 서버 값
     - 규칙: 같은 이름이 허용되면 자기 값, 없으면 **위쪽으로** 올림(Pi `clampThinkingLevel`과 방향 일치), 최상이면 최고값
     - `off`는 허용값에 `none`이 있을 때만, 없으면 `null`(수준에서 제거)
   - Pi 패키지 의존 없음 → Node 타입 제거 실행으로 직접 검증 가능
2. `index.ts`
   - `StoredCapability`에 `reasoning` · `thinkingLevelMap` 추가
   - `fetchProviderModels`가 선언값을 사용, `registerProvider`가 `thinkingLevelMap`을 전달
   - `/select-model`: vision 질문 직후 thinking 질문 → 자동 측정 → 실패 시 프리셋 폴백 → 저장 → 재등록
   - 모델 목록에 `[thinking]` 태그
3. 문서: 확장 README + 루트 README + JOURNAL

## 측정 알고리즘

| 단계 | 동작 | 실패 처리 |
| --- | --- | --- |
| 기준 | `reasoning_effort` 없이 최소 토큰 요청 | 200 아니면 측정 중단(불확실) |
| 후보 | `none/minimal/low/medium/high/xhigh/max` 각각 전송 | 200=허용, 400=거부 |
| 판정 | 허용값 0개 → 불확실(측정 불가로 취급) | 프리셋 폴백 질문 |
| 구성 | 위 규칙으로 맵 생성 | — |

비용: 모델당 짧은 요청 8개(`max_tokens=16`), 1회만 수행 후 파일에 저장.

## 검증 방법

| 번호 | 검증 | 통과 기준 |
| --- | --- | --- |
| V1 | `thinking-probe.ts`를 Node로 직접 실행해 두 실서버에 측정 | vLLM/Ollama가 기대 맵과 완전 일치 |
| V2 | 순수 함수 단위 확인: 허용 부분집합/off 없음/전부 거부 입력 | 규칙표와 일치, 400을 유발하는 값 없음 |
| V3 | Pi 로더와 같은 방식으로 `index.ts` import | 상대 import `./thinking-probe.ts` 해석 성공, 예외 없음 |
| V4 | `settings.json`/`models.json` 무변경 확인 + 저장 파일 read-back | 기존 keys 보존 |
| V5 | 생성 맵의 모든 값이 해당 서버에서 200 | 400 부재 |

## 범위 밖

- Ollama `/api/show`의 `capabilities` 자동 발견 (vision도 동일하게 발견 가능 — 별도 결정 필요)
- Pi의 `models.json` `modelOverrides` 경로 (사용자가 프롬프트 경로를 선택)
- 수준 간 실효성: 실측상 `low/medium/xhigh`의 thinking 길이차가 노이즈 수준이라 보정하지 않음

## 실행 결과 (2026-09-24)

| 번호 | 검증 | 결과 |
| --- | --- | --- |
| V1 | 실서버 측정 | vLLM → `{off:none, minimal:low, low:low, medium:medium, high:xhigh, xhigh:xhigh, max:xhigh}` (수동 검증 맵과 완전 일치, 4.8초) / Ollama → 자기 이름 동일 매핑 (26.3초) |
| V2 | 순수 함수 13 case | 전부 통과 |
| V3 | Pi 로더와 동일 방식(jiti + Pi alias)으로 `index.ts` 해석 | 통과 — 상대 import `./thinking-probe.ts` 해결, `/select-model` 등록 |
| V4 | 스크립트 `ExtensionAPI`로 명령 전체 경로 3회차(측정/유지/끄기) | 통과 — 저장 파일·등록값·`settings.json` 두 키만 갱신·`[thinking]` 태그·유지 시 재측정 없음 |
| V5 | 맵의 모든 값이 서버 허용값 | 통과 — 400은 맵에서 제외된 값에서만 발생 |
| 타입 | `tsc 5.9 --strict` + Pi 동봉 `.d.ts` | 오류 0 (HEAD는 6건이었으나 전부 기존 코드) |

수정된 기존 결함 3건(`ui.input`의 placeholder 인자 타입 4곳, `err.message`, `m` 암시 any)과 한계는
`JOURNAL.md`의 같은 날짜 항목에 기록.
