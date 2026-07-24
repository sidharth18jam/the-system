# The System — production image. Works on Railway, Fly, Render, or any container host.
FROM node:20-alpine

WORKDIR /app

# Install production deps only (socket.io-client is a devDependency, used by tests).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# The app reads PORT from the environment; platforms set it. Default 3000 for local Docker.
ENV PORT=3000
EXPOSE 3000

# Persist the room snapshot on a writable volume if the platform provides one.
# Set STATE_FILE=/data/rooms-state.json and mount a volume at /data for durable games.
CMD ["node", "server/index.js"]
