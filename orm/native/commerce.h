#ifndef NODEC_COMMERCE_H
#define NODEC_COMMERCE_H
#include <node_api.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <time.h>

static inline double nodec_now_ms(void) {
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (double)value.tv_sec * 1000.0 + (double)value.tv_nsec / 1000000.0;
}

/* Workload-specific graph. No JS objects are created until grouping is complete. */
napi_value nodec_commerce_all(napi_env env, sqlite3_stmt *stmt, bool profile);
#endif
