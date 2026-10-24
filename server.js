const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const COLORS = ['morado', 'rojo', 'verde', 'azul', 'naranja'];
const MAX_MOVES = 15;
const NAME_MAX_LENGTH = 12;
const RESTART_COOLDOWN_MS = 800;
const DISCONNECT_GRACE_MS = 30000;

/* ------------------------------------------------------------------ */
/* Tablero y estado de partida                                         */
/* ------------------------------------------------------------------ */

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Funcion para generar el tablero en el servidor (una sola vez por partida)
function generateBoard() {
    const firstRow = shuffle([...COLORS]);
    const fifthRow = [...firstRow].reverse();

    const bag = [];
    COLORS.forEach(c => { for (let i = 0; i < 8; i++) bag.push(c); });

    firstRow.forEach(c => { let i = bag.indexOf(c); if (i !== -1) bag.splice(i, 1); });
    fifthRow.forEach(c => { let i = bag.indexOf(c); if (i !== -1) bag.splice(i, 1); });

    shuffle(bag);

    const board = [firstRow];
    for (let r = 0; r < 3; r++) {
        const row = [];
        for (let c = 0; c < 5; c++) row.push(bag.pop());
        board.push(row);
    }
    board.push(fifthRow);

    return board;
}

// Estado inicial completo: colores + fichas + turno + movimientos restantes
function createInitialState() {
    const pieces = [];
    for (let c = 0; c < 5; c++) pieces.push({ row: 0, col: c, player: 1 });
    for (let c = 0; c < 5; c++) pieces.push({ row: 4, col: c, player: 2 });

    return {
        board: generateBoard(),
        pieces: pieces,
        empty: [],
        currentTurn: 1,
        movesLeft: MAX_MOVES
    };
}

/* ------------------------------------------------------------------ */
/* Reglas del juego (la unica fuente de verdad)                        */
/* ------------------------------------------------------------------ */

// Desplazamientos permitidos para cada color
const MOVE_RULES = {
    morado: [[1, 0], [0, 1]],        // 1 casilla ortogonal
    rojo: [[2, 0], [0, 2]],          // 2 casillas ortogonales (salta)
    azul: [[1, 1]],                  // 1 casilla diagonal
    verde: [[2, 2]],                 // 2 casillas diagonales (salta)
    naranja: [[2, 1], [1, 2]]        // forma de L
};

function isValidMove(colorName, fromRow, fromCol, toRow, toCol) {
    const moves = MOVE_RULES[colorName];
    if (!moves) return false;

    const dr = Math.abs(toRow - fromRow);
    const dc = Math.abs(toCol - fromCol);
    if (dr === 0 && dc === 0) return false;

    return moves.some(([mr, mc]) => dr === mr && dc === mc);
}

function getPieceAt(state, row, col) {
    return state.pieces.find(p => p.row === row && p.col === col) || null;
}

function isConsumed(state, row, col) {
    return state.empty.some(([r, c]) => r === row && c === col);
}

// Devuelve null si el movimiento es legal o el motivo del rechazo
function validateMove(state, role, move) {
    if (!move || !isIndex(move.fromRow) || !isIndex(move.fromCol) ||
        !isIndex(move.toRow) || !isIndex(move.toCol)) {
        return 'Coordenadas invÃ¡lidas';
    }
    if (role !== state.currentTurn) {
        return 'No es tu turno';
    }

    const piece = getPieceAt(state, move.fromRow, move.fromCol);
    if (!piece || piece.player !== role) {
        return 'Esa ficha no es tuya';
    }
    if (isConsumed(state, move.toRow, move.toCol)) {
        return 'Esa casilla ya no existe';
    }

    const target = getPieceAt(state, move.toRow, move.toCol);
    if (target && target.player === role) {
        return 'No puedes capturar tu propia ficha';
    }

    const color = state.board[move.fromRow][move.fromCol];
    if (!isValidMove(color, move.fromRow, move.fromCol, move.toRow, move.toCol)) {
        return 'Ese color no se mueve asÃ­';
    }

    return null;
}

