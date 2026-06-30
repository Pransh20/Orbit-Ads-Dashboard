# Orbit deployment on Oracle VM

Target domain:

```txt
https://orbit.ixclabs.com
```

Oracle VM public IP:

```txt
141.148.207.54
```

This deployment is additive. It does not edit the existing `tc.elitecollection.net.in` Nginx config. Orbit runs in Docker on local port `4100`, and Nginx proxies `orbit.ixclabs.com` to it.

## 1. GoDaddy DNS

In GoDaddy DNS for `ixclabs.com`, add:

```txt
Type: A
Name: orbit
Value: 141.148.207.54
TTL: default or 600 seconds
```

Wait until DNS resolves:

```bash
dig +short orbit.ixclabs.com
```

Expected:

```txt
141.148.207.54
```

## 2. Oracle Cloud security list / NSG

Make sure inbound traffic is allowed to the VM for:

```txt
TCP 80
TCP 443
```

Do not open `4100` publicly. The Docker compose file binds it to `127.0.0.1` only.

## 3. Clone the repo on the VM

```bash
cd /opt
sudo git clone git@github.com:Pransh20/Orbit-Ads-Dashboard.git orbit-ads-dashboard
sudo chown -R opc:opc /opt/orbit-ads-dashboard
cd /opt/orbit-ads-dashboard
```

If SSH deploy keys are not set up on the VM, use HTTPS instead:

```bash
sudo git clone https://github.com/Pransh20/Orbit-Ads-Dashboard.git orbit-ads-dashboard
```

## 4. Create production env

```bash
cp .env.production.example .env.production
nano .env.production
```

Set strong values for:

```txt
POSTGRES_PASSWORD
DATABASE_URL
JWT_SECRET
TOKEN_ENCRYPTION_KEY
META_APP_ID
META_APP_SECRET
OPENAI_API_KEY
```

Make sure these stay as:

```txt
CLIENT_URL=https://orbit.ixclabs.com
META_REDIRECT_URI=https://orbit.ixclabs.com/api/meta/callback
```

Keep this false until the publishing route is deliberately enabled and tested:

```txt
PUBLISHING_ENABLED=false
```

## 5. Start Orbit

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Check status:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f orbit
```

Seed the first local admin user once:

```bash
docker compose -f docker-compose.prod.yml exec orbit npm --prefix server run prisma:seed
```

Default seeded login:

```txt
Email: maya@acmestudio.com
Password: password123
```

Change this password immediately after logging in.

## 6. Add Nginx config

Create a new Nginx file. Do not edit the existing `maloo.conf`.

```bash
sudo nano /etc/nginx/conf.d/orbit.ixclabs.com.conf
```

Paste:

```nginx
server {
    server_name orbit.ixclabs.com;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
    }

    listen 80;
}
```

Test Nginx:

```bash
sudo nginx -t
```

Reload only if the test passes:

```bash
sudo systemctl reload nginx
```

At this point, `http://orbit.ixclabs.com` should load.

## 7. Add HTTPS with Certbot

Run:

```bash
sudo certbot --nginx -d orbit.ixclabs.com
```

Choose the redirect-to-HTTPS option when prompted.

Re-test:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Then open:

```txt
https://orbit.ixclabs.com
```

## 8. Meta app settings

In Meta for Developers:

App Domains:

```txt
ixclabs.com
orbit.ixclabs.com
```

Website URL:

```txt
https://orbit.ixclabs.com/
```

Valid OAuth Redirect URI:

```txt
https://orbit.ixclabs.com/api/meta/callback
```

Production privacy/app review URLs should also live on HTTPS before review.

## 9. Updating deployment later

```bash
cd /opt/orbit-ads-dashboard
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f orbit
```

