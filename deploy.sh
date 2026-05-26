#!/bin/bash
# Deploy script per Excel AI su VPS
# Uso: ./deploy.sh user@vps.example.com

set -e

VPS=${1:?Usage: ./deploy.sh user@vps.example.com}
REMOTE_DIR=/opt/excelai

echo "🔨 Building frontend..."
npm run build

echo "📦 Syncing files to $VPS..."
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude data/backups \
  --exclude 'server/turns/turn-*.json' \
  --exclude 'server/memory/' \
  --exclude 'server/metrics/' \
  --exclude '.*' \
  --exclude 'dist/' \
  --exclude 'bench/' \
  --exclude 'test/' \
  --exclude 'docs/wiki/raw/' \
  --exclude '.venv*/' \
  --exclude 'python_bridge/' \
  ./ "$VPS:$REMOTE_DIR/"

echo "📦 Installing dependencies..."
ssh "$VPS" "cd $REMOTE_DIR && npm ci --production"

echo "🔄 Restarting server..."
ssh "$VPS" "cd $REMOTE_DIR && pm2 restart excelai || pm2 start server/server.js --name excelai"

echo "✅ Deploy complete"
echo "🌐 https://$(echo $VPS | cut -d@ -f2 | cut -d: -f1)"
