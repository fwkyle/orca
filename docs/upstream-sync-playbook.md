# Upstream 동기화 랠리 플레이북

## Why

Orca Kyle 포크를 매월 upstream 원본과 맞출 때, kyle과 다음 감독·작업자가 검증된 순서와 근거를 먼저 읽고 시작하여 같은 충돌·시험 실패·환경 함정을 다시 밟지 않도록 한다.

## 운영 계약

이 문서는 살아있는 문서다. 매월 랠리를 시작하기 전에 처음부터 끝까지 읽고, 랠리가 끝나면 이번에 새로 발견한 충돌 유형·시험 실패·환경 함정을 갱신한다. 과거 판의 사례는 삭제하지 않고 누적한다. 숫자·SHA·카드 ID·evidence 경로는 실측값이고, 추정은 명시적으로 표시한다. 살아있는 플레이북은 생성 직후 Git 추적·커밋해 미추적 유실을 막는다.

포크 동기화 리듬은 docs/TODO.md 4번에 따라 3종이다. (1) 주 1회 upstream → `main` 무선별 ff 미러 — 운영 앱은 건드리지 않는다. (2) 월 1회 `main` → `bootstrap` 전체 병합 랠리 — 이 플레이북이 기록하는 절차다. 월간 병합 전에 먼저 최근 주간 미러가 건강한지 확인하고, 미러가 건너뛰어진 주(충돌 또는 ff 아님)가 있으면 월간 병합을 진행하지 않고 decision gate로 올린다. (3) 보안·P0 픽스는 월 랠리를 기다리지 않고 해당 커밋만 `git cherry-pick -x`로 즉시 반영한다. 이 세 가지 리듬은 서로 충돌하지 않고, 어느 것이 적용되는지는 대상과 시점으로 결정한다.

연결 문서: [orca-kyle-maintenance.md](./readme/orca-kyle-maintenance.md) — 포크의 기준선 관리와 월간 랠리 밖 선별 긴급 반영(stable tag / cherry-pick) 절차를 정의한다. maintenance의 '전체 동기화 금지'는 '자동·무검수·월간 랠리 밖의 전체 동기화 금지'를 뜻한다. 월간 랠리 자체는 kyle이 승인한 전체 병합 절차이므로 이 금지 대상이 아니다.

---

## 1. 이번 랠리 충돌 13건 유형과 해소 패턴

upstream/main `a6b14eb04`을 bootstrap `20cc28a5f` 위에 no-commit merge 할 때 13개 파일이 충돌했다. merge-base는 `d34bbd7917b3afde4c164ee7338dae4bf1e5818a`. 근거: [card-2-upstream-merge](../.orca/evidence/upstream-sync-1/card-2-upstream-merge.txt)

충돌 해소는 두 시점의 분류를 모두 기록한다. 초기 병합 시점 분류는 `card-2-upstream-merge.txt` 원문이고, remediation 이후 최종 분류는 `card-2-fix-r2.txt`의 appId 수동 복구를 반영한다.

### 초기 분류 (병합 직후, 합계 13)

| 분류 | 건수 | 파일 |
| --- | --- | --- |
| upstream 채택 (버전업) | 5 | daemon-foreground-confirmation-protocol.test.ts, daemon-protocol-version.test.ts, daemon-protocol-version.ts, local-build-compatibility-contract.json, local-build-compatibility-contract.ts |
| fork 채택 (의도적 단순화·브랜딩) | 4 | orchestration-db-retention-pagination.test.ts, GeneralUpdateSettingsSection.tsx, ReleaseChannelSection.tsx, SidebarSettingsHelpMenu.tsx |
| 수동 조합 (양쪽 보존) | 4 | electron-builder.config.cjs, package.json, db.ts, UpdateCard.error-card.test.tsx |

### 최종 remediation 분류 (fix-r2 반영, 합계 13)

contract 파일 2개(`local-build-compatibility-contract.json/.ts`)는 초기에 `--theirs`로 upstream 채택했으나 appId가 `com.stablyai.orca`로 덮여 fix-r2에서 포크 appId로 수동 복구했다. 따라서 최종적으로는 수동 조합이다.

