# C 관계 조립과 비용 분해

이번 실험은 조인 결과를 **중복된 평면 JS 행으로 모두 만든 뒤 다시 묶는 작업**을 없앤다. SQL은 그대로 실행하고, SQLite 값을 C에서 읽어 PK별로 중복 제거한 다음 최종 중첩 JS 객체를 만든다. JS 비즈니스 로직이 받는 객체의 필드·타입·배열 순서는 기존 경로와 같다.

## 재현

```sh
cd orm
npm run check
npm run bench:graph -- --customers 1000 --repeats 3 --samples 7 --profile-samples 7 --out results/my-graph-experiment
```

각 시나리오·실행기를 새 프로세스/DB에서 3회 반복하고, 프로세스마다 7개 배치를 측정한다. 순서는 회차와 시나리오에 따라 회전한다. 전체 wall/CPU 시간은 **단계별 타이머를 끈 상태**에서 측정한다. 계측은 그 뒤 별도 호출로 진행하며 같은 값이 반환되는지 매번 검증한다. 강제 GC는 워밍업 뒤와 진단 시작 전 한 번씩만 수행한다.

## 구현 경로

| 실행기 | 처리 |
| --- | --- |
| node-driver-js | Node SQLite 평면 행 → JS 관계 조립 |
| node-compiled-js | Node SQLite 평면 행 → 생성 JS 타입 매퍼 → JS 관계 조립 |
| native-flat-js | C SQLite → 평면 JS 객체 → JS 관계 조립 |
| native-graph | C SQLite → C 값 검증/해시 맵/엔티티 저장 → 최종 JS 객체 |

주 대조군은 **native-flat-js와 native-graph**다. 같은 시스템 SQLite 빌드, SQL, 바인딩, 연결 옵션과 반환 계약을 사용하므로 이전 Node/C 비교의 SQLite 버전 차이를 제거한다. Node 경로와의 비교에는 여전히 SQLite 버전/빌드 차이가 남는다.

두 관계 조립기는 글로벌 PK 조회와 최초 등장 순서를 사용한다. C는 open-addressing 해시 테이블과 엔티티 배열/자식 인덱스를 쓰며 JS는 Map/Set/배열을 사용한다. 정렬된 입력에만 가능한 특별한 알고리즘을 C에만 적용하지 않는다. 같은 PK의 첫 값을 보존하며, PK가 서로 다른 부모에 중복되는 데이터의 일관성을 검사하는 기능은 아니다. 픽스처는 PK/FK로 이 조건을 보장한다.

C는 모든 접근 행의 타입과 int32 범위를 검사하고, 고유한 엔티티의 문자열만 복사해 소유한다. 최종 JS 객체를 만든 뒤 호출 종료 전에 C 메모리를 해제한다. 행별 SQLite 문자열 포인터를 다음 sqlite3_step 이후까지 보관하지 않는다. 임시 V8 핸들은 고객/주문/항목 단위의 scope로 제한한다.

현재 `query.commerce()`는 **이 커머스 모델의 11개 projection에 특화된 실험 API**다. 컬럼 이름·순서·타입·nullable 계약을 확인한다. 임의 모델에서 쓸 수 있는 범용 관계 쿼리 플래너는 아직 아니다.

```js
const session = openSession(path, { engine: 'native' });
const query = session.prepareQuery(sql, parameters, JoinRow);

query.all();                       // 평면 JS 행
query.commerce();                  // C에서 조립한 최종 고객/주문 그래프
query.profile();                   // 평면 경로의 rows + timings
query.commerce({ profile: true }); // 최종 그래프 + 단계별 timings + 객체 개수
query.scan();                      // SQL 실행 후 행 개수만 반환하는 진단 대조군
```

`JoinRow`와 SQL은 [커머스 픽스처](bench/commerce.mjs), C 조립기는 [commerce.c](native/commerce.c)에 있다. 한 세션의 트랜잭션 안에서는 미커밋 변경을 볼 수 있고 롤백 후에는 기존 값을 다시 반환한다.

## 데이터와 정확성