// Aplica un movimiento ya validado sobre el estado
function applyMove(state, move) {
    const piece = getPieceAt(state, move.fromRow, move.fromCol);
    const captured = getPieceAt(state, move.toRow, move.toCol);

    if (captured) {
        state.pieces = state.pieces.filter(p => p !== captured);
    }

    piece.row = move.toRow;
    piece.col = move.toCol;

    // Al salir de una casilla con el contador a 0, la casilla desaparece
    let consumedCell = null;
    if (state.movesLeft === 0 && !isConsumed(state, move.fromRow, move.fromCol)) {
        state.empty.push([move.fromRow, move.fromCol]);
        consumedCell = { row: move.fromRow, col: move.fromCol };
    }

    if (state.movesLeft > 0) state.movesLeft--;
    state.currentTurn = otherRole(state.currentTurn);

    return {
        captured: captured ? { row: captured.row, col: captured.col, player: captured.player } : null,
        consumedCell: consumedCell
    };
}

function hasValidMoves(state, player) {
    const pieces = state.pieces.filter(p => p.player === player);

    for (const piece of pieces) {
        const color = state.board[piece.row][piece.col];
        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
                if (r === piece.row && c === piece.col) continue;
                if (isConsumed(state, r, c)) continue;
                if (!isValidMove(color, piece.row, piece.col, r, c)) continue;

                const target = getPieceAt(state, r, c);
                if (!target || target.player !== player) return true;
            }
        }
    }

    return false;
}

// Devuelve { winner, reason } si la partida terminó, o null si sigue
function checkGameEnd(state) {
    const p1Pieces = state.pieces.filter(p => p.player === 1).length;
    const p2Pieces = state.pieces.filter(p => p.player === 2).length;

    if (p1Pieces === 0) return { winner: 2, reason: 'sin-fichas' };
    if (p2Pieces === 0) return { winner: 1, reason: 'sin-fichas' };
    if (!hasValidMoves(state, state.currentTurn)) {
        return { winner: otherRole(state.currentTurn), reason: 'sin-movimientos' };
    }

    return null;
}

/* ------------------------------------------------------------------ */
/* Partidas en curso                                                   */
/* ------------------------------------------------------------------ */

// roomId -> { id, names, tokens, socketIds, state, disconnectTimers, lastRestartAt }
const games = new Map();
// token de jugador (persistente por pestaña) -> roomId
const tokenToRoom = new Map();
// socket.id -> { roomId, role }
const socketGames = new Map();
// jugador esperando rival: { socket, name, token }
let waitingPlayer = null;

function cleanName(value) {
    const name = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return name.slice(0, NAME_MAX_LENGTH);
}

function cleanToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

function isIndex(value) {
    return Number.isInteger(value) && value >= 0 && value < 5;
}

function buildPayload(game, role) {
    return {
        roomId: game.id,
        role: role,
        player1Name: game.names[1],
        player2Name: game.names[2],
        board: game.state.board,
        pieces: game.state.pieces,
        empty: game.state.empty,
        currentTurn: game.state.currentTurn,
        movesLeft: game.state.movesLeft,
        status: game.status,
        winner: game.winner,
        seq: game.seq,
        lastMove: game.lastMove
    };
}

function otherRole(role) {
    return role === 1 ? 2 : 1;
}

function getSocket(socketId) {
    return socketId ? io.sockets.sockets.get(socketId) : null;
}

function clearDisconnectTimer(game, role) {
    if (game.disconnectTimers[role]) {
        clearTimeout(game.disconnectTimers[role]);
        game.disconnectTimers[role] = null;
    }
}

function removeGame(game) {
    clearDisconnectTimer(game, 1);
    clearDisconnectTimer(game, 2);
    [1, 2].forEach(role => {
        const token = game.tokens[role];
        if (token) tokenToRoom.delete(token);
        const socketId = game.socketIds[role];
        if (socketId) socketGames.delete(socketId);
    });
    games.delete(game.id);
}

