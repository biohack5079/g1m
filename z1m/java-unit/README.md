# 🏢 Z1:M (Enterprise Core Module)

**Z1:M** is the enterprise-grade backend platform of the **G1:M ecosystem**, responsible for transforming human activities into structured, auditable, and manageable business operations.

While **G1:M** integrates **Human × AI × Robot interactions**, **Z1:M** manages the administrative and financial backbone that supports those interactions.

---

## 🌐 Position in the G1:M Ecosystem

```
Human Reality World
(MediaPipe / Mobile / Sensors)
            ↓
Avatar Universe
(Unity / Three.js / Plower)
            ↓
Robotics Matrix
(Unitree / Physical AI)
            ↓
      Z1:M
Enterprise Core System
```

G1:M enables humans, AI, and robots to collaborate.

Z1:M ensures that these collaborations become:

* Structured
* Persistent
* Traceable
* Auditable

---

# 🎯 Mission

Traditional RPA focuses on automating user operations.

Z1:M aims to go further.

Instead of reproducing mouse clicks and keyboard input, Z1:M treats business processes themselves as structured data.

This enables:

* Reduced manual operations
* Consistent execution across systems
* Financial accountability
* Complete audit trails

---

# 🧩 Role within G1:M

Z1:M provides enterprise services used by various G1:M modules.

Examples include:

## 📅 Workforce Operations

* Shift scheduling
* Attendance management
* Task assignment

For example:

A shift schedule created inside G1:M can be transformed into:

* Google Calendar events
* Outlook Calendar entries
* Internal scheduling systems

Z1:M processes the generated business data and synchronizes it across platforms.

---

## 💳 Billing and Financial Processing

Z1:M serves as the external financial component for applications inside the ecosystem.

Responsible for:

* Payment processing integration
* Donation tracking
* Transaction recording
* Revenue management
* Financial reconciliation

---

## 🧠 Knowledge and AI Applications

Modules such as:

### Plower

Local-first RAG application.

Used for:

* Document retrieval
* Internal knowledge management
* Interaction history storage

### CyberNet Call

WebRTC communication system.

Used for:

* Communication event tracking
* Session state management

These applications generate operational data that can be processed by Z1:M.

---

## 🔐 Identity and Compliance

* Role-Based Access Control (RBAC)
* Immutable audit logs
* Traceable system activities
* Separation of personal and financial information

---

# 🏗 Architecture

Z1:M is designed using:

* Java
* Spring Boot
* JPA / Hibernate
* Docker
* H2 Database (development)

Example architecture:

```
Controller Layer
        ↓
Business Logic
        ↓
Repository Layer
        ↓
Separated Databases
 ┌────────────┐
 │ Personal DB│
 └────────────┘

 ┌────────────┐
 │Financial DB│
 └────────────┘
```

The separation between personal information and financial information is intentional to improve maintainability and security.

---

# ☕ Why Java?

Many modern backend projects choose Go or Rust.

Z1:M intentionally adopts Java.

Reasons include:

## ✔ Proven Enterprise History

Java has decades of production use in:

* Banking
* Government systems
* ERP platforms
* Large-scale enterprise applications

---

## ✔ Large Talent Pool

Java remains one of the most widely used enterprise languages worldwide.

This improves:

* Maintainability
* Recruitment
* Knowledge sharing

---

## ✔ Strong Static Typing

Business systems require correctness.

Java provides:

* Compile-time verification
* Robust IDE support
* Reduced runtime errors

---

## ✔ Designed for Large Systems

Z1:M is intended to evolve from:

```
Personal Projects
        ↓
Small Teams
        ↓
Business Applications
        ↓
Enterprise Platforms
```

Java's mature ecosystem supports this evolution.

---

## ✔ Vendor Neutrality

Z1:M avoids dependence on specific vendors.

Built upon:

* Open standards
* Open-source frameworks
* Containerized deployment

This minimizes platform lock-in.

---

## ✔ Stability Over Novelty

The goal of Z1:M is not to adopt the newest technology.

The goal is to build systems that organizations can trust for years.

Correctness, maintainability, and operational stability are prioritized over trend adoption.

---

# 💡 Design Principles

## Minimal Personal Data

Only necessary information should be stored.

---

## Separation of Concerns

Execution logic and business logic should remain independent.

---

## Cloud Agnostic

Deployable anywhere using containers.

---

## Incremental Growth

