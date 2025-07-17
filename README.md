[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/bytebot-ai-bytebot-badge.png)](https://mseep.ai/app/bytebot-ai-bytebot)

<div align="center">

<img src="static/bytebot-logo.png" width="500" alt="Bytebot Logo">

# Bytebot – Self-Hosted AI Desktop Agent

**Automate any computer task with natural language**

[🌐 Website](https://bytebot.ai) • [📚 Docs](https://docs.bytebot.ai) • [💬 Discord](https://discord.com/invite/zcb5wA2t4u) • [𝕏 Twitter](https://x.com/bytebot_ai)

</div>

## What is Bytebot?

Bytebot is a self-hosted AI desktop agent that transforms how you interact with computers. By combining powerful AI with a containerized Linux desktop, Bytebot can perform complex computer tasks. Think of it as your virtual employee that can actually use a computer – clicking, typing, browsing, and completing workflows just like a human would.

## Why Self-Host Bytebot?

- **Complete Privacy**: Your tasks and data never leave your infrastructure
- **Full Control**: Customize the desktop environment and installed applications
- **No Usage Limits**: Use your own LLM API keys without platform restrictions
- **Secure Isolation**: Each desktop runs in its own container, isolated from your host

## Examples

https://github.com/user-attachments/assets/32a76e83-ea3a-4d5e-b34b-3b57f3604948

https://github.com/user-attachments/assets/5f946df9-9161-4e7e-8262-9eda83ee7d22

## ☁️ Deploy on Railway (1-Click)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/bytebot?referralCode=L9lKXQ)

1. Click the Deploy Now button in the Bytebot Railway template.
2. Paste your `ANTHROPIC_API_KEY` in the single required environment variable.
3. Press **Deploy**. Railway will spin up the Desktop, Agent, UI and Postgres services using pre-built container images, connect them via [private networking](https://docs.railway.com/guides/private-networking) and expose only the UI publicly.
4. In about two minutes your agent will be live at your project's public URL.

_For an in-depth guide see [here](https://docs.bytebot.ai/deployment/railway)._

---

## 🚀 Quick Start

### Prerequisites

- Docker ≥ 20.10
- Docker Compose
- AI API key from one of these providers:
  - Anthropic ([get one here](https://console.anthropic.com)) - Claude models
  - OpenAI ([get one here](https://platform.openai.com/api-keys)) - GPT models
  - Google ([get one here](https://makersuite.google.com/app/apikey)) - Gemini models

### Start Your Desktop Agent (2 minutes)

1. **Clone and configure:**

```bash
git clone https://github.com/bytebot-ai/bytebot.git
cd bytebot

# Configure your AI provider (choose one):
echo "ANTHROPIC_API_KEY=your_api_key_here" > docker/.env    # For Claude
# echo "OPENAI_API_KEY=your_api_key_here" > docker/.env     # For OpenAI
# echo "GOOGLE_API_KEY=your_api_key_here" > docker/.env     # For Gemini
```

2. **Start the agent stack:**

```bash
docker-compose -f docker/docker-compose.yml up -d
```

3. **Open the chat interface:**

```
http://localhost:9992
```

That's it! Start chatting with your AI desktop agent. Watch it work in real-time through the embedded desktop viewer.

### Example Tasks You Can Delegate

- "Research the top 5 competitors for [product] and create a comparison spreadsheet"
- "Fill out this web form with the data from my CSV file"
- "Check my email and summarize important messages"
- "Download all PDFs from this website and organize them by date"
- "Monitor this webpage and alert me when the price drops below $50"

## 🤖 Supported AI Models

Bytebot supports multiple AI providers to power your desktop agent:

- **Anthropic Claude**: Claude 3.5 Sonnet (default) - Best for complex reasoning and visual tasks
- **OpenAI**: GPT-4, GPT-4o - Excellent for general automation tasks
- **Google Gemini**: Gemini 1.5 Pro, Flash - Fast and efficient for routine tasks

Choose the model that best fits your needs and budget. Simply set the appropriate API key in your environment configuration.

## 🏗️ Architecture Overview

Bytebot consists of four main components working together:

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Browser                          │
│                    http://localhost:9992                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                    Bytebot UI (Next.js)                      │
│              • Task interface                                │
│              • Desktop viewer (VNC)                          │
│              • Task management                               │
└─────────────────────┬───────────────────────────────────────┘
                      │ WebSocket
┌─────────────────────▼───────────────────────────────────────┐
│                 Bytebot Agent (NestJS)                       │
│              • Multi-LLM integration (Claude/GPT/Gemini)     │
│              • Task orchestration                            │
│              • Action planning                               │
└─────────────────────┬───────────────────────────────────────┘
                      │ REST API
┌─────────────────────▼───────────────────────────────────────┐
│              Bytebot Desktop (Ubuntu + XFCE)                 │
│              • Full Linux desktop                            │
│              • Browser, email, office apps                   │
│              • Automation daemon (bytebotd)                  │
└─────────────────────────────────────────────────────────────┘
```

## 🛠️ Key Features

### For End Users

- **Natural Language Control**: Just describe what you want done
- **Visual Feedback**: Watch the AI work in real-time
- **Task History**: Review and replay previous automations
- **Browser-Based**: No software to install on your machine

### For Developers

- **REST API**: Integrate desktop automation into your applications
- **Extensible**: Add custom tools and applications to the desktop
- **Scriptable**: Create complex workflows with the automation API
- **Observable**: Full logging and debugging capabilities

### For IT Teams

- **Container-Based**: Easy deployment with Docker
- **Resource Efficient**: Minimal overhead compared to VMs
- **Network Isolated**: Secure by default with customizable access
- **Scalable**: Run multiple instances for team use

## 📊 System Requirements

### Minimum (Single Agent)

- 2 CPU cores
- 4GB RAM
- 10GB storage
- Docker & Docker Compose

### Recommended (Production)

- 4+ CPU cores
- 8GB+ RAM
- 20GB+ storage
- Linux host OS for best performance

## 🔧 Configuration

### Environment Variables

Create `docker/.env`:

```bash
# Required - Choose one of these AI providers:
ANTHROPIC_API_KEY=sk-ant-...      # For Claude models
# OPENAI_API_KEY=sk-...           # For OpenAI models
# GOOGLE_API_KEY=...              # For Google Gemini models
```

### Desktop Customization

Add applications or configurations by extending the Dockerfile:

```dockerfile
# docker/desktop/Dockerfile.custom
FROM bytebot/desktop:latest

# Install additional software
RUN apt-get update && apt-get install -y \
    libreoffice \
    gimp \
    your-custom-app

# Copy custom configs
COPY configs/.config /home/user/.config
```

## 🔒 Security Considerations

- **API Keys**: Keep your AI provider API keys secure and never commit them
- **Network**: By default, services are only accessible from localhost
- **VNC**: Change the default VNC password for production use
- **Updates**: Regularly update the container images for security patches

## 🎯 Common Use Cases

### Personal Productivity

- Email management and responses
- Calendar scheduling
- Document organization
- Web research and data collection

### Business Automation

- Form filling and data entry
- Report generation
- Competitive analysis
- Customer support tasks

### Development & Testing

- UI testing automation
- Cross-browser testing
- API integration testing
- Documentation screenshots

## 🚦 Managing Your Agent

### View Logs

```bash
docker-compose -f docker/docker-compose.yml logs -f
```

### Stop Services

```bash
docker-compose -f docker/docker-compose.yml down
```

### Update to Latest Version

```bash
docker-compose -f docker/docker-compose.yml pull
docker-compose -f docker/docker-compose.yml up -d
```

### Reset Everything

```bash
docker-compose -f docker/docker-compose.yml down -v
```

## 📚 Advanced Usage

### Programmatic Control

Control Bytebot via REST API:

```python
import requests

# Create a task
response = requests.post('http://localhost:9991/tasks', json={
    'description': 'Search for flights from NYC to London next month',
})

task_id = response.json()['id']

# Check task status
status = requests.get(f'http://localhost:9991/tasks/{task_id}')
print(status.json())
```

### Direct Desktop Automation

Use the computer control API for precise automation:

The core container also exposes an [MCP](https://github.com/rekog-labs/MCP-Nest) endpoint.
Connect your MCP client to `http://localhost:9990/mcp` to invoke these tools over SSE.

```json
{
  "mcpServers": {
    "bytebot": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://127.0.0.1:9990/mcp",
        "--transport",
        "http-first"
      ]
    }
  }
}
```

```javascript
// Take screenshot
POST http://localhost:9990/computer-use
{
  "action": "screenshot"
}

// Click at coordinates
POST http://localhost:9990/computer-use
{
  "action": "click_mouse",
  "coordinate": [500, 300]
}

// Type text
POST http://localhost:9990/computer-use
{
  "action": "type_text",
  "text": "Hello, Bytebot!"
}
```

## 🤝 Contributing

We welcome contributions! Whether it's bug fixes, new features, or documentation improvements:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 💬 Community & Support

- **Discord**: Join our [community server](https://discord.com/invite/zcb5wA2t4u) for help and discussions
- **Documentation**: Comprehensive guides at [docs.bytebot.ai](https://docs.bytebot.ai)
- **Issues**: Report bugs on [GitHub](https://github.com/bytebot-ai/bytebot/issues)

## 🙏 Acknowledgments

Built with amazing open source projects:

- [nutjs](https://github.com/nut-tree/nut.js) - Desktop automation framework
- [Anthropic Claude](https://www.anthropic.com) - AI reasoning engine
- [OpenAI](https://openai.com) - GPT models for automation
- [Google AI](https://ai.google.dev) - Gemini models for efficient tasks
- [noVNC](https://novnc.com) - Browser-based VNC client
- Inspired by Anthropic's [computer-use demo](https://github.com/anthropics/anthropic-quickstarts)

## 📄 License

Apache-2.0 license © 2025 Tantl Labs, Inc.

---

<div align="center">
<strong>Ready to give your AI its own computer?</strong><br>
Start with the Quick Start guide above or dive into the <a href="https://docs.bytebot.ai">full documentation</a>.
</div>
