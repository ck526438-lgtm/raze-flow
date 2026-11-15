FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY examples ./examples
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5678 RAZE_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:5678/api/health || exit 1
CMD ["node", "src/server.js"]
