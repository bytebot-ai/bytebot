# 🖥️ Bytebot – **The Easiest Way to Build Desktop Agents**

<img src="static/bytebot-logo.png" width="300" alt="Bytebot Logo">

[🌐 Website](https://bytebot.ai) • [📚 Docs](https://docs.bytebot.ai) • [💬 Discord](https://discord.gg/tYhrV7zj) • [𝕏 Twitter](https://x.com/bytebot_ai)

## ✨ Why Bytebot?

Bytebot spins up a containerized Linux desktop you can **drive programmatically** or via VNC—perfect for automation, scraping, CI tasks, and remote work.

## 🚀 Features

- 📦 **Containerized Desktop** – XFCE4 on Ubuntu 22.04 in a single Docker image
- 🌍 **Access Anywhere** – VNC & browser‑based **noVNC** built‑in
- 🛠️ **Unified API** – Script every click & keystroke with a clean REST interface
- ⚙️ **Ready‑to‑Go Tools** – Firefox & essentials pre‑installed

## 📖 Documentation

Dive deeper at [**docs.bytebot.ai**](https://docs.bytebot.ai).

## ⚡ Quick Start

### 🛠️ Prerequisites

- Docker ≥ 20.10

### 🐳 Run Bytebot

#### Core Container (fastest way)

```bash
docker run --privileged -d \
  -p 9990:9990 -p 5900:5900 -p 6080:6080 -p 6081:6081 \
  --name bytebot \
  ghcr.io/bytebot-ai/bytebot:edge
```

Build locally instead:

```bash
./scripts/build.sh   # 🔨 build
./scripts/run.sh     # 🚀 run
```

#### 🤖 Full Agent Stack (alpha)

```bash
echo "ANTHROPIC_API_KEY=your_api_key_here" > infrastructure/docker/.env

docker-compose -f infrastructure/docker/docker-compose.yml \
  --env-file infrastructure/docker/.env up -d     # 🔥 start everything
```

Stop:

```bash
docker-compose -f infrastructure/docker/docker-compose.yml \
  --env-file infrastructure/docker/.env down
```

More details in the [**Quickstart Guide**](https://docs.bytebot.ai/quickstart).

### 🔑 Connect

| Interface     | URL / Port                  | Notes                    |
| ------------- | --------------------------- | ------------------------ |
| 🖥️ VNC Client | `localhost:5900`            | password‑less by default |
| 🌐 noVNC      | `http://localhost:9990/vnc` | open in any browser      |
| 🤖 Agent API  | `http://localhost:9991`     | REST API                 |
| 💬 Chat UI    | `http://localhost:9992`     | Agent UI                 |

## 🤖 Automation API

Control Bytebot with a single endpoint. Read the [**REST reference**](https://docs.bytebot.ai/rest-api/computer-use). Supported actions:

| 🎮 Action         | Description                |
| ----------------- | -------------------------- |
| `move_mouse`      | Move cursor to coordinates |
| `trace_mouse`     | Draw a path                |
| `click_mouse`     | Click (left/right/middle)  |
| `press_mouse`     | Press / release button     |
| `drag_mouse`      | Drag along path            |
| `scroll`          | Scroll direction & amount  |
| `type_keys`       | Type sequence of keys      |
| `press_keys`      | Press / release keys       |
| `type_text`       | Type a string              |
| `wait`            | Wait milliseconds          |
| `screenshot`      | Capture screen             |
| `cursor_position` | Return cursor position     |

_(See docs for parameter details.)_

## 🙌 Contributing

1. 🍴 Fork & branch from `main`
2. 💡 Commit small, focused changes
3. 📩 Open a PR with details
4. 🔍 Address review feedback
5. 🎉 Merge & celebrate!

## 💬 Support

Questions or ideas? Join us on [**Discord**](https://discord.gg/6nxuF6cs).

## 🙏 Acknowledgments

Powered by [**nutjs**](https://github.com/nut-tree/nut.js) and inspired by Anthropic's [**computer‑use demo**](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo).

## 📄 License

MIT © 2025 Tantl Labs, Inc.
