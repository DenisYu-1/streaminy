FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python-is-python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci --omit=dev

RUN npm rebuild --build-from-source mediasoup

COPY server/ .
COPY client ./client

EXPOSE 3000

CMD ["npm", "start"]
