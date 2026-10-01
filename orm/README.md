# ORM experiments

비즈니스 로직은 JS로 작성하고 npm 라이브러리를 사용하면서, ORM의 공통 처리 비용을 줄일 수 있는지 검증합니다. 데이터베이스는 **SQLite**입니다.

현재 구현은 작은 **실험용 ORM**입니다. 모델 정의 → SQLite 테이블 생성 → 일괄 삽입 → 조건 검색 → 컬럼 선택 → JS 결과 반환까지 실행됩니다. 같은 API에서 `generic`, `compiled`, `native` 실행기를 비교할 수 있습니다. 복잡한 쿼리 실험에는 SQL과 반환 모델을 명시하는 별도 세션을 사용합니다. 범용 관계 쿼리 빌더나 완성된 TypeORM 호환 구현은 아직 없습니다.

## 실행

필요 환경: Node.js 22.13 이상, C11 컴파일러, Node 헤더, SQLite 개발 헤더/라이브러리. macOS와 Linux를 지원하며 최초 결과는 macOS arm64 / Node 24에서 측정했습니다. `node:sqlite` 지원 상태와 경고는 Node 버전에 따라 다릅니다. 외부 npm 의존성은 없습니다.

```sh
cd orm
npm run check
npm run example
npm run bench
npm run bench:complex
npm run bench:graph
```

빌드는 Node 실행 파일 옆의 `include/node`를 찾습니다. 다른 위치의 헤더를 사용할 때:

```sh
NODE_INCLUDE_DIR=/path/to/include/node CC=clang npm run build
```

빌드 스크립트는 헤더나 라이브러리를 다운로드하지 않습니다. Linux에서는 시스템의 SQLite 개발 패키지가 필요합니다. Node 헤더는 실행 중인 Node 버전에 맞추세요.

## ORM 사용 예

```js
import { defineModel } from './src/orm.mjs';
import { openSqlite } from './src/sqlite.mjs';

const User = defineModel('User', {
  id: 'int32',
  name: 'string',
  active: 'boolean',
  score: 'float64',
  nickname: { type: 'string', nullable: true },
});

const db = openSqlite('./experiment.sqlite', [User]);
try {
  db.createSchema();
  db.tables.User.insertMany([
    { id: 1, name: '민지', active: true, score: 4.5, nickname: null },
  ]);

  const rows = db.tables.User.findMany({
    where: { active: true },
    select: ['id', 'name', 'nickname'],
    limit: 100,
  }, { engine: 'native' });
  console.log(rows);

  // 준비 비용을 분리해서 반복 실행할 때
  const query = db.tables.User.prepareFindMany({ where: { active: true } });
  query.all('generic');
  query.all('compiled');
  query.all('native');
} finally {
  db.close();
}
```

`insertMany()`는 SQLite 트랜잭션으로 처리하며 중간 입력 검증/SQL 실패 시 전체를 롤백합니다. `createSchema()`는 없는 테이블을 생성하는 기능이며 기존 테이블의 변경을 처리하는 마이그레이션 기능은 아닙니다. `id`는 일반 컬럼이며 자동으로 PK, unique, 인덱스가 되지 않습니다.

## 비교하는 실행 경로

| 실행기 | SQLite 실험 경로 |
| --- | --- |
| `generic` | Node 내장 SQLite → 원시 JS 행 → 필드 메타데이터를 순회하며 ORM 객체 생성 |
| `compiled` | Node 내장 SQLite → 원시 JS 행 → 준비 시 생성한 전용 JS 매퍼로 ORM 객체 생성 |
| `native` | C SQLite API → 준비한 컬럼 정보로 최종 JS 객체 직접 생성 |
| `raw()` 대조군 | Node 내장 SQLite의 결과를 추가 변환 없이 반환 |

