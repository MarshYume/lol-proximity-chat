const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// Map<roomCode, Map<socketId, { name, team, position }>>
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomCode, summonerName }) => {
    currentRoom = roomCode;
    socket.join(roomCode);

    if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
    rooms.get(roomCode).set(socket.id, { name: summonerName, team: null, position: null });

    // Envoie au nouveau joueur la liste des joueurs déjà présents
    const existing = [];
    rooms.get(roomCode).forEach((p, id) => {
      if (id !== socket.id) existing.push({ socketId: id, name: p.name });
    });
    socket.emit('existing-players', existing);

    // Notifie les joueurs existants de l'arrivée du nouveau
    socket.to(roomCode).emit('player-joined', { socketId: socket.id, name: summonerName });

    console.log(`[${roomCode}] ${summonerName} a rejoint (${rooms.get(roomCode).size} joueurs)`);
  });

  socket.on('position-update', ({ position, team }) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    if (room.has(socket.id)) {
      const p = room.get(socket.id);
      p.position = position;
      p.team = team;
    }
    // Diffuse les positions de TOUS les joueurs de la room (même sans équipe connue)
    const positions = {};
    room.forEach((p, id) => {
      positions[id] = { name: p.name, team: p.team, position: p.position };
    });
    io.to(currentRoom).emit('positions-update', positions);
  });

  // Relais de signalisation WebRTC entre pairs
  socket.on('signal', ({ targetId, signal }) => {
    io.to(targetId).emit('signal', { fromId: socket.id, signal });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const name = rooms.get(currentRoom).get(socket.id)?.name ?? socket.id;
      rooms.get(currentRoom).delete(socket.id);
      if (rooms.get(currentRoom).size === 0) rooms.delete(currentRoom);
      else io.to(currentRoom).emit('player-left', { socketId: socket.id });
      console.log(`[${currentRoom}] ${name} a quitté`);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Serveur proximity chat sur le port ${PORT}`));