| 분류 | 건수 | 파일 |
| --- | --- | --- |
| upstream 채택 (버전업) | 3 | daemon-foreground-confirmation-protocol.test.ts, daemon-protocol-version.test.ts, daemon-protocol-version.ts |
| fork 채택 (의도적 단순화·브랜딩) | 4 | orchestration-db-retention-pagination.test.ts, GeneralUpdateSettingsSection.tsx, ReleaseChannelSection.tsx, SidebarSettingsHelpMenu.tsx |
| 수동 조합 (양쪽 보존) | 6 | electron-builder.config.cjs, package.json, db.ts, UpdateCard.error-card.test.tsx, local-build-compatibility-contract.json, local-build-compatibility-contract.ts |

### 핵심 충돌 패턴 3가지

(1) 포크 appId 계약 — upstream 테스트는 `com.stablyai.orca`를 기대하지만 포크는 `com.chickenbreastky.orca-kyle`을 사용한다. `config/electron-builder.config.cjs`는 fork appId를 유지하되 upstream의 `devChannelBuildVersion`/`devChannelRepo` 로직을 도입했다. 단, `--theirs`로 contract 파일 2개를 가져오면 appId가 upstream 값으로 덮어씌워지므로 수동 복구가 필요했다. 근거: [card-2-fix-r2](../.orca/evidence/upstream-sync-1/card-2-fix-r2.txt), [card-2-review-r3](../.orca/evidence/upstream-sync-1/card-2-review-r3/report.md)

(2) DB schema v25와 기존 v23/v24 backfill — `db.ts`에서 fork와 upstream이 같은 v23에 각자 다른 기능(role_roster vs worker_terminal_resources)을 추가했다. `backfillWorkerTerminalResources()`가 `if (current < 23)` 안에만 있어 기존 포크 v23/v24 DB는 영구히 건너뛰는 결함이 있었다. 해결: SCHEMA_VERSION을 24에서 25로 승격하고 backfill을 별도 `if (current < 25)` 블록에 idempotent migration으로 배치했다. NOT EXISTS 가드로 재실행이 안전하다. 근거: [card-2-fix-r2](../.orca/evidence/upstream-sync-1/card-2-fix-r2.txt), [card-2-fix-r3](../.orca/evidence/upstream-sync-1/card-2-fix-r3.txt)

(3) xterm patch의 unified-diff context 공백과 .gitattributes 좁은 정책 — `config/patches/@xterm__xterm@6.1.0-beta.287.patch`의 단일 공백 20줄은 unified diff의 빈 context line이라 필수다. R2에서 trailing whitespace로 제거했다가 patch parser와 pnpm-lock hash가 깨졌다. 해결: MERGE_HEAD 원본으로 복구하고 `.gitattributes`에 `/config/patches/*.patch -whitespace` 한 줄을 추가해 patch 파일에만 whitespace 검사를 비활성화했다. 다른 파일은 영향 없다. 근거: [card-2-fix-r3](../.orca/evidence/upstream-sync-1/card-2-fix-r3.txt), [card-2-review-r3](../.orca/evidence/upstream-sync-1/card-2-review-r3/report.md)

---

## 2. 전체 시험 실패 10범주 분류표와 범주별 표준 방향

체크포인트 `9ec9f1657f`에서 루트 전체 시험을 실행한 결과 16개 파일 / 35개 시험이 실패했다 (1개 unhandled error 포함 시 36). 합계 검증: 7+1+2+3+11+3+2+4+1+2 = 36. 근거: [card-4-full-tests](../.orca/evidence/upstream-sync-1/card-4-full-tests/report.md), [card-4a-failure-triage](../.orca/evidence/upstream-sync-1/card-4a-failure-triage/report.md)

