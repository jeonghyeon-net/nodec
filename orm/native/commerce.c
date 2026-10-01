#define _POSIX_C_SOURCE 200809L
#include "commerce.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

#define NONE UINT32_MAX
typedef struct { char *data; size_t length; bool null; } Text;
typedef struct { bool null; int32_t integer; const char *text; size_t length; } Cell;
typedef struct { int32_t key; uint32_t index_plus_one; } Slot;
typedef struct { Slot *slots; size_t capacity, used; } Index;
typedef struct { int32_t id; Text name; uint32_t first, last; } Customer;
typedef struct { int32_t id; Text status; uint32_t next, first_item, last_item, first_payment, last_payment; } Order;
typedef struct { int32_t id; Cell product_id, quantity, unit_cents; Text product_name; uint32_t next; } Item;
typedef struct { int32_t id; Cell paid_cents; uint32_t next; } Payment;
typedef struct {
  Customer *customers; uint32_t customer_count, customer_capacity;
  Order *orders; uint32_t order_count, order_capacity;
  Item *items; uint32_t item_count, item_capacity;
  Payment *payments; uint32_t payment_count, payment_capacity;
  Index customer_index, order_index, item_index, payment_index;
  uint32_t rows;
} Graph;

static bool fail(napi_env env, const char *message) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, NULL, message);
  return false;
}
static bool check(napi_env env, napi_status status) { return status == napi_ok || fail(env, "Graph Node-API operation failed"); }
static bool db_fail(napi_env env, sqlite3_stmt *stmt) {
  sqlite3 *db = sqlite3_db_handle(stmt);
  napi_value message, error, code;
  if (!check(env, napi_create_string_utf8(env, sqlite3_errmsg(db), NAPI_AUTO_LENGTH, &message)) ||
      !check(env, napi_create_error(env, NULL, message, &error)) ||
      !check(env, napi_create_int32(env, sqlite3_extended_errcode(db), &code)) ||
      !check(env, napi_set_named_property(env, error, "sqliteCode", code))) return false;
  napi_throw(env, error);
  return false;
}

static uint32_t hash_key(int32_t key) {
  uint32_t n = (uint32_t)key;
  n ^= n >> 16; n *= UINT32_C(0x7feb352d); n ^= n >> 15;
  n *= UINT32_C(0x846ca68b); return n ^ (n >> 16);
}
static bool index_grow(napi_env env, Index *index) {
  size_t capacity = index->capacity ? index->capacity * 2 : 64;
  if (capacity < index->capacity || capacity > SIZE_MAX / sizeof(Slot)) return fail(env, "Graph index too large");
  Slot *slots = calloc(capacity, sizeof(Slot));
  if (!slots) return fail(env, "Out of memory");
  for (size_t i = 0; i < index->capacity; i++) if (index->slots[i].index_plus_one) {
    size_t target = hash_key(index->slots[i].key) & (capacity - 1);
    while (slots[target].index_plus_one) target = (target + 1) & (capacity - 1);
    slots[target] = index->slots[i];
  }
  free(index->slots); index->slots = slots; index->capacity = capacity;
  return true;
}
static uint32_t lookup(const Index *index, int32_t key) {
  if (!index->capacity) return NONE;
  size_t slot = hash_key(key) & (index->capacity - 1);
  while (index->slots[slot].index_plus_one) {
    if (index->slots[slot].key == key) return index->slots[slot].index_plus_one - 1;
    slot = (slot + 1) & (index->capacity - 1);
  }
  return NONE;
}
static bool add_index(napi_env env, Index *index, int32_t key, uint32_t value) {
  if (!index->capacity || index->used >= index->capacity / 2) if (!index_grow(env, index)) return false;
  size_t slot = hash_key(key) & (index->capacity - 1);
  while (index->slots[slot].index_plus_one) slot = (slot + 1) & (index->capacity - 1);
  index->slots[slot] = (Slot){ key, value + 1 }; index->used++;
  return true;
}
static void *reserve(napi_env env, void *data, uint32_t count, uint32_t *capacity, size_t width) {
  if (count < *capacity) return data;
  if (*capacity > UINT32_MAX / 2) { fail(env, "Graph too large"); return NULL; }
  uint32_t next = *capacity ? *capacity * 2 : 64;
  if (next > SIZE_MAX / width) { fail(env, "Graph too large"); return NULL; }
  void *grown = realloc(data, (size_t)next * width);
  if (!grown) { fail(env, "Out of memory"); return NULL; }
  *capacity = next;
  return grown;
}
static bool copy_text(napi_env env, Text *out, const Cell *cell) {
  out->null = cell->null; out->length = cell->length;
  if (cell->null) return true;
  out->data = malloc(cell->length + 1);
  if (!out->data) return fail(env, "Out of memory");
  memcpy(out->data, cell->text, cell->length); out->data[cell->length] = 0;
  return true;
}
static void free_graph(Graph *g) {
  for (uint32_t i = 0; i < g->customer_count; i++) free(g->customers[i].name.data);
  for (uint32_t i = 0; i < g->order_count; i++) free(g->orders[i].status.data);
  for (uint32_t i = 0; i < g->item_count; i++) free(g->items[i].product_name.data);
  free(g->customers); free(g->orders); free(g->items); free(g->payments);
  free(g->customer_index.slots); free(g->order_index.slots); free(g->item_index.slots); free(g->payment_index.slots);
}

