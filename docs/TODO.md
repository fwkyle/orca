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

## 12. 완료 세션 정리 — failed 카드와 구세대 capability 누락 이력

- 우선순위: **이번 `improvement-1` 판 범위 밖, 다음 판 카드 후보.** 현재 기록을 강제로 고치거나 다른 카드의 완료 이력을 대신 넣지 않는다.
- Why: 작업이 끝나 터미널이 사라졌는데 roster만 살아 있다고 표시되면, 감독이 죽은 작업자를 실제 작업자로 오해하고 메모리와 검수 슬롯을 낭비한다.
- 2026-08-05 실측:
  - `roster retire`는 `status=failed`인 검수 카드 3건을 `task_completed`에서 거부했다. 실패 보고이더라도 작업은 끝났지만 정리할 수 없다.
  - 구세대 Dispatch capability 주입 누락으로 감독이 안전하게 수동 완료한 구현 카드 5건은 공식 `worker_done`이 없어 `worker_done_recorded`에서 거부됐다.
  - 정확 handle 개별 종료 뒤 해당 8개 handle은 `terminal list`에서 사라졌지만, `roster resolve`는 계속 `live=true`를 반환했다.
- 요구 사항:
  - 공식 실패 보고로 정산된 `failed` 카드를 "실행 중"과 구분해 안전한 retire 대상으로 인정한다.
  - 구세대 capability 누락 이력은 가짜 `worker_done`을 만들지 않고, 수동 완료 근거·원 Dispatch·담당 pane·증거 경로를 검증하는 별도 이력 복구 절차로 정리한다.
  - `terminal list`에 없는 pane을 `roster resolve live=true`로 보고하지 않는다. pane·PTY·현재 handle을 실시간 대조하고 불일치는 fail-closed 영수증으로 노출한다.
- 가드레일: DB 직접 수정, 다른 완료 task 대입, 완료 보고 위조, 이름 기반 kill, worktree 광역 stop 금지. `project+board+role+pane+run+task`와 증거 경로를 끝까지 고정한다.
- 검증 기준: (1) 공식 `worker_done --outcome failed` 카드 retire 성공 (2) 실제 진행 중 카드 retire 거부 (3) 승인된 구세대 누락 이력 복구 후 retire 성공 (4) terminal 부재·roster 잔존 상태에서 `resolve`가 `live=false` 또는 명시적 stale 오류 반환.

## 결함 E 검증 가설 추가 (2026-08-04 kyle, 슈퍼감독 기록)

- Computer Use AXIsProcessTrusted false의 검증 가설: **"같은 앱이 스스로를 조작하지 못하는 제약"**에 막혔을 가능성 (kyle 제안). 운영·후보 문맥 모두 거부였던 실측과 부합하는지 결함 E 카드(task_08fc56ec260a)에서 함께 검증.
- 대안 경로: Computer Use를 Orca 내장 대신 **Codex 쪽을 거쳐** 실행하는 방식도 후보 — 추후 검증 (kyle).

## 우편함 시각화 + 스레드 일원화 (2026-08-05 kyle 아이디어, 슈퍼감독 기록)

- Why: 우편(Run 수신함) 소통에서 낱장 send는 대화의 이어짐이 안 보인다. 스레드(`thread_id`)는 이미 장부에 있지만 관습적으로만 쓰이고, 이번 판에서 "관문 질문 → 슈퍼 결정 → 적용 보고" 추적이 스레드 유무에 따라 편의가 크게 갈렸다.
- [ ] 우편함 시각화 작업 시 함께 검토: **스레드를 소통의 기본 단위(플래그)로 일원화** — 질문·결정·적용 계열 편지는 thread_id 필수화 후보, UI는 스레드 묶음으로 표시.
- [ ] 관련 관습(슈퍼감독 실전): 관문 해소는 "슈퍼 Run 스레드 답장 + 프로젝트 Run 공식 전달"을 한 쌍으로 — 스레드(대화 묶음)와 Run(수신함)은 별개 축이므로 둘 다 챙겨야 배달·추적이 모두 성립.

## Orca dispatch 제품 수준 라우팅 영수증 하드 강제(B안, gate_k_pin_receipt_scope, 슈퍼감독 기록)