| 범주 | 묶음 | 건수 | 원인 | 표준 방향 | 근거 카드 |
| --- | --- | --- | --- | --- | --- |
| fork appId 계약 불일치 | A | 7 | upstream 테스트가 `com.stablyai.orca` 기대 | 포크 브랜딩 기대값 갱신 | card-2-fix-r2 |
| fork node:test 포맷 | B | 1 (unhandled) | vitest가 `node:test` suite 인식 불가 | runner/포맷 변환 (vitest exclude 또는 node:test→describe 마이그레이션) | card-4a |
| fork UI 기대값 | C | 2 | manual-only 모델과 upstream auto-update UI 불일치 | 포크 브랜딩 기대값 갱신 | card-4a |
| fork DB 스키마·retire blocker 기대값 | D | 3 | SCHEMA_VERSION 25 승격 1건 + `worker_done_recorded` retire blocker 기대 2건 | DB schema + retire blocker 기대값 갱신 | card-2-fix-r2 |
| OS·플랫폼·셸 환경 | E | 11 | Linux 기대 macOS 실행 (updater, csh 파서) | CI(Linux) 환경 분리, 소스 수정 불필요 | card-4a |
| macOS bash 3.2 | F | 3 | `declare -A`(associative array) 미지원 | Bash 3.2 호환 소스 수정 (NUL 순회 + `git cat-file -e`) | card-5e |
| 빌드 산출물 미생성 | G | 2 | `out/cli` 빌드 선행 필요 | 빌드 산출물 선행 | card-4a |
| fork 데이터 경로 격리 | H | 4 | `ORCA_USER_DATA_PATH` 미설정 시 throw | 테스트 격리 환경 설정 (ORCA_USER_DATA_PATH 지정) | card-4a |
| OS 로케일 (한국어) | I | 1 | ko_KR 로케일에서 cron 요일 라벨 현지화 | CI(영어 로케일) 환경 분리 | card-4a |
| ambient GIT_CONFIG_COUNT 간섭 | J | 2 | relay가 주입한 GIT_CONFIG_COUNT가 테스트 matcher 불일치 | CI(clean env) 환경 분리 또는 matcher에서 GIT_CONFIG_* 제외 | card-5g |

범주별 표준 방향 7가지 (A-J 각각 정확히 한 방향에 배정):

1. 포크 브랜딩 기대값 갱신 — upstream이 가져온 테스트가 포크 브랜딩(appId, UI 단순화)과 충돌할 때, 포크 의도에 맞게 테스트 기대값을 수정한다 (A, C).
2. runner/포맷 변환 — 테스트 실행기(vitest)가 인식하지 못하는 포맷(`node:test`)을 exclude하거나 마이그레이션한다 (B).
3. DB schema + retire blocker 기대값 갱신 — 스키마 버전 승격과 retire blocker(`worker_done_recorded`) 기대값을 포크 로직에 맞게 갱신한다 (D).
4. Bash 3.2 호환 소스 수정 — macOS 기본 bash에서 실행되는 셸 스크립트를 Bash 3.2 호환 코드로 수정한다 (F). 이번 랠리에서 `e3e527a58`에 실제로 커밋됐다.
5. 테스트 격리 환경 설정 — 포크 전용 환경변수(`ORCA_USER_DATA_PATH`)가 없어 throw하는 테스트에 격리 환경을 설정한다 (H).
6. OS·locale·ambient env 간섭 분리 — 로컬 macOS 환경 때문에 실패하지만 CI(Linux, 영어 로케일, clean env)에서는 통과하는 항목은 소스 수정 없이 환경 분리로 처리한다 (E, I, J).
7. 빌드 산출물 선행 — `out/cli`이나 `.generated` 파일이 없어 실패하는 항목은 빌드 단계에서 해결한다 (G, 모바일).

### macOS Bash 3.2 호환 사례 (범주 F 상세)

`.github/scripts/check-root-directory-entries.sh`가 `declare -A`를 사용해 macOS 기본 `/bin/bash` 3.2에서 시작부터 깨졌다. 첫 수정(R1)은 `comm -23` 기반이었으나 `comm`의 locale 정렬과 git ls-tree의 tree 순서가 달라 기존 한글 root 파일을 새 항목으로 오탐했다. 최종 수정(R2)은 NUL 구분 순회 + `git cat-file -e "${base_sha}:${entry}"` membership 검사로 교체했다. indexed array만 쓰고 associative array, comm, sort, mapfile을 사용하지 않는다. 근거: [card-5e-review-r1](../.orca/evidence/upstream-sync-1/card-5e-review-r1/report.md), [card-5e-fix-r2](../.orca/evidence/upstream-sync-1/card-5e-fix-r2.txt), [card-5e-review-r2](../.orca/evidence/upstream-sync-1/card-5e-review-r2/report.md)

