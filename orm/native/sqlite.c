#define _POSIX_C_SOURCE 200809L
#include <node_api.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include "commerce.h"

typedef struct Select Select;
typedef struct { sqlite3 *db; Select *queries; bool writable; } Database;
typedef struct { char *name; size_t length; int type; bool nullable; } Column;
struct Select {
  sqlite3_stmt *stmt;
  Database *owner;
  napi_ref owner_ref;
  Column *columns;
  uint32_t count;
  bool is_run;
  Select *next;
};

static const napi_type_tag database_tag = { UINT64_C(0x674aef5af12d426c), UINT64_C(0xa47b9f14f19a0142) };
static const napi_type_tag select_tag = { UINT64_C(0x4c7c458a19444e45), UINT64_C(0xafa19561c9f01761) };

static bool error(napi_env env, const char *message) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, NULL, message);
  return false;
}
static bool ok(napi_env env, napi_status status) {
  return status == napi_ok || error(env, "SQLite Node-API operation failed");
}
static bool database_error(napi_env env, sqlite3 *db) {
  napi_value message, exception, code;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) return false;
  if (!ok(env, napi_create_string_utf8(env, sqlite3_errmsg(db), NAPI_AUTO_LENGTH, &message)) ||
      !ok(env, napi_create_error(env, NULL, message, &exception)) ||
      !ok(env, napi_create_int32(env, sqlite3_extended_errcode(db), &code)) ||
      !ok(env, napi_set_named_property(env, exception, "sqliteCode", code))) return false;
  napi_throw(env, exception);
  return false;
}
static bool copy_string(napi_env env, napi_value value, char **text, size_t *length) {
  if (!ok(env, napi_get_value_string_utf8(env, value, NULL, 0, length))) return false;
  if (*length >= INT_MAX) return error(env, "String too long");
  *text = malloc(*length + 1);
  if (!*text) return error(env, "Out of memory");
  return ok(env, napi_get_value_string_utf8(env, value, *text, *length + 1, length));
}
static bool unwrap(napi_env env, napi_value value, const napi_type_tag *tag, void **data) {
  bool tagged = false;
  if (!ok(env, napi_check_object_type_tag(env, value, tag, &tagged))) return false;
  if (!tagged) return error(env, "Invalid SQLite handle");
  return ok(env, napi_unwrap(env, value, data));
}
static void close_database(Database *database) {
  if (!database->db) return;
  for (Select *query = database->queries; query; query = query->next) {
    if (query->stmt) sqlite3_finalize(query->stmt);
    query->stmt = NULL;
  }
  sqlite3_close_v2(database->db);
  database->db = NULL;
}
static void free_database(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  Database *database = data;
  close_database(database);
  free(database);
}
static void free_select(napi_env env, void *data, void *hint) {
  (void)hint;
  Select *query = data;
  if (query->owner) {
    Select **cursor = &query->owner->queries;
    while (*cursor && *cursor != query) cursor = &(*cursor)->next;
    if (*cursor) *cursor = query->next;
  }
  if (query->stmt) sqlite3_finalize(query->stmt);
  for (uint32_t i = 0; i < query->count; i++) free(query->columns[i].name);
  free(query->columns);
  if (query->owner_ref) napi_delete_reference(env, query->owner_ref);
  free(query);
}

#define CALL(operation) do { if (!ok(env, (operation))) return NULL; } while (0)

