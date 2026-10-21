FROM node:18-slim

RUN npm i -g @opencode/cli@2.0.29

WORKDIR /app
COPY bridge-koyeb.mjs start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
