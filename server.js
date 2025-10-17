const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Load word lists from JSON files
const wordLists = {
  'en': require('./wordlists/english.json'),
  'sv': require('./wordlists/swedish.json')
};

// Game data
const rooms = new Map();
const players = new Map();

class GameRoom {
  constructor(roomId, host, roomName, language = 'en') {
    this.id = roomId;
    this.name = roomName;
    this.language = language;
    this.players = new Map();
    this.host = host.id;
    this.hostPlayer = host;
    this.gameState = null;
    this.status = 'waiting';
    this.createdAt = Date.now();
    this.maxPlayers = 8;
    
    this.addPlayer(host);
  }

  addPlayer(player) {
    if (this.players.size >= this.maxPlayers) {
      throw new Error('Room is full');
    }
    
    this.players.set(player.id, player);
    player.room = this.id;
    
    this.broadcastToRoom('player_joined', {
      player: this.serializePlayer(player),
      players: this.getSerializedPlayers(),
      host: this.host
    });

    this.broadcastRoomListUpdate();
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      this.players.delete(playerId);
      
      if (this.host === playerId && this.players.size > 0) {
        const newHostId = Array.from(this.players.keys())[0];
        this.host = newHostId;
        this.hostPlayer = this.players.get(newHostId);
      }
      
      this.broadcastToRoom('player_left', {
        playerId: playerId,
        players: this.getSerializedPlayers(),
        host: this.host
      });

      if (this.players.size === 0) {
        rooms.delete(this.id);
      }

      this.broadcastRoomListUpdate();
    }
  }
  
  startGame() {
    if (this.status !== 'waiting' || this.players.size < 2) return false;

    this.status = 'playing';
    this.gameState = {
      currentRound: 0,
      currentPlayerIndex: -1,
      currentWord: '',
      timer: 60,
      scores: {},
      drawingPlayerId: null,
      usedWords: [],
      canvasData: null,
      startTime: Date.now()
    };

    this.players.forEach((player, id) => {
      this.gameState.scores[id] = 0;
    });

    this.broadcastToRoom('game_started', {
      gameState: this.gameState
    });

    this.startNewRound();
    this.broadcastRoomListUpdate();
    return true;
  }

  resetGame() {
    this.status = 'waiting';
    this.gameState = null;
    
    this.broadcastToRoom('game_reset', {
      players: this.getSerializedPlayers()
    });

    this.broadcastRoomListUpdate();
  }

  startNewRound() {
    this.gameState.currentPlayerIndex = (this.gameState.currentPlayerIndex + 1) % this.players.size;
    const playerIds = Array.from(this.players.keys());
    const drawingPlayerId = playerIds[this.gameState.currentPlayerIndex];
    
    this.gameState.drawingPlayerId = drawingPlayerId;
    this.gameState.currentWord = this.getRandomWord();
    this.gameState.canvasData = null;
    this.gameState.timer = 60;

    console.log(`New round - Drawing player: ${drawingPlayerId}, Word: ${this.gameState.currentWord}`);

    this.broadcastToRoom('new_round', {
      drawingPlayerId: drawingPlayerId,
      currentWord: this.gameState.currentWord,
      gameState: this.gameState
    });

    this.startTimer();
  }

  startTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = setInterval(() => {
      // Check if game state still exists (game might have ended)
      if (!this.gameState || this.status !== 'playing') {
        clearInterval(this.timerInterval);
        return;
      }
      
      this.gameState.timer--;
      
      this.broadcastToRoom('timer_update', {
        timer: this.gameState.timer
      });

      if (this.gameState.timer <= 0) {
        clearInterval(this.timerInterval);
        this.endRound();
      }
    }, 1000);
  }

  endRound() {
    this.broadcastToRoom('round_ended', {
      word: this.gameState.currentWord
    });

    setTimeout(() => {
      this.startNewRound();
    }, 3000);
  }

  handleGuess(playerId, guess) {
    if (this.status !== 'playing') return;
    if (playerId === this.gameState.drawingPlayerId) return;

    const guessLower = guess.toLowerCase().trim();
    const wordLower = this.gameState.currentWord.toLowerCase();

    if (guessLower === wordLower) {
      const drawingPlayer = this.players.get(this.gameState.drawingPlayerId);
      const guessingPlayer = this.players.get(playerId);

      if (!drawingPlayer || !guessingPlayer) return;

      const timeBonus = Math.floor(this.gameState.timer / 10) * 10;
      const drawingPlayerPoints = 40 + timeBonus;
      const guessingPlayerPoints = 30 + timeBonus;

      this.gameState.scores[this.gameState.drawingPlayerId] += drawingPlayerPoints;
      this.gameState.scores[playerId] += guessingPlayerPoints;

      this.broadcastToRoom('correct_guess', {
        guessingPlayer: this.serializePlayer(guessingPlayer),
        drawingPlayer: this.serializePlayer(drawingPlayer),
        guessingPlayerPoints: guessingPlayerPoints,
        drawingPlayerPoints: drawingPlayerPoints,
        scores: this.gameState.scores
      });

      this.checkForWinner();

      clearInterval(this.timerInterval);
      setTimeout(() => {
        this.startNewRound();
      }, 3000);
    }
  }

  checkForWinner() {
    const WINNING_SCORE = 1000;
    
    for (const [playerId, score] of Object.entries(this.gameState.scores)) {
      if (score >= WINNING_SCORE) {
        const winner = this.players.get(playerId);
        if (winner) {
          this.broadcastToRoom('game_ended', {
            winner: this.serializePlayer(winner),
            winnerScore: score
          });
          this.status = 'finished';
          if (this.timerInterval) {
            clearInterval(this.timerInterval);
          }
          this.broadcastRoomListUpdate();
        }
        break;
      }
    }
  }

  updateCanvas(canvasData) {
    if (!this.gameState) return;
    
    this.gameState.canvasData = canvasData;
    
    this.broadcastToRoom('canvas_updated', {
      canvasData: canvasData
    }, this.gameState.drawingPlayerId);
  }

  getRandomWord() {
    const words = wordLists[this.language] || wordLists['en'];
    let availableWords = words.filter(word => !this.gameState.usedWords.includes(word));
    if (availableWords.length === 0) {
      this.gameState.usedWords = [];
      availableWords = words;
    }

    const word = availableWords[Math.floor(Math.random() * availableWords.length)];
    this.gameState.usedWords.push(word);
    return word;
  }

  broadcastToRoom(event, data, excludePlayerId = null) {
    this.players.forEach((player, playerId) => {
      if (playerId !== excludePlayerId && player.socket) {
        try {
          player.socket.emit(event, data);
        } catch (error) {
          console.error('Error sending message to player:', error);
        }
      }
    });
  }

  broadcastRoomListUpdate() {
    const availableRooms = getAvailableRooms();
    
    players.forEach((player) => {
      if (player.socket) {
        try {
          player.socket.emit('room_list_updated', {
            rooms: availableRooms
          });
        } catch (error) {
          console.error('Error sending room list update:', error);
        }
      }
    });
  }

  getSerializedPlayers() {
    return Array.from(this.players.values()).map(player => this.serializePlayer(player));
  }

  serializePlayer(player) {
    return {
      id: player.id,
      name: player.name,
      isHost: player.id === this.host
    };
  }

  serialize() {
    const hostPlayer = this.players.get(this.host);
    return {
      id: this.id,
      name: this.name,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
      status: this.status,
      language: this.language,
      host: hostPlayer ? hostPlayer.name : 'Unknown'
    };
  }
}

