# Keymaker Cloud — the hosted multi-tenant platform.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV PORT=8080 KEYMAKER_DATA=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "src/cli.js", "cloud"]