static napi_value open_database(napi_env env, napi_callback_info info) {
  napi_value args[2], result, value;
  size_t argc = 2, length;
  char *path = NULL;
  bool writable = false;
  double timeout = 1000;
  CALL(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc < 1) { error(env, "SQLite needs a database path"); return NULL; }
  if (argc == 2) {
    CALL(napi_get_named_property(env, args[1], "writable", &value));
    CALL(napi_get_value_bool(env, value, &writable));
    CALL(napi_get_named_property(env, args[1], "busyTimeoutMs", &value));
    CALL(napi_get_value_double(env, value, &timeout));
    if (!isfinite(timeout) || timeout < 0 || timeout > 60000 || floor(timeout) != timeout) {
      error(env, "Invalid busy timeout"); return NULL;
    }
  }
  if (!copy_string(env, args[0], &path, &length)) { free(path); return NULL; }
  if (memchr(path, 0, length)) { free(path); error(env, "NUL in database path"); return NULL; }
  Database *database = calloc(1, sizeof(Database));
  if (!database) { free(path); error(env, "Out of memory"); return NULL; }
  // WAL readers may need to recreate -wal/-shm after the last connection closes.
  // Existing ORM calls stay read-only; experiment sessions explicitly opt into writes.
  int status = sqlite3_open_v2(path, &database->db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, NULL);
  free(path);
  if (status != SQLITE_OK) {
    char message[512];
    snprintf(message, sizeof(message), "Cannot open SQLite database: %s (code %d, system %d)",
      database->db ? sqlite3_errmsg(database->db) : "allocation failed",
      database->db ? sqlite3_extended_errcode(database->db) : status,
      database->db ? sqlite3_system_errno(database->db) : 0);
    error(env, message);
    free_database(env, database, NULL); return NULL;
  }
  database->writable = writable;
  sqlite3_busy_timeout(database->db, (int)timeout);
  if (!writable && sqlite3_exec(database->db, "PRAGMA query_only=ON", NULL, NULL, NULL) != SQLITE_OK) {
    error(env, sqlite3_errmsg(database->db));
    free_database(env, database, NULL); return NULL;
  }
  if (!ok(env, napi_create_object(env, &result)) ||
      !ok(env, napi_type_tag_object(env, result, &database_tag)) ||
      !ok(env, napi_wrap(env, result, database, free_database, NULL, NULL))) {
    free_database(env, database, NULL); return NULL;
  }
  return result;
}

static napi_value close_handle(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t argc = 1;
  Database *database;
  CALL(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 1) { error(env, "SQLite needs a database handle"); return NULL; }
  if (!unwrap(env, args[0], &database_tag, (void **)&database)) return NULL;
  close_database(database);
  CALL(napi_get_undefined(env, &result));
  return result;
}

#define TRY(operation) do { if (!ok(env, (operation))) goto failure; } while (0)
#define REQUIRE(condition, message) do { if (!(condition)) { error(env, (message)); goto failure; } } while (0)

