FROM node:20-alpine

WORKDIR /app

COPY api/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY api/server.js ./server.js
COPY students-db.js ./students-db.js

EXPOSE 3000
CMD ["npm", "start"]
