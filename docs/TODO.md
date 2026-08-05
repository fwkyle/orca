# Orca Kyle 후속 작업 큐

각 항목은 나중에 orchestration 카드로 만들어 진행한다. 카드로 승격되면 해당 항목에 Run/카드 ID를 적고 상태를 바꾼다.

## 1. 미배정(inbox) 카드 일급 모델 — 정석 수정

- Why: 생각난 작업을 TODO 파일·이슈·대화에 흩뿌리면 나중에 "카드로 옮겼는지"를 사람이 기억해야 한다. 카드 원장(`orchestration.db`)이 이미 존재하므로, 미배정은 새 공간이 아니라 원장 위의 상태값이어야 한다. 사이드바를 지저분하게 만들지 않으면서 "아무도 안 잡은 일"을 드러내는 게 목표다.
- 현재 제약(2026-08-03 실측): `tasks.run_id`가 `TEXT NOT NULL DEFAULT 'run_legacy_local'` (src/main/runtime/orchestration/db.ts:309, 458, 480, 505, 691 등 다수 테이블). 카드는 반드시 Run에 속해야 하므로 "감독 미정 카드"를 적재할 곳이 없다.
- 설계 방향 (kyle 확정 2026-08-03):
  - `tasks.run_id`를 nullable로 마이그레이션 — Run 미소속 카드 허용
  - 별도 플래그 추가: `assignment_state TEXT NOT NULL DEFAULT 'assigned'`, 값은 `inbox / assigned` (향후 `archived` 등 확장 여지)
  - `run_id IS NULL`만으로 미배정을 판단하지 않고 명시 플래그를 둔다 — 쿼리·인덱스·UI 분기가 단순해지고 "인계됐지만 감독 죽음" 같은 회귀 상태도 표현 가능
  - `task-create`에 `--run` 없이 만들면 `run_id = NULL`, `assignment_state = 'inbox'`로 적재
  - 사이드바 Run 트리는 그대로 유지, `inbox` 개수만 작업 섹션 배지로 표시. 배지 클릭 시 미배정 목록 → 감독 판으로 인계
  - 감독 인계 시 `run_id` 연결 + `assigned` 전환. 카드 ID 불변이라 이력이 끊기지 않음
  - 기존 DB의 `run_legacy_local` 카드는 건드리지 않고 새 기본 동작만 추가. 조회 쿼리는 `run_id IS NOT NULL` 기본 조건으로 기존 화면 동작 보존
- 검증: 마이그레이션 전후 기존 카드 목록 동일성, inbox 생성→인계→완료 왕복, 기존 Run 트리 화면 회귀 없음
- 금지: 숨겨진 inbox Run을 상주시키는 임시 우회(1번 안)를 정석처럼 문서화하지 않는다
- 참고: 원장 위치는 포크본 `/Users/fw_m1/Library/Application Support/Orca Kyle/orchestration.db` (구 오르카 `~/Library/Application Support/orca/orchestration.db`와 분리됨, 2026-08-03 기준 신규 작업은 포크본에만 기록)

## 2. 비활성 워크트리 에이전트 스피너 미표시

- 증상 (kyle 제보 2026-08-03): 에이전트로 판정되지 않는 터미널은 사이드바 스피너가 안 돌다가, 해당 브랜치(워크트리 카드)를 클릭하면 그제서야 스피너가 나타난다. 진행 표시가 클릭에 의존하면 정체·폭주 감지가 늦어진다.
- 이미 카드 생성됨: Run `run_d5fa5131a1b0`, 카드 `task_78b7ce444fe6` (감독 미배정 상태 — 1번 inbox 모델이 생기면 첫 적용 후보)
- 실측 근거:
  - `useWorktreeAgentRows(worktreeId, active)`는 active=false면 빈 배열 반환 (src/renderer/src/components/sidebar/useWorktreeAgentRows.ts)
  - 행은 working|blocked|waiting 훅 항목만 생성 (worktree-agent-rows.ts)
  - freshness signature는 agentStatusEpoch 캐시 (worktree-agent-freshness-selector.ts)
  - bootstrap 워크트리 실측: 터미널 22개 연결, 훅 상태는 done 16 / working 1뿐
- 조사 분기: (a) 비활성 워크트리의 훅 이벤트가 renderer store에 클릭 전엔 반영되지 않는가 (b) 반영되지만 행 계산 active 게이트가 막는가
- 가드레일: `done` 세션 상시 표시·카운트를 터미널 수로 바꾸는 재설계 금지

