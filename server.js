const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let waitingPlayer = null;

// Función para generar el tablero en el servidor
function generateBoard() {
    const uniqueColors = ['morado', 'rojo', 'verde', 'azul', 'naranja'];
    
    let firstRow = [...uniqueColors].sort(() => Math.random() - 0.5);
    let fifthRow = [...firstRow].reverse();
    
    let bag = [];
    uniqueColors.forEach(c => { for(let i=0; i<8; i++) bag.push(c); });
    
    firstRow.forEach(c => { let i = bag.indexOf(c); if(i !== -1) bag.splice(i, 1); });
    fifthRow.forEach(c => { let i = bag.indexOf(c); if(i !== -1) bag.splice(i, 1); });
    
    bag.sort(() => Math.random() - 0.5);
    
    let board = [firstRow];
    for (let r = 0; r < 3; r++) {
        let row = [];
        for (let c = 0; c < 5; c++) row.push(bag.pop());
        board.push(row);
    }
    board.push(fifthRow);
    
    return board;
}

io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    socket.on('player_ready', (playerName) => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const player1 = waitingPlayer;
            const player2 = socket;

            const roomId = `room_${Date.now()}`;
            player1.join(roomId);
            player2.join(roomId);

            const gameData = {
                roomId: roomId,
                player1Name: player1.playerName,
                player2Name: player2.playerName,
                board: generateBoard()
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

    socket.on('restart_game', (data) => {
        // Generar nuevo tablero y enviar datos completos a ambos jugadores
        const newBoard = generateBoard();
        const payload = {
            board: newBoard,
            player1Name: data.player1Name,
            player2Name: data.player2Name
        };
        // Emitir a TODOS en la sala (ambos clientes)
        io.to(data.roomId).emit('game_restart', payload);
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