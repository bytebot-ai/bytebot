file:Contribution Plan:contribution_plan.md

# Contribution Plan: Bytebot Stabilization & Enhancement

## Overview

**Repository:** `bytebot-ai/bytebot`

**Goal:** Stabilize the build process, fix critical runtime errors, optimize performance, and expand model support.

This plan details the steps to resolve currently reported blocking issues (Docker build failures, UI crashes) and implements a roadmap for high-demand feature requests (Universal Model Support).

---

## Phase 1: Critical Fixes & Stabilization

**Objective:** Resolve build-time and boot-time failures that prevent users from deploying the application.

### 1.1 Fix Docker Build Failure (`dbus-uuidgen`)

**Issue:** #172 - `dbus-uuidgen: not found` during `docker build`.

**Severity:** Critical (Blocks deployment).

**Root Cause:** The `bytebot-desktop` Dockerfile attempts to generate a machine ID using `dbus-uuidgen` without having the `dbus` package installed in the base image.

**Task Description:**
Modify the `packages/bytebot-desktop/Dockerfile` to ensure `dbus` is installed before the machine ID generation step.

**Technical Implementation Detail:**

```dockerfile
# File: packages/bytebot-desktop/Dockerfile

# Locate the apt-get install section
RUN apt-get update && apt-get install -y \
    # ... existing packages ...
    dbus \
    # ...
    && rm -rf /var/lib/apt/lists/*

# The existing command will now succeed:
# RUN mkdir -p /run/dbus && dbus-uuidgen --ensure=/etc/machine-id

```

**Verification/Testing:**

* Run `docker compose build bytebot-desktop`.
* Verify the build completes without the `exit code: 127` error.

### 1.2 Fix UI Proxy Crash (`Missing "target" option`)

**Issue:** #156 - `[HPM] Missing "target" option` in `bytebot-ui`.

**Severity:** High (UI fails to start).

**Root Cause:** The `http-proxy-middleware` in `packages/bytebot-ui/server.ts` is initialized with an undefined `target` because the environment variable (likely `AGENT_URL` or `API_BASE_URL`) is not correctly passed or read.

**Task Description:**

1. Harden `server.ts` to provide a fallback target or a descriptive error.
2. Update `docker/docker-compose.yml` to explicitly pass `AGENT_URL` to the UI service.

**Technical Implementation Detail:**

```typescript
// File: packages/bytebot-ui/server.ts

// Current logic likely resembles:
// app.use('/api', createProxyMiddleware({ target: process.env.AGENT_URL, ... }));

// Proposed fix:
const proxyTarget = process.env.AGENT_URL || process.env.API_BASE_URL || 'http://bytebot-agent:3000';

if (!proxyTarget) {
  console.error("CRITICAL: AGENT_URL environment variable is missing.");
  process.exit(1);
}

app.use('/api', createProxyMiddleware({ 
    target: proxyTarget,
    changeOrigin: true,
    // ...
}));

```

```yaml
# File: docker/docker-compose.yml
services:
  bytebot-ui:
    environment:
      - AGENT_URL=http://bytebot-agent:3000
      # ...

```

**Verification/Testing:**

* Run `docker compose up bytebot-ui`.
* Check logs for "Proxy target set to: http://bytebot-agent:3000".
* Verify the UI is accessible at `http://localhost:9992`.

---

## Phase 2: Performance Optimization

**Objective:** Address user reports of "sluggish" task execution and VNC delays (Issue #150).

### 2.1 Optimize Shared Memory for Desktop Container

**Issue:** High VNC latency and browser crashing.

**Root Cause:** Chrome/Firefox and VNC sessions inside Docker often run out of shared memory (`/dev/shm`), defaulting to 64MB, which causes poor rendering performance and crashes.

**Task Description:**
Increase the `shm_size` for the `bytebot-desktop` service in the compose file.

**Technical Implementation Detail:**

```yaml
# File: docker/docker-compose.yml
services:
  bytebot-desktop:
    image: ghcr.io/bytebot-ai/bytebot-desktop:edge
    shm_size: '2gb' # Critical for browser/VNC performance
    # ...

```

**Verification/Testing:**

* Deploy the stack.
* Open the "Desktop" view in the UI.
* Visually verify that dragging windows or scrolling in Firefox is smoother.

---

## Phase 3: Feature Expansion

**Objective:** Implement "Universal Model Support" to allow users to bring any LLM (OpenRouter, Grok, Local Ollama) without code changes.

### 3.1 Unified Model Adapter Pattern

**Issue:** #144 - Users want to use providers other than the hardcoded defaults (OpenAI/Claude).

**Task Description:**

Refactor the agent's model service to use a configuration-driven Adapter pattern. Instead of `if (provider === 'openai')`, use a map of strategy classes.

**Technical Implementation Detail:**

1. **Interface Definition:**
```typescript
interface LLMProvider {
  generateResponse(prompt: string, images?: string[]): Promise<string>;
}

```


2. **Configuration:**
Update `packages/bytebot-agent/src/config.ts` to read a generic `LLM_CONFIG_JSON` env var, allowing users to define custom endpoints and model names.
3. **LiteLLM Integration:**
Fully leverage the existing `bytebot-llm-proxy` (LiteLLM) by making the agent default to hitting the proxy for *all* requests if a specific flag is set, rather than maintaining separate client libraries for each vendor.

**Verification/Testing:**

* Configure `LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY=...`.
* Run a simple task ("Open Calculator").
* Verify in logs that the request was routed through the generic provider adapter.

The analysis of `bytebot-ai/bytebot` reveals two critical blocking issues that should be addressed immediately: a Docker build failure caused by a missing `dbus` dependency (Issue #172) and a UI startup crash due to a missing proxy configuration (Issue #156).

I have generated a comprehensive **Contribution Plan** (see file) that prioritizes these fixes to stabilize the project. Following stabilization, the plan outlines performance optimizations for the VNC environment and a roadmap for a "Universal Model Adapter" to support the community's request for more LLM providers.

For a deeper dive into the "First-Ever AI Operating System" claims and a visual overview of Bytebot's architecture, you might find this video helpful: [ByteBot OS: First-Ever AI Operating System IS INSANE!](https://www.youtube.com/watch?v=UxoDxG7bah4).