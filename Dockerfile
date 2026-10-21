FROM node:18-slim

# opencode CLI (pinned to the version verified with this bridge)
RUN npm i -g @opencode/cli@2.0.29 && opencode --version

WORKDIR /app
COPY bridge-koyeb.mjs start.sh ./
RUN chmod +x start.sh

# Koyeb routes public traffic to $PORT (defaults to 4200, see service config)
CMD ["./start.sh"]