static bool decode(napi_env env, sqlite3_stmt *stmt, Cell row[11]) {
  for (int i = 0; i < 11; i++) {
    Cell *cell = &row[i]; *cell = (Cell){0};
    int stored = sqlite3_column_type(stmt, i);
    if (stored == SQLITE_NULL) {
      if (i < 2) return fail(env, "Null in required commerce column");
      cell->null = true; continue;
    }
    if (i == 1 || i == 3 || i == 6) {
      if (stored != SQLITE_TEXT) return fail(env, "Invalid commerce text storage");
      cell->text = (const char *)sqlite3_column_text(stmt, i);
      cell->length = (size_t)sqlite3_column_bytes(stmt, i);
      if (!cell->text) return fail(env, "Cannot read commerce text");
    } else {
      if (stored != SQLITE_INTEGER) return fail(env, "Invalid commerce integer storage");
      sqlite3_int64 n = sqlite3_column_int64(stmt, i);
      if (n < INT32_MIN || n > INT32_MAX) return fail(env, "Commerce int32 overflow");
      cell->integer = (int32_t)n;
    }
  }
  return true;
}

/* Global PK maps and first-seen order match hydrateCommerce, including unsorted input.
 * Strings are copied only when the entity is first seen; duplicate rows still decode/validate. */
static bool group(napi_env env, Graph *g, const Cell r[11]) {
  uint32_t c = lookup(&g->customer_index, r[0].integer);
  if (c == NONE) {
    Customer *grown = reserve(env, g->customers, g->customer_count, &g->customer_capacity, sizeof(Customer));
    if (!grown) return false;
    g->customers = grown;
    c = g->customer_count++;
    g->customers[c] = (Customer){ .id = r[0].integer, .first = NONE, .last = NONE };
    if (!copy_text(env, &g->customers[c].name, &r[1]) || !add_index(env, &g->customer_index, r[0].integer, c)) return false;
  }
  if (r[2].null) return true;
  uint32_t o = lookup(&g->order_index, r[2].integer);
  if (o == NONE) {
    Order *grown = reserve(env, g->orders, g->order_count, &g->order_capacity, sizeof(Order));
    if (!grown) return false;
    g->orders = grown;
    o = g->order_count++;
    g->orders[o] = (Order){ .id = r[2].integer, .next = NONE, .first_item = NONE, .last_item = NONE,
      .first_payment = NONE, .last_payment = NONE };
    if (!copy_text(env, &g->orders[o].status, &r[3]) || !add_index(env, &g->order_index, r[2].integer, o)) return false;
    Customer *customer = &g->customers[c];
    if (customer->first == NONE) customer->first = o; else g->orders[customer->last].next = o;
    customer->last = o;
  }
  Order *order = &g->orders[o];
  if (!r[4].null && lookup(&g->item_index, r[4].integer) == NONE) {
    Item *grown = reserve(env, g->items, g->item_count, &g->item_capacity, sizeof(Item));
    if (!grown) return false;
    g->items = grown;
    uint32_t i = g->item_count++;
    g->items[i] = (Item){ .id = r[4].integer, .product_id = r[5], .quantity = r[7], .unit_cents = r[8], .next = NONE };
    if (!copy_text(env, &g->items[i].product_name, &r[6]) || !add_index(env, &g->item_index, r[4].integer, i)) return false;
    if (order->first_item == NONE) order->first_item = i; else g->items[order->last_item].next = i;
    order->last_item = i;
  }
  if (!r[9].null && lookup(&g->payment_index, r[9].integer) == NONE) {
    Payment *grown = reserve(env, g->payments, g->payment_count, &g->payment_capacity, sizeof(Payment));
    if (!grown) return false;
    g->payments = grown;
    uint32_t p = g->payment_count++;
    g->payments[p] = (Payment){ .id = r[9].integer, .paid_cents = r[10], .next = NONE };
    if (!add_index(env, &g->payment_index, r[9].integer, p)) return false;
    if (order->first_payment == NONE) order->first_payment = p; else g->payments[order->last_payment].next = p;
    order->last_payment = p;
  }
  return true;
}

