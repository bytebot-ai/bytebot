# Railway Quick Start Guide

Deploy Bytebot to Railway from this repository in under 15 minutes.

## Prerequisites

- Railway account with credit card (Pro plan recommended for desktop service)
- One AI API key: [Anthropic](https://console.anthropic.com/) | [OpenAI](https://platform.openai.com/api-keys) | [Gemini](https://aistudio.google.com/app/apikey)

## Quick Deploy Checklist

### 1. Create Railway Project (2 min)

- [ ] Go to [railway.app](https://railway.app/) → New Project
- [ ] Select **Empty Project** (don't use GitHub auto-deploy yet)
- [ ] Name your project (e.g., "Bytebot")

### 2. Add PostgreSQL (1 min)

- [ ] Click **New** → **Database** → **PostgreSQL**
- [ ] Wait for provisioning (auto-completes in ~30 seconds)

### 3. Deploy bytebot-desktop (10 min)

- [ ] Click **New** → **GitHub Repo** → Select this repository
- [ ] **Service Name:** `bytebot-desktop` (exact name matters!)

**Configure Build (Settings → Build):**
- **Builder:** Dockerfile
- **Dockerfile Path:** `Dockerfile.desktop`
- **Watch Paths:** `packages/bytebotd/**,packages/shared/**`

**Environment Variables (Variables tab):**
```bash
DISPLAY=:0
```

**Resources (Settings → Resources):**
- Memory: 2048 MB (minimum)
- CPU: 2 vCPU (minimum)

- [ ] Click **Deploy** → Wait 5-10 minutes for Ubuntu desktop build

### 4. Deploy bytebot-agent (3 min)

- [ ] Click **New** → **GitHub Repo** → Select this repository
- [ ] **Service Name:** `bytebot-agent`

**Configure Build (Settings → Build):**
- **Builder:** Dockerfile
- **Dockerfile Path:** `Dockerfile.agent`
- **Watch Paths:** `packages/bytebot-agent/**,packages/shared/**`

**Environment Variables (Variables tab):**
```bash
DATABASE_URL=${{Postgres.DATABASE_URL}}
BYTEBOT_DESKTOP_BASE_URL=http://bytebot-desktop.railway.internal:9990
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

Optional (add more AI providers):
```bash
OPENAI_API_KEY=sk-xxxxx
GEMINI_API_KEY=xxxxx
```

- [ ] Click **Deploy**

### 5. Deploy bytebot-ui (3 min)

- [ ] Click **New** → **GitHub Repo** → Select this repository
- [ ] **Service Name:** `bytebot-ui`

**Configure Build (Settings → Build):**
- **Builder:** Dockerfile
- **Dockerfile Path:** `Dockerfile.ui`
- **Watch Paths:** `packages/bytebot-ui/**,packages/shared/**`

**Build Variables (Settings → Variables → Add Variable → Make Build Variable):**
```bash
BYTEBOT_AGENT_BASE_URL=http://bytebot-agent.railway.internal:9991
BYTEBOT_DESKTOP_VNC_URL=ws://bytebot-desktop.railway.internal:9990/websockify
```

**Environment Variables:**
```bash
BYTEBOT_AGENT_BASE_URL=http://bytebot-agent.railway.internal:9991
BYTEBOT_DESKTOP_VNC_URL=ws://bytebot-desktop.railway.internal:9990/websockify
NEXT_PUBLIC_API_URL=http://bytebot-agent.railway.internal:9991
NODE_ENV=production
HOSTNAME=0.0.0.0
```

**Networking:**
- Enable **Public Networking** (Settings → Networking)
- Copy the generated public URL

- [ ] Click **Deploy**

### 6. Test (1 min)

- [ ] Wait for all services to show **Active** status
- [ ] Open the bytebot-ui public URL
- [ ] Create a test task (e.g., "Open Firefox and search for Railway")
- [ ] Watch the desktop stream execute the task

## Service Names Matter!

Railway's internal DNS uses exact service names. If you used different names, update these environment variables:

```bash
# In bytebot-agent:
BYTEBOT_DESKTOP_BASE_URL=http://YOUR-DESKTOP-SERVICE-NAME.railway.internal:9990

# In bytebot-ui:
BYTEBOT_AGENT_BASE_URL=http://YOUR-AGENT-SERVICE-NAME.railway.internal:9991
BYTEBOT_DESKTOP_VNC_URL=ws://YOUR-DESKTOP-SERVICE-NAME.railway.internal:9990/websockify
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Desktop build timeout | Use Pro plan (free tier has build time limits) |
| Agent can't connect | Check service names match exactly |
| UI shows "connecting..." | Wait for desktop to fully start (check logs) |
| Out of memory | Increase desktop RAM to 4GB |

## Cost Estimate (Pro Plan)

- **Plan:** $20/month
- **Usage:** ~$30-60/month for moderate use
  - Desktop: ~$20-40/month (2GB RAM, always-on)
  - Agent + UI: ~$5-10/month
  - Database: ~$5-10/month
- **Total:** ~$50-80/month

Optimize costs by:
- Stopping desktop service when not in use
- Using Hobby plan for testing ($5/month)
- Monitoring usage in Railway dashboard

## Next Steps

- [ ] Add custom domain (Settings → Networking → Custom Domain)
- [ ] Set up environment-specific deployments (dev/staging/prod)
- [ ] Configure monitoring and alerts
- [ ] Review [full deployment guide](RAILWAY_DEPLOYMENT.md)

## Support

- 📚 [Full Guide](RAILWAY_DEPLOYMENT.md)
- 🚂 [Railway Docs](https://docs.railway.app/)
- 💬 [Railway Discord](https://discord.gg/railway)
- 🤖 [Bytebot Discord](https://discord.com/invite/d9ewZkWPTP)