## 3. 판 종료 시 UI 표면 정리(GC) — 작업 탭과 워크스페이스

- Why: 판이 끝나도 UI에는 그 판의 흔적이 그대로 남는다. CLI 장부에서는 이미 사라졌는데 화면에만 죽은 작업 탭이 쌓여 있고(2026-08-04 실측 약 30개), 사용자는 어느 탭이 살아 있는 판인지 매번 눈으로 골라내야 한다. 끝난 표면은 판을 닫을 때 공식 절차로 치워야 한다.
- 범위: 판(Run/board) 종료 시 (a) 그 판이 만든 작업 탭 (b) 그 판이 만든 worktree 및 folder workspace를 UI에서 공식적으로 정리한다.
- 필수 조건:
  - **사용자 확인 후 실행.** 무엇을 닫는지 목록을 먼저 보여주고, 보존을 선택한 항목은 남긴다. 산출물이 있는 worktree는 기본 보존 쪽으로 제안한다.
  - **다른 판·운영 프로세스 불개입.** 정리 대상은 종료하는 판이 만든 표면만이다. 다른 `[판:]`의 탭, 명패, 프로젝트 감독, 중계기, 앱 밖 프로세스는 대상에서 제외한다.
  - **worktree 삭제는 기존 관문 규칙을 그대로 탄다.** UI GC가 승인 절차를 우회하는 경로가 되면 안 된다.
  - macOS / Linux / Windows 모두에서 동작해야 한다. 경로 조립은 `path.join`, 프로세스 종료는 플랫폼 분기.
  - SSH 워크스페이스와 folder workspace를 함께 지원한다. 모든 워크스페이스가 git worktree라고 가정하지 않는다.
- 검증 기준: 판 종료 전후 (1) 남은 탭 목록이 사용자가 보존 선택한 것과 정확히 일치 (2) 다른 판의 탭·터미널 수 변화 0 (3) folder workspace와 SSH 워크스페이스 각각에서 왕복 1회 (4) 보존 선택한 worktree가 디스크에 그대로 (5) 정리 후 CLI 장부와 UI 탭 목록의 불일치 0건.
- 이번 범위 밖: UI 구현 자체. 이 항목은 계약과 검증 기준까지만 확정한다.
- 2026-08-05 improvement-1 판 결과 (Track E, main task `task_2ca1c06ff05f`, 관문 `gate_404bcf8d5e01` = 부분 마감 + 차기 판 이월):
  - **이번 판에 끝낸 것 — 안전 계약 코드와 테스트만.** 정리 후보를 판 단위 ID로 고정(candidate ID), 사용자에게 보여준 미리보기와 실행 시점 목록이 같은지 확인하는 지문(preview fingerprint), 실행 직전 한 번 더 낡음 여부 재검증(stale 재검증), 그리고 다른 board·다른 workspace·공유 세션(shared session)·null·unknown 소유자는 전부 "정리하지 않음"으로 막는 fail-closed 판정까지다. 안전 계약 checkpoint `96c3caa37`, 독립 최종 검수 `task_59bb3a3b7041` CODE_PASS, 통합 checkpoint `4d8185b4865c61408eeb778960e7dfd9aa898399`.
  - **실제 정리는 하지 않았다.** 이번 판에서 세션 종료(close/kill), 프로세스 정리(cleanup), 탭·워크스페이스 실삭제는 한 건도 실행하지 않았다. 지금 코드는 "무엇을 지울 수 있는지 판정하는 층"까지만 있다.
  - **차기 판 후보 (순서 고정):** (1) 사이드바 개수 표시를 실제 후보 계산에 연결 (2) 실행기(production executor) 연결 (3) 아무것도 지우지 않는 미리보기를 실물에서 검증 (4) exact candidate 목록을 kyle에게 그대로 보여준 뒤 **그 시점의 kyle 승인**을 별도로 받는다 (5) 승인 뒤에만 실제 session close/kill/cleanup. 앞 단계 승인은 다음 판으로 이월되지 않는다.
  - **혼동 금지:** 이 항목은 고아 세션(orphan session) 문제나 roster retire 오보고 결함과 별개 사안이다. 같은 판에서 나왔다는 이유로 묶어 처리하지 않는다.

## 4. 포크 동기화 리듬 — upstream 미러 / 정기 동기화 랠리 / 즉시 cherry-pick