- Why: 스킬 dispatch-safe를 우회한 raw orchestration dispatch도 라우터 선택 없이 실행되지 못하게 제품(Orca) 경계에서 차단한다. 이는 공격자 사례만이 아니다. 2026-08-07 정상 운영 중인 감독도 선택을 발령에 묶지 않는 지름길을 써 8건이 격리됐고, 정책 밖 모델이 실행될 수 있었다. R8 독립 검수가 "스킬 계층은 실제 대상 터미널 모델 결속과 raw dispatch 차단을 보증할 수 없다"고 판정(치명 1·치명 2)함에 따라, 위협 모델이 A안(스킬 2단계 영수증)에서 B안(제품 경계 하드 강제)으로 이관됐다(B안 이관 2026-08-06). A안 종결·descope 원 지시는 msg_8de55f6d81ab·msg_6c64bfafd352, 슈퍼감독 운영 판단.
- 제품(Orca) 책임(발령 전 단계):
  - 발령 전 dispatchId 예약 — `orchestration dispatch`가 실행 전에 `ctx_` ID를 발급하고 그 ID를 영수증에 결속한 뒤에만 실제 발령을 수행한다.
  - 제품 키 서명/MAC 영수증 — 영수증을 제품 키로 서명(또는 MAC)해 스킬 계층 위조를 무력화한다.
  - 영수증 없는 raw orchestration dispatch 거부 — 유효 영수증 없는 `orchestration dispatch` 직접 호출을 제품이 거부한다(재사용(replay)·만료 방지 포함). 특히 selection/round ID가 발령에 결속되지 않은 요청은 부작용 전에 제품 경계에서 막는다.
  - dispatch 응답에 대상 터미널의 실제 model/effort 반환 — 영수증 주장값이 아니라 실제 발령 모델·effort를 돌려준다. 선택값과 actual model/effort를 화면 상태바 판독 없이 기계적으로 대조할 수 있어야 하며, 권위 정보가 없을 때는 기존 계약대로 `unknown`을 정직하게 반환한다. 이것이 없으면 아래 스킬 한계는 어느 스킬 구현으로도 닫히지 않는다.
  - 정당한 예외 경로 — 무영수증 통과가 아니라 제품이 검증·감사 가능한 override 영수증으로만 허용한다. 최소 결속 필드는 사유(reason), 대체 경로(alternativePath), 원 라우터 출력(originalRouterOutput)+selectionId, 승인 ID(superApprovalId)이며, 1회성(singleUse)·범위 제한(scope)이 감사 기록에 남아야 한다. 이는 새 구현 범위가 아니라 B안 요구사항 문구 보강이다.
- 스킬(kyle-agent-skills) 책임(범위 축소): 안정 키 라우터 경유 증명 + 발령 뒤 append-only 감사 기록까지만. model/effort mismatch·actual_unreported는 감사에 사후 기록으로 남기되 **발령 거부 조건이 아니다**(D1 축소 명세, kyle-agent-skills routing-pin-contract.md 절 5.3.7).
- 검증 철학: raw dispatch 거부는 task·run·pane·model 바인딩과 재사용·만료 방지, selection/round ID 결속을 포함하고, 제품 카드 구현 뒤 독립 적대 검수로 닫는다. dispatch 응답의 actual model/effort도 영수증 선택값과 기계 대조해 검증한다.
- 선행 근거: kyle-agent-skills R8 독립 검수 치명 1(model/effort가 필수도 아니고 실제 터미널과 묶이지도 않음)·치명 2(휘발 6키 라이브 재계산 불완전 + 발급 experiment-key가 소비 경로에서 유실), 및 D1 축소 절 5.3.7. 증거 보고서는 본체 레포 kyle-agent-skills의 `.orca/evidence/router-improvement-1/track-k-code-r8-review/`, `track-k-descope-spec/`, `track-k-descope-implementation/`.
  - 격리 기록이 직접 증명한 것: 절대경로 `/Users/fw_m1/Dev/kyle-agent-skills/.orca/routing-events/conductor-hardening-1.quarantine.jsonl`에 `dispatch_missing_selection_or_round_id` 8건이 있고, 대표 발령은 `task_b4c634b3e37b`다. 이 기록은 selection/round ID 없이 발령을 시도한 사실까지만 증명한다.
  - 슈퍼 대조가 확인한 것: 대표 task는 `gpt-5.6-terra` `medium`으로 수동 발령됐고, 같은 시각 selector `sel-f3aa229860022b4a` 및 `sel-fbf740fd0404ea3c`가 실행됐지만 발령에 결속되지 않았다. 라우팅 원본에는 terra medium 항목이 없고 terra high는 비활성이어서 정책과 맞지 않는다. 제품 dispatch 응답은 실제 모델을 주지 않아 사람이 화면 상태바를 읽어야만 이를 확인했다.
  - 예외 경로 실측: 이번 문서 작업도 제품 영수증 경로가 준비되지 않아 공식 Orca dispatch가 멈췄고, 슈퍼 승인 `msg_66a273c3e40b`의 override 영수증(`/Users/fw_m1/Dev/orca-kyle/.orca/evidence/receipt-hardening-1/b-evidence-reinforcement/override-receipt.json`, selectionId `sel-150f47e8bb58bbef`) 뒤에만 외부 문서 작업자를 쓸 수 있었다. 강제만 만들고 검증 가능한 정당한 예외 경로를 주지 않으면 작업이 멈춘다는 근거다.