enum { ID, NAME, ORDERS, STATUS, ITEMS, PAYMENTS, QUANTITY, UNIT_CENTS, PRODUCT, PAID_CENTS, KEY_COUNT };
static bool set_number(napi_env env, napi_value object, napi_value key, int32_t number, bool null) {
  napi_value value;
  return check(env, null ? napi_get_null(env, &value) : napi_create_int32(env, number, &value)) &&
    check(env, napi_set_property(env, object, key, value));
}
static bool set_text(napi_env env, napi_value object, napi_value key, Text text) {
  napi_value value;
  return check(env, text.null ? napi_get_null(env, &value) : napi_create_string_utf8(env, text.data, text.length, &value)) &&
    check(env, napi_set_property(env, object, key, value));
}
static bool materialize(napi_env env, const Graph *g, napi_value *result) {
  const char *names[] = { "id", "name", "orders", "status", "items", "payments", "quantity", "unitCents", "product", "paidCents" };
  napi_value keys[KEY_COUNT];
  if (!check(env, napi_create_array_with_length(env, g->customer_count, result))) return false;
  for (int i = 0; i < KEY_COUNT; i++) if (!check(env, napi_create_string_utf8(env, names[i], NAPI_AUTO_LENGTH, &keys[i]))) return false;
  /* Attach each object to a reachable array before closing its bounded handle scope. */
  for (uint32_t c = 0; c < g->customer_count; c++) {
    napi_handle_scope cs; napi_value customer, orders;
    if (!check(env, napi_open_handle_scope(env, &cs))) return false;
    bool success = check(env, napi_create_object(env, &customer)) && check(env, napi_create_array(env, &orders)) &&
      set_number(env, customer, keys[ID], g->customers[c].id, false) && set_text(env, customer, keys[NAME], g->customers[c].name) &&
      check(env, napi_set_property(env, customer, keys[ORDERS], orders)) && check(env, napi_set_element(env, *result, c, customer));
    uint32_t order_pos = 0;
    for (uint32_t o = g->customers[c].first; success && o != NONE; o = g->orders[o].next) {
      const Order *ord = &g->orders[o];
      napi_handle_scope os; napi_value order, items, payments;
      if (!check(env, napi_open_handle_scope(env, &os))) { success = false; break; }
      success = check(env, napi_create_object(env, &order)) && check(env, napi_create_array(env, &items)) &&
        check(env, napi_create_array(env, &payments)) && set_number(env, order, keys[ID], ord->id, false) &&
        set_text(env, order, keys[STATUS], ord->status) && check(env, napi_set_property(env, order, keys[ITEMS], items)) &&
        check(env, napi_set_property(env, order, keys[PAYMENTS], payments)) && check(env, napi_set_element(env, orders, order_pos++, order));
      uint32_t item_pos = 0, payment_pos = 0;
      for (uint32_t i = ord->first_item; success && i != NONE; i = g->items[i].next) {
        const Item *it = &g->items[i];
        napi_handle_scope scope; napi_value item, product;
        if (!check(env, napi_open_handle_scope(env, &scope))) { success = false; break; }
        success = check(env, napi_create_object(env, &item)) && check(env, napi_create_object(env, &product)) &&
          set_number(env, item, keys[ID], it->id, false) &&
          set_number(env, item, keys[QUANTITY], it->quantity.integer, it->quantity.null) &&
          set_number(env, item, keys[UNIT_CENTS], it->unit_cents.integer, it->unit_cents.null) &&
          set_number(env, product, keys[ID], it->product_id.integer, it->product_id.null) &&
          set_text(env, product, keys[NAME], it->product_name) && check(env, napi_set_property(env, item, keys[PRODUCT], product)) &&
          check(env, napi_set_element(env, items, item_pos++, item));
        if (!check(env, napi_close_handle_scope(env, scope))) success = false;
      }
      for (uint32_t p = ord->first_payment; success && p != NONE; p = g->payments[p].next) {
        const Payment *pay = &g->payments[p];
        napi_handle_scope scope; napi_value payment;
        if (!check(env, napi_open_handle_scope(env, &scope))) { success = false; break; }
        success = check(env, napi_create_object(env, &payment)) && set_number(env, payment, keys[ID], pay->id, false) &&
          set_number(env, payment, keys[PAID_CENTS], pay->paid_cents.integer, pay->paid_cents.null) &&
          check(env, napi_set_element(env, payments, payment_pos++, payment));
        if (!check(env, napi_close_handle_scope(env, scope))) success = false;
      }
      if (!check(env, napi_close_handle_scope(env, os))) success = false;
    }
    if (!check(env, napi_close_handle_scope(env, cs))) success = false;
    if (!success) return false;
  }
  return true;
}
static bool metric(napi_env env, napi_value object, const char *name, double number) {
  napi_value value;
  return check(env, napi_create_double(env, number, &value)) && check(env, napi_set_named_property(env, object, name, value));
}