// Vincula un socket a un hueco de la partida (sirve para entrar y para reconectar)
function attachPlayer(game, role, socket, name) {
    const previousId = game.socketIds[role];
    const previous = previousId && previousId !== socket.id ? getSocket(previousId) : null;

    game.names[role] = name;
    game.socketIds[role] = socket.id;
    socket.playerName = name;
    socketGames.set(socket.id, { roomId: game.id, role: role });

    const token = socket.playerToken;
    if (token) {
        if (game.tokens[role] && game.tokens[role] !== token) tokenToRoom.delete(game.tokens[role]);
        game.tokens[role] = token;
        tokenToRoom.set(token, game.id);
    }

    clearDisconnectTimer(game, role);
    socket.join(game.id);

    // Si el jugador abrió otra pestaña/dispositivo con la misma sesion, cerramos la vieja
    if (previous) {
        socketGames.delete(previous.id);
        previous.leave(game.id);
        previous.disconnect(true);
    }
}

function startGame(player1Socket, player1Name, player2Socket, player2Name) {
    const roomId = 'room_' + crypto.randomUUID();
    const game = {
        id: roomId,
        names: { 1: player1Name, 2: player2Name },
        tokens: { 1: null, 2: null },
        socketIds: { 1: null, 2: null },
        state: createInitialState(),
        status: 'playing',
        winner: null,
        seq: 0,
        lastMove: null,
        disconnectTimers: { 1: null, 2: null },
        lastRestartAt: 0
    };

    games.set(roomId, game);
    attachPlayer(game, 1, player1Socket, player1Name);
    attachPlayer(game, 2, player2Socket, player2Name);

    player1Socket.emit('game_start', buildPayload(game, 1));
    player2Socket.emit('game_start', buildPayload(game, 2));

    return game;
}

function sendState(game, role) {
    const target = getSocket(game.socketIds[role]);
    if (target) target.emit('game_state', buildPayload(game, role));
}

function emitToBoth(game, event, data) {
    [1, 2].forEach(role => {
        const target = getSocket(game.socketIds[role]);
        if (target) target.emit(event, data);
    });
}

function broadcastState(game) {
    [1, 2].forEach(role => {
        const target = getSocket(game.socketIds[role]);
        if (target) target.emit('game_state', buildPayload(game, role));
    });
}

// El jugador abandona de forma explicita ("Salir")
function abandonGame(socket) {
    const entry = socketGames.get(socket.id);
    socketGames.delete(socket.id);
    if (!entry) return;

    const game = games.get(entry.roomId);
    if (!game) return;

    if (game.socketIds[entry.role] === socket.id) {
        game.socketIds[entry.role] = null;
    }
    socket.leave(game.id);

    const rival = getSocket(game.socketIds[otherRole(entry.role)]);
    if (rival) rival.emit('opponent_left');

    removeGame(game);
}

