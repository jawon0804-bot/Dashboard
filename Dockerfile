# Node 18은 2025-04-30에 EOL(보안 패치 종료)이라 22 LTS로 올림.
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
# npm install이 아니라 npm ci — package-lock.json을 그대로 재현해서 설치한다.
# (install은 락파일을 무시하고 새 버전을 끌어올 수 있어 "내 PC에선 되는데" 상황을 만든다)
RUN npm ci --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
