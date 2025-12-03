# syntax=docker/dockerfile:1

FROM node:22-alpine

WORKDIR /app

# Copy application files (no dependencies needed)
COPY package.json server.js ./

# Environment variables are provided at runtime via -e or .env file mounting
EXPOSE 3000

CMD ["node", "server.js"]
