FROM node:22-alpine
WORKDIR /app

# ก๊อป package.json ก่อนแล้วค่อย npm install
# แยกขั้นแบบนี้ทำให้ Docker cache ชั้น npm install ไว้ได้
# แก้ index.js แล้ว build ใหม่จะเร็วมากเพราะไม่ต้องลง dependency ซ้ำ
COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001
CMD ["node", "index.js"]