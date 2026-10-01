#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#define MAX_FIELDS 128
#define HEADER 20
#define SLOT 16
#define MAGIC UINT32_C(0x4c4d524f)

typedef struct {
  char *name;
  size_t name_length;
  uint32_t type;
  bool nullable;
} Field;

typedef struct {
  uint32_t index;
  bool is_null;
  double number;
  bool boolean;
  char *text;
  size_t length;
} Filter;

typedef struct {
  uint32_t count, signature, selected_count, filter_count, limit;
  Field fields[MAX_FIELDS];
  uint32_t selected[MAX_FIELDS];
  Filter filters[MAX_FIELDS];
} Query;

typedef struct {
  bool is_null, boolean;
  int32_t integer;
  double number;
  const char *text;
  size_t length;
} Cell;

static const napi_type_tag query_tag = { UINT64_C(0x92db2c090a17443e), UINT64_C(0xaf48b5f87871e9d0) };

static bool fail(napi_env env, const char *message) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, NULL, message);
  return false;
}

static bool checked(napi_env env, napi_status status) {
  return status == napi_ok || fail(env, "Node-API operation failed");
}

static bool get_u32(napi_env env, napi_value value, uint32_t *out) {
  double number;
  if (!checked(env, napi_get_value_double(env, value, &number))) return false;
  if (!isfinite(number) || number < 0 || number > UINT32_MAX || floor(number) != number)
    return fail(env, "Expected uint32");
  *out = (uint32_t)number;
  return true;
}

static bool string_copy(napi_env env, napi_value value, char **out, size_t *length) {
  if (!checked(env, napi_get_value_string_utf8(env, value, NULL, 0, length))) return false;
  if (*length == SIZE_MAX) return fail(env, "String is too large");
  *out = malloc(*length + 1);
  if (!*out) return fail(env, "Out of memory");
  return checked(env, napi_get_value_string_utf8(env, value, *out, *length + 1, length));
}

static bool array_length(napi_env env, napi_value value, uint32_t *length) {
  bool array;
  if (!checked(env, napi_is_array(env, value, &array))) return false;
  if (!array) return fail(env, "Expected an array");
  return checked(env, napi_get_array_length(env, value, length));
}

static void destroy_query(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  Query *query = data;
  if (!query) return;
  for (uint32_t i = 0; i < MAX_FIELDS; i++) {
    free(query->fields[i].name);
    free(query->filters[i].text);
  }
  free(query);
}

#define TRY(call) do { if (!checked(env, (call))) goto failure; } while (0)
#define REQUIRE(condition, message) do { if (!(condition)) { fail(env, (message)); goto failure; } } while (0)

