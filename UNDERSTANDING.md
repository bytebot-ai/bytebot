# Bytebot – Project Understanding

_Last updated: <!-- timestamp placeholder, replace later -->_

## 1. Purpose
Bytebot is a **self-hosted AI desktop agent** that automates arbitrary computer tasks using natural-language instructions. It couples a containerised Linux desktop (Ubuntu + XFCE) with AI-driven task planning and execution so that users can delegate workflows such as web research, form filling, and data extraction.

Key value-props:
* Runs fully on the user's infrastructure (privacy & control)
* Uses the user's own Anthropic Claude (or other) API key – no SaaS limits
* Provides live visual feedback through an embedded VNC viewer in the browser

## 2. Top-Level Architecture
```
┌──────────────────────────────────────────┐
│              User Browser               │
│          (Next.js Web UI)               │
└───────────────┬─────────────────────────┘
                │ WebSocket / HTTP
┌───────────────▼─────────────────────────┐
│       Bytebot Agent  (NestJS)           │
│ • LLM integration (Anthropic Claude)    │
│ • Task orchestration & scheduling       │
│ • Action planning                       │
└───────────────┬─────────────────────────┘
                │ REST / SSE / WebSocket
┌───────────────▼─────────────────────────┐
│   Bytebot Desktop  (Ubuntu + XFCE)      │
│ • Full Linux desktop environment        │
│ • Automation daemon (bytebotd)          │
└───────────────┬─────────────────────────┘
                │ NutJS / MCP API
┌───────────────▼─────────────────────────┐
│        Automation Daemon (bytebotd)     │
│ • Executes low-level computer actions   │
│ • Exposes REST endpoints (/computer-use)│
└──────────────────────────────────────────┘
```

### Component Roles
| Component | Code location | Runtime | Responsibilities |
|-----------|---------------|---------|-------------------|
| **UI** | `packages/bytebot-ui` | Next.js server & client | Task creation, chat interface, VNC viewer |
| **Agent** | `packages/bytebot-agent` | NestJS | Converts user intents → plans, coordinates Desktop & Daemon |
| **Daemon (Core)** | `packages/bytebotd` | NestJS inside Desktop container | Low-level computer control API via NutJS, screenshot streaming |
| **Shared** | `packages/shared` | Node lib | Type definitions & utilities shared across services |
| **Infrastructure** | `infrastructure/docker` | Docker Compose | Spins up Postgres, UI, Agent, Desktop, proxy |

## 3. Deployment Modes
* **Local** – Run `docker-compose` to start all services on `localhost` ports 9990-9993.
* **Railway One-Click** – Pre-built images + private networking; only UI exposed publicly.

## 4. Key Technologies
* **NestJS** – Backend framework for Agent & Daemon.
* **Next.js (React)** – Front-end + simple API routes.
* **NutJS** – JS desktop automation lib used by Daemon.
* **MCP-Nest** – Provides SSE endpoint for remote tool invocation.
* **PostgreSQL + Prisma** – Persistence for tasks & messages.
* **noVNC** – Browser VNC viewer inside UI.
* **Docker** – Isolation; each desktop in its own container.

## 5. Initial Questions / Unknowns
1. How are tasks represented in the DB and flowed between Agent ↔ UI?
2. What scheduling capabilities exist (cron-like)?
3. How does MCP tooling integrate with external clients?

These will be explored while diving into each package.

## 6. Next Steps
1. Deep-dive into `packages/bytebot-agent` – document modules, task lifecycle, Anthropic integration.
2. Repeat for **UI**, **Daemon**, and **Shared** packages.
3. Map cross-service communication (ports, message shapes, DB schema).
4. Identify potential refactors or tech-debt areas. 