- Why: 포크가 upstream에서 오래 떨어질수록 나중에 한 번에 합칠 때 위험이 커지고, 그렇다고 매번 따라가면 운영 앱이 흔들린다. 주기를 고정해 "떨어짐"과 "흔들림" 둘 다 막는다. 기준선·태그 판정 절차 자체는 [`orca-kyle-maintenance.md`](./readme/orca-kyle-maintenance.md)를 따르고, 이 항목은 **리듬**만 정한다.
- 리듬 3종:
  1. **주 1회 — upstream → `main` 미러.** 무선별 fast-forward만. 충돌이 나거나 ff가 아니면 그 주는 미러를 건너뛰고 기록만 남긴다. 미러는 `main`을 최신 기준본으로 유지하는 것이 목적이고, 운영 앱은 건드리지 않는다.
  2. **월 1회 — `main` → `bootstrap` 정기 동기화 랠리.** 순서 고정: 머지 → 테스트 → 로컬 빌드 → QA 실기동 E2E → 검수 PASS. **검수 PASS 뒤에만 운영 앱을 교체한다.** 앞 단계 중 하나라도 실패하면 그 달 교체는 없고 기존 운영 앱을 유지한다. 실기동 E2E와 앱 교체는 위 "운영 앱 E2E 재기동 절차"를 그대로 쓴다.
  3. **[P0]·보안 픽스는 즉시.** 월 랠리를 기다리지 않고 해당 커밋만 개별 `git cherry-pick -x` 한다. 전체 동기화로 확대하지 않는다.
- 금지: upstream `main` 자동 병합, 검수 PASS 전 운영 앱 교체, 월 랠리 안에 무관한 변경 끼워넣기.

## 5. 결함 A 제품 수정 — `terminal create --role` 등록 실패가 조용히 숨는다

- Why (2026-08-04 실증): 후임 중계기를 `--role`로 만들었을 때, 같은 identity에 active 레코드가 이미 있으면 roster 등록이 **조용히 건너뛰어졌는데도** receipt는 `ok=true`였다. 감독은 등록됐다고 믿고 교대를 진행했고, 실제로는 `roster list`·`roster show`에 후임이 없어 교대가 실패했다.
- 실측 경로:
  - `src/main/runtime/orchestration/role-roster-creation.ts:117` — 사전 검사 `assertRoleRosterIdentityAvailable`은 `params.terminal`이 있을 때(기존 pane 재사용)만 돈다. 새 터미널 생성은 이 시점에 pane이 없어 검사를 통과한다.
  - 같은 파일 `:127-138` — 실제 기록은 발령 준비가 끝난 뒤에 일어나고, identity 충돌 오류는 `console.warn`으로 삼켜진다. 호출자에게 실패가 전달되지 않는다.
  - `src/cli/handlers/terminal.ts:163-186` — receipt는 `RuntimeTerminalCreate`(handle·title 등)뿐이고 roster 등록 여부를 담는 필드가 없다.
- 요구 사항: 등록 실패는 **fail-closed(생성 자체를 실패)** 또는 **명시적 경고**여야 한다. 어느 쪽을 택하든 receipt에 **등록 여부(`registered`)를 반드시 싣는다** — 호출자가 확인할 수단이 없는 지금이 사고의 핵심이다.
- 주의: `:97-100`의 기존 주석은 "발령 준비 후 실패는 살아 있는 작업자를 고아로 만든다"는 이유로 늦은 실패를 warning으로 낮췄다. 그 이유 자체는 유효하므로, 해결은 "warning을 error로 바꾸기"가 아니라 **검사 시점을 앞당기거나 결과를 receipt로 노출하는** 쪽이어야 한다.
- 검증 기준: identity 충돌 상태에서 `terminal create --role` 왕복 1회 — receipt의 등록 여부가 `roster list` 실제 결과와 일치할 것. 충돌 없는 정상 생성 경로 회귀 없음.

## 6. 판 개설 안전 카드 군 — 선언과 실제 상태의 장부 대조