- **standard:** 기존 1,000명 고객 픽스처, 6,739개의 JOIN 결과 행.
- **fanout8:** 자식이 있는 주문에 항목 8개와 결제 8개를 붙인다. 한 주문에서 최대 64행이 나오며 빈 관계도 유지한다. 고객 1,000명 설정에서 75,897행이 반환된다.
- **page50:** standard 데이터에서 고객 50명을 먼저 고른 뒤 자식을 JOIN한다. 결과 389행이며 자식을 잘라내지 않는다.

기준 결과는 원본 엔티티 배열을 따로 순회해서 만들며 실제 JS/C 관계 조립기를 재사용하지 않는다. 각 실행은 프로파일을 포함해 동일한 그래프를 반환해야 한다. 테스트에는 역순·서로 섞인 행, 불연속 중복, 빈 결과/관계, 0·음수·int32 경계 ID, Unicode/NUL/빈 문자열, nullable 자식 값, 결과 변경 독립성, 잘못된 projection/타입, 오류 후 재사용, 연결 종료와 트랜잭션 가시성을 포함한다.

## 계측을 읽는 방법

| 구간 | 포함하는 작업 |
| --- | --- |
| SQLite step | SQLite VM, JOIN/정렬/페이지 접근과 SQLite 내부 값 생성 |
| C decode | 저장 타입 검사, 정수 범위 검사, SQLite 값/문자열 포인터 읽기 |
| C grouping | PK 조회, 중복 제거, C 엔티티 할당과 고유 문자열 복사 |
| Final JS creation | Node-API를 통한 값 변환, 최종 객체/배열/속성 생성과 이때 발생한 GC |
| Native cleanup | C 엔티티·문자열·해시 테이블 해제 |
| JS grouping | Map/Set으로 묶고 최종 JS 객체 만들기 |

기존 C 평면 경로에서는 값 디코딩과 JS 객체 생성이 같은 함수 안에 있어 합쳐 기록한다. Node driver의 공개 API는 SQL 실행과 원시 JS 행 생성을 분리하지 않으므로 `driverReadMs`에 함께 기록한다. 형변환/할당만의 시간으로 이름을 바꾸어 과장하지 않는다.

계측에는 행마다 시계를 읽는 비용과 실행 흐름 변화가 있다. 따라서 **프로파일 표를 최종 속도 비교에 사용하지 않는다.** 프로파일에는 각 전체 호출 시간도 기록해 타이머 없는 결과와 차이를 볼 수 있다. 각 단계의 중앙값을 더한 값이 전체 시간의 중앙값과 정확히 같을 필요는 없다.

별도 `native-scan`은 같은 SQL에서 행 개수만 세고, `js-group-only`는 미리 만든 평면 객체를 반복 사용한다. 둘 다 반환 계약/객체 수명/캐시 상태가 달라서, 전체 시간에서 이 값을 빼고 나머지를 정확한 객체 생성 비용이라고 주장하지 않는다. JSON의 그래프 개수는 기준 결과의 개수이며 scan이 그 객체를 생성한다는 뜻은 아니다.

## 해석의 범위

개선 요인은 C에서 더 적은 JS 객체와 문자열을 만들도록 처리 순서를 바꾼 것이다. 이 변경은 언어뿐 아니라 중간 표현과 메모리 할당 방식도 바꾼다. 단계별 계측으로 주요 비용 위치를 확인할 수 있지만, 문자열 변환·속성 설정·GC 각각의 인과 효과를 따로 측정한 것은 아니다. 원시 driver 행과 고정 형태의 일반 JS 행에서도 그룹화 시간이 다를 수 있다.

모든 API는 여전히 **동기식**이다. setImmediate 지연은 쿼리 앞에 예약한 콜백 한 번으로 측정한다. 쿼리가 빨라지면 메인 스레드를 붙잡는 시간이 줄어들 수 있지만, 작업을 별도 스레드로 옮긴 구현은 아니다. HTTP 처리량/p99, peak memory, TypeORM 대비 배수, 다른 DB/모델의 성능은 이 결과로 주장하지 않는다.

측정 결과: [보고서](results/2026-10-01-graph.md), [원시 샘플·환경·SQL·소스 해시](results/2026-10-01-graph.json).
