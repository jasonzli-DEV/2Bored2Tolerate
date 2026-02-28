FROM node:22-alpine

LABEL maintainer="jasonzli-DEV"
LABEL name="2bored2tolerate"
LABEL description="Modern queue proxy for 2b2t.org"

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Expose ports: web dashboard + minecraft proxy
EXPOSE 8080/tcp
EXPOSE 25565/tcp

# Run with node directly (no npm overhead)
CMD ["node", "src/index.js"]
