# Railway Deployment Guide

This guide shows how to deploy Bytebot on Railway **directly from this repository** without using pre-built templates or container images.

## Overview

Bytebot consists of four services that work together:

**Important:** This is a monorepo deployment. Railway requires **manual configuration via the UI** for each service. Do not rely on auto-detection - follow the step-by-step instructions below to configure each service explicitly.

1. **PostgreSQL** - Database for tasks, messages, and summaries
2. **bytebot-agent** - NestJS backend for task orchestration and LLM integration
3. **bytebot-ui** - Next.js frontend with Express server for proxying
4. **bytebot-desktop** - Ubuntu desktop environment with XFCE, VNC, and automation tools

## Prerequisites

- Railway account ([sign up here](https://railway.app/))
- At least one AI provider API key:
  - [Anthropic Claude](https://console.anthropic.com/)
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Google Gemini](https://aistudio.google.com/app/apikey)
- Recommended Railway plan: **Pro or higher** (desktop service requires significant resources)

## Deployment Steps

### 1. Create a New Railway Project

1. Go to [railway.app](https://railway.app/) and sign in
2. Click **"New Project"**
3. Select **"Empty Project"** (we'll manually configure each service)
4. Name your project (e.g., "Bytebot Production")

### 2. Add PostgreSQL Database

1. In your Railway project, click **"New"**
2. Select **"Database"** → **"Add PostgreSQL"**
3. Railway will automatically provision a PostgreSQL instance
4. The `DATABASE_URL` environment variable will be available as `${{Postgres.DATABASE_URL}}`

### 3. Deploy bytebot-desktop Service

⚠️ **Deploy this first** - other services depend on it.

1. Click **"New"** → **"GitHub Repo"**
2. Connect your GitHub account and select this repository
3. Name the service: `bytebot-desktop` (exact name matters for internal DNS)

4. Configure build settings (Settings → Build):
   - **Builder:** Dockerfile
   - **Dockerfile Path:** `Dockerfile.desktop`
   - **Watch Paths:** `packages/bytebotd/**,packages/shared/**`

5. Add environment variables (Variables tab):
   ```
   DISPLAY=:0
   ```

6. Configure resources (Settings → Resources):
   - **Memory:** 2GB minimum (4GB recommended)
   - **CPU:** 2 vCPU minimum
   - **Disk:** 2GB minimum

7. Click **"Deploy"**

   **Note:** This service takes 5-10 minutes for initial build due to the Ubuntu desktop environment. Wait for it to be fully active before proceeding.

### 4. Deploy bytebot-agent Service

1. Click **"New"** → **"GitHub Repo"** → Select this repository
2. Name the service: `bytebot-agent`

3. Configure build settings (Settings → Build):
   - **Builder:** Dockerfile
   - **Dockerfile Path:** `Dockerfile.agent`
   - **Watch Paths:** `packages/bytebot-agent/**,packages/shared/**`

4. Add environment variables (Variables tab):
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   BYTEBOT_DESKTOP_BASE_URL=http://bytebot-desktop.railway.internal:9990
   ANTHROPIC_API_KEY=your-anthropic-api-key-here
   ```

   Optional variables:
   ```
   OPENAI_API_KEY=your-openai-api-key-here
   GEMINI_API_KEY=your-gemini-api-key-here
   ```

5. Click **"Deploy"**

### 5. Deploy bytebot-ui Service

1. Click **"New"** → **"GitHub Repo"** → Select this repository
2. Name the service: `bytebot-ui`

3. Configure build settings (Settings → Build):
   - **Builder:** Dockerfile
   - **Dockerfile Path:** `Dockerfile.ui`
   - **Watch Paths:** `packages/bytebot-ui/**,packages/shared/**`

4. Add build variables (Settings → Variables → Add Variable → Check "Build Variable"):
   ```
   BYTEBOT_AGENT_BASE_URL=http://bytebot-agent.railway.internal:9991
   BYTEBOT_DESKTOP_VNC_URL=ws://bytebot-desktop.railway.internal:9990/websockify
   ```

5. Add runtime environment variables (Variables tab):
   ```
   BYTEBOT_AGENT_BASE_URL=http://bytebot-agent.railway.internal:9991
   BYTEBOT_DESKTOP_VNC_URL=ws://bytebot-desktop.railway.internal:9990/websockify
   NEXT_PUBLIC_API_URL=http://bytebot-agent.railway.internal:9991
   NODE_ENV=production
   HOSTNAME=0.0.0.0
   ```

6. Enable public networking (Settings → Networking):
   - Toggle **"Public Networking"** ON
   - Railway will assign a public URL (e.g., `https://bytebot-ui-production.up.railway.app`)

7. Click **"Deploy"**

### 6. Verify Deployment

1. Wait for all services to show **"Active"** status
2. Click on the **bytebot-ui** service to get the public URL
3. Open the URL in your browser
4. You should see the Bytebot task interface
5. Try creating a task to verify the full stack is working

## Railway Service Discovery

Railway provides automatic service discovery via internal DNS:

- Format: `<service-name>.railway.internal:<port>`
- Examples:
  - `bytebot-agent.railway.internal:9991`
  - `bytebot-desktop.railway.internal:9990`
  - `postgres.railway.internal:5432`

Services communicate internally using these URLs, and only the UI is exposed publicly.

## Configuration Files

This repository includes Railway-specific configuration:

- `railway.json` - Root project configuration
- `packages/bytebot-agent/railway.toml` - Agent service configuration
- `packages/bytebot-ui/railway.toml` - UI service configuration
- `packages/bytebotd/railway.toml` - Desktop service configuration
- `.env.example` files in each package directory

## Troubleshooting

### Service won't start

- **Check logs:** Click on the service → "Deployments" → Select latest deployment → "View Logs"
- **Verify environment variables:** Ensure all required variables are set correctly
- **Check service names:** Internal URLs must match the exact service names in Railway

### Desktop service build timeout

- The desktop service takes 5-10 minutes to build initially
- If build fails, check the Railway plan limits (free tier may have build time restrictions)
- Upgrade to Pro plan for longer build times and better resources

### Agent can't connect to desktop

- Verify `BYTEBOT_DESKTOP_BASE_URL` uses the correct internal URL
- Ensure desktop service is deployed and active before agent starts
- Check that service name matches exactly (case-sensitive)

### UI shows "connecting..." indefinitely

- Verify all services are active and healthy
- Check UI environment variables match internal service URLs
- Open browser console (F12) to check for WebSocket connection errors
- Verify desktop service is fully started (check logs for "supervisord started")

### Database connection errors

- Ensure PostgreSQL service is active
- Verify `DATABASE_URL` is set correctly in agent service
- Check database service logs for connection issues
- For first deployment, wait for Prisma migrations to complete

### Out of memory errors

- Desktop service requires minimum 2GB RAM
- Upgrade Railway plan if on free tier
- Check resource usage in Railway dashboard
- Consider reducing desktop applications if needed

## Cost Optimization

Railway charges based on resource usage. To optimize costs:

1. **Use appropriate plan:**
   - Free trial: Limited resources, good for testing
   - Pro: $20/month + usage, recommended for production

2. **Scale resources appropriately:**
   - Agent: 512MB RAM, 0.5 vCPU sufficient
   - UI: 512MB RAM, 0.5 vCPU sufficient
   - Desktop: 2GB RAM, 2 vCPU minimum
   - Database: Use default settings

3. **Monitor usage:**
   - Check Railway dashboard regularly
   - Set up usage alerts
   - Review deployment logs for errors that cause restarts

## Security Considerations

1. **Environment Variables:**
   - Never commit API keys to version control
   - Use Railway's environment variable system
   - Rotate API keys regularly

2. **Network Security:**
   - Only UI service should be publicly accessible
   - All internal services use private Railway networking
   - Add authentication to UI if exposing to internet

3. **Database Security:**
   - Railway PostgreSQL uses encrypted connections by default
   - Database is only accessible via private network
   - Regular backups are recommended

## Advanced Configuration

### Custom Domain

1. Go to UI service → Settings → Networking
2. Click "Add Custom Domain"
3. Follow Railway's DNS configuration instructions
4. Optional: Enable Cloudflare integration for CDN/WAF

### Environment-Specific Configuration

Deploy to different Railway projects for different environments:

- **Development:** Use `development` branch, lower resources
- **Staging:** Use `staging` branch, production-like resources
- **Production:** Use `main` branch, full resources

### Adding LLM Proxy (Optional)

If you want to use the optional LiteLLM proxy:

1. Click **"New"** → **"Service"**
2. Configure:
   - **Name:** `bytebot-llm-proxy`
   - **Root Directory:** `packages/bytebot-llm-proxy`
   - **Dockerfile Path:** `packages/bytebot-llm-proxy/Dockerfile`
3. Add environment variables (your AI provider keys)
4. Update agent service:
   ```
   BYTEBOT_LLM_PROXY_URL=http://bytebot-llm-proxy.railway.internal:4000
   ```

## Monitoring and Maintenance

### View Logs

- Click on any service → "Deployments" → "View Logs"
- Logs are real-time and searchable
- Use logs to debug issues and monitor performance

### Restart Service

- Click on service → Settings → "Restart"
- Or trigger redeploy by pushing to GitHub

### Database Migrations

- Prisma migrations run automatically on agent startup
- Check agent logs for migration status
- For manual migrations, use Railway CLI or database GUI

### Scaling

Railway auto-scales within configured resource limits. To adjust:

1. Click service → Settings → Resources
2. Adjust Memory, CPU, and Replicas
3. Click "Save"
4. Service will restart with new resources

## Support

- **Railway Documentation:** https://docs.railway.app/
- **Bytebot Issues:** https://github.com/bytebot-ai/bytebot/issues
- **Railway Community:** https://discord.gg/railway
- **Bytebot Discord:** https://discord.com/invite/d9ewZkWPTP

## Next Steps

After deployment:

1. Explore the REST APIs at `/api/tasks`, `/api/messages`, etc.
2. Review the [API documentation](/docs/api-reference/introduction)
3. Join the Bytebot community on Discord
4. Share your automation workflows!