- 범위 밖: 본 카드는 이 TODO 항목 정리만 담당한다. 제품 구현과 push는 이 카드 범위 밖이며, 차기 orca-kyle 판 제품 카드로 kyle가 승격 여부를 결정한다.

## gate-create의 관문-편지 원자화 (2026-08-05 실사고 gate_404bcf8d5e01, 슈퍼감독 기록)

- Why: 감독이 decision_gate를 장부에 만들고 슈퍼 Run 편지 발송을 누락하면, 판 전체가 "정당한 대기"로 위장된 채 무기한 멈춘다 (실사고: E 관문 편지 미발송 → kyle 육안 발견까지 대기). 규칙 문장은 언젠가 빼먹힌다 — 절차를 코드로 옮긴다.
- [ ] `orchestration gate-create`가 관문 생성과 동시에 지정 상위 Run(예: --notify-run 또는 Run 계층 설정)으로 decision_gate 편지를 자동 발송 — 생성·통지를 원자적 한 동작으로. 편지 발송 실패 시 관문 생성도 실패(fail-closed).
- 임시 방어(코드 전까지): companion "고아 관문 NUDGE" (kyle-agent-skills TODO 2026-08-05 항목 — pending gate 존재 + 대응 편지 부재 → 감독 1회 깨움).

## companion 위임 소비 토큰 — pane 위장 요구 제거 (2026-08-06 kyle 승인, 슈퍼감독 기록)

- Why: companion이 감독 Run 우편함을 소비하려면 "감독 pane 안에서 실행 중"(`ORCA_TERMINAL_HANDLE` == 감독 handle)이어야 하는 현행 설계가, env로 신분을 위장해 상주하는 구조를 강제한다. 이 위장 신분은 앱 교체·재기동 경계에서 반드시 낡는다.
- 근거 (2026-08-05 실사고 2건, router-improvement-1 판):
  1. 앱 교체 직후 기동된 companion이 교체 전 pane handle(term_5dbfcd04)을 env로 물고 상주 — 매 주기 `consumer_owner_mismatch`로 배달·깨우기 전면 불능 1시간 반 (worker_done 미배달, kyle 육안 발견). 수리 지시: 슈퍼 Run msg_6dd62e79a5e3.
  2. 수리 재기동에서도 PPID=1 데몬화 과정에서 env 누락(`actual=missing`)으로 같은 fail-closed 재발 — 감독 하네스의 셸 도구가 pane env를 승계하지 않을 수 있음. 수리 지시: msg_1f22db96b486.
  - 교훈: "프로세스 살아있음 ≠ companion 정상". env 신분 요구가 있는 한 tmux·launchd 등 어떤 상주 방식으로 바꿔도 "env를 어떻게 정확히 물려주나" 문제가 남는다 (정적 plist에 handle을 박으면 낡은 신분을 오히려 굳힘).
- [ ] 제품이 companion에게 **위임 소비 자격**을 발급한다 — dispatch capability처럼 "이 Run의 Delivery를 감독 대신 소비·ack해도 된다"는 토큰(Run 단위, 감독이 발급, 만료·회수 가능). companion은 pane env 신분 없이 토큰만으로 `orchestration check` 소비가 가능해진다.
- [ ] 토큰 검증은 receipt-hardening-1 판이 확정한 "제품 검증 서명" 경계(앱 프로세스 보유 키, msg_502b46a75ed7)와 같은 축을 재사용한다.
- 범위 밖: 본 항목은 기록만. 제품 구현 승격은 receipt-hardening-1 판 B안 완료 후 kyle이 결정.

## orchestration send가 존재하지 않는 수신자를 조용히 받아들인다 (실패 닫힘 필요)

