---
title: 2026-05-20 - SSH into production and run Laravel post-deploy verification
type: session-log
session-date: 2026-05-20
agent: codex
duration-minutes: 15
outcomes:
  - Connected to production via SSH as root using existing SSH key.
  - Identified Laravel project path as /opt/laravel-api and runtime as Docker container laravel-octane-api.
  - "Verified production Laravel about: config/events/routes cached, views not cached, Octane Swoole enabled."
  - "Ran php artisan optimize; config/events/routes cached successfully but view cache failed because config/view.php/view.compiled is missing in this API-only app."
  - "Ran targeted performance migration 2026_05_20_132621_add_performance_indexes_and_normalized_driver_name_to_work_assignments.php with --force; migration completed and status now Ran batch 90."
  - "Enabled opt-in production slow query monitoring in .env with DB_SLOW_QUERY_LOG_ENABLED=true, DB_SLOW_QUERY_THRESHOLD_MS=500, DB_QUERY_COUNT_WARNING_THRESHOLD=80, then config:cache and octane:reload."
  - "Reloaded Octane workers and broadcast queue restart signal; queue worker container restarted."
  - Verified public health endpoint remains healthy after changes.
  - "Checked slow query monitor command; performance_schema access is denied for DB user pmauser."
  - "Inspected scheduler container health: Docker healthcheck is unhealthy because ps is missing, but scheduler logs show scheduled jobs are running."
created: 2026-05-20
updated: 2026-05-20
tags:
  - session-log
  - project/general
---
# 2026-05-20 - SSH into production and run Laravel post-deploy verification

## TL;DR
- Connected to production via SSH as root using existing SSH key.
- Identified Laravel project path as /opt/laravel-api and runtime as Docker container laravel-octane-api.
- Verified production Laravel about: config/events/routes cached, views not cached, Octane Swoole enabled.
- Ran php artisan optimize; config/events/routes cached successfully but view cache failed because config/view.php/view.compiled is missing in this API-only app.
- Ran targeted performance migration 2026_05_20_132621_add_performance_indexes_and_normalized_driver_name_to_work_assignments.php with --force; migration completed and status now Ran batch 90.
- Enabled opt-in production slow query monitoring in .env with DB_SLOW_QUERY_LOG_ENABLED=true, DB_SLOW_QUERY_THRESHOLD_MS=500, DB_QUERY_COUNT_WARNING_THRESHOLD=80, then config:cache and octane:reload.
- Reloaded Octane workers and broadcast queue restart signal; queue worker container restarted.
- Verified public health endpoint remains healthy after changes.
- Checked slow query monitor command; performance_schema access is denied for DB user pmauser.
- Inspected scheduler container health: Docker healthcheck is unhealthy because ps is missing, but scheduler logs show scheduled jobs are running.

## Goal
SSH into production and run Laravel post-deploy verification

## What Was Done
- Connected to production via SSH as root using existing SSH key.
- Identified Laravel project path as /opt/laravel-api and runtime as Docker container laravel-octane-api.
- Verified production Laravel about: config/events/routes cached, views not cached, Octane Swoole enabled.
- Ran php artisan optimize; config/events/routes cached successfully but view cache failed because config/view.php/view.compiled is missing in this API-only app.
- Ran targeted performance migration 2026_05_20_132621_add_performance_indexes_and_normalized_driver_name_to_work_assignments.php with --force; migration completed and status now Ran batch 90.
- Enabled opt-in production slow query monitoring in .env with DB_SLOW_QUERY_LOG_ENABLED=true, DB_SLOW_QUERY_THRESHOLD_MS=500, DB_QUERY_COUNT_WARNING_THRESHOLD=80, then config:cache and octane:reload.
- Reloaded Octane workers and broadcast queue restart signal; queue worker container restarted.
- Verified public health endpoint remains healthy after changes.
- Checked slow query monitor command; performance_schema access is denied for DB user pmauser.
- Inspected scheduler container health: Docker healthcheck is unhealthy because ps is missing, but scheduler logs show scheduled jobs are running.

## Files Touched
- /opt/laravel-api/.env on production server

## Decisions Made
- Ran only the specific performance migration instead of all pending migrations to avoid unrelated production schema changes.
- Left remaining unrelated pending migrations untouched.
- Did not attempt to fix view cache/config/view.php on production during SSH session because API health is healthy and optimize partially succeeded for config/routes/events.

## Open Follow-ups
- [ ] Monitor storage/logs/laravel-2026-05-20.log for [SLOW QUERY] and [POTENTIAL N+1] entries after real user traffic hits slow endpoints.
- [ ] Consider adding config/view.php or excluding view cache from deploy optimize flow for API-only deployment.
- [ ] Review remaining pending migrations before running full php artisan migrate --force.
- [ ] Fix scheduler Docker healthcheck by installing procps/ps or changing healthcheck to a command available in the image.
- [ ] Grant performance_schema read permissions or use an admin DB account if db:monitor-slow-queries should be used in production.

## References
- ssh root@tms.pathwaylogistic.com
- /opt/laravel-api
- laravel-octane-api
- laravel-queue-worker
- laravel-scheduler

## Verification
SSH whoami/hostname succeeded; docker exec laravel-octane-api php artisan about; migrate:status before/after targeted migration; php artisan config:show database.monitoring; php artisan octane:reload; php artisan queue:restart; curl https://tms.pathwaylogistic.com/api/health returned healthy; curl /api/work-assignments returned expected 401 unauthenticated.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Production SSH access works with root and existing SSH key. | high | ssh root@tms.pathwaylogistic.com returned whoami=root and hostname=ohmi. | Use BatchMode and ConnectTimeout for non-interactive production SSH checks. |
| Targeted performance migration is applied in production. | high | php artisan migrate --path=... --force completed DONE and migrate:status shows [90] Ran. | For production, prefer targeted migration when unrelated pending migrations exist. |
