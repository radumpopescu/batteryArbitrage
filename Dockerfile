FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5174

COPY server.js ./
COPY public ./public

EXPOSE 5174

CMD ["node", "server.js"]