**Why**: 2026-08-07 슈퍼감독이 감독 handle 마지막 한 글자가 잘린 값(41자 중 40자)을 `--to`에 넣어 편지를 보냈는데, CLI가 오류 없이 `Sent msg_305bbffc2041`을 반환했다. 그 편지는 존재하지 않는 주소로 들어가 누구에게도 배달되지 않았고, 판 receipt-hardening-1은 그 사실을 모른 채 계속 서 있었다. 발신자는 보냈다고 믿었고 수신자는 받은 적이 없다.

**필요한 것**
- `orchestration send`가 `--to <handle>`을 받을 때 그 handle이 실제 존재하는 terminal인지 확인하고, 없으면 실패 닫힘으로 거부한다. 지금은 fail-open이다.
- `--to-role` 경로와 동일하게 후보 0개면 거부하는 규칙을 handle 경로에도 적용한다.
- 회귀 시험: 존재하지 않는 handle, 한 글자 잘린 handle, 이미 종료된 terminal의 handle 세 경우 모두 거부되는지.

**참고**: 실사고 기록은 super-conductor 스킬의 `references/incident-log.md` 2026-08-07 항목.

## dispatch_contexts가 비정상 종료 경로에서 정산되지 않고, 닫을 명령도 없다

**Why**: 2026-08-07 기준 `dispatch_contexts`에 `dispatched` 상태로 남은 행이 9건이고, 8월 2일부터 5일에 걸쳐 6개 서로 다른 판에서 나왔다. 정상 완료 경로에서는 정산된다(completed 389, failed 60). 그러나 교체·중단·사망으로 끝난 발령은 `dispatched` 행을 영구히 남긴다. `worker-abandon`과 `worker-stop`은 `worker_dispatches` 표를 보므로 이 행들에는 `dispatch_not_found`를 낸다. 결과적으로 한 카드의 현재 발령을 장부만으로 유일하게 결정할 수 없다. 실제로 R6 구현 카드에서는 진짜로 일한 발령만 completed로 닫히고, 죽은 창 2개가 유일한 "진행 중"으로 남았다.

**필요한 것**
- 발령 교체·중단·사망 경로에서도 `dispatch_contexts`를 종료 상태로 정산한다.
- 남은 행을 닫는 공개 CLI 명령을 추가한다(현재는 DB 직접 수정 외에 경로가 없고, 그건 금지다).
- 한 카드에 `dispatched`가 2개 이상이면 그 자체를 결속 위반으로 보는 검사.

## 카드 사양을 고칠 공개 명령이 없다 (정정이 원문을 덮지 못한다)

**Why**: 2026-08-07 슈퍼감독이 대기 중인 카드 하나의 문구를 고치라고 지시했는데, 공개 CLI에 카드 사양(spec)을 수정하는 명령이 없었다. 감독은 카드를 새로 만들지 않고 정정 내용을 addendum으로 결속한 뒤 "발령 시 addendum이 우선한다"는 규칙으로 처리했다. 올바른 대응이지만 원문은 그대로 남는다. 나중에 그 카드를 처음 보는 작업자가 원문을 먼저 읽고 폐기된 방향으로 시작할 위험이 있다.

**필요한 것**
- 발령 전 카드의 사양을 수정하는 공개 명령. 이력은 남기되 현재 사양이 무엇인지 한 번에 알 수 있어야 한다.
- 수정 이력과 현재 사양을 분리해 보여주는 조회. 지금은 원문과 정정이 같은 평면에 섞인다.
- 이미 발령된 카드는 수정 대상이 아니다. 그건 발령 교체로 처리한다.

**참고**: 자체 장부(conductor-core)로 옮길 때 같은 구멍을 재현하지 않도록 그쪽 후속 작업에도 기록했다.

**2026-08-09 재발 (다른 판, 같은 구멍)**: 판 mailbox-relay-1 감독이 대기 중인 카드 B9에 판정 기준 한 줄을 추가하려다 **`task-update`가 `--spec`을 받지 않아** 같은 벽을 만났다. 우회도 같았다 — 사양은 그대로 두고 **발령 시 지시문으로 전달**. 이틀 사이 서로 다른 판에서 두 번 물렸고, 두 번 다 감독이 알아서 우회했기 때문에 **제품 쪽에는 아무 신호도 남지 않았다.** 우회가 잘 되는 결함일수록 우선순위가 낮게 보이는데, 실제로는 **모든 감독이 매번 같은 비용을 낸다.**

## 정상 상태의 발령인데 worker_done이 dispatch_capability_invalid로 거부된다

