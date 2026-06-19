# ════════════════════════════════════════════════════════════════
#  TactixGlobalMCT — Node server + Open MCT front-end
# ════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim

# Native build deps for better-sqlite3 (fallback if no prebuilt binary)
# + ffmpeg for the RTSP→MJPEG stream proxy.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (layer cache). Includes `openmct` (prebuilt dist).
COPY package*.json ./
RUN npm install --omit=dev

# App source (node_modules is excluded via .dockerignore).
COPY . .

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server/index.js"]
