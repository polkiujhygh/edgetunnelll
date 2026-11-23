# Dockerfile — fallback build path for Hostless if Railpack auto-detection fails.
# Railpack usually detects Node.js automatically from package.json. This
# Dockerfile is here so that if you toggle "Build with Docker" in Hostless
# Configuration > Build, the build still works.

FROM node:20-slim

WORKDIR /app

# Copy project files
COPY package.json server.js ./
COPY _worker.js ./
COPY img.png ./
COPY README.md LICENSE CHANGELOG ./

# No runtime dependencies to install — uses Node built-in
# Request/Response/Headers/fetch (Node 20+).
RUN npm install --omit=dev --no-audit --no-fund || true

ENV NODE_ENV=production
ENV HOST=0.0.0.0
# PORT is injected by Hostless at runtime; we set a default for local dev.
ENV PORT=8080

EXPOSE 8080

# Use dumb-init if available for clean signal handling; fall back to node.
CMD ["node", "server.js"]