**Why**: 2026-08-07 판 conductor-hardening-1에서 `task_54ebe4dacc2a` / `ctx_63f6c761ce95`의 최종 `worker_done` 보고가 `dispatch_capability_invalid`로 거부됐다. 그런데 같은 시점 `dispatch-show`는 그 발령을 정상으로 보고했다. 상태는 `dispatched`, `capability_revoked_at`은 `null`, `failure_count`는 0이었다. 즉 조회로는 멀쩡한 발령인데 그 발령으로 완료 보고를 할 수 없었다. 감독은 우회 장치를 만들지 않고 공개 CLI로 카드를 실패 정산한 뒤 상신했다.

**왜 중요한가**: 작업자가 일을 끝내고도 완료를 보고할 수 없으면, 판은 결과를 잃거나 중복 발령으로 되돌아간다. 그리고 조회 결과와 실제 수용 여부가 어긋나므로 감독이 원인을 진단할 수 없다.

**필요한 것**
- 거부 사유를 조회 가능한 상태와 일치시킨다. `dispatch-show`가 정상이라고 답한 발령은 완료 보고를 수용해야 하고, 수용하지 못한다면 그 이유가 조회에도 드러나야 한다.
- 거부할 때 어떤 조건이 깨졌는지 응답에 명시한다. 지금은 `dispatch_capability_invalid` 한 단어뿐이라 감독이 다음 행동을 정할 수 없다.
- 회귀 시험: 정상 발령의 완료 보고 수용, 실제로 권한이 회수된 발령의 거부, 그리고 두 경우가 조회 결과와 일치하는지.

**금지**: 우회 장치를 만들지 않는다. 이 결함은 장부를 우리 것으로 옮기면 우리 계약으로 다시 정의된다.

**증거**: `kyle-agent-skills/.orca/evidence/conductor-hardening-1/task_shadow_live_ab/` 아래 진단 보고.

## 판 마감 때 신분 정산이 강제되지 않는다 (2026-08-09 실측)

`roster list`에 **닫힌 판의 `active` 신분이 대량으로 남아 있다.** 실측된 판만 해도 roster-followup, upstream-sync-1, improvement-1, receipt-hardening-1, conductor-core-spike-1, orca-integration-1, rottie-master-integration-1이다. 판은 마감됐는데 신분은 살아 있는 것으로 조회된다.

왜 문제인가: 다음 작업이 **옛 handle을 현재 신분으로 잘못 쓸 수 있다.** `retired`가 active 후보 해석에서 제외되는 설계의 이점이 통째로 사라진다. 실제로 같은 role로 새 pane을 등록하려다 `role_roster_conflict`로 거부되는 사고가 이미 났다.

- 판 마감이 그 판의 신분 정산을 **강제하지 않는다.** 감독이 정산을 잊거나 비정상 종료하면 그대로 남는다.
- 정산이 안 된 신분을 사후에 찾아내는 수단이 없다. `cleanupCandidate` 필드가 있으나 이 경우들에는 붙지 않았다.
- 판 conductor-hardening-1은 마감하면서 49개를 정산했지만 **12개는 공식 `worker_done` 결속이 없어 정산할 수 없었다.** DB 직접 수정은 금지라 보존만 하고 넘어갔다. 즉 규칙을 지켜도 누수가 남는 경로가 있다.

필요한 것: 판 마감 시 남은 active 신분을 **집계해서 보여주는 수단**, 그리고 `worker_done` 결속이 없는 신분을 안전하게 정산하는 공식 동사. 계약 쪽 정의는 `conductor-core/docs/TODO.md` 5-3에 있다.

## cross-Run 편지의 dispatch 식별자 검증이 fail-open이다 (2026-08-09 시험 3회로 확정)

판 mailbox-relay-1이 슈퍼 Run으로 상위 보고를 보내려다 발견하고, 슈퍼 요청으로 3회 시험해 확정했다.

**증상**: 편지 payload에 실린 dispatch 식별자를 런타임이 조회해 소속을 검증하고, 소속이 다르면 `dispatch_run_mismatch`로 편지 자체를 거부한다. `--dispatch-id` 플래그든 `--payload` JSON 안에 직접 쓴 값이든 똑같이 검증한다.

**시험 결과** (판 3회 + 슈퍼 대조 2회)