napi_value nodec_commerce_all(napi_env env, sqlite3_stmt *stmt, bool profile) {
  Graph graph = {0}; napi_value rows, result, timing, counts;
  double start = profile ? nodec_now_ms() : 0, step_ms = 0, decode_ms = 0, group_ms = 0;
  for (;;) {
    double t = profile ? nodec_now_ms() : 0;
    int status = sqlite3_step(stmt);
    if (profile) step_ms += nodec_now_ms() - t;
    if (status == SQLITE_DONE) break;
    if (status != SQLITE_ROW) { db_fail(env, stmt); goto failure; }
    if (graph.rows == UINT32_MAX) { fail(env, "Too many commerce rows"); goto failure; }
    graph.rows++;
    Cell row[11];
    t = profile ? nodec_now_ms() : 0;
    if (!decode(env, stmt, row)) goto failure;
    if (profile) decode_ms += nodec_now_ms() - t;
    t = profile ? nodec_now_ms() : 0;
    if (!group(env, &graph, row)) goto failure;
    if (profile) group_ms += nodec_now_ms() - t;
  }
  sqlite3_reset(stmt);
  double materialize_start = profile ? nodec_now_ms() : 0;
  if (!materialize(env, &graph, &rows)) goto failure;
  double materialize_ms = profile ? nodec_now_ms() - materialize_start : 0;
  uint32_t row_count = graph.rows, customers = graph.customer_count, orders = graph.order_count,
    items = graph.item_count, payments = graph.payment_count;
  double cleanup_start = profile ? nodec_now_ms() : 0;
  free_graph(&graph);
  if (!profile) return rows;
  double cleanup_ms = nodec_now_ms() - cleanup_start, total_ms = nodec_now_ms() - start;
  if (!check(env, napi_create_object(env, &result)) || !check(env, napi_create_object(env, &timing)) ||
      !check(env, napi_create_object(env, &counts)) || !check(env, napi_set_named_property(env, result, "rows", rows)) ||
      !check(env, napi_set_named_property(env, result, "timings", timing)) || !check(env, napi_set_named_property(env, result, "counts", counts))) return NULL;
  if (!metric(env, timing, "sqliteStepMs", step_ms) || !metric(env, timing, "decodeMs", decode_ms) ||
      !metric(env, timing, "groupMs", group_ms) || !metric(env, timing, "materializeMs", materialize_ms) ||
      !metric(env, timing, "cleanupMs", cleanup_ms) || !metric(env, timing, "totalMs", total_ms) ||
      !metric(env, counts, "flatRows", row_count) || !metric(env, counts, "customers", customers) ||
      !metric(env, counts, "orders", orders) || !metric(env, counts, "items", items) || !metric(env, counts, "payments", payments) ||
      !metric(env, counts, "intermediateRowObjects", 0) ||
      !metric(env, counts, "finalObjects", (double)customers + orders + 2.0 * items + payments) ||
      !metric(env, counts, "finalArrays", 1.0 + customers + 2.0 * orders) ||
      !metric(env, counts, "finalPropertySets", 3.0 * customers + 4.0 * orders + 6.0 * items + 2.0 * payments)) return NULL;
  return result;
failure:
  sqlite3_reset(stmt); free_graph(&graph); return NULL;
}
