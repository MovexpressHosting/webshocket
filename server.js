const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// MySQL Configuration
const dbConfig = {
  host: "srv657.hstgr.io",
  user: "u442108067_mydb",
  password: "mOhe6ln0iP>",
  database: "u442108067_mydb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Create MySQL connection pool
const pool = mysql.createPool(dbConfig);

// Track online status and users
let adminOnline = false;
const users = {}; // { socketId: { type: 'user'|'admin', name: string, driverId?: string } }

// Create messages table if not exists
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(50) NOT NULL,
        sender_id VARCHAR(50) NOT NULL,
        receiver_id VARCHAR(50),
        driver_id VARCHAR(50) NOT NULL,
        text TEXT,
        timestamp DATETIME NOT NULL,
        sender_type ENUM('user', 'support') NOT NULL,
        media_data JSON,
        INDEX (sender_id),
        INDEX (receiver_id),
        INDEX (driver_id),
        INDEX (timestamp)
      )
    `);
    console.log("Database initialized");
  } catch (error) {
    console.error("Database initialization error:", error);
  } finally {
    connection.release();
  }
}

initializeDatabase();

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('register', (userType, userName, driverId) => {
    users[socket.id] = {
      type: userType,
      name: userName || `User-${socket.id.slice(0, 4)}`,
      driverId,
    };
    console.log(`User registered as ${userType}:`, socket.id, users[socket.id].name);
    socket.join(userType);
    if (userType === 'admin') {
      adminOnline = true;
      io.emit('adminStatus', true);
    }
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    io.emit('onlineUsers', onlineUsers);
  });

  // New event to get driver's socket ID
  socket.on('getDriverSocketId', (driverId, callback) => {
    const driverSocket = Object.entries(users).find(
      ([id, user]) => user.driverId === driverId && user.type === 'user'
    );
    if (driverSocket) {
      callback(driverSocket[0]); // Return the socket ID
    } else {
      callback(null); // Driver not found or offline
    }
  });

  // Handle manual driver disconnection
  socket.on('disconnectUser', (driverId) => {
    console.log('Manual driver disconnection:', driverId);
    
    // Find all sockets for this driver
    const driverSockets = Object.entries(users).filter(
      ([id, user]) => user.driverId === driverId && user.type === 'user'
    );
    
    // Remove all driver sockets
    driverSockets.forEach(([socketId, user]) => {
      console.log(`Removing driver socket: ${socketId} for driver: ${driverId}`);
      delete users[socketId];
      
      // Force disconnect the socket
      const driverSocket = io.sockets.sockets.get(socketId);
      if (driverSocket) {
        driverSocket.disconnect(true);
      }
    });
    
    // Update online users list
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    io.emit('onlineUsers', onlineUsers);
    
    console.log(`Driver ${driverId} manually disconnected. Remaining users:`, Object.keys(users).length);
  });

  socket.on('sendMessage', async (message) => {
    console.log('Message received:', message);
    const { receiverId, driverId, media, ...rest } = message;
    
    const messageWithTimestamp = {
      ...rest,
      id: `msg-${Date.now()}`,
      timestamp: new Date().toISOString(),
      senderId: socket.id,
      senderName: users[socket.id]?.name || 'Unknown',
      sender: users[socket.id]?.type === 'admin' ? 'support' : 'user',
      sender_type: users[socket.id]?.type === 'admin' ? 'support' : 'user',
      driverId: message.driverId || users[socket.id]?.driverId,
      media: media || null,
    };

    try {
      const connection = await pool.getConnection();
      await connection.query(
        'INSERT INTO messages (message_id, sender_id, receiver_id, driver_id, text, timestamp, sender_type, media_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          messageWithTimestamp.id,
          socket.id,
          receiverId,
          messageWithTimestamp.driverId,
          messageWithTimestamp.text,
          messageWithTimestamp.timestamp,
          messageWithTimestamp.sender_type,
          media ? JSON.stringify(media) : null,
        ]
      );
      connection.release();
    } catch (error) {
      console.error('Error saving message:', error);
    }

    // Route the message to the correct receiver
    if (receiverId) {
      if (users[receiverId]) {
        io.to(receiverId).emit('receiveMessage', messageWithTimestamp);
      } else if (receiverId === 'admin') {
        io.to('admin').emit('receiveMessage', messageWithTimestamp);
      } else if (messageWithTimestamp.driverId) {
        // If receiverId is not set but driverId is, find the driver's socket
        const driverSocket = Object.entries(users).find(
          ([id, user]) => user.driverId === messageWithTimestamp.driverId && user.type === 'user'
        );
        if (driverSocket) {
          io.to(driverSocket[0]).emit('receiveMessage', messageWithTimestamp);
        }
      }
    } else {
      io.emit('receiveMessage', messageWithTimestamp);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
    
    const disconnectedUser = users[socket.id];
    
    if (disconnectedUser?.type === 'admin') {
      adminOnline = false;
      io.emit('adminStatus', false);
      console.log('Admin went offline');
    }
    
    // Remove user from tracking
    delete users[socket.id];
    
    // Update online users list
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    io.emit('onlineUsers', onlineUsers);
    
    console.log(`User disconnected. Remaining users:`, Object.keys(users).length);
  });
});

// API endpoint to fetch old messages
app.get('/api/messages/:driverId', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT *,
       CASE
         WHEN sender_id = 'admin' THEN 'support'
         ELSE 'user'
       END as sender,
       sender_type,
       media_data
       FROM messages
       WHERE driver_id = ?
       ORDER BY timestamp ASC`,
      [req.params.driverId]
    );
    
    // Parse media_data from JSON string
    const messagesWithMedia = rows.map(row => ({
      ...row,
      media: row.media_data ? JSON.parse(row.media_data) : null
    }));
    
    res.json(messagesWithMedia);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '0.0.0.0';
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  const localIp = getLocalIpAddress();
  console.log(`Socket.IO server running at:`);
  console.log(`- Local:   http://localhost:${PORT}`);
  console.log(`- Network: http://${localIp}:${PORT}`);
});
