# Imagen mínima de Node para servir el dashboard estático (server.js, sin deps).
# Evita la ambigüedad de detección de Nixpacks (el repo es mayormente TS/HTML).
FROM node:20-alpine

WORKDIR /app

# Solo lo necesario: el server y el dashboard.
COPY server.js ./
COPY dashboard ./dashboard

# Railway inyecta PORT; el server escucha en process.env.PORT.
EXPOSE 3000
CMD ["node", "server.js"]
