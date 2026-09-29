FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @clouddeck/shared && npm run build -w @clouddeck/web
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["npm","run","start","-w","@clouddeck/web"]