### ambient GIT_CONFIG_COUNT 간섭 사례 (범주 J 상세)

Orca relay 프로세스가 터미널에 `GIT_CONFIG_COUNT=4`와 credential 쌍을 환경으로 주입한다. 테스트 1/2는 `expect.objectContaining({...process.env})`를 사용해 assertion 시점의 COUNT를 기대값으로 고정하지만, 소스는 spawn 시 기존 COUNT 위에 2개를 추가(append)해 COUNT=6으로 만든다. 이는 올바른 동작(`appendGitConfigEnv`)이지만 matcher가 불일치로 실패한다. 소스는 HEAD의 양쪽 부모와 바이트 동일해 회귀가 아니다. CI(clean env, COUNT=0)에서는 통과한다. 근거: [card-5g-agent-exec-diagnosis](../.orca/evidence/upstream-sync-1/card-5g-agent-exec-diagnosis/report.md)

---

## 3. 환경 함정

### Node 24 필수

터미널 기본 PATH의 Node는 v22일 수 있다. `pnpm test`와 `pnpm build:mac`는 Node 24(`v24.18.0`)에서 실행해야 한다. 매번 `env PATH=/Users/fw_m1/.nvm/versions/node/v24.18.0/bin:...`로 명시하거나 사전에 PATH를 전환한다. 새 Node 설치나 시스템 설정 변경은 하지 않는다. 근거: [card-4-full-tests](../.orca/evidence/upstream-sync-1/card-4-full-tests/report.md), [card-6-local-build](../.orca/evidence/upstream-sync-1/card-6-local-build/report.md)

### macOS Bash 3.2 호환

macOS 기본 `/bin/bash`는 3.2.57로 Bash 4+ 전용 기능(associative array `declare -A`, `mapfile`, `readarray`)을 지원하지 않는다. 셸 스크립트를 수정할 때는 indexed array + `while IFS= read -r -d ''` 또는 `git cat-file -e` membership 검사로 대체한다. `comm`이나 `sort`는 locale 정렬에 의존하므로 git tree 순서와 달라 오탐이 발생할 수 있다. 근거: [card-5e-fix-r2](../.orca/evidence/upstream-sync-1/card-5e-fix-r2.txt)

### 로컬 ad-hoc 서명과 macOS TCC 권한 불일치 (유력한 위험/추정)

- 실측: 새 로컬 빌드 뒤 `Orca Kyle Computer Use.app`의 Accessibility와 Screen Recording 권한이 `not-granted`로 돌아가 E2E가 차단됐다.
- 유력한 위험 (추정, 미실측): ad-hoc 서명은 빌드마다 코드 신원이 달라질 수 있어, macOS TCC가 이전 빌드에 준 권한을 새 빌드에 이어 주지 않을 가능성이 있다. 빌드 검수(card-6-build-review)는 이 인과를 당시 '미실측 위험'으로 기록했고, 후속 TCC 조사도 권한 문맥과 수명주기 가능성을 나눠 다뤘다. 인과를 확정하려면 연속 빌드의 code identity 변화와 TCC 불일치를 직접 측정한 근거가 필요하다.
- 주의: 시스템 설정 토글이 켜진 것처럼 보여도 새 코드 신원에 대한 TCC 결정이 무효화됐거나 낡은 기록을 가리키면 실제 권한이 적용되지 않을 수 있다.
- 현재 표준 복구 순서: helper bundle ID `com.chickenbreastky.orca-kyle.computer-use` 범위에서 낡은 Accessibility와 ScreenCapture TCC 기록을 먼저 reset한 뒤, 새 빌드 helper에 사용자가 macOS 개인정보 보호 및 보안의 손쉬운 사용과 화면 기록을 다시 승인한다. 이 카드에서는 아래 `tccutil` 명령을 실행하지 않고 절차만 기록한다.

  ```sh
  tccutil reset Accessibility com.chickenbreastky.orca-kyle.computer-use
  tccutil reset ScreenCapture com.chickenbreastky.orca-kyle.computer-use
  ```