// Helper functions
function generatePlayerId() {
  return 'player_' + Math.random().toString(36).substring(2, 15);
}

function getAvailableRooms() {
  return Array.from(rooms.values())
    .filter(room => room.status === 'waiting')
    .map(room => room.serialize());
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  let currentPlayer = null;

  // Send initial room list
  socket.emit('room_list_updated', {
    rooms: getAvailableRooms()
  });

  socket.on('create_room', (data) => {
    handleCreateRoom(socket, data);
  });

  socket.on('join_room', (data) => {
    handleJoinRoom(socket, data);
  });

  socket.on('start_game', (data) => {
    handleStartGame(socket, data);
  });

  socket.on('reset_game', (data) => {
    handleResetGame(socket, data);
  });

  socket.on('send_message', (data) => {
    handleSendMessage(socket, data);
  });

  socket.on('update_canvas', (data) => {
    handleUpdateCanvas(socket, data);
  });

  socket.on('clear_canvas', (data) => {
    handleClearCanvas(socket, data);
  });

  socket.on('get_rooms', (data) => {
    handleGetRooms(socket, data);
  });

  socket.on('leave_room', (data) => {
    handleLeaveRoom(socket, data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    if (currentPlayer) {
      const room = rooms.get(currentPlayer.room);
      if (room) {
        room.removePlayer(currentPlayer.id);
      }
      players.delete(currentPlayer.id);
    }
  });

  function handleCreateRoom(socket, data) {
    const { playerName, roomName, language = 'en' } = data;
    
    if (!playerName) {
      socket.emit('error', {
        message: 'Name is required'
      });
      return;
    }

    const roomId = uuidv4();
    const player = {
      id: generatePlayerId(),
      name: playerName,
      socket: socket,
      room: roomId
    };

    players.set(player.id, player);
    currentPlayer = player;

    const room = new GameRoom(roomId, player, roomName || `${playerName}'s room`, language);
    rooms.set(roomId, room);

    socket.emit('room_created', {
      room: room.serialize(),
      player: room.serializePlayer(player),
      players: room.getSerializedPlayers()
    });

    console.log(`Room ${roomId} created by ${playerName} in ${language}`);
  }

  function handleJoinRoom(socket, data) {
    const { roomId, playerName } = data;
    
    if (!roomId || !playerName) {
      socket.emit('error', {
        message: 'Room ID and player name are required'
      });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', {
        message: 'Room not found'
      });
      return;
    }

    if (room.status !== 'waiting') {
      socket.emit('error', {
        message: 'Game has already started'
      });
      return;
    }

    try {
      const player = {
        id: generatePlayerId(),
        name: playerName,
        socket: socket,
        room: roomId
      };

      players.set(player.id, player);
      currentPlayer = player;

      room.addPlayer(player);

      socket.emit('room_joined', {
        room: room.serialize(),
        player: room.serializePlayer(player),
        players: room.getSerializedPlayers(),
        host: room.host
      });

      console.log(`Player ${playerName} joined room ${roomId}`);
    } catch (error) {
      socket.emit('error', {
        message: error.message
      });
    }
  }

  function handleGetRooms(socket, data) {
    socket.emit('room_list_updated', {
      rooms: getAvailableRooms()
    });
  }

  function handleStartGame(socket, data) {
    if (!currentPlayer) return;

    const room = rooms.get(currentPlayer.room);
    if (!room) {
      socket.emit('error', {
        message: 'Not in a room'
      });
      return;
    }

    if (room.host !== currentPlayer.id) {
      socket.emit('error', {
        message: 'Only the host can start the game'
      });
      return;
    }

    const success = room.startGame();
    if (!success) {
      socket.emit('error', {
        message: 'At least 2 players needed to start'
      });
    }
  }

  function handleResetGame(socket, data) {
    if (!currentPlayer) return;

    const room = rooms.get(currentPlayer.room);
    if (!room || room.host !== currentPlayer.id) {
      socket.emit('error', {
        message: 'Only the host can reset the game'
      });
      return;
    }

    room.resetGame();
  }

  function handleSendMessage(socket, data) {
    if (!currentPlayer) return;

    const { message } = data;
    const room = rooms.get(currentPlayer.room);
    
    if (room) {
      room.broadcastToRoom('chat_message', {
        player: room.serializePlayer(currentPlayer),
        message: message,
        timestamp: Date.now()
      });

      if (room.status === 'playing' && currentPlayer.id !== room.gameState.drawingPlayerId) {
        room.handleGuess(currentPlayer.id, message);
      }
    }
  }

  function handleUpdateCanvas(socket, data) {
    if (!currentPlayer) return;

    const { canvasData } = data;
    const room = rooms.get(currentPlayer.room);
    
    if (room && room.status === 'playing' && currentPlayer.id === room.gameState.drawingPlayerId) {
      room.updateCanvas(canvasData);
    }
  }

  function handleClearCanvas(socket, data) {
    if (!currentPlayer) return;

    const room = rooms.get(currentPlayer.room);
    
    if (room && room.status === 'playing' && currentPlayer.id === room.gameState.drawingPlayerId) {
      room.updateCanvas(null);
    }
  }

  function handleLeaveRoom(socket, data) {
    if (!currentPlayer) return;

    const room = rooms.get(currentPlayer.room);
    if (room) {
      room.removePlayer(currentPlayer.id);
    }
    players.delete(currentPlayer.id);
    currentPlayer = null;

    socket.emit('left_room', {});
  }
  
});

// Clean up old rooms every hour
setInterval(() => {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  
  for (const [id, room] of rooms.entries()) {
    if (now - room.createdAt > ONE_HOUR && room.players.size === 0) {
      rooms.delete(id);
      console.log(`Cleaned up old room: ${id}`);
    }
  }
}, 60 * 60 * 1000);

// Start server
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to play the game`);
});