---
title: Developer Performance and Testing Guide
type: runbook
status: active
confidence: high
source: Manual analysis of project-memory configuration and testing rules inside app/ and tests/
verified-by: antigravity
last-verified: "2026-05-20"
tags:
  - runbook
  - development
  - performance
  - testing
  - laravel
created: "2026-05-20"
updated: "2026-05-20"
---

# Developer Performance and Testing Guide

This runbook acts as a step-by-step developer guide for writing high-performance code, running lightning-fast unit/feature tests, and managing the caching layer safely in this Laravel 12 application.

---

## 1. Running the Local Test Suite

The test suite runs on an ultra-optimized in-memory SQLite schema, ensuring tests complete in seconds.

### Commands to Execute
- **Run Full Test Suite**:
  ```bash
  composer test
  ```
  *(This clears local configurations and runs the entire test suite via `php artisan test`)*

- **Run Target Test Class**:
  ```bash
  php artisan test --filter=WorkAssignmentModelTest
  ```

- **Run Specific Test Case**:
  ```bash
  php artisan test --filter=test_login_with_valid_credentials
  ```

### Developer Protocol: Working with `DatabaseTestCase`
When writing model, controller, or API tests:
1. Extend `Tests\DatabaseTestCase` instead of the generic PHPUnit test case.
2. In-memory tables are defined dynamically. If you add a new database table, you **must** update the `createMinimalSchema()` and `dropMinimalSchema()` methods inside [DatabaseTestCase.php](file:///c:/Users/Server/Desktop/laravel/tests/DatabaseTestCase.php) with the equivalent SQLite `CREATE TABLE` and `DROP TABLE` statements.
3. This completely bypasses slow MySQL migrations, keeping the local development loop fast and light.

---

## 2. Inspecting Caching Statistics

Developers should periodically check cache sizes and key counts, especially after heavy API usage.

### Commands to Execute
- **Basic Cache Breakdown**:
  ```bash
  php artisan performance:cache-stats
  ```
  Displays tables containing key counts and estimated memory sizes for the **API Response Cache** and the **Query Cache**.

- **Detailed Cache Breakdown (Redis Required)**:
  ```bash
  php artisan performance:cache-stats --detailed
  ```
  Scans active keys categorized by tags (`dashboard`, `reports`, `query-cache`, `lookup`) and outputs a detailed table with keys and megabyte counts.

---

## 3. Modifying Caching Behavior Safely

### Rule: Never Use Redis `KEYS` Command
The Redis `KEYS` command blocks the single-threaded Redis process, causing latency spikes in production. 

### Protocol: Use `RedisCacheHelper` for Scanning
When you need to perform pattern-based cache clearing:
1. Resolve the Redis connection.
2. Call `scanAndDelete` or `scanAndCollect` on the [RedisCacheHelper](file:///c:/Users/Server/Desktop/laravel/app/Support/RedisCacheHelper.php) class.

```php
use App\Support\RedisCacheHelper;
use Illuminate\Support\Facades\Cache;

$redis = Cache::getStore()->connection();
$prefix = config('cache.prefix');

// Safe, non-blocking cache clearing:
RedisCacheHelper::scanAndDelete($redis, "{$prefix}work_assignments:{$userId}:*");
```

### Protocol: Use the `CacheInvalidationService`
For standard business transactions, use the centralized [CacheInvalidationService](file:///c:/Users/Server/Desktop/laravel/app/Services/Cache/CacheInvalidationService.php):

```php
$service = app(\App\Services\Cache\CacheInvalidationService::class);

// Evicts invoice, customer, and supervisor tags
$service->invalidateInvoice($invoiceId, $customerId, $supervisorId);

// Evicts work assignment tags
$service->invalidateWorkAssignment($workAssignmentId, $contractorId, $supervisorId);
```

---

## 4. Query Optimization & N+1 Prevention

### Standard Eager Loading
- Do not let models load relational attributes via the default `$appends` array, as this triggers N+1 queries.
- Eager load relations explicitly inside queries. Use the pre-configured query scope:
  ```php
  $assignments = WorkAssignment::withRelations()->get();
  ```

### Safe Relational Accessors
Inside model accessors, use `relationLoaded` to check if a relation is pre-loaded before triggering a separate database call:

```php
public function getIsInvoicedAttribute(): bool
{
    if ($this->relationLoaded('invoiceItems')) {
        return $this->invoiceItems->isNotEmpty();
    }

    return $this->invoiceItems()->exists();
}
```

### Writing Fuzzy Searches
When querying text fields with multiple spaces (e.g. driver name, plate numbers), utilize normalized whitespace:
1. In PHP, strip multiple spaces:
   ```php
   $search = preg_replace('/\s+/', ' ', trim($search));
   ```
2. Use database `REPLACE` functions to collapse spaces inside the database:
   ```php
   $normalizedCol = "REPLACE(REPLACE(REPLACE(driver_name, '    ', ' '), '   ', ' '), '  ', ' ')";
   $query->whereRaw("{$normalizedCol} LIKE ?", ["%{$search}%"]);
   ```