- 우선순위: **현재 `upstream-sync-1` 랠리 뒤.** 랠리 중에는 카드로 만들거나 구현하지 않는다.
- Why: 판 개설 선언과 실제 장부 상태가 다르면 감독·companion·relay가 있다고 믿으면서도 작업은 조용히 멈춘다. 2026-08-04 `upstream-sync-1` 판에서 개시 선언 뒤 첫 카드 생성 전까지 16분간 카드 0장·발령 0건으로 정체됐고, 첫 편지 이전에는 companion이 깨울 신호 자체가 없었다.
- 관통 원칙: **선언과 실제 상태의 불일치를 장부 대조가 잡는다.** 화면 제목·스피너·명령 receipt만으로 성공을 판정하지 않는다.
- 카드 1 — `orchestration board-open`: Run 생성과 필수 역할 등록을 한 원자 명령으로 수행한다. receipt에는 Run, coordinator, companion, relay 각 단계의 실제 등록·기동 결과를 정직하게 노출한다. 일부 단계 실패를 `ok=true` 하나로 숨기지 않으며, 결함 A 수정과 한 묶음으로 설계한다.
- 카드 2 — `orchestration board-doctor`: coordinator 바인딩, companion 생존, relay active, relay kicker 생존·5분 주기·`PPID=1` 분리 상태, ready 카드 워치독 준비 상태를 `project+board+run+role+pane` 장부와 실제 프로세스로 대조하고 미비 목록을 반환한다. 감독은 개시 선언을 보내기 전에 doctor 통과를 관문으로 사용한다.
- 카드 3 — ready 카드 워치독: open 상태 board에서 ready 카드가 설정된 N분 이상 미발령이면 해당 Run의 현재 coordinator 터미널을 역할·pane 기준으로 다시 찾아 자동 wake 이벤트를 보낸다.
- 공통 가드레일: 다른 board·Run을 깨우지 않고, active dispatch가 있거나 board가 닫혔거나 decision gate 대기 중이면 깨우지 않는다. 고정 handle 재사용과 DB 직접 수정은 금지한다.
- 검증 기준: 부분 등록 실패가 receipt·doctor 미비 목록에 그대로 나타나고 개시 선언이 차단될 것. 정상 판은 doctor PASS. ready 카드 장기 미발령 시 wake 1회, 발령·board 종료·gate 대기 시 wake 0회, 같은 정체 구간 중복 wake 방지.

## 7. companion NUDGE — kicker 주기 장부 대조

- 우선순위: **현재 `upstream-sync-1` 랠리 뒤.** 구현 대상은 `kyle-agent-skills`의 `orca-conductor` companion이며, 랠리 중에는 카드로 만들지 않는다.
- Why: 편지가 아직 없더라도 장부에는 ready 카드와 active dispatch 부재가 보인다. companion이 kicker 주기마다 이 결정적 상태를 대조하면 감독의 추측 없이 안전하게 정체를 깨울 수 있다.
- 조건: `ready 카드 present + active dispatch absent + coordinator idle`이 모두 참일 때만 coordinator에 `NUDGE` wake를 보낸다.
- 가드레일: 화면 스피너·제목·자연어 추측을 근거로 쓰지 않는다. project+board+run 범위를 고정하고 현재 coordinator 역할을 전송 직전에 다시 찾는다. 같은 장부 상태의 중복 NUDGE를 막는다.
- 검증 기준: 세 조건이 모두 참일 때 NUDGE 1회, 각 조건이 하나라도 거짓이면 0회, 카드·dispatch 상태가 바뀐 뒤에는 새 상태로 다시 판정.

## 8. worker-start 입력 검증 고정 테스트

- 우선순위: **현재 `upstream-sync-1` 랠리 뒤.** 2026-08-03 kyle 정책에 따라 동작 불변 리팩터링의 테스트 정비는 현재 체크포인트 관문을 막지 않는다.
- Why: `worker-start` 입력 검증을 별도 모듈로 옮긴 뒤에도 잘못된 입력 조합과 검사 순서가 바뀌지 않았음을 빠르게 확인할 수 있어야 한다.
- 범위: `terminal + agent`, 새 worktree + `terminal`, 새 worktree의 `name` 누락, 기존 worktree에 생성 옵션 전달, terminal 없이 agent 미설정·비TUI agent, 정상 TUI agent의 runtime 검사 호출과 순서를 직접 고정한다.
- 검증 기준: 각 잘못된 입력이 기존 오류 코드·문구로 거부되고, 정상 TUI agent에서 `validateOrchestrationAgentLauncher`가 topology 조회 전에 정확히 호출될 것.

## 9. upstream 동기화 뒤 테스트 기대값 정비

- 우선순위: **현재 `upstream-sync-1` 랠리 뒤.** 2026-08-03 kyle 정책에 따라 제품 동작이 이미 의도대로인 테스트 정비는 릴리즈 관문을 막지 않는다.
- Why: upstream 테스트가 원본 Orca의 브랜드·자동 업데이트 UI·DB 버전·기본 데이터 경로를 기대하면 Orca Kyle의 의도된 포크 계약과 충돌해 전체 시험 결과를 흐린다.
- 범위: fork appId 기대값 7건, packaging-contract의 `node:test`/Vitest 실행 방식 1묶음, manual-only 사이드바 UI 기대값 2건, schema v25·retire blocker 기대값 3건, launch 시험의 `ORCA_USER_DATA_PATH` 격리 환경 4건, relay `agent-exec-handler` 시험의 ambient `GIT_CONFIG_*` 격리 2건을 카드별로 정비한다.
- 환경 분리: macOS와 Linux의 updater·csh·로케일 차이 12건은 플랫폼을 명시해 실행하거나 해당 플랫폼 CI 결과로 판정한다. built CLI 2건과 모바일 generated engine 13개 suite는 빌드 카드가 산출물을 만든 뒤 검증한다.
- root guard 후속: 탭·줄바꿈 root 이름과 동일 이름 file/tree type 변경을 자동 시험으로 고정하고, 시험 실행 셸이 실제 Bash 3.2인지 명시적으로 검증한다. 실제 NUL-safe 동작은 Card 5E R2 독립 검수에서 8/8 통과했다.
- Computer Use peer allowlist 후속: source-string 회귀 검사에 `hasPrefix("com.chickenbreastky.")`, `contains("orca-kyle")` 같은 과도한 확장 변형을 추가로 거부하고, Swift와 TypeScript의 product identity 규칙이 함께 바뀌는 교차 검사를 검토한다. Card 7C 독립 검수에서 현재 구현 자체는 치명·중요 0건으로 PASS했다.
- 검증 기준: 제품 코드를 테스트에 맞춰 되돌리지 않고, 각 테스트가 포크 계약 또는 명시된 플랫폼 계약을 정확히 표현할 것.

## 10. 고정 로컬 개발용 서명 인증서 도입 — Rottie Local 방식

- 우선순위: **현재 `upstream-sync-1` 랠리 뒤.** 이번 랠리의 앱 교체·검수 흐름을 막지 않는다.
- Why: 매 로컬 빌드의 ad-hoc 서명이 달라지면 macOS가 새 앱으로 판단해 Computer Use의 손쉬운 사용·화면 기록 권한을 다시 요구한다. 월간 랠리마다 사람이 같은 권한을 재부여하지 않도록 로컬 빌드 신원을 고정한다.
- 범위: Keychain에 고정 로컬 개발용 인증서(`Rottie Local` 방식)를 만들고 `pnpm build:mac`의 로컬 서명 경로에서만 사용한다. 인증서·개인 키·비밀값은 저장소에 넣지 않으며 Developer ID 릴리스 서명·공증 계약은 바꾸지 않는다.
- 플레이북 반영: [`upstream-sync-playbook.md`](./upstream-sync-playbook.md)의 환경 함정 절을 매 랠리 시작 전에 읽고, 고정 인증서 유무와 실제 codesign identity를 사전 점검한다.
- 검증 기준: 같은 인증서로 연속 2회 빌드한 앱의 서명 신원이 안정적이고, 첫 승인 뒤 두 번째 빌드에서 Accessibility·Screen Recording 권한이 유지될 것. 인증서가 없거나 잘못됐으면 키체인 자동 탐색으로 멈추지 말고 명확히 실패할 것.

## 11. QA 방식 쉬운 설명 문서

- Why: kyle이 서로 다른 검증 방법을 어려운 용어 때문에 헷갈리지 않고, 무엇을 실제로 확인했는지 바로 이해할 수 있게 한다.
- 범위: `docs/user-guide/` 아래에 kyle용 쉬운 말로 검증 3형제를 설명하는 짧은 문서를 만든다. 비유와 그림을 써도 되며 `kyle-plain-language` 기준을 따른다.
  - 단위 테스트: 앱을 켜지 않고 부품만 검사한다.
  - 실기동 E2E: 진짜 앱을 격리된 가짜 집에서 하나 더 켜고 CLI 대화로 검사한다. 화면 클릭 검사는 Computer Use 후순위 결정에 따라 이번 범위에서 제외한다.
  - 데몬 점화: 창 없는 백그라운드 엔진만 잠깐 단독으로 시동한다.

## 결함 E 검증 가설 추가 (2026-08-04 kyle, 슈퍼감독 기록)

- Computer Use AXIsProcessTrusted false의 검증 가설: **"같은 앱이 스스로를 조작하지 못하는 제약"**에 막혔을 가능성 (kyle 제안). 운영·후보 문맥 모두 거부였던 실측과 부합하는지 결함 E 카드(task_08fc56ec260a)에서 함께 검증.
- 대안 경로: Computer Use를 Orca 내장 대신 **Codex 쪽을 거쳐** 실행하는 방식도 후보 — 추후 검증 (kyle).
