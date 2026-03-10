const wsClients = new Set();

export function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of wsClients) {
    try { client.send(msg); } catch { wsClients.delete(client); }
  }
}

export function registerWsRoute(app) {
  app.get("/ws", { websocket: true }, (socket) => {
    wsClients.add(socket);
    socket.on("close", () => wsClients.delete(socket));
    socket.send(JSON.stringify({ event: "connected", ts: Date.now() }));
  });
}
