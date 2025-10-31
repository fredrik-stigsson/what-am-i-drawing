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
const roomStatistics = {
  total: 0,
  waiting: 0,
  playing: 0,
  finished: 0
};
const roomChatHistory = new Map();

class GameRoom {
  constructor(roomId, host, roomName, language = 'en') {
    this.id = roomId;
    this.name = roomName;
    this.language = language;
    this.players = new Map();
    this.host = host.id;
    this.hostPlayer = host;
    this.gameState = null;
    this._status = 'waiting'; // Initialize _status directly
    this.createdAt = Date.now();
    this.maxPlayers = 8;
    
    roomChatHistory.set(this.id, []);
    
    this.addPlayer(host);
    this.updateStatistics('add');
    
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
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      this.players.delete(playerId);
      
      // Add chat message about player leaving
      this.broadcastToRoom('chat_message', {
        player: { name: 'System' },
        message: `${player.name} left the game`,
        timestamp: Date.now(),
        type: 'system'
      });
      
      if (this.host === playerId && this.players.size > 0) {
        const newHostId = Array.from(this.players.keys())[0];
        this.host = newHostId;
        this.hostPlayer = this.players.get(newHostId);
        
        // Notify about new host
        this.broadcastToRoom('chat_message', {
          player: { name: 'System' },
          message: `${this.hostPlayer.name} is now the host`,
          timestamp: Date.now(),
          type: 'system'
        });
      }
      
      this.broadcastToRoom('player_left', {
        playerId: playerId,
        players: this.getSerializedPlayers(),
        host: this.host
      });

      // Check if game should end (only 1 player left)
      if (this.status === 'playing' && this.players.size <= 1) {
        this.endGameDueToInsufficientPlayers();
      } else if (this.players.size === 0) {
        this.cleanupRoom();
      } else {
        this.broadcastGlobalRoomListUpdate();
      }
    }
  }

  cleanupRoom() {
    
    // 1. Clear chat history
    if (roomChatHistory.has(this.id)) {
      roomChatHistory.delete(this.id);
    }
    
    // 2. Clear any game state intervals
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    
    // 3. Remove all players from this room
    this.players.forEach((player, playerId) => {
      player.room = null;
    });
    this.players.clear();
    
    // 4. Update statistics before removing
    this.updateStatistics('remove');
    
    // 5. Remove room from rooms map
    const wasDeleted = rooms.delete(this.id);
    
    // 6. Force garbage collection by nullifying references
    this.gameState = null;
    this.hostPlayer = null;
    
    // 7. Broadcast the updated room list
    this.broadcastGlobalRoomListUpdate();
  }

  addChatMessage(messageData) {
    const history = roomChatHistory.get(this.id) || [];
    history.push({
      ...messageData,
      timestamp: Date.now()
    });
    
    // Keep only last 100 messages to prevent memory issues
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
    
    roomChatHistory.set(this.id, history);
  }

  getChatHistory() {
    return roomChatHistory.get(this.id) || [];
  }

  updateStatistics(action) {
    switch (action) {
      case 'add':
        roomStatistics.total++;
        roomStatistics.waiting++;
        break;
      case 'statusChange':
        const oldStatus = this.previousStatus;
        const newStatus = this.status;
        
        if (oldStatus && roomStatistics[oldStatus] > 0) {
          roomStatistics[oldStatus]--;
        }
        if (roomStatistics[newStatus] >= 0) {
          roomStatistics[newStatus]++;
        }
        break;
      case 'remove':
        roomStatistics.total--;
        if (roomStatistics[this.status] > 0) {
          roomStatistics[this.status]--;
        }
        break;
    }
  }

  set status(newStatus) {
    if (this._status !== newStatus) {
      this.previousStatus = this._status;
      this._status = newStatus;
      if (this.previousStatus) {
        this.updateStatistics('statusChange');
      }
    }
  }

  get status() {
    return this._status;
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
    this.broadcastGlobalRoomListUpdate();
    return true;
  }

  resetGame() {
    this.status = 'waiting';
    this.gameState = null;
    
    this.broadcastToRoom('game_reset', {
      players: this.getSerializedPlayers()
    });

    this.broadcastGlobalRoomListUpdate();
  }

  startNewRound() {
    this.gameState.currentPlayerIndex = (this.gameState.currentPlayerIndex + 1) % this.players.size;
    const playerIds = Array.from(this.players.keys());
    const drawingPlayerId = playerIds[this.gameState.currentPlayerIndex];
    
    this.gameState.drawingPlayerId = drawingPlayerId;
    this.gameState.currentWord = this.getRandomWord();
    this.gameState.canvasData = null;
    this.gameState.timer = 60;

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
    
    // Check if anyone reached winning score
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
          this.broadcastGlobalRoomListUpdate();
          
          // Add congratulatory message
          this.broadcastToRoom('chat_message', {
            player: { name: 'System' },
            message: `🎉 ${winner.name} won the game with ${score} points! 🎉`,
            timestamp: Date.now(),
            type: 'system'
          });
        }
        break;
      }
    }
    
    // Also check if we have enough players to continue
    if (this.status === 'playing' && this.players.size <= 1) {
      this.endGameDueToInsufficientPlayers();
    }
  }

  endGameDueToInsufficientPlayers() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    
    // Find the remaining player (if any)
    let remainingPlayer = null;
    if (this.players.size === 1) {
      const playerId = Array.from(this.players.keys())[0];
      remainingPlayer = this.players.get(playerId);
    }
    
    this.broadcastToRoom('chat_message', {
      player: { name: 'System' },
      message: 'Game ended - not enough players to continue',
      timestamp: Date.now(),
      type: 'system'
    });

    this.broadcastToRoom('game_ended_early', {
      reason: 'not_enough_players',
      remainingPlayer: remainingPlayer ? this.serializePlayer(remainingPlayer) : null,
      message: remainingPlayer ? 
        `Game ended. Only ${remainingPlayer.name} remains.` : 
        'Game ended. All players have left.'
    });

    // Set status to 'finished' instead of 'waiting'
    this.status = 'finished';
    this.gameState = null;
    this.broadcastGlobalRoomListUpdate();
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

  broadcastGlobalRoomListUpdate() {
    const availableRooms = getAvailableRooms();
    const statistics = getRoomStatistics();
    
    // Broadcast to ALL connected clients using io.emit
    io.emit('room_list_updated', {
      rooms: availableRooms,
      statistics: statistics
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
      status: this.status, // Use the getter to ensure correct status
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
  // Clean up rooms with no players
  let roomsCleaned = 0;
  rooms.forEach((room, roomId) => {
    if (room.players.size === 0) {
      room.cleanupRoom();
      roomsCleaned++;
    }
  });
  
  // Only show waiting rooms (exclude playing and finished rooms)
  const availableRooms = Array.from(rooms.values())
    .filter(room => room.status === 'waiting')
    .map(room => room.serialize());

  return availableRooms;
}

// Add a function to get room statistics
function getRoomStatistics() {
  // Recalculate to ensure accuracy
  const recalculatedStats = {
    total: rooms.size,
    waiting: 0,
    playing: 0,
    finished: 0
  };

  rooms.forEach(room => {
    const status = room.status;
    if (recalculatedStats[status] >= 0) {
      recalculatedStats[status]++;
    }
  });

  // Update the global statistics
  Object.assign(roomStatistics, recalculatedStats);

  return recalculatedStats;
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  
  let currentPlayer = null;

  // Send initial room list and statistics immediately on connection
  socket.emit('room_list_updated', {
    rooms: getAvailableRooms(),
    statistics: getRoomStatistics()
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
    if (currentPlayer) {
      const room = rooms.get(currentPlayer.room);
      if (room) {
        room.removePlayer(currentPlayer.id);
      }
      players.delete(currentPlayer.id);
    }
    // Room list will auto-update via removePlayer broadcast
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

    // Broadcast room list update to ALL clients after room is fully created
    room.broadcastGlobalRoomListUpdate();
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

      // Send chat history to the joining player
      const chatHistory = room.getChatHistory();
      socket.emit('chat_history', {
        messages: chatHistory
      });

      socket.emit('room_joined', {
        room: room.serialize(),
        player: room.serializePlayer(player),
        players: room.getSerializedPlayers(),
        host: room.host
      });

      // Broadcast room list update after player is fully joined
      room.broadcastGlobalRoomListUpdate();

    } catch (error) {
      socket.emit('error', {
        message: error.message
      });
    }
  }

  function handleGetRooms(socket, data) {
    socket.emit('room_list_updated', {
      rooms: getAvailableRooms(),
      statistics: getRoomStatistics()
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
      const messageData = {
        player: room.serializePlayer(currentPlayer),
        message: message,
        timestamp: Date.now(),
        type: 'player'
      };

      // Store the message in chat history
      room.addChatMessage(messageData);

      room.broadcastToRoom('chat_message', messageData);

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

// Start server
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to play the game`);
});