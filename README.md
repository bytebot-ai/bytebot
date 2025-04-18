<div align="center">

  <img src="static/bytebot-logo.png" width="300" alt="Bytebot Logo">

**The computer use container**

[Website](https://bytebot.ai) | [Documentation](https://docs.bytebot.ai) | [Discord](https://discord.gg/tYhrV7zj) | [Twitter](https://x.com/bytebot_ai)

</div>

## Features

- **Containerized Desktop** - Lightweight XFCE4 desktop on Ubuntu 22.04
- **Access Anywhere** - VNC and browser-based noVNC remote access
- **Unified API** - Control all desktop actions through a simple REST API
- **Pre-installed Tools** - Firefox and other essential applications ready to use

## Documentation

For full documentation, visit [**docs.bytebot.ai**](https://docs.bytebot.ai)

## Quick Start

### Prerequisites

- Docker installed on your system

### Run Bytebot

#### Core Container Only

```bash
# Run using the pre-built image
docker run --privileged -d \
  -p 9990:9990 -p 5900:5900 -p 6080:6080 -p 6081:6081 \
  --name "bytebot" \
  ghcr.io/bytebot-ai/bytebot:edge
```

Alternatively, you can build and run the image locally:

```bash
# Build the image locally
./scripts/build.sh

# Run the container
./scripts/run.sh
```

#### Full Agent Setup (Alpha)

```bash
# Create .env file with your Anthropic API key
echo "ANTHROPIC_API_KEY=your_api_key_here" > infrastructure/docker/.env

# Start all services (Bytebot, agent, UI, databases)
docker-compose -f infrastructure/docker/docker-compose.yml --env-file infrastructure/docker/.env up -d
```

To shut down all services:

```bash
docker-compose -f infrastructure/docker/docker-compose.yml --env-file infrastructure/docker/.env down
```

More information can be found in the [Quickstart Guide](https://docs.bytebot.ai/quickstart).

### Access Bytebot

- **VNC Client**: Connect to `localhost:5900`
- **Web Browser (noVNC)**: Navigate to `http://localhost:9990/vnc`
- **Bytebot Agent API**: Available at `http://localhost:9991`
- **Bytebot Chat UI**: Available at `http://localhost:9992`

## Automation API

Control Bytebot using the unified computer action API:

- [REST API Reference](https://docs.bytebot.ai/rest-api/computer-use)

### Available Actions

The unified API supports the following actions:

| Action            | Description                                        | Parameters                                                                                                                          |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `move_mouse`      | Move the mouse cursor to a specific position       | `coordinates: { x: number, y: number }`                                                                                             |
| `trace_mouse`     | Move the mouse along a path of coordinates         | `path: { x: number, y: number }[]`, `holdKeys?: string[]`                                                                           |
| `click_mouse`     | Perform a mouse click                              | `coordinates?: { x: number, y: number }`, `button: 'left' \| 'right' \| 'middle'`, `numClicks?: number`, `holdKeys?: string[]`      |
| `press_mouse`     | Press or release a mouse button                    | `coordinates?: { x: number, y: number }`, `button: 'left' \| 'right' \| 'middle'`, `press: 'up' \| 'down'`                          |
| `drag_mouse`      | Click and drag the mouse from one point to another | `path: { x: number, y: number }[]`, `button: 'left' \| 'right' \| 'middle'`, `holdKeys?: string[]`                                  |
| `scroll`          | Scroll up, down, left, or right                    | `coordinates?: { x: number, y: number }`, `direction: 'up' \| 'down' \| 'left' \| 'right'`, `amount: number`, `holdKeys?: string[]` |
| `type_keys`       | Type a sequence of keyboard keys                   | `keys: string[]`, `delay?: number`                                                                                                  |
| `press_keys`      | Press or release keyboard keys                     | `keys: string[]`, `press: 'up' \| 'down'`                                                                                           |
| `type_text`       | Type a text string                                 | `text: string`, `delay?: number`                                                                                                    |
| `wait`            | Wait for a specified duration                      | `duration: number` (milliseconds)                                                                                                   |
| `screenshot`      | Capture a screenshot of the desktop                | None                                                                                                                                |
| `cursor_position` | Get the current cursor position                    | None                                                                                                                                |

## Contributing

We welcome contributions from the community!

### Guidelines

1. Fork the repo and create a new branch from the main branch.
2. Commit your changes to the branch (please keep commits small and focused).
3. Open a pull request with a clear description of the changes.
4. Wait for review and address any feedback.
5. Once approved, your changes will be merged.

## Support

For any questions or feedback, please join our community on [Discord](https://discord.gg/6nxuF6cs).

## Acknowledgments

Bytebot builds on top of [nutjs](https://github.com/nut-tree/nut.js), and is inspired by Anthropic's original [computer use demo](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo).

## License

Licensed under the MIT License.

Copyright 2025 Tantl Labs, Inc.