| 시험 | 보낸 사람 | dispatch 소속 | 전달 경로 | 결과 |
|---|---|---|---|---|
| 1 | 판B | 가짜 id | payload JSON | **통과** |
| 2 | 판B | 발신자 Run 아님 | payload JSON | **거부** |
| 3 | 판B | (dispatchId 없음) | — | **통과** |
| 4 | 판A | **자기 Run** | payload JSON 표준 키 | **통과** |
| 5 | 슈퍼 | 남의 Run(판A 것) | payload JSON | **거부** |
| 6 | 슈퍼 | 남의 Run(판A 것) | `--dispatch-id` 플래그 | **거부** |

**확정된 규칙**: 검증 기준은 **수신 Run이 아니라 발신자의 Run**이다. 자기 Run 소속 dispatch를 다른 Run으로 보내는 것은 통과한다(시험 4). 전달 경로(플래그 대 payload JSON)는 무관하다 — 5와 6이 같은 결과다.

처음에 "payload JSON은 검증을 안 받는다"고 본 것도, 이어서 "cross-Run이면 무조건 거부"라고 본 것도 둘 다 틀렸다. 두 번 좁힌 끝에 위 규칙에 도달했다.

**왜 문제인가**

1. **검증이 fail-open이다.** 존재하지 않는 가짜 식별자는 통과하고, 실재하는 올바른 식별자만 막힌다. **올바른 데이터가 잘못된 데이터보다 더 엄격하게 막힌다.** 이 상태에서는 "거부되지 않았다"가 "식별자가 유효하다"의 근거가 되지 못한다. 편지에 실린 dispatch 식별자를 아무도 믿을 수 없게 된다.
2. **참조를 싣는 것과 실행을 지시하는 것을 구분하지 않는다.** 편지 payload는 참조 데이터인데, 런타임은 그것을 실행 권한처럼 검증한다. 그래서 남의 판 dispatch를 **인용조차 할 수 없다.** 슈퍼가 판 사이 사고를 기록하거나 한 판의 발령을 다른 판에 알려 주는 정상적인 일이 막힌다. 실제로 이 조사 중 슈퍼가 판A의 dispatch 식별자를 자기 편지에 인용하려다 두 번 거부당했다.
3. `taskId`는 검증되지 않는데 `dispatchId`만 검증되는 비대칭도 근거가 불분명하다.

**필요한 것**: 편지 payload는 참조 데이터이지 실행 지시가 아니다. 다른 Run의 식별자를 **참조로 싣는 것 자체는 허용**하고, 실행 권한이 필요한 자리에서만 소속을 검증해야 한다. 그게 어렵다면 최소한 가짜 식별자도 같은 기준으로 막아 fail-closed로 만들어야 한다. 지금은 둘 다 아니다.

슈퍼 쪽 임시 규약은 `super-conductor/references/board-opening-standard.md`의 "통신·보고 계약"에 기록했다.

## roster의 상태 필드를 믿을 수 없다 — 쓰기도 읽기도 거짓을 낸다 (2026-08-09 실측)

두 방향 모두에서 확인됐다.

**쓰기 쪽**: `roster retire`가 `ok=true`를 반환하면서 실제로는 `retired=false`로 남는다. 판 mailbox-relay-1이 **3회 관측**했다(검수자 은퇴). 3회면 우연이 아니다.

**읽기 쪽**: `roster list`의 `live` 필드가 실제 연결 상태와 다르다. 슈퍼 실측:

| role | roster `status` | roster `live` | `terminal show`의 `connected` | 실제 프로세스 |
|---|---|---|---|---|
| `worker-a1` | **active** | **True** | **False** | 없음 |
| `worker-a2` | **active** | **True** | **False** | 없음 |

판 conductor-core-contract-1은 이 둘을 `terminal close --terminal`로 **정상적으로 닫았다고 보고했고 그 보고가 맞다.** 프로세스도 없고 `connected`도 `False`다. 그런데 roster는 여전히 `active`·`live=True`이고 `cleanupCandidate=False`다.

**왜 심각한가**

1. **동시 실행 상한 계산이 틀어진다.** 두 판은 anthropic 동시 작업자 1명 상한을 roster/장부 기준으로 센다. 죽은 작업자가 live로 남으면 실제보다 많이 세어 발령을 못 하거나, 반대로 신분 충돌이 난다. 같은 날 두 판 합계 **active 34 / retired 12** 인데, 완료된 카드의 `worker-a1`·`reviewer-b1` 같은 것들이 전부 active로 남아 있다.
2. **`retire`가 성공을 보고하며 실패하므로** 감독이 정산했다고 믿고 넘어간다. 아침에 기록한 "판 마감 때 신분 정산이 강제되지 않는다"는 항목의 **실제 메커니즘이 이것**이다 — 강제되지 않는 것이 아니라 **강제한 결과가 반영되지 않는다.**
3. `cleanupCandidate`가 이 경우들에 붙지 않으므로 **사후에 찾아낼 수단도 없다.**

