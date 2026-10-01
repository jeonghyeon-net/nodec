# 복잡한 쿼리, 트랜잭션, 락 실험

단일 테이블 조회만으로 관계 ORM이나 이벤트 루프 병목을 평가할 수 없다. SQL 실행, 중복 행 생성, 관계 객체 조립, 커밋, 락 대기는 원인과 개선 방법이 다르므로 다음 워크로드를 각각 기록한다.

## 재현

```sh
cd orm
npm run check
npm run bench:complex -- --customers 1000 --samples 9 --lock-samples 3 --out results/my-complex-experiment
```

`driver`, `generic`, `compiled`, `native`마다 별도 프로세스와 SQLite 파일을 사용한다. 동일 입력·SQL·바인딩으로 비교하며 준비·삽입·워밍업은 측정 밖이다. 원시 샘플, SQLite 버전/빌드 옵션, PRAGMA, SQL, 바인딩, 실행 계획, 소스 해시를 JSON에 저장한다. `compiled`는 준비 시 생성한 JS 매퍼이며 C로 컴파일한 JS가 아니다.

## JOIN과 집계

기본 픽스처는 고객 1,000명, 주문 2,000개, 상품 100개, 주문 항목 4,998개, 결제 내역 2,001개다. PK/FK, 관계 키 인덱스와 `ANALYZE`를 적용한다. 주문이 없는 고객, 상품 항목이 없는 주문, 결제가 없는 주문도 포함한다.

```text
customer → orders → item → product
                  → payment
```

상품 항목과 결제를 동시에 JOIN하면 한 주문의 항목 수 × 결제 수만큼 행이 늘어난다. `join-flat`은 이를 그대로 반환하고, `join-graph`는 고객·주문·항목·결제의 PK를 기준으로 중복을 제거하여 중첩 JS 객체를 만든다. 모든 실행기가 **같은 JS 관계 조립 함수**를 사용한다. native만 C에서 관계를 조립하는 실험은 아직 아니다.

이후 추가된 [H006 / C 관계 조립 실험](GRAPH.md)은 C 내부에서 중복 제거를 끝내는 별도 경로를 비교한다. 이 문서와 초기 복합 워크로드의 측정 결과는 기존 JS 관계 조립 경로를 그대로 가리킨다.

`join-page`는 CTE 안에서 고객 50명을 먼저 선택한 뒤 자식을 JOIN한다. JOIN한 행에 바로 LIMIT를 걸어서 한 고객의 자식이 잘리는 오류를 피한다. `aggregate`는 항목 금액과 결제 금액을 각각 먼저 집계하고 고객별 `GROUP BY`, `HAVING`, 합계 정렬, LIMIT를 적용한다. 항목 × 결제 행에 곧바로 SUM해서 금액이 부풀어 오르는 오류를 검사한다.

기준 결과는 원본 엔티티 배열을 따로 순회해서 만든다. SQL 결과나 실제 관계 조립 함수를 기준 결과 생성에 재사용하지 않는다. flat 행과 최종 그래프를 각각 비교한다. JOIN 전후 실행 시간 차이는 독립 프로세스 측정이므로 단순 차감을 정확한 조립 비용으로 해석하지 않는다.

## 트랜잭션

`openSession(path, { engine })`은 단일 연결을 소유한다. `prepareQuery(sql, parameters, resultModel)`과 `prepareRun(sql, parameters)`는 준비된 쿼리를 반환하며 파라미터는 준비 시 고정된다. SQL은 실험 작성자가 제공하고, 결과 모델 필드의 이름·순서는 SELECT 컬럼과 맞춰야 한다. 일반 관계 ORM DSL은 아니다. DB 파일은 사전에 생성해야 한다.

```js
const debit = session.prepareRun('UPDATE account SET balance = balance - ? WHERE id = ?', [3, 1]);
const credit = session.prepareRun('UPDATE account SET balance = balance + ? WHERE id = ?', [3, 2]);

session.transaction(() => {
  debit.run();
  credit.run();
  // 이 세션에서 실행하는 조회는 위의 미커밋 쓰기를 볼 수 있다.
});
```

벤치마크는 이체 원장 INSERT와 잔액 SELECT까지 추가한 뒤 COMMIT한다. rollback 시나리오는 같은 작업 뒤 의도적인 예외를 발생시킨다. 테스트는 FK 실패가 앞선 UPDATE까지 되돌리는지, 같은 연결에서 자신의 쓰기를 읽는지, 잔액 합계·원장 개수·실제 성공 횟수가 일치하는지 확인한다. `BEGIN IMMEDIATE`가 기본이고 DEFERRED/EXCLUSIVE도 지정할 수 있다.

