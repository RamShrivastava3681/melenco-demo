#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════
# VPS Deployment Script — excel.frillchills.com
# ═══════════════════════════════════════════════════
# Run on your VPS **after** uploading the project files.
# Tested on Ubuntu 22.04 / Debian 12.
# ═══════════════════════════════════════════════════

APP_DIR="/var/www/excel.frillchills.com"
DOMAIN="excel.frillchills.com"

echo "==> 1. Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx

echo "==> 2. Installing Node.js 22 (LTS)..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> 3. Installing PM2 globally..."
sudo npm install -g pm2

echo "==> 4. Creating app directory..."
sudo mkdir -p "$APP_DIR/html"
sudo chown -R "$USER:$USER" "$APP_DIR"

echo "==> 5. Setting up backend..."
cd "$APP_DIR/backend"
npm ci --omit=dev
npm run build
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"

echo "==> 6. Building frontend..."
cd "$APP_DIR/frontend"
npm ci
npm run build
# Copy built frontend to nginx serve directory
cp -r dist/* "$APP_DIR/html/"

echo "==> 7. Setting up nginx..."
sudo cp "$APP_DIR/deploy/nginx-vps.conf" /etc/nginx/sites-available/"$DOMAIN"
sudo ln -sf /etc/nginx/sites-available/"$DOMAIN" /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

echo "==> 8. Obtaining SSL certificate..."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@"$DOMAIN"

echo "==> 9. Starting backend with PM2..."
cd "$APP_DIR"
# ⚠️  Edit ecosystem.config.cjs and set JWT_SECRET to a strong random value first!
pm2 start ecosystem.config.cjs
pm2 save
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "/home/$USER"

echo ""
echo "✅ Deployment complete!"
echo "   Visit https://$DOMAIN"
echo ""
echo "⚠️  Next steps:"
echo "   1. Edit ecosystem.config.cjs and set JWT_SECRET to a random string"
echo "      (run: openssl rand -hex 32)"
echo "   2. Run: pm2 restart ledgerly-backend"
echo "   3. Check logs: pm2 logs ledgerly-backend"
