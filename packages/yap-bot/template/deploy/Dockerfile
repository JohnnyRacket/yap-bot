# docker build -f deploy/Dockerfile -t Yappy .     (from the project root)
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# the default engines' models (~1 GB): their own layer, so changing the agent doesn't fetch them again
ENV MODELS_DIR=/models
RUN npx yap-bot models --defaults
COPY agent agent
# anything the agent's voice needs beyond the defaults (other Kokoro voices, another model)
RUN npx yap-bot models agent
ENV NODE_ENV=production PORT=8450 DATA_DIR=/data WATCH=0
VOLUME /data
EXPOSE 8450
CMD ["node_modules/.bin/yap-bot", "start", "agent"]