/* ------------------------------------------------------------------ */
/* Socket.io                                                           */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    socket.on('player_ready', (payload) => {
        const data = payload && typeof payload === 'object' ? payload : {};
        const name = cleanName(typeof payload === 'string' ? payload : data.name);
        const token = cleanToken(data.token);

        if (!name) {
            socket.emit('name_required');
            return;
        }

        // Ya esta dentro de una partida: le devolvemos el estado actual
        const current = socketGames.get(socket.id);
        if (current) {
            const game = games.get(current.roomId);
            if (game) {
                sendState(game, current.role);
                return;
            }
            socketGames.delete(socket.id);
        }

        // Si su sesion ya estaba en una partida, la retoma (p. ej. recargó la pagina)
        if (token) {
            const roomId = tokenToRoom.get(token);
            const game = roomId ? games.get(roomId) : null;
            if (game) {
                const role = game.tokens[1] === token ? 1 : game.tokens[2] === token ? 2 : 0;
                if (role) {
                    socket.playerToken = token;
                    socket.playerName = name;
                    attachPlayer(game, role, socket, name);
                    sendState(game, role);
                    return;
                }
                tokenToRoom.delete(token);
            }
        }

        socket.playerName = name;
        socket.playerToken = token;

        if (waitingPlayer && waitingPlayer.socket.id !== socket.id && waitingPlayer.socket.connected) {
            const rival = waitingPlayer;
            waitingPlayer = null;
            startGame(rival.socket, rival.name, socket, name);
        } else {
            waitingPlayer = { socket: socket, name: name, token: token };
            socket.emit('waiting');
        }
    });

    // Reconexion (socket.io reconecta solo): devolvemos el estado completo
    socket.on('rejoin', (payload) => {
        const token = cleanToken(payload && payload.token);
        const roomId = token ? tokenToRoom.get(token) : null;
        const game = roomId ? games.get(roomId) : null;

        if (!game) {
            socket.emit('rejoin_failed');
            return;
        }

        const role = game.tokens[1] === token ? 1 : game.tokens[2] === token ? 2 : 0;
        if (!role) {
            socket.emit('rejoin_failed');
            return;
        }

        socket.playerToken = token;
        socket.playerName = game.names[role];
        attachPlayer(game, role, socket, game.names[role]);
        sendState(game, role);
    });

    // El cliente manda solo la intencion; el servidor valida, aplica y reparte el estado
    socket.on('make_move', (moveData) => {
        const entry = socketGames.get(socket.id);
        if (!entry) return;

        const game = games.get(entry.roomId);
        if (!game) return;

        if (game.status !== 'playing') {
            socket.emit('move_rejected', {
                reason: game.status === 'finished' ? 'La partida ya terminÃ³' : 'La partida no estÃ¡ activa',
                state: buildPayload(game, entry.role)
            });
            return;
        }

        const move = {
            fromRow: moveData && moveData.fromRow,
            fromCol: moveData && moveData.fromCol,
            toRow: moveData && moveData.toRow,
            toCol: moveData && moveData.toCol
        };

        const error = validateMove(game.state, entry.role, move);
        if (error) {
            socket.emit('move_rejected', {
                reason: error,
                state: buildPayload(game, entry.role)
            });
            return;
        }

        const result = applyMove(game.state, move);
        game.seq++;
        game.lastMove = {
            fromRow: move.fromRow,
            fromCol: move.fromCol,
            toRow: move.toRow,
            toCol: move.toCol,
            player: entry.role,
            captured: result.captured,
            consumedCell: result.consumedCell
        };

        const end = checkGameEnd(game.state);
        if (end) {
            game.status = 'finished';
            game.winner = end.winner;
        }

        broadcastState(game);

        if (end) {
            emitToBoth(game, 'game_over', { winnerRole: end.winner, reason: end.reason });
        }
    });

    socket.on('restart_game', () => {
        const entry = socketGames.get(socket.id);
        if (!entry) return;

        const game = games.get(entry.roomId);
        if (!game) return;

        // Evita que dos pulsaciones simultaneas generen dos tableros distintos
        const now = Date.now();
        if (now - game.lastRestartAt < RESTART_COOLDOWN_MS) return;
        game.lastRestartAt = now;

        // Un unico tablero, guardado en el servidor y enviado a los dos jugadores
        game.state = createInitialState();
        game.status = 'playing';
        game.winner = null;
        game.lastMove = null;
        game.seq++;

        [1, 2].forEach(role => {
            const target = getSocket(game.socketIds[role]);
            if (target) target.emit('game_restart', buildPayload(game, role));
        });
    });

    socket.on('leave_game', (ack) => {
        abandonGame(socket);
        if (typeof ack === 'function') ack();
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
            waitingPlayer = null;
        }

        const entry = socketGames.get(socket.id);
        socketGames.delete(socket.id);
        if (!entry) return;

        const game = games.get(entry.roomId);
        if (!game) return;

        // Socket viejo (el jugador ya se reconectó con otro id)
        if (game.socketIds[entry.role] !== socket.id) return;

        game.socketIds[entry.role] = null;
        clearDisconnectTimer(game, entry.role);

        // Damos margen para que vuelva (redes móviles, pantalla bloqueada, etc.)
        game.disconnectTimers[entry.role] = setTimeout(() => {
            const currentGame = games.get(entry.roomId);
            if (!currentGame) return;
            if (currentGame.socketIds[entry.role]) return; // volvió a tiempo

            const rival = getSocket(currentGame.socketIds[otherRole(entry.role)]);
            if (rival) rival.emit('opponent_left');

            removeGame(currentGame);
        }, DISCONNECT_GRACE_MS);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Pentaktys corriendo en http://localhost:${PORT}`);
});
