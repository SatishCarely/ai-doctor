FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY . .
COPY kyc-templates/ ./kyc-templates/

EXPOSE 3000

CMD ["node", "server.js"]