- 복구 완료 확인: `orca computer permissions --json` 결과에서 `accessibility=granted`와 `screenshots=granted`를 모두 확인해야 한다. 둘 중 하나라도 `not-granted`이면 토글 외관만으로 완료 처리하지 않는다.
- 현재 구현: `pnpm build:mac`은 `Rottie Local` 방식의 전용 Keychain과 고정 identity `Orca Kyle Local Development Code Signing`을 사용한다. 인증서와 개인 키는 전용 Keychain에만 보관하고, 인증서 생성에 쓰는 임시 PEM/P12는 빌드가 끝나면 정리하며, Developer ID 릴리스 서명·공증 경로는 건드리지 않는다.
- 최초 준비는 `pnpm setup:mac-local-signing`으로 한다. 이 명령은 고정 identity가 없을 때만 전용 인증서를 만들고, 이미 다른 인증서가 있어도 그 인증서를 자동 선택하지 않는다. 고정 identity 또는 전용 Keychain이 없거나 손상되면 명확히 실패한다.
- R2(2026-08-04) 이후 verify/setup은 신뢰되지 않은 identity(`(CSSMERR_TP_NOT_TRUSTED)`처럼 괄호 상태가 붙은 항목)를 유효로 승인하지 않는다. codesign이 쓸 수 없는 상태이면 SHA-1 hash와 Keychain Access 승인 절차를 담은 오류로 명확히 실패한다. 또한 setup이 신뢰 등록에 실패하면 그 실행이 방금 import한 인증서·개인 키를 자동 롤백하므로, 실패를 반복해도 고아 인증서가 더 쌓이지 않는다. 기존 고아 항목은 자동 정리하지 않는다.
- 손상 진단 (track-a-review-r1 실기기 실측): 전용 Keychain 안에 같은 이름 인증서 4개(SHA-1: A32F4023…, 280B3561…, A09FB6FA…, DE050927…)가 있고, 이 중 개인 키가 붙은 identity는 A32F4023… 1개뿐이며 `(CSSMERR_TP_NOT_TRUSTED)` 상태라 codesign이 거부한다. `security dump-trust-settings`에는 이 인증서의 신뢰 설정이 없고, 비밀번호 레코드(`local-signing-keychain-password-f067c35e262b1043`, 메타데이터만 확인)는 로그인 Keychain에 남아 있다.
- 손상 상태 수동 복구는 에이전트가 자동 실행하지 않는다. 아래 절차는 kyle의 decision_gate 승인 후 kyle이 직접 실행한다.

  경로 A (기존 인증서 승인 — 가장 적은 변경):
  1. Keychain Access에서 전용 Keychain(`~/Library/Application Support/com.chickenbreastky.orca-kyle/local-signing/orca-kyle-local-signing.keychain-db`)을 열고, SHA-1 `A32F4023…` 인증서를 더블클릭한다. 같은 이름 인증서가 여러 개이므로 hash로 구별한다.
  2. Trust 항목을 펼쳐 "When using this certificate"를 "Always Trust"로 바꾼다. GUI 비밀번호 입력이 필요한 자동화 불가 지점이다.
  3. `pnpm setup:mac-local-signing`을 다시 실행해 identity hash가 출력되며 성공하는지 확인한다.
  4. (별도 승인 시) 개인 키가 없는 고아 인증서 3개만 정리한다: `security delete-certificate -Z <SHA-1> "<전용 Keychain 경로>"`를 280B3561…, A09FB6FA…, DE050927… 각각에 실행한다.

  경로 B (전용 Keychain만 완전 초기화):
  1. `security delete-keychain "<전용 Keychain 경로>"`
  2. 로그인 Keychain의 비밀번호 레코드만 삭제: `security delete-generic-password -s "local-signing-keychain-password-f067c35e262b1043" ~/Library/Keychains/login.keychain-db`. 접미사는 전용 Keychain 경로 sha256의 앞 16자로, `node -e "console.log(require('crypto').createHash('sha256').update('<전용 Keychain 경로>').digest('hex').slice(0,16))"`로 재계산할 수 있다.
  3. `pnpm setup:mac-local-signing`을 GUI 세션에서 다시 실행하고 신뢰 등록 프롬프트를 승인한다.