**필요한 것**: `live`를 실제 연결 상태(`connected`)에서 파생시키거나, 둘이 어긋날 수 있음을 소비자가 알 수 있게 한다. `retire`는 반영 실패 시 `ok=false`로 실패 닫힘해야 한다. 지금은 두 필드 모두 **신호가 무엇을 보증하는지 알 수 없는 상태**다.

**부수 관찰(슈퍼 자기 오류)**: 슈퍼가 이것을 확인하면서 `terminal show`의 `ok=true`를 살아 있음으로 읽었다. `ok`는 **핸들을 아는가**이지 **연결돼 있는가**가 아니다. `connected` 필드를 봐야 한다. 같은 날 "성공 신호가 무엇에 대한 성공인지 확인하라"를 두 판에 지시한 직후에 슈퍼가 그 규칙을 어겼다.

## 앱이 프로세스 추적용 `ps`를 7초마다 띄우고 한 번에 코어 대부분을 쓴다 (2026-08-09 슈퍼 실측)

**측정**: 20초 표본에서 `Orca Kyle` 본체(PID 30017)가 `ps -p <수백 개 PID>` 형태의 자식을 **3회** 띄웠다. 관측 시점의 `%CPU` 합이 **193%**(살아 있는 동안 각각 평균 약 64%). 대략 **7초에 한 번, 매번 코어 하나의 절반 이상**이다.

같은 날 같은 부류의 더 큰 건이 하나 더 있었다 — Claude Code 상태줄이 `ccusage`를 캐시 없이 매 렌더마다 호출해 **상시 코어 1~2개**를 태우고 있었고, 그 때문에 두 작업판이 부하 안전판에 걸려 발령을 멈췄다(`~/.claude/statusline-command.sh`에 60초 캐시를 넣어 해소).

**왜 기록하는가**

1. **감시·추적 도구 자신이 가장 흔한 부하원이다.** "가볍다고 가정한" 주기 실행은 대상 수와 인스턴스 수만큼 곱해진다.
2. 이 부하는 **판 안에서는 절대 안 보인다.** 판은 자기 프로세스만 세고, 그래서 부하를 자기 탓으로 오진한다(같은 날 실제로 발생 — 판이 자기 시험을 껐는데 부하가 더 올랐다).
3. `ps` 한 번에 수백 PID를 넘기는 것은 대상 목록을 매번 통째로 다시 훑는다는 뜻이다. 증분 갱신이나 캐시 여지가 크다.

**원인을 실측했다 — `-p`에 PID를 두 개 이상 넘기는 순간 절벽이 생긴다 (2026-08-09 정정)**

macOS `ps`는 `-p`에 PID를 **하나만** 주면 빠르고, **두 개 이상** 주면 개수와 무관하게 2초대가 된다.

```
ps -o pid= -o command= -p <PID 1개>       24~34ms
ps -o pid= -o command= -p <PID 2개>     1791~3254ms      <- 절벽
ps -o pid= -o command= -p <PID 3개>     2227~4315ms
ps -o pid= -o command= -p <PID 20개>    1811~2052ms
ps -o pid= -o command= -p <PID 300개>       1370ms
ps -Ao pid,command  (전체 2020개)        114~149ms       <- 2개 조회보다 15배 빠름
```

**개수에 비례하지 않는다. 1에서 2로 갈 때 약 70배 뛰고 그 뒤로는 평평하다.** 출력 옵션과도 무관하다(`-o pid=`·`-o command=`·`-o comm=` 전부 같은 절벽). 부하·전체 프로세스 수와도 무관하다(부하 6~9, 프로세스 1993~2020에서 반복 확인).

**앞서 이 항목에 적었던 "목록 길이에 정확히 선형"은 틀렸다.** 1개(4ms)와 300개(1370ms) 두 점만 보고 선형이라고 읽었는데, 2·3·5·20개를 채워 넣으니 **선형이 아니라 계단**이었다. **두 점으로 기울기를 그리면 안 된다.**

**필요한 것**

