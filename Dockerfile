FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4173

COPY server.js ./
COPY public ./public

EXPOSE 4173

CMD ["node", "server.js"]
