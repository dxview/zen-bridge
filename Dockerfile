FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists \
 && npm i -g @opencode/cli@2.0.29

WORKDIR /app
COPY bridge-koyeb.mjs start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