1. **`-p`에 PID 목록을 넘기지 않는다.** `ps -Ao`(전체 1회) + 앱 안에서 걸러내기로 바꾼다. 실측 기준 **15배** 싸다(2개 조회 2031ms vs 전체 116ms). PID가 딱 2~3개인 경우라면 **1개씩 나눠 호출하는 것이 더 싸다**(2개를 나눠 부르면 26~32ms, 한 번에 부르면 2031ms — **70배**). 이게 이 항목의 핵심이고 나머지는 부차적이다.
2. 호출 주기(현재 약 7초)와 대상 목록 산출 방식을 확인한다.
3. **주기 실행이 쓰는 CPU를 앱이 스스로 계측해 드러낸다.** 지금은 밖에서 `ps`로 잡기 전까지 아무도 모른다.

**대조 확인**: 같은 날 `Rottie Local` 2대도 프로세스 확인용 `ps`를 상시 띄우고 있었지만 **PID를 1~2개만 넘겨서 1회 약 4ms**였다 — 무시할 수준이라 별도 항목으로 남기지 않는다. **같은 도구, 같은 주기라도 목록 길이가 비용을 가른다.**

## `task-create`에 `--run`을 빠뜨리면 Run 밖 고아 카드가 조용히 만들어지고, 그 카드는 발령까지 된다 (2026-08-09 판 conductor-core-contract-1 실측)

**증상**: 감독이 검수 카드를 만들 때 `--run`을 빠뜨렸다. 카드는 **만들어졌고 발령됐고 작업자가 실제로 돌았다.** 그런데 **판 장부에는 안 잡힌다.**

```
장부 기준 dispatched                   1  (중계기 순찰뿐)
화면에서 실제 도구가 도는 pane          2  (A6-R4, A4-F4)
```

슈퍼가 장부를 조회해 1이라 했고 판은 화면을 보고 2라 했다. **둘 다 정확했고 근거가 갈렸다.** 원인은 카드 하나가 Run 밖에 있었던 것이다. 뒤늦게 `task-update --status ready`가 `task_not_found: Task ... was not found in Run run_01553b7a106b`를 내면서 드러났다.

**왜 심각한가**

1. **동시 실행 상한이 조용히 뚫린다.** 상한은 장부를 세어 판정하는데 고아 카드는 장부에 없다. 실제로는 상한을 넘겨 돌면서 도구는 통과시킨다.
2. **감시가 0으로 읽는다.** 정체 감지·판 비움 판정·마감 정산이 전부 장부 기준이다. 고아 카드는 처음부터 없었던 것처럼 보인다.
3. **생성 시점에 아무 경고가 없다.** 실패는 한참 뒤 `task-update`에서 처음 드러났고, 그때는 이미 작업자가 돌고 있었다.

이건 같은 날 두 판이 사냥하던 부류의 실물이다 — **"없다"와 "못 봤다"가 같은 값으로 나오고, 그 값이 통과 조건이다.**

**필요한 것**

- `task-create`에서 `--run`이 없으면 **실패 닫힘**으로 거절하거나, 최소한 경고와 함께 어느 Run에 들어갔는지 출력한다. 지금은 조용히 성공한다.
- 발령(`dispatch`)은 **대상 카드가 발령자의 Run에 속하는지 확인**한 뒤에만 진행한다. 지금은 Run 밖 카드도 발령된다.
- 판 마감 점검에 **"이 판 워크트리에서 도는 작업자 중 장부에 없는 것"** 조회를 넣는다. 고아를 사후에 찾을 수단이 현재 없다.

## 미배정(inbox) 카드 기능 정비 — 인계가 obsolete contract로 거부됨 (2026-08-12 kyle 실측)

**Why**: improvement-1 Track B가 만든 미배정 카드 대기실이 반쯤 고립됐다 — 카드를 넣을 수는 있는데
빼낼 방법이 전부 막혀 있다. 잔재 카드가 영구히 남는다.

실측 증상 3종 (2026-08-12):
- [ ] UI "run으로 보내기(인계)"가 `This orchestration mutation uses an obsolete contract. No effects
      were applied.`로 거부 — 인계 mutation의 contract_version이 현행 런타임과 어긋남. 갱신 필요.
- [ ] UI에 삭제/보관 처리 옵션이 없음 — 고아 카드(닫힌 판 잔재 task_41c6e23b53a3 등) 처분 불가.
- [ ] CLI(task-update)가 run_id NULL 카드에 못 닿음 — 바인딩 Run 범위만 조회. `--inbox` 같은
      스코프 지원 필요.

참고: 판 관제 대시보드 메모함 탭이 이 inbox를 읽기 전용 표면으로 보여주며 고아를 라벨링한다
(kyle-agent-skills board-dashboard.py /api/inbox-cards).