Designed to scale from:

* Proof of Concept
* Internal tools
* Department systems
* Enterprise platforms

---

# 🚀 Future Directions

* Multi-tenant SaaS architecture
* Event-driven processing (Kafka)
* Financial-grade transaction systems
* Integration with payment providers
* Advanced audit capabilities
* Cross-module billing infrastructure for G1:M applications

---

# 🌏 Vision

G1:M aims to become:

> **"The Android OS for Human–AI–Robot interaction."**

Z1:M aims to become:

> **"The enterprise operating layer that transforms those interactions into accountable business processes."**

Humans create intent.

AI interprets and optimizes.

Robots execute.

**Z1:M records, validates, and manages the resulting operations.**

---

# 🛠 Current Technologies

* Java
* Spring Boot
* Spring Data JPA
* Docker
* H2 Database
* Maven

Future integrations:

* PostgreSQL
* Kafka
* Vault
* Stripe
* Google Workspace APIs
* Microsoft Graph APIs






z1m/java-unit
├── Dockerfile
├── config
│   └── VaultIntegrationTest.java
├── db
│   ├── financial.mv.db
│   └── personal.mv.db
├── docker-compose.yml
├── pom.xml
├── src
│   ├── main
│   │   ├── java
│   │   │   └── com
│   │   │       └── g1m
│   │   │           └── z1m
│   │   │               ├── Z1mApplication.java
│   │   │               ├── config
│   │   │               │   ├── FinancialDbConfig.java
│   │   │               │   └── PersonalDbConfig.java
│   │   │               ├── controller
│   │   │               │   ├── KampaController.java
│   │   │               │   └── application.properties
│   │   │               ├── entity
│   │   │               │   ├── financial
│   │   │               │   │   └── FinancialInfo.java
│   │   │               │   └── personal
│   │   │               │       └── PersonalInfo.java
│   │   │               ├── model
│   │   │               │   └── WalletInfo.java
│   │   │               └── repository
│   │   │                   ├── financial
│   │   │                   │   └── FinancialInfoRepository.java
│   │   │                   └── personal
│   │   │                       ├── PersonalInfoRepository.java
│   │   │                       └── WalletRepository.java
│   │   └── resources
│   │       ├── application.properties
│   │       └── test.md
│   └── test
│       ├── java
│       │   └── com
│       │       └── g1m
│       │           └── z1m
│       │               └── VaultIntegrationTest.java
│       └── resources
│           └── application.properties
└── target
    ├── classes
    │   ├── application.properties
    │   ├── com
    │   │   └── g1m
    │   │       └── z1m
    │   │           ├── Z1mApplication.class
    │   │           ├── config
    │   │           │   ├── FinancialDbConfig.class
    │   │           │   └── PersonalDbConfig.class
    │   │           ├── controller
    │   │           │   ├── KampaController$DonationRequest.class
    │   │           │   ├── KampaController$NicknameRequest.class
    │   │           │   └── KampaController.class
    │   │           ├── entity
    │   │           │   ├── financial
    │   │           │   │   ├── FinancialInfo$FinancialInfoBuilder.class
    │   │           │   │   └── FinancialInfo.class
    │   │           │   └── personal
    │   │           │       ├── PersonalInfo$PersonalInfoBuilder.class
    │   │           │       └── PersonalInfo.class
    │   │           ├── model
    │   │           │   └── WalletInfo.class
    │   │           └── repository
    │   │               ├── financial
    │   │               │   └── FinancialInfoRepository.class
    │   │               └── personal
    │   │                   ├── PersonalInfoRepository.class
    │   │                   └── WalletRepository.class
    │   └── test.md
    ├── generated-sources
    │   └── annotations
    ├── generated-test-sources
    │   └── test-annotations
    ├── maven-status
    │   └── maven-compiler-plugin
    │       ├── compile
    │       │   └── default-compile
    │       │       ├── createdFiles.lst
    │       │       └── inputFiles.lst
    │       └── testCompile
    │           └── default-testCompile
    │               ├── createdFiles.lst
    │               └── inputFiles.lst
    ├── surefire-reports
    │   ├── TEST-com.g1m.z1m.VaultIntegrationTest.xml
    │   └── com.g1m.z1m.VaultIntegrationTest.txt
    └── test-classes
        ├── application.properties
        └── com
            └── g1m
                └── z1m
                    └── VaultIntegrationTest.class
