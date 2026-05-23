---
title: "System Architecture Overview (ERP & Logistics)"
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-05-18-bootstrap-project-memory-mcp-into-laravel-project.md
confidence: high
status: active
created: 2026-05-18
updated: 2026-05-18
tags:
  - architecture
  - erp
  - logistics
  - overview
---
# System Architecture Overview: Awakened AI System (Laravel ERP & Logistics)

## Core Technologies
- **Framework**: Laravel 12.0
- **Language**: PHP 8.4
- **Real-time**: Laravel Reverb (`laravel/reverb`)
- **Performance**: Laravel Octane (`laravel/octane`)
- **Auth**: JWT Authentication (`php-open-source-saver/jwt-auth`)
- **Monitoring**: Sentry (`sentry/sentry-laravel`)

## Domain Modules (ERP & Logistics)
The system is structured as a comprehensive ERP specifically tailored for logistics, transportation, and contractor management. The API routes and controllers are heavily modularized:
- **Core ERP**: Accounting (AR/AP/GL), HR, Payroll, Inventory, Assets, Procurement, Reporting, Forecasting.
- **Logistics & Transportation**: Transportation lines, Vehicles, Work Assignments, Turboroute integration, and Flash Express API integration.
- **Contractor & Billing**: Contractor management, contractor payment configs, supervisor/superadmin deductions, and team pricing.

## Route Architecture
Routes are separated logically in `routes/api.php` by loading modular files from `routes/api/` (e.g., `auth.php`, `work-assignments.php`, `turboroute.php`, `invoices.php`, `gl.php`, `hr.php`, `flash-express.php`). This ensures maintainability and clear domain boundaries.

## Build & Agent Tooling
- The project implements a Strict Mode environment with mandatory MCP memory integration (`project-memory`).
- Development and review pipelines are enforced via custom workflows (e.g., `/strict-pr-review-8-category`).
- The project also has provisions for production build obfuscation to protect IP.

## Key Takeaways
The architecture is designed to handle complex relational business logic for logistics routing (Turboroute, Flash Express) tied directly into standard ERP financial and HR functions, scaled via Laravel Octane.
