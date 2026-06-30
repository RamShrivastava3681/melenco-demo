# Ledgerly — VPS Deployment Guide

> Deploy Ledgerly on a VPS with **nginx** (frontend) and **PM2** (backend).

**Domain:** `excel.frillchills.com`
**Stack:** React + Vite (frontend), Express + sql.js (backend)

---

## 1. Prerequisites on Your VPS

```bash
# System packages
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot python3-certbot-nginx git

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Verify
node -v
npm -v
pm2 -v
nginx -v
```

---

## 2. Upload Project Files

Choose one method:

### Option A — Git Clone
```bash
sudo mkdir -p /var/www/excel.frillchills.com
sudo chown -R $USER:$USER /var/www/excel.frillchills.com
cd /var/www/excel.frillchills.com
git clone <your-repo-url> .
```

### Option B — SCP from Local Machine
```bash
# From your local machine:
scp -r /path/to/InvoiceFlow user@your-vps:/var/www/excel.frillchills.com/
```

---

## 3. Build the Backend

```bash
cd /var/www/excel.frillchills.com/backend
npm ci
npm run build
```

**What this does:**
- Installs production dependencies (`npm ci`)
- Compiles TypeScript from `src/` → `dist/`
- Output: `backend/dist/index.js` (entry point for PM2)

Verify the build:
```bash
ls -la dist/
# Should see: index.js, db/, middleware/, routes/
```

---

## 4. Build the Frontend

```bash
cd /var/www/excel.frillchills.com/frontend
npm ci
npm run build
```

**What this does:**
- Installs all dependencies
- Type-checks with `tsc -b` then bundles with `vite build`
- Output: `frontend/dist/` → contains `index.html` + `assets/`

Verify the build:
```bash
ls -la dist/
# Should see: index.html, assets/
```

---

## 5. Set Up Environment Variables

### Backend — edit `ecosystem.config.cjs`

**File:** `/var/www/excel.frillchills.com/ecosystem.config.cjs`

```js
env: {
  NODE_ENV: "production",
  PORT: "3004",
  JWT_SECRET: "<generate this>",           // ← REQUIRED: set a strong random value
  DATABASE_URL: "./data/ledgerly.db",
  FRONTEND_URL: "https://excel.frillchills.com",
}
```

Generate a JWT secret:
```bash
openssl rand -hex 32
```

### Frontend — no manual .env needed on VPS

When the frontend is served behind nginx (same domain), API requests go to `/api/...` and nginx proxies them to the backend. The `VITE_URL` in `frontend/.env` is only needed if the frontend and backend are on **different domains**.

---

## 6. Set Up Nginx

### Copy the production config

```bash
sudo cp /var/www/excel.frillchills.com/deploy/nginx-vps.conf /etc/nginx/sites-available/excel.frillchills.com
sudo ln -sf /etc/nginx/sites-available/excel.frillchills.com /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

### Test and reload

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Copy frontend build to nginx serve directory

```bash
# Create the directory if it doesn't exist
sudo mkdir -p /var/www/excel.frillchills.com/html
sudo chown -R $USER:$USER /var/www/excel.frillchills.com/html

# Copy the built frontend
cp -r /var/www/excel.frillchills.com/frontend/dist/* /var/www/excel.frillchills.com/html/
```

---

## 7. Set Up SSL with Certbot

```bash
sudo certbot --nginx -d excel.frillchills.com --non-interactive --agree-tos -m admin@excel.frillchills.com
```

Certbot automatically updates the nginx config to:
- Redirect HTTP → HTTPS (port 80 → 443)
- Add SSL certificate paths
- Set up auto-renewal

Verify auto-renewal works:
```bash
sudo certbot renew --dry-run
```

---

## 8. Create Data and Log Directories

```bash
mkdir -p /var/www/excel.frillchills.com/data
mkdir -p /var/www/excel.frillchills.com/logs
```

---

## 9. Start the Backend with PM2

```bash
cd /var/www/excel.frillchills.com
pm2 start ecosystem.config.cjs
pm2 save
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u $USER --hp /home/$USER
```

### Useful PM2 commands

| Command | What it does |
|---|---|
| `pm2 logs ledgerly-backend` | View real-time logs |
| `pm2 status` | Show all running processes |
| `pm2 restart ledgerly-backend` | Restart the backend |
| `pm2 stop ledgerly-backend` | Stop the backend |
| `pm2 reload ecosystem.config.cjs` | Reload config after edits |
| `pm2 restart all` | Restart all PM2 processes |

---

## 10. Verify Deployment

```bash
# Check nginx is running
sudo systemctl status nginx

# Check PM2 is running
pm2 status

# Check backend logs
pm2 logs ledgerly-backend --lines 20

# Test API health
curl https://excel.frillchills.com/api/health

# Visit in browser
# → https://excel.frillchills.com
```

---

## 11. Re-deploying After Code Changes

```bash
cd /var/www/excel.frillchills.com

# Pull latest code
git pull

# Rebuild backend
cd backend && npm run build && cd ..

# Rebuild frontend
cd frontend && npm run build && cd ..

# Copy frontend to nginx directory
cp -r frontend/dist/* html/

# Restart backend
pm2 restart ledgerly-backend
```

Or use the included deploy script:
```bash
bash deploy/setup.sh
```

---

## Project Structure (Build Outputs)

```
/var/www/excel.frillchills.com/
├── backend/
│   ├── dist/                    ← Built by: npm run build (in backend/)
│   │   ├── index.js             ← PM2 entry point
│   │   ├── db/index.js
│   │   ├── middleware/auth.js
│   │   └── routes/
│   │       ├── auth.js
│   │       ├── customers.js
│   │       ├── invoices.js
│   │       ├── payments.js
│   │       └── allocations.js
│   └── node_modules/
├── frontend/
│   ├── dist/                    ← Built by: npm run build (in frontend/)
│   │   ├── index.html
│   │   └── assets/
│   │       ├── index-*.js
│   │       └── index-*.css
│   └── node_modules/
├── html/                        ← Copied from frontend/dist/ for nginx
│   ├── index.html
│   └── assets/
├── data/                        ← SQLite database stored here
│   └── ledgerly.db
├── logs/                        ← PM2 log files
│   ├── backend-error.log
│   └── backend-out.log
├── deploy/
│   └── nginx-vps.conf           ← Production nginx config
└── ecosystem.config.cjs         ← PM2 process config
```

---

## Architecture

```
Browser ──HTTPS──► nginx (port 443)
                      │
                      ├── /api/* ──proxy──► backend (PM2, port 3004)
                      │
                      └── /* ──serve──► frontend static files
                                          (from html/index.html)
```

Nginx handles:
- SSL termination (HTTPS)
- Serving static frontend files
- Proxying API requests to the backend
- Security headers
- Gzip compression
- Long-term caching for assets
