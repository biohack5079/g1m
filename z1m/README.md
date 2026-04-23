# Z1:M (zi:m)

**Enterprise Core System — The Central Nervous System of G1:M**

---

## Overview

Z1:M is the enterprise backbone of the G1:M ecosystem, designed to handle the full spectrum of white-collar administrative operations — from workforce scheduling and shift management to enterprise-wide accounting and financial reconciliation.

Unlike the physical robotics layers of G1:M, Z1:M operates entirely in the digital domain: no actuators required. It is the authoritative source of truth for all financial and operational data across the entire G1:M platform.

### Key Responsibilities

- **Shift & Workforce Management** — Scheduling, attendance tracking, and labor allocation
- **Accounting & Finance** — Double-entry ledger, payables/receivables, and reconciliation
- **G1:M Platform-wide Accounting** — Consolidated financial reporting across all G1:M subsystems
- **Identity & Access Management** — Role-based access control for enterprise operators
- **Audit & Compliance** — Immutable transaction logs and regulatory-ready reporting

---

## Architecture

Z1:M is built on the **Java / Spring Boot** stack — chosen deliberately for its proven enterprise reliability, type safety, and the mature ecosystem surrounding financial-grade systems. Where personal data and monetary transactions are the core concern, correctness and long-term maintainability outweigh velocity.

```
z1m/
├── java-unit/               # Spring Boot application root
│   └── src/main/java/
│       └── com/g1m/z1m/
│           ├── controller/  # REST API layer
│           ├── service/     # Business logic
│           ├── repository/  # Data access (JPA)
│           └── domain/      # Entities & value objects
├── docker/                  # Container configuration
└── docs/                    # API specs (Swagger / OpenAPI)
```

### Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Java 21 (LTS) |
| Framework | Spring Boot 3.x |
| ORM | Spring Data JPA / Hibernate |
| Database | PostgreSQL |
| Auth | JWT + Spring Security |
| Docs | Swagger / OpenAPI 3 |
| Testing | JUnit 5 |
| Containerization | Docker + docker-compose |

---

## Development Roadmap

### Phase 1 — Java Fundamentals
> Core language competency: OOP, collections, exception handling, generics

### Phase 2 — Spring Boot Foundation
> Project scaffolding · Controller / Service / Repository architecture · REST API (GET / POST)

**Milestone:** Live JSON-returning API

### Phase 3 — Database Integration *(critical path)*
> PostgreSQL connection · JPA / Hibernate · Full CRUD implementation

**Milestone:** Persistent data storage and retrieval

### Phase 4 — Production-grade Hardening
> Input validation (`@Valid`) · Global exception handling (`@ControllerAdvice`) · Structured logging (Logback)

**Milestone:** Business-grade API surface

### Phase 5 — Authentication & Authorization *(high-value)*
> JWT-based auth · Login API · Role-based access control

**Milestone:** Secured, multi-tenant API

### Phase 6 — Containerization
> Dockerfile · docker-compose with DB orchestration

**Milestone:** Fully portable, environment-agnostic deployment

---

## Target Deliverable

A production-ready **authenticated business API** covering:

- User & operator management
- Task and workflow tracking
- Payment and transaction history (designed for Stripe integration)
- Consolidated G1:M financial reporting

**Optional enhancements:** Swagger UI, JUnit unit test coverage

---

## Future Vision

As G1:M scales, Z1:M is positioned to evolve into a **multi-tenant SaaS enterprise platform** — providing accounting, compliance, and workforce management capabilities not only for internal G1:M operations but as a service layer for external enterprise clients. The Java / Spring Boot foundation ensures the system can grow into microservice decomposition, event-driven architecture (Kafka), and cloud-native deployments (GCP / AWS) without architectural rework.

Z1:M is the financial and operational ground truth of the G1:M ecosystem. Everything that moves through G1:M is ultimately accounted for here.

---

*Part of the [G1:M](../README.md) platform.*