`raw()`는 일반 ORM 반환값과 동일한 계약이 아닙니다. 예를 들어 boolean은 0/1이고 객체의 prototype은 null입니다. 벤치마크의 raw 대조군은 boolean 컬럼을 제외한 projection을 사용해 반환 필드값을 맞춥니다. ORM의 세 실행기는 boolean 변환과 null/type 검사를 적용하고 일반 JS 객체를 반환합니다.

생성 코드는 모델 정의에 맞춰 JS 객체를 직접 만듭니다. 필드 이름은 문자열로 이스케이프하며 필터 값은 생성 코드에 삽입하지 않습니다. SQLite 식별자는 따옴표 처리하고 조건 값은 바인딩합니다. 기존 `openSqlite()`의 네이티브 연결은 읽기 전용이며, 새 `openSession()`은 트랜잭션 실험을 위해 쓰기를 명시적으로 활성화합니다.

## 실험

- [가설과 판정 기준](EXPERIMENTS.md)
- [초기 측정 결과](results/2026-10-01-initial.md)
- [초기 원시 측정값](results/2026-10-01-initial.json)
- [복잡한 쿼리·락·트랜잭션 실험 설계](COMPLEX.md)
- [복합 워크로드 결과](results/2026-10-01-complex.md)
- [복합 워크로드 원시 측정값과 실행 계획](results/2026-10-01-complex.json)
- [C 관계 조립과 단계별 계측](GRAPH.md)
- [C 관계 조립 측정 결과](results/2026-10-01-graph.md)

**H001 / 매핑 비용 분리:** 같은 바이너리 픽스처에서 조건 검사, 컬럼 디코딩, 최종 JS 객체 생성을 비교합니다. 픽스처 생성은 측정 밖입니다. 실제 DB 조회 시간으로 해석하지 않습니다.

**H002 / SQLite 전체 읽기 경로:** 실제 파일 DB에 동일 데이터를 넣고 같은 SQL·바인딩·출력 필드로 비교합니다. DB 생성, 삽입, 쿼리 준비, 캐시/JIT 워밍업은 측정 밖입니다. SQLite 라이브러리 버전 차이도 결과에 기록합니다.

**H003–H005 / 복합 워크로드:** 5개 테이블의 4중 LEFT JOIN과 관계 객체 조립, 부모 기준 페이지네이션, CTE/집계/정렬, 송금 트랜잭션 커밋·롤백, 여러 연결의 쓰기 락 경합을 측정합니다. JOIN 중복 제거와 관계 조립은 모든 경로에서 동일한 JS 함수를 사용합니다. 락 실험은 별도 worker 연결이 락을 보유하며, 메인 스레드의 동기 호출과 `setImmediate` 지연도 기록합니다.

**H006 / C 관계 조립:** 같은 SQLite 빌드에서 C 평면 행 → JS 관계 조립과 C 내부 관계 조립 → 최종 JS 객체를 비교합니다. 일반 조인, 높은 자식 수로 중복 행이 늘어나는 조인, 50명 페이지 조회를 측정합니다. SQL 실행·디코딩·관계 조립·최종 JS 생성의 계측은 별도 호출에서 수행하고, 속도 비교는 계측을 끈 호출로 합니다.

각 variant를 별도 Node 프로세스로 실행합니다. 측정 전후에 독립적인 원본 행 기준 결과와 비교하고, 매 batch에서 결과를 외부에 보존해 실제 객체 생성을 포함합니다. wall time과 프로세스 CPU time의 원시 샘플을 JSON으로 남깁니다. 강제 GC는 워밍업 뒤 한 번만 수행하며 측정 중 발생한 GC 비용은 측정에 포함됩니다. 종료 시점의 GC까지 모두 포함한 총 할당 비용 측정은 아닙니다.

```sh
npm run bench -- --rows 10000 --samples 9 --target-ms 25 --warmup-ms 100

# 결과를 커밋할 때는 명시적인 이름 사용
npm run bench -- --out results/my-experiment

npm run bench:complex -- --customers 1000 --samples 9 --lock-samples 3 --out results/my-complex-experiment
npm run bench:graph -- --customers 1000 --repeats 3 --out results/my-graph-experiment
```

