# docker build -f deploy/Dockerfile -t Yappy .     (from the project root)
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# the default engines' models (~1 GB) first, by yap-bot's version alone: changing the agent or its
# other dependencies doesn't fetch them again (raise the version with yap-bot's; "models agent" below
# fetches anything a newer one needs meanwhile)
ENV MODELS_DIR=/models
RUN npx -y yap-bot@YAP_BOT_VERSION models --defaults && rm -rf ~/.npm
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY agent agent
# anything the agent's voice needs beyond the defaults (other Kokoro voices, another model)
RUN npx yap-bot models agent
ENV NODE_ENV=production PORT=8450 DATA_DIR=/data WATCH=0
VOLUME /data
EXPOSE 8450
CMD ["node_modules/.bin/yap-bot", "start", "agent"]
