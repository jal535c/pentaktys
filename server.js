const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    socket.on('player_ready', (playerName) => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const player1 = waitingPlayer;
            const player2 = socket;

            const roomId = `room_${Date.now()}`;
            player1.join(roomId);
            player2.join(roomId);

            // El servidor genera una semilla aleatoria para que ambos tableros sean idénticos
            const boardSeed = Math.random();

            const gameData = {
                roomId: roomId,
                player1Name: player1.playerName,
                player2Name: player2.playerName,
                boardSeed: boardSeed
            };

            io.to(player1.id).emit('game_start', gameData, 1);
            io.to(player2.id).emit('game_start', gameData, 2);

            waitingPlayer = null;
        } else {
            socket.playerName = playerName;
            waitingPlayer = socket;
        }
    });

    socket.on('make_move', (moveData) => {
        socket.to(moveData.roomId).emit('opponent_move', moveData);
    });

    socket.on('restart_game', (roomId) => {
        // Avisar a ambos en la sala para que reinicien
        io.to(roomId).emit('game_restart');
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Pentaktys corriendo en http://localhost:${PORT}`);
});