기본 결과 경로 `results/local/`과 빌드 산출물은 Git에서 제외합니다. 벤치마크 SQLite 파일은 OS 임시 디렉터리에 만들고 정상 종료 시 제거합니다. 실험 소스 해시는 결과 JSON의 `sourceFiles` 목록을 기준으로 합니다.

## 현재 제약

- API는 **모두 동기식**입니다. C 호출도 메인 스레드에서 실행되므로 이벤트 루프를 막을 수 있습니다. 비동기 실행이나 멀티코어 개선을 검증한 결과가 아닙니다.
- SQLite는 파일 경로만 지원합니다. Node와 C가 같은 파일을 각각 열기 때문에 `:memory:`와 URI 경로는 지원하지 않습니다. WAL sidecar를 만들 수 있도록 파일/디렉터리에 쓰기 권한이 필요합니다.
- 지원 타입: int32, 유한한 float64, boolean, 올바른 Unicode string, nullable. Decimal, bigint, Date, BLOB, 사용자 정의 transformer는 아직 없습니다.
- 기존 모델 조회 API는 동등 비교 조건들의 AND, 컬럼 선택, limit만 지원하며 fixture 테이블의 rowid 순서로 반환합니다. 복합 실험의 JOIN/집계/정렬/update는 `openSession()`에 명시적 SQL을 전달합니다. 범용 관계 API와 변경 추적은 아직 없습니다.
- `openSqlite()`는 Node/C 연결을 각각 사용합니다. 새 세션은 하나의 실행기·연결을 사용해 트랜잭션 안의 조회가 자신의 미커밋 쓰기를 볼 수 있게 합니다. 두 API를 같은 트랜잭션인 것처럼 섞어 쓰면 안 됩니다.
- 세션의 트랜잭션 콜백은 동기식이며 중첩 트랜잭션/savepoint는 미지원입니다. 일반 ORM의 자동 재시도 기능은 없고, 경합 부하 실험에서만 명시적으로 재시도합니다.
- `query.commerce()`는 커머스 픽스처의 특정 projection에 한해 C 관계 조립을 실행합니다. 범용 모델/관계 플래너가 아니며 세부 계약은 [GRAPH.md](GRAPH.md)에 있습니다.
- DB 스키마를 외부에서 변경하거나 모델 컬럼으로 rowid 별칭을 가리는 사용은 지원하지 않습니다.
- 매핑용 바이너리 포맷은 내부 실험용입니다. 안정적인 DB/네트워크 프로토콜이 아니며 Buffer를 실행 중 변경하면 안 됩니다. 헤더와 접근하는 셀만 검사하며 조회하지 않은 필드까지 전체 검증하지 않습니다.
- 기존 NestJS, TypeORM, `class-transformer`를 실행하는 벤치마크가 아닙니다. 여기서 관측한 차이를 해당 라이브러리 대비 배수로 주장하지 않습니다.

## 파일

```text
src/orm.mjs       모델, 내부 픽스처, 범용/생성 JS 매퍼
src/sqlite.mjs    SQLite ORM API, SQL 생성, JS 매핑 경로
src/session.mjs   단일 연결의 SQL/반환 모델, 쓰기, 동기 트랜잭션
src/layout.mjs    실험용 바이너리 데이터 표현과 검증
native/mapper.c  동일 픽스처의 C 매핑, Node-API 객체 생성
native/sqlite.c  실제 SQLite C API, 준비된 조회/쓰기, 핸들 생명주기
native/commerce.c  C 해시 맵 기반 관계 조립, 최종 JS 객체 생성, 단계별 계측
test/            결과 동등성, 손상 입력, 바인딩, 롤백, 종료 검사
bench/           격리 프로세스 벤치마크와 결과 보고서 생성
```