- 주의: 로그인 Keychain 전체를 삭제·초기화하지 않는다. 위 파괴적 명령은 kyle의 현재 시점 승인 없이 실행하지 않는다.
- 환경 점검은 아래처럼 전용 Keychain을 직접 지정해 실행한다. 출력에는 identity 이름과 hash만 남기며, 개인 키·인증서 파일·Keychain 비밀번호는 출력하거나 보고서에 복사하지 않는다.

  ```sh
  pnpm setup:mac-local-signing
  security find-identity -v -p codesigning "$HOME/Library/Application Support/com.chickenbreastky.orca-kyle/local-signing/orca-kyle-local-signing.keychain-db"
  ```

- `pnpm build:mac`은 메인 앱, Computer Use helper, notification helper에 같은 `CSC_NAME`과 `CSC_KEYCHAIN`을 전달한다. 인증서가 없거나 서명 검증이 실패하면 다른 Keychain이나 ad-hoc identity로 바꾸지 않고 빌드를 중단한다.
- 완료 증거: 같은 인증서로 연속 2회 빌드해 서명 신원이 유지되고, 두 번째 빌드에서 권한 재승인 없이 `computer capabilities`와 `computer list-apps`가 성공해야 한다.
- 실제 TCC 검증을 안전하게 실행할 수 없는 환경에서는 위 서명 확인만으로 권한 유지까지 PASS 처리하지 말고, `accessibility=granted`, `screenshots=granted` 및 두 번째 빌드의 재승인 없는 성공을 미확인 관문으로 보고한다.
- 근거: [paired live QA 보고서](../.orca/evidence/upstream-sync-1/card-7-r4-paired-live-qa/report.md), [빌드 검수 사소 s4 미실측 위험](../.orca/evidence/upstream-sync-1/card-6-build-review/report.md)

### ambient GIT_CONFIG_COUNT 간섭

Orca relay가 터미널에 주입하는 `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*` 환경변수가 테스트 matcher를 불일치시킨다. 로컬에서 시험을 실행할 때는 이 환경이 상속되어 실패할 수 있으므로, CI(clean env) 결과와 분리해 판단하거나 matcher에서 `GIT_CONFIG_*` 키를 제외한다. 근거: [card-5g-agent-exec-diagnosis](../.orca/evidence/upstream-sync-1/card-5g-agent-exec-diagnosis/report.md)

---

## 테스트 실패·환경 분류 기준

