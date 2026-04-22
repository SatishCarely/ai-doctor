FROM node:20-bullseye

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

ENV FFMPEG_PATH=/usr/bin/ffmpeg 

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev --include=optional --platform=linux --arch=x64

COPY . .
COPY kyc-templates/ ./kyc-templates/

EXPOSE 3000

CMD ["node", "start.js"]