.PHONY: dev certs build start clean db-reset deploy install

dev:
	node --watch server/server.js

install:
	bash install.sh http://localhost:3000

install-prod:
	bash install.sh https://francescodelsesto.com

certs:
	mkcert -install
	mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1

build:
	node build.js

start:
	node server/server.js

clean:
	rm -rf dist node_modules certs

db-reset:
	rm -f data/app.db
	node -e "const { getDb } = require('./server/db/init'); getDb(); console.log('DB created'); process.exit(0);"

deploy:
	rsync -avz --exclude node_modules --exclude .git --exclude data/backups ./ user@vps:/opt/excelai/
	ssh user@vps "cd /opt/excelai && npm ci --production && pm2 restart excelai"