월간 랠리의 실패와 미실행 항목은 [위 10범주 분류표](#2-전체-시험-실패-10범주-분류표와-범주별-표준-방향) 기준으로 분류한다. `kyle 미사용 기능 → 관문 제외 후순위`는 다음 네 조건을 모두 만족할 때만 적용한다.

(1) 이 포크에서 기존 통과 증거가 없어 회귀(regression)로 볼 수 없다.
(2) kyle이 실제로 사용하는 핵심 흐름과 무관하다.
(3) 결함을 삭제하거나 숨기지 않고 `ready`/`TODO` 후속 카드로 보존한다.
(4) 보안 문제, 데이터 손상, 핵심 경로 영향이 있는 항목은 이 범주로 내리지 않는다.

| 범주 | 관문 처리 | 후속 보존 |
| --- | --- | --- |
| `kyle 미사용 기능 → 관문 제외 후순위` | 이번 핵심 릴리즈 관문과 현재 E2E에서 제외한다. | 원인과 근거를 남기고 `ready`/`TODO` 카드로 유지하며, 고정 로컬 서명 카드와 연계한다. |

### 적용 사례

- **Linux 계열·macOS 로컬 랠리 미실행 항목:** Linux 계열 경로와 macOS 로컬 랠리에서 아직 실행하지 않은 항목은, 이 포크에 기존 통과 증거가 없고 kyle의 현재 핵심 흐름과 무관한 경우 위 범주로 분류한다. 미실행 사실을 결함 삭제로 처리하지 않고 `ready`/`TODO` 후속 카드로 남긴다.
- **Computer Use `AXIsProcessTrusted` false (`task_08fc56ec260a`):** fresh helper로 교체하고 `accessibility=granted`, `screenshots=granted`를 확인한 뒤에도 운영과 candidate의 같은 exact Computer Use 경로가 `permission_denied`를 반환한 사례다. kyle의 현재 핵심 흐름에서 이 Computer Use E2E는 사용하지 않으므로 이번 E2E 관문에서는 제외하되, 결함과 후속 판단을 삭제하지 않고 고정 로컬 서명 카드와 함께 `ready`/`TODO`로 보존한다.

근거: [fresh 운영·candidate AX 조사](../.orca/evidence/upstream-sync-1/card-7f-tcc-context-discriminator/report.md), [get-app-state 소스 조사](../.orca/evidence/upstream-sync-1/card-7e-get-app-state-permission-investigation/report.md), [TCC reset·고정 로컬 서명 업데이트](../.orca/evidence/upstream-sync-1/playbook-tcc-reset-update/report.md).

---

## 4. 다음 월간 랠리 카드 템플릿

매월 랠리는 아래 순서로 카드를 발령한다. 각 단계는 명시된 관문을 통과해야 다음 단계로 넘어간다. 관문이 없는 단계는 같은 카드에서 직접 진행한다.

1. 현황 실측 — 현재 HEAD, branch, upstream/origin remote SHA, rev-list 차이, dirty state를 읽기 전용으로 측정한다. 관문: 실측 완료 자체. (예: [card-1-current-state](../.orca/evidence/upstream-sync-1/card-1-current-state.txt))
2. main → bootstrap 병합 — 최근 주간 upstream → `main` 미러가 건강한지(건너뛰어진 주가 없는지) 먼저 확인한다. 미러가 건너뛰어진 주가 있으면 월간 병합을 진행하지 않고 decision gate로 올린다. 미러가 건강하면 `git merge --no-commit --no-ff main`으로 `main`을 `bootstrap` 위에 no-commit 병합한다. origin/main이 조상이면 Already up to date로 확인한다. 관문: 미해결 충돌 0 (`git diff --name-only --diff-filter=U`, `git ls-files -u`). (예: [card-2-upstream-merge](../.orca/evidence/upstream-sync-1/card-2-upstream-merge.txt), [card-3-origin-main-merge](../.orca/evidence/upstream-sync-1/card-3-origin-main-merge.txt))
3. 병합 독립 검수 — 병합 무결성(충돌 0, diff --check, MERGE_HEAD 일치)과 충돌 해소 정확성(appId, DB schema, xterm patch)을 별도 검수자가 확인한다. 관문: 검수 PASS. PASS 전에 커밋하지 않는다. (예: [card-2-review-r3](../.orca/evidence/upstream-sync-1/card-2-review-r3/report.md))
4. 전체 테스트 — Node 24에서 루트 `pnpm test`와 모바일 `pnpm --dir mobile test`를 각 1회 실행한다. 관문: 실행 완료 자체 (결과가 FAIL이어도 분류를 위해 진행). (예: [card-4-full-tests](../.orca/evidence/upstream-sync-1/card-4-full-tests/report.md))
5. 실패 분류 — 실패를 10범주 분류표로 나누고, 각 범주의 표준 방향을 결정한다. 관문: 모든 실패가 정확히 한 범주·한 방향에 배정됨. (예: [card-4a-failure-triage](../.orca/evidence/upstream-sync-1/card-4a-failure-triage/report.md))
6. 실패 수정 + 로컬 빌드 — 분류된 수정(기대값 갱신, 소스 수정, 환경 설정)을 적용한 뒤 `pnpm build:mac`로 macOS 산출물을 만들고 bundle id, version, commit, architecture, codesign(헬퍼 2개)을 검증한다. 관문: 빌드 산출물 독립 검수 PASS. (예: [card-6-local-build](../.orca/evidence/upstream-sync-1/card-6-local-build/report.md), [card-6-build-review](../.orca/evidence/upstream-sync-1/card-6-build-review/report.md))
7. 실기동 E2E — 후보 앱을 격리 기동(QA root)하여 repo/worktree 인식, terminal 왕복, 오케스트레이션 Run/task/message/check-ack를 검증한다. Computer Use는 kyle 미사용 시 관문에서 제외한다. 관문: 실행 완료. 이번 판에서 terminal close가 `tab_not_found`로 FAIL했지만, 이것은 기존 결함이다 (아래 단계 8 참조). (예: [card-7g-core-live-e2e](../.orca/evidence/upstream-sync-1/card-7g-core-live-e2e/report.md))
8. E2E 독립 검수 + 기존 결함 분리 — E2E 결과를 독립 검수한다. 새 회귀(이번 동기화로 생긴 결함)는 치명·중요가 0건이어야 교체 관문을 통과한다. 기존 결함(회귀 아님)은 네 가지 후순위 조건을 만족하면 관문에서 제외하고 `ready`/`TODO`로 보존한다. 이번 판의 사례: Card 7G terminal close `tab_not_found` FAIL → [Card 7H 조사](../.orca/evidence/upstream-sync-1/card-7h-terminal-close-investigation/report.md)가 구빌드 `ee610730d`에서 동일 실패를 실측해 EXISTING_DEFECT_NOT_REGRESSION으로 분류 → 결함 F ready로 보존, 교체 관문 차단 사유에서 제외. 관문: 새 회귀 치명·중요 0건.
9. 운영 앱 교체 — 분리 실행(detached script)으로 운영 앱 PID를 정확히 식별·종료하고 후보 앱으로 교체한 뒤, PID, appVersion, runtime ready, userData 불변을 확인한다. 교체 후 roster rebind 실전 검증으로 장부 일치를 확인한다. 관문: 교체 후 status ready + roster rebind 일치. (예: [app-replacement-20260804](../.orca/evidence/upstream-sync-1/app-replacement-20260804.md), [card-8-roster-rebind-live-validation](../.orca/evidence/upstream-sync-1/card-8-roster-rebind-live-validation/report.md))

커밋은 단계 3(병합 독립 검수) PASS 후에만 한다. push는 kyle의 명시적 지시가 있을 때만 한다.

---

## 5. 이번 판 핵심 SHA 및 evidence 경로

| 항목 | SHA / 값 | 비고 |
| --- | --- | --- |
| upstream/main | `a6b14eb04c9aa8a1812f2a74a417fbb7d79eb68b` | fetch 후 ls-remote = local ref 일치 (실측) |
| origin/main | `79251d7a9861568dc261faabfa16df5347d1d008` | Already up to date (실측) |
| bootstrap HEAD (병합 전) | `20cc28a5f60e4ac909097a7b237ae22da21821eb` | 병합 기준점 (실측) |
| merge checkpoint | `9ec9f1657f1b3bb0c919ee59fa65d4f457a42554` | 전체 테스트 실행 시점 (실측) |
| build HEAD | `e3e527a58ab308d64e8f13aaebd2962f78df39f0` | 로컬 빌드 산출물 기준, Bash 3.2 소스 수정 포함 (실측) |
| 운영 앱 교체 HEAD | `4cf749aaab07ad5e39e2780bc84463bf224cdc15` | 최종 교체·roster rebind 검증 (실측) |
| 기존 결함 대조 빌드 | `ee610730d` | Card 7H terminal close 기존 결함 실측 (실측) |
| daemon protocol | 32 | upstream 버전업 반영 (실측) |
| SCHEMA_VERSION | 25 | fork backfill 분리 (실측) |
| appId | `com.chickenbreastky.orca-kyle` | fork 브랜딩 (실측) |
| 충돌 파일 수 | 13 | no-commit merge (실측) |
| 루트 시험 실패 | 35 test + 1 unhandled = 36 | 10범주 분류 (실측) |
| 모바일 시험 | 13 suite 로드 실패, 0개별 실패 | codegen 빌드 산출물 필요 (실측) |

evidence 디렉토리: `.orca/evidence/upstream-sync-1/`

역링크: [orca-kyle-maintenance.md](./readme/orca-kyle-maintenance.md)