static napi_value prepare(napi_env env, napi_callback_info info) {
  napi_value args[1], fields, selected, filters, item, value, result;
  size_t argc = 1;
  Query *query = calloc(1, sizeof(Query));
  if (!query) { fail(env, "Out of memory"); return NULL; }
  TRY(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  REQUIRE(argc == 1, "prepare needs a query specification");
  TRY(napi_get_named_property(env, args[0], "fields", &fields));
  if (!array_length(env, fields, &query->count)) goto failure;
  REQUIRE(query->count > 0 && query->count <= MAX_FIELDS, "Invalid field count");
  for (uint32_t i = 0; i < query->count; i++) {
    Field *field = &query->fields[i];
    TRY(napi_get_element(env, fields, i, &item));
    TRY(napi_get_named_property(env, item, "name", &value));
    if (!string_copy(env, value, &field->name, &field->name_length)) goto failure;
    REQUIRE(field->name_length > 0, "Empty field name");
    TRY(napi_get_named_property(env, item, "type", &value));
    if (!get_u32(env, value, &field->type)) goto failure;
    REQUIRE(field->type >= 1 && field->type <= 4, "Unknown field type");
    TRY(napi_get_named_property(env, item, "nullable", &value));
    TRY(napi_get_value_bool(env, value, &field->nullable));
  }
  TRY(napi_get_named_property(env, args[0], "signature", &value));
  if (!get_u32(env, value, &query->signature)) goto failure;
  TRY(napi_get_named_property(env, args[0], "limit", &value));
  if (!get_u32(env, value, &query->limit)) goto failure;
  TRY(napi_get_named_property(env, args[0], "select", &selected));
  if (!array_length(env, selected, &query->selected_count)) goto failure;
  REQUIRE(query->selected_count > 0 && query->selected_count <= query->count, "Invalid selection count");
  for (uint32_t i = 0; i < query->selected_count; i++) {
    TRY(napi_get_element(env, selected, i, &value));
    if (!get_u32(env, value, &query->selected[i])) goto failure;
    REQUIRE(query->selected[i] < query->count, "Invalid selection index");
    for (uint32_t j = 0; j < i; j++) REQUIRE(query->selected[j] != query->selected[i], "Duplicate selection");
  }
  TRY(napi_get_named_property(env, args[0], "filters", &filters));
  if (!array_length(env, filters, &query->filter_count)) goto failure;
  REQUIRE(query->filter_count <= MAX_FIELDS, "Too many filters");
  for (uint32_t i = 0; i < query->filter_count; i++) {
    Filter *filter = &query->filters[i];
    napi_valuetype value_type;
    TRY(napi_get_element(env, filters, i, &item));
    TRY(napi_get_named_property(env, item, "index", &value));
    if (!get_u32(env, value, &filter->index)) goto failure;
    REQUIRE(filter->index < query->count, "Invalid filter index");
    TRY(napi_get_named_property(env, item, "value", &value));
    TRY(napi_typeof(env, value, &value_type));
    filter->is_null = value_type == napi_null;
    const Field *field = &query->fields[filter->index];
    if (filter->is_null) {
      REQUIRE(field->nullable, "Null filter for required field");
    } else if (field->type == 1 || field->type == 2) {
      TRY(napi_get_value_double(env, value, &filter->number));
      REQUIRE(isfinite(filter->number), "Non-finite filter");
      if (field->type == 1) REQUIRE(filter->number >= INT32_MIN && filter->number <= INT32_MAX && floor(filter->number) == filter->number, "Invalid integer filter");
    } else if (field->type == 3) {
      TRY(napi_get_value_bool(env, value, &filter->boolean));
    } else if (!string_copy(env, value, &filter->text, &filter->length)) goto failure;
  }
  TRY(napi_create_object(env, &result));
  TRY(napi_type_tag_object(env, result, &query_tag));
  TRY(napi_wrap(env, result, query, destroy_query, NULL, NULL));
  return result;
failure:
  destroy_query(env, query, NULL);
  return NULL;
}

#undef TRY
#undef REQUIRE

static uint32_t read_u32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static bool valid_utf8(const uint8_t *p, size_t length) {
  for (size_t i = 0; i < length;) {
    uint8_t a = p[i++];
    if (a < 0x80) continue;
    size_t n;
    uint32_t code;
    if (a >= 0xc2 && a <= 0xdf) { n = 1; code = a & 0x1f; }
    else if (a >= 0xe0 && a <= 0xef) { n = 2; code = a & 0x0f; }
    else if (a >= 0xf0 && a <= 0xf4) { n = 3; code = a & 0x07; }
    else return false;
    if (n > length - i) return false;
    for (size_t j = 0; j < n; j++) {
      uint8_t b = p[i++];
      if ((b & 0xc0) != 0x80) return false;
      code = (code << 6) | (b & 0x3f);
    }
    if ((n == 1 && code < 0x80) || (n == 2 && code < 0x800) ||
        (n == 3 && code < 0x10000) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}

static bool read_cell(napi_env env, const uint8_t *buffer, size_t length, size_t text_start,
                      size_t at, const Field *field, Cell *cell) {
  memset(cell, 0, sizeof(*cell));
  uint8_t marker = buffer[at];
  if (marker == 0) {
    if (!field->nullable) return fail(env, "Null in a required field");
    cell->is_null = true;
    return true;
  }
  if (marker != 1) return fail(env, "Invalid presence marker");
  const uint8_t *p = buffer + at + 4;
  if (field->type == 1) {
    uint32_t bits = read_u32(p);
    memcpy(&cell->integer, &bits, sizeof(bits));
    cell->number = cell->integer;
  } else if (field->type == 2) {
    uint64_t bits = (uint64_t)read_u32(p) | (uint64_t)read_u32(p + 4) << 32;
    _Static_assert(sizeof(double) == sizeof(uint64_t), "64-bit double required");
    memcpy(&cell->number, &bits, sizeof(bits));
    if (!isfinite(cell->number)) return fail(env, "Non-finite float");
  } else if (field->type == 3) {
    if (*p > 1) return fail(env, "Invalid boolean");
    cell->boolean = *p == 1;
  } else {
    size_t start = read_u32(p);
    size_t size = read_u32(p + 4);
    if (start < text_start || start > length || size > length - start) return fail(env, "Invalid string bounds");
    if (!valid_utf8(buffer + start, size)) return fail(env, "Invalid UTF-8");
    cell->text = (const char *)buffer + start;
    cell->length = size;
  }
  return true;
}

static bool cell_matches(const Field *field, const Cell *cell, const Filter *filter) {
  if (cell->is_null || filter->is_null) return cell->is_null == filter->is_null;
  if (field->type == 1 || field->type == 2) return cell->number == filter->number;
  if (field->type == 3) return cell->boolean == filter->boolean;
  return cell->length == filter->length && memcmp(cell->text, filter->text, cell->length) == 0;
}

static bool to_js(napi_env env, const Field *field, const Cell *cell, napi_value *out) {
  if (cell->is_null) return checked(env, napi_get_null(env, out));
  if (field->type == 1) return checked(env, napi_create_int32(env, cell->integer, out));
  if (field->type == 2) return checked(env, napi_create_double(env, cell->number, out));
  if (field->type == 3) return checked(env, napi_get_boolean(env, cell->boolean, out));
  return checked(env, napi_create_string_utf8(env, cell->text, cell->length, out));
}

#define CALL(call) do { if (!checked(env, (call))) return NULL; } while (0)

static napi_value execute(napi_env env, napi_callback_info info) {
  napi_value args[2], result, keys[MAX_FIELDS];
  size_t argc = 2, length;
  bool tagged = false, is_buffer = false;
  Query *query = NULL;
  uint8_t *buffer;
  CALL(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) { fail(env, "execute needs a prepared query and Buffer"); return NULL; }
  CALL(napi_check_object_type_tag(env, args[0], &query_tag, &tagged));
  if (!tagged) { fail(env, "Invalid prepared query"); return NULL; }
  CALL(napi_unwrap(env, args[0], (void **)&query));
  CALL(napi_is_buffer(env, args[1], &is_buffer));
  if (!is_buffer) { fail(env, "Expected a Buffer"); return NULL; }
  CALL(napi_get_buffer_info(env, args[1], (void **)&buffer, &length));
  if (length < HEADER || read_u32(buffer) != MAGIC || read_u32(buffer + 4) != 1 ||
      read_u32(buffer + 12) != query->count || read_u32(buffer + 16) != query->signature) {
    fail(env, "Invalid or incompatible fixture header"); return NULL;
  }
  uint32_t count = read_u32(buffer + 8);
  size_t stride = (size_t)query->count * SLOT;
  if ((size_t)count > (length - HEADER) / stride) { fail(env, "Truncated fixture records"); return NULL; }
  size_t text_start = HEADER + (size_t)count * stride;
  CALL(napi_create_array(env, &result));
  for (uint32_t i = 0; i < query->selected_count; i++) {
    const Field *field = &query->fields[query->selected[i]];
    CALL(napi_create_string_utf8(env, field->name, field->name_length, &keys[i]));
  }
  uint32_t output_count = 0;
  for (uint32_t row = 0; row < count && output_count < query->limit; row++) {
    size_t base = HEADER + (size_t)row * stride;
    bool matches = true;
    Cell cell;
    for (uint32_t f = 0; f < query->filter_count; f++) {
      const Filter *filter = &query->filters[f];
      const Field *field = &query->fields[filter->index];
      if (!read_cell(env, buffer, length, text_start, base + (size_t)filter->index * SLOT, field, &cell)) return NULL;
      if (!cell_matches(field, &cell, filter)) { matches = false; break; }
    }
    if (!matches) continue;
    // Bound temporary V8 handles to one row. The output array retains the actual objects.
    napi_handle_scope scope;
    napi_value object, value;
    CALL(napi_open_handle_scope(env, &scope));
    if (!checked(env, napi_create_object(env, &object))) {
      napi_close_handle_scope(env, scope); return NULL;
    }
    for (uint32_t s = 0; s < query->selected_count; s++) {
      uint32_t index = query->selected[s];
      const Field *field = &query->fields[index];
      if (!read_cell(env, buffer, length, text_start, base + (size_t)index * SLOT, field, &cell) ||
          !to_js(env, field, &cell, &value) || !checked(env, napi_set_property(env, object, keys[s], value))) {
        napi_close_handle_scope(env, scope); return NULL;
      }
    }
    bool stored = checked(env, napi_set_element(env, result, output_count++, object));
    bool closed = checked(env, napi_close_handle_scope(env, scope));
    if (!stored || !closed) return NULL;
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "prepare", NULL, prepare, NULL, NULL, NULL, napi_default, NULL },
    { "execute", NULL, execute, NULL, NULL, NULL, napi_default, NULL },
  };
  CALL(napi_define_properties(env, exports, 2, properties));
  extern napi_value initialize_sqlite(napi_env env, napi_value exports);
  return initialize_sqlite(env, exports);
}

NAPI_MODULE(mapper, initialize)
