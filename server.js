const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir los archivos de la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    // Cuando un jugador se registra con su nombre
    socket.on('player_ready', (playerName) => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            // Hay un rival esperando, creamos la partida
            const player1 = waitingPlayer;
            const player2 = socket;

            const roomId = `room_${Date.now()}`;
            player1.join(roomId);
            player2.join(roomId);

            // Asignar roles: El primero que entró (player1) es Blancas
            const gameData = {
                roomId: roomId,
                player1: { id: player1.id, name: player1.playerName, role: 1 },
                player2: { id: player2.id, name: player2.playerName, role: 2 }
            };

            io.to(player1.id).emit('game_start', gameData, 1);
            io.to(player2.id).emit('game_start', gameData, 2);

            waitingPlayer = null; // Limpiar la sala de espera
        } else {
            // No hay rival, lo ponemos a esperar
            socket.playerName = playerName;
            waitingPlayer = socket;
        }
    });

    // Recibir y reenviar movimientos de tablero
    socket.on('make_move', (moveData) => {
        // Enviar a todos en la sala EXCEPTO al que hizo el movimiento
        socket.to(moveData.roomId).emit('opponent_move', moveData);
    });

    // Manejar desconexiones
    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
        // Aquí se podría avisar al rival de que el jugador abandonó (opcional)
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Pentaktys corriendo en http://localhost:${PORT}`);
});