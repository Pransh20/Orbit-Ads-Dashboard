FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
COPY client/package*.json client/
COPY server/package*.json server/

RUN npm run install:all

COPY client client
COPY server server

RUN npm --prefix server run prisma:generate
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/server/package*.json server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/src/prisma server/src/prisma
COPY --from=build /app/client/dist client/dist

RUN mkdir -p uploads

EXPOSE 4000

CMD ["sh", "-c", "npm --prefix server run prisma:deploy && npm --prefix server run start"]