동기 콜백만 지원하며 `async` 함수와 반환된 thenable은 거부한다. 중첩 트랜잭션은 미지원이다. 콜백에서 비동기 후속 작업을 예약하거나 별도의 BEGIN/COMMIT을 실행하는 사용은 지원하지 않는다. `exec()`은 신뢰하는 실험 SQL을 위한 통로이며 임의 사용자 SQL을 받는 API로 제공하면 안 된다.

모든 연결은 `foreign_keys=ON`, `synchronous=FULL`, `wal_autocheckpoint=1000`을 사용하며 픽스처는 WAL 모드다. 커밋 비용에는 실제 SQLite 커밋과 해당 시점에 발생한 체크포인트 비용이 포함된다. 정전·장치 캐시·파일시스템의 내구성을 검증하는 실험은 아니다.

## 락과 동시성

SQLite WAL은 여러 reader와 하나의 writer가 공존할 수 있지만 동시에 쓰는 writer는 하나다. PostgreSQL/MySQL의 행 잠금이나 `SELECT FOR UPDATE`를 흉내 내지 않는다. [SQLite WAL](https://www.sqlite.org/wal.html), [트랜잭션 문서](https://www.sqlite.org/lang_transaction.html).

1. **timeout:** 별도 worker가 `BEGIN IMMEDIATE` 후 counter 1번 행을 갱신하고 120ms 보유한다. 메인 스레드는 이전 커밋 값을 읽을 수 있지만, 다른 2번 행의 쓰기는 `busy_timeout=20ms` 이후 SQLITE_BUSY로 실패해야 한다.
2. **대기 후 성공:** 락을 60ms 보유하고 timeout을 500ms로 두면 락 해제 후 쓰기가 성공해야 한다. 두 시나리오 모두 이후 재실행과 최종 값을 확인한다.
3. **스냅샷:** DEFERRED 읽기 트랜잭션은 다른 연결의 커밋 전후로 같은 값을 보며, 오래된 스냅샷을 쓰기로 전환할 때 SQLITE_BUSY가 발생하는지 검사한다.
4. **동시 송금:** 세 worker가 각각 40회 이체한다. 트랜잭션 안에서 2ms 대기를 의도적으로 넣고 timeout 5ms를 적용한다. SQLITE_BUSY만 1–3ms backoff로 재시도하며 작업당 10초 제한을 넘으면 실험 전체가 실패한다. 실패 샘플을 버리고 성공 결과만 보고하지 않는다.

동시 송금의 p50/p95/p99는 각 작업의 최초 시도부터 최종 커밋까지의 실제 지연이다. 2ms 보유, SQLite 대기, 재시도와 backoff가 모두 포함된다. 세 클라이언트가 이전 작업 완료 후 다음 작업을 보내는 closed-loop 부하이므로, HTTP 요청이 계속 유입될 때의 큐 대기나 서비스 p99를 나타내지 않는다. 원시 데이터에는 각 worker의 지연과 시도 횟수를 모두 보존한다.

락 시나리오에서 메인 스레드가 쓰기를 호출하기 직전에 `setImmediate`를 예약한다. 동기 native 호출이 락을 기다리는 동안 이 콜백도 지연되는지 측정한다. 부하 생성용 worker를 사용했다는 사실이 ORM API가 비동기라는 뜻은 아니다.

## 해석의 범위

- 원시 driver 대조군은 타입 검증을 생략하고 null-prototype 객체를 반환한다. 이번 projection은 boolean을 포함하지 않으므로 scalar 값이 일치하며, 검증 단계에서만 prototype을 정규화한다. 중첩 객체 결과는 동일하다.
- native는 준비 단계에 바인딩한 값을 재사용하고 Node driver는 실행할 때 다시 바인딩한다. 이 차이를 포함한 구현 경로 전체를 비교한다.
- Node 내장 SQLite와 시스템 SQLite의 버전/컴파일 옵션이 다르다. C 언어만의 효과라고 결론 내릴 수 없다.
- 복잡한 SQL이 더 비싸다고 해서 ORM의 JS 매핑이 병목이라는 뜻은 아니다. 반대로 락 대기로 wall time이 늘어도 CPU 사용량이 같은 비율로 증가하지는 않는다. wall time과 CPU를 함께 기록한다.
- 범용 C 관계 조립기, TypeORM/class-transformer 비교, 서버 부하, 비동기 결과 전달, 메모리 최고 사용량은 후속 실험으로 남긴다.

결과: [첫 복합 워크로드 보고서](results/2026-10-01-complex.md), [원본 JSON](results/2026-10-01-complex.json).