static napi_value prepare_statement(napi_env env, napi_callback_info info, bool is_run) {
  napi_value args[4], result, item, value;
  size_t argc = 4, sql_length;
  char *sql = NULL;
  bool array;
  uint32_t parameter_count;
  Database *database;
  Select *query = calloc(1, sizeof(Select));
  if (!query) { error(env, "Out of memory"); return NULL; }
  TRY(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  REQUIRE(argc == (is_run ? 3u : 4u), "Invalid SQLite prepare arguments");
  if (!unwrap(env, args[0], &database_tag, (void **)&database)) goto failure;
  REQUIRE(database->db, "Database is closed");
  REQUIRE(!is_run || database->writable, "Read-only connection");
  query->is_run = is_run;
  if (!copy_string(env, args[1], &sql, &sql_length)) goto failure;
  REQUIRE(!memchr(sql, 0, sql_length), "NUL in SQL");
  const char *tail;
  int status = sqlite3_prepare_v2(database->db, sql, (int)sql_length + 1, &query->stmt, &tail);
  if (status != SQLITE_OK) { database_error(env, database->db); goto failure; }
  REQUIRE(query->stmt, "Empty statement");
  REQUIRE(is_run || sqlite3_stmt_readonly(query->stmt), "Only read-only statements are supported");
  REQUIRE(!is_run || sqlite3_column_count(query->stmt) == 0, "run() cannot return columns");
  while (*tail && isspace((unsigned char)*tail)) tail++;
  REQUIRE(!*tail, "Multiple statements are not supported");
  TRY(napi_is_array(env, args[2], &array));
  REQUIRE(array, "Parameters must be an array");
  TRY(napi_get_array_length(env, args[2], &parameter_count));
  REQUIRE(parameter_count == (uint32_t)sqlite3_bind_parameter_count(query->stmt), "Parameter count mismatch");
  for (uint32_t i = 0; i < parameter_count; i++) {
    napi_valuetype type;
    TRY(napi_get_element(env, args[2], i, &value));
    TRY(napi_typeof(env, value, &type));
    if (type == napi_null) status = sqlite3_bind_null(query->stmt, (int)i + 1);
    else if (type == napi_number) {
      double number;
      TRY(napi_get_value_double(env, value, &number));
      REQUIRE(isfinite(number), "Non-finite parameter");
      status = sqlite3_bind_double(query->stmt, (int)i + 1, number);
    } else if (type == napi_string) {
      char *text = NULL;
      size_t length;
      if (!copy_string(env, value, &text, &length)) { free(text); goto failure; }
      status = sqlite3_bind_text(query->stmt, (int)i + 1, text, (int)length, SQLITE_TRANSIENT);
      free(text);
    } else { error(env, "Unsupported SQLite parameter"); goto failure; }
    REQUIRE(status == SQLITE_OK, sqlite3_errmsg(database->db));
  }
  if (!is_run) {
    TRY(napi_is_array(env, args[3], &array));
    REQUIRE(array, "Columns must be an array");
    TRY(napi_get_array_length(env, args[3], &query->count));
    REQUIRE(query->count > 0 && query->count <= 128 && query->count == (uint32_t)sqlite3_column_count(query->stmt), "Invalid column count");
    query->columns = calloc(query->count, sizeof(Column));
    REQUIRE(query->columns, "Out of memory");
    for (uint32_t i = 0; i < query->count; i++) {
      Column *column = &query->columns[i];
      TRY(napi_get_element(env, args[3], i, &item));
      TRY(napi_get_named_property(env, item, "name", &value));
      if (!copy_string(env, value, &column->name, &column->length)) goto failure;
      TRY(napi_get_named_property(env, item, "type", &value));
      double type;
      TRY(napi_get_value_double(env, value, &type));
      REQUIRE(type >= 1 && type <= 4 && floor(type) == type, "Invalid column type");
      column->type = (int)type;
      TRY(napi_get_named_property(env, item, "nullable", &value));
      TRY(napi_get_value_bool(env, value, &column->nullable));
    }
  }
  TRY(napi_create_reference(env, args[0], 1, &query->owner_ref));
  TRY(napi_create_object(env, &result));
  TRY(napi_type_tag_object(env, result, &select_tag));
  TRY(napi_wrap(env, result, query, free_select, NULL, NULL));
  query->owner = database;
  query->next = database->queries;
  database->queries = query;
  free(sql);
  return result;
failure:
  free(sql);
  if (!query->columns) query->count = 0;
  free_select(env, query, NULL);
  return NULL;
}

static napi_value prepare_select(napi_env env, napi_callback_info info) {
  return prepare_statement(env, info, false);
}
static napi_value prepare_run(napi_env env, napi_callback_info info) {
  return prepare_statement(env, info, true);
}

static napi_value exec_sql(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2, length;
  Database *database;
  char *sql = NULL;
  CALL(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) { error(env, "exec needs database and SQL"); return NULL; }
  if (!unwrap(env, args[0], &database_tag, (void **)&database)) return NULL;
  if (!database->db || !database->writable) { error(env, "Database is closed or read-only"); return NULL; }
  if (!copy_string(env, args[1], &sql, &length)) { free(sql); return NULL; }
  if (memchr(sql, 0, length)) { free(sql); error(env, "NUL in SQL"); return NULL; }
  int status = sqlite3_exec(database->db, sql, NULL, NULL, NULL);
  free(sql);
  if (status != SQLITE_OK) { database_error(env, database->db); return NULL; }
  CALL(napi_get_undefined(env, &result));
  return result;
}

static napi_value run_statement(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t argc = 1;
  Select *query;
  CALL(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 1) { error(env, "run needs a prepared statement"); return NULL; }
  if (!unwrap(env, args[0], &select_tag, (void **)&query)) return NULL;
  if (!query->stmt || !query->owner->db) { error(env, "Database is closed"); return NULL; }
  if (!query->is_run) { error(env, "Expected a run statement"); return NULL; }
  int status = sqlite3_step(query->stmt);
  if (status != SQLITE_DONE) {
    database_error(env, query->owner->db);
    sqlite3_reset(query->stmt);
    return NULL;
  }
  int changes = sqlite3_changes(query->owner->db);
  sqlite3_reset(query->stmt);
  CALL(napi_create_int32(env, changes, &result));
  return result;
}

#undef TRY
#undef REQUIRE

static bool column_value(napi_env env, Select *query, uint32_t index, napi_value *value) {
  const Column *column = &query->columns[index];
  int stored = sqlite3_column_type(query->stmt, (int)index);
  if (stored == SQLITE_NULL) {
    if (!column->nullable) return error(env, "Null in required SQLite column");
    return ok(env, napi_get_null(env, value));
  }
  if (column->type == 1 || column->type == 3) {
    if (stored != SQLITE_INTEGER) return error(env, "Invalid SQLite integer storage");
    sqlite3_int64 integer = sqlite3_column_int64(query->stmt, (int)index);
    if (column->type == 3) {
      if (integer != 0 && integer != 1) return error(env, "Invalid SQLite boolean");
      return ok(env, napi_get_boolean(env, integer == 1, value));
    }
    if (integer < INT32_MIN || integer > INT32_MAX) return error(env, "SQLite int32 overflow");
    return ok(env, napi_create_int32(env, (int32_t)integer, value));
  }
  if (column->type == 2) {
    if (stored != SQLITE_FLOAT && stored != SQLITE_INTEGER) return error(env, "Invalid SQLite numeric storage");
    double number = sqlite3_column_double(query->stmt, (int)index);
    if (!isfinite(number)) return error(env, "Non-finite SQLite number");
    return ok(env, napi_create_double(env, number, value));
  }
  if (stored != SQLITE_TEXT) return error(env, "Invalid SQLite text storage");
  const unsigned char *text = sqlite3_column_text(query->stmt, (int)index);
  int length = sqlite3_column_bytes(query->stmt, (int)index);
  if (!text) return error(env, "Cannot read SQLite text");
  return ok(env, napi_create_string_utf8(env, (const char *)text, (size_t)length, value));
}

static napi_value select_all_impl(napi_env env, napi_callback_info info, bool profile) {
  napi_value args[1], result, keys[128];
  size_t argc = 1;
  Select *query;
  CALL(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 1) { error(env, "SQLite all needs a prepared query"); return NULL; }
  if (!unwrap(env, args[0], &select_tag, (void **)&query)) return NULL;
  if (!query->stmt || !query->owner->db) { error(env, "Database is closed"); return NULL; }
  if (query->is_run) { error(env, "Expected a select statement"); return NULL; }
  double started = profile ? nodec_now_ms() : 0, step_ms = 0, materialize_ms = 0;
  CALL(napi_create_array(env, &result));
  for (uint32_t i = 0; i < query->count; i++)
    CALL(napi_create_string_utf8(env, query->columns[i].name, query->columns[i].length, &keys[i]));
  uint32_t row = 0;
  int status;
  for (;;) {
    double t = profile ? nodec_now_ms() : 0;
    status = sqlite3_step(query->stmt);
    if (profile) step_ms += nodec_now_ms() - t;
    if (status != SQLITE_ROW) break;
    t = profile ? nodec_now_ms() : 0;
    napi_handle_scope scope;
    napi_value object, value;
    if (!ok(env, napi_open_handle_scope(env, &scope))) goto failure;
    if (!ok(env, napi_create_object(env, &object))) { napi_close_handle_scope(env, scope); goto failure; }
    for (uint32_t i = 0; i < query->count; i++) {
      if (!column_value(env, query, i, &value) || !ok(env, napi_set_property(env, object, keys[i], value))) {
        napi_close_handle_scope(env, scope); goto failure;
      }
    }
    bool saved = ok(env, napi_set_element(env, result, row++, object));
    bool closed = ok(env, napi_close_handle_scope(env, scope));
    if (!saved || !closed) goto failure;
    if (profile) materialize_ms += nodec_now_ms() - t;
  }
  if (status != SQLITE_DONE) { database_error(env, query->owner->db); goto failure; }
  sqlite3_reset(query->stmt);
  if (profile) {
    double total_ms = nodec_now_ms() - started;
    napi_value envelope, timing, value;
    CALL(napi_create_object(env, &envelope));
    CALL(napi_create_object(env, &timing));
    CALL(napi_set_named_property(env, envelope, "rows", result));
    CALL(napi_set_named_property(env, envelope, "timings", timing));
    const char *names[] = { "sqliteStepMs", "flatDecodeAndMaterializeMs", "totalMs" };
    double values[] = { step_ms, materialize_ms, total_ms };
    for (int i = 0; i < 3; i++) {
      CALL(napi_create_double(env, values[i], &value));
      CALL(napi_set_named_property(env, timing, names[i], value));
    }
    return envelope;
  }
  return result;
failure:
  sqlite3_reset(query->stmt);
  return NULL;
}

static napi_value select_all(napi_env env, napi_callback_info info) { return select_all_impl(env, info, false); }
static napi_value profile_all(napi_env env, napi_callback_info info) { return select_all_impl(env, info, true); }

static napi_value commerce_all(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t argc = 2;
  Select *query; bool profile;
  CALL(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) { error(env, "commerce needs query and profiling flag"); return NULL; }
  CALL(napi_get_value_bool(env, args[1], &profile));
  if (!unwrap(env, args[0], &select_tag, (void **)&query)) return NULL;
  if (!query->stmt || !query->owner->db) { error(env, "Database is closed"); return NULL; }
  const char *names[] = { "customerId", "customerName", "orderId", "status", "itemId", "productId",
    "productName", "quantity", "unitCents", "paymentId", "paidCents" };
  if (query->is_run || query->count != 11) { error(env, "Expected commerce projection"); return NULL; }
  for (uint32_t i = 0; i < 11; i++) {
    int type = (i == 1 || i == 3 || i == 6) ? 4 : 1;
    if (query->columns[i].length != strlen(names[i]) || memcmp(query->columns[i].name, names[i], strlen(names[i])) ||
        query->columns[i].type != type || query->columns[i].nullable != (i >= 2) ||
        strcmp(sqlite3_column_name(query->stmt, (int)i), names[i])) {
      error(env, "Expected commerce projection names, types, order, and nullability"); return NULL;
    }
  }
  return nodec_commerce_all(env, query->stmt, profile);
}

/* Diagnostic lower-work control: execute identical SQL but do not read/create field values. */
static napi_value scan_rows(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t argc = 1; Select *query;
  CALL(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 1) { error(env, "scan needs a query"); return NULL; }
  if (!unwrap(env, args[0], &select_tag, (void **)&query)) return NULL;
  if (!query->stmt || !query->owner->db) { error(env, "Database is closed"); return NULL; }
  if (query->is_run) { error(env, "Expected a select statement"); return NULL; }
  double count = 0; int status;
  while ((status = sqlite3_step(query->stmt)) == SQLITE_ROW) count++;
  if (status != SQLITE_DONE) { database_error(env, query->owner->db); sqlite3_reset(query->stmt); return NULL; }
  sqlite3_reset(query->stmt);
  CALL(napi_create_double(env, count, &result));
  return result;
}

napi_value initialize_sqlite(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "sqliteOpen", NULL, open_database, NULL, NULL, NULL, napi_default, NULL },
    { "sqliteClose", NULL, close_handle, NULL, NULL, NULL, napi_default, NULL },
    { "sqlitePrepare", NULL, prepare_select, NULL, NULL, NULL, napi_default, NULL },
    { "sqliteAll", NULL, select_all, NULL, NULL, NULL, napi_default, NULL },
    { "sqliteExec", NULL, exec_sql, NULL, NULL, NULL, napi_default, NULL },
    { "sqlitePrepareRun", NULL, prepare_run, NULL, NULL, NULL, napi_default, NULL },
    { "sqliteRun", NULL, run_statement, NULL, NULL, NULL, napi_default, NULL },
    { "sqliteProfileAll", NULL, profile_all, NULL, NULL, NULL, napi_default, NULL },
    { "sqliteCommerceAll", NULL, commerce_all, NULL, NULL, NULL, napi_default, NULL },
    { "sqliteScan", NULL, scan_rows, NULL, NULL, NULL, napi_default, NULL },
  };
  CALL(napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
  napi_value version;
  CALL(napi_create_string_utf8(env, sqlite3_libversion(), NAPI_AUTO_LENGTH, &version));
  CALL(napi_set_named_property(env, exports, "sqliteVersion", version));
  return exports;
}
