# The System — production image. Works on Fly, Render, Railway, or any container host.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install production deps only, exactly as locked (socket.io-client is a test-only devDependency).
COPY package.json package-lock.json ./
# npm can exit 0 after a network hiccup with packages missing; fail the build instead of
# shipping an image that crash-loops on boot.
RUN npm ci --omit=dev && npm cache clean --force \
 && node -e "require('express'); require('socket.io'); require('qrcode')"

COPY . .
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app/data

# The app reads PORT from the environment; platforms set it. Default 3000 for local Docker.
ENV PORT=3000
EXPOSE 3000

# Persist the room snapshot on a writable volume if the platform provides one:
# set STATE_FILE=/data/rooms-state.json and mount a volume at /data for durable games.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
