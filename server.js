const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const dbConfig = {
  host: "srv657.hstgr.io",
  user: "u442108067_mydb",
  password: "mOhe6ln0iP>",
  database: "u442108067_mydb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);
let adminOnline = false;
const users = {};

async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(50) NOT NULL,
        sender_id VARCHAR(50) NOT NULL,
        receiver_id VARCHAR(50),
        driver_id VARCHAR(50),
        customer_id VARCHAR(50),
        text TEXT,
        timestamp DATETIME NOT NULL,
        sender_type ENUM('user', 'support', 'admin') NOT NULL,
        INDEX (sender_id),
        INDEX (receiver_id),
        INDEX (driver_id),
        INDEX (customer_id),
        INDEX (timestamp)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS media_uploads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(50) NOT NULL,
        driver_id VARCHAR(50),
        customer_id VARCHAR(50),
        file_name VARCHAR(255) NOT NULL,
        file_url TEXT NOT NULL,
        media_type ENUM('image', 'video', 'gif', 'file') NOT NULL,
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (message_id),
        INDEX (driver_id),
        INDEX (customer_id)
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

  socket.on('register', (userType, userName, userId) => {
    users[socket.id] = {
      type: userType,
      name: userName || `User-${socket.id.slice(0, 4)}`,
      userId,
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
      userId: user.userId,
    }));
    io.emit('onlineUsers', onlineUsers);
  });

  socket.on('joinChat', ({ chatId, userType, userId }) => {
    users[socket.id] = {
      type: userType,
      name: userType === 'admin' ? 'Admin' : userType === 'driver' ? `Driver-${userId.slice(0, 4)}` : `Customer-${userId.slice(0, 4)}`,
      userId: chatId,
    };
    socket.join(chatId);
    console.log(`User ${userType} joined chat:`, chatId);
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      userId: user.userId,
    }));
    io.emit('onlineUsers', onlineUsers);
  });

  socket.on('sendMessage', async (message) => {
    console.log('Message received:', message);
    const messageId = message.id || `msg-${Date.now()}`;
    const messageWithTimestamp = {
      ...message,
      id: messageId,
      timestamp: new Date().toISOString(),
      senderId: socket.id,
      senderName: users[socket.id]?.name || 'Unknown',
      sender: users[socket.id]?.type,
      sender_type: users[socket.id]?.type,
    };

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        'INSERT INTO messages (message_id, sender_id, receiver_id, driver_id, customer_id, text, timestamp, sender_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          messageWithTimestamp.id,
          socket.id,
          messageWithTimestamp.receiverId,
          messageWithTimestamp.driverId,
          messageWithTimestamp.customerId,
          messageWithTimestamp.text || '',
          messageWithTimestamp.timestamp,
          messageWithTimestamp.sender_type,
        ]
      );
      await connection.commit();
      console.log('Message saved to database');
    } catch (error) {
      await connection.rollback();
      console.error('Error saving message:', error);
      return;
    } finally {
      connection.release();
    }

    if (messageWithTimestamp.receiverId) {
      if (users[messageWithTimestamp.receiverId]) {
        io.to(messageWithTimestamp.receiverId).emit('receiveMessage', messageWithTimestamp);
      } else if (messageWithTimestamp.receiverId === 'admin') {
        io.to('admin').emit('receiveMessage', messageWithTimestamp);
      } else if (messageWithTimestamp.driverId) {
        const driverSocket = Object.entries(users).find(
          ([id, user]) => user.userId === messageWithTimestamp.driverId && user.type === 'driver'
        );
        if (driverSocket) {
          io.to(driverSocket[0]).emit('receiveMessage', messageWithTimestamp);
        }
      } else if (messageWithTimestamp.customerId) {
        const customerSocket = Object.entries(users).find(
          ([id, user]) => user.userId === messageWithTimestamp.customerId && user.type === 'user'
        );
        if (customerSocket) {
          io.to(customerSocket[0]).emit('receiveMessage', messageWithTimestamp);
        }
      } else {
        io.emit('receiveMessage', messageWithTimestamp);
      }
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
    delete users[socket.id];
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      userId: user.userId,
    }));
    io.emit('onlineUsers', onlineUsers);
    console.log(`User disconnected. Remaining users:`, Object.keys(users).length);
  });
});

app.get('/api/messages/:userId', async (req, res) => {
  try {
    console.log('Fetching messages for user:', req.params.userId);
    const [messages] = await pool.query(
      `SELECT m.*,
       CASE
         WHEN m.sender_id = 'admin' THEN 'support'
         ELSE m.sender_type
       END as sender,
       m.sender_type
       FROM messages m
       WHERE m.driver_id = ? OR m.customer_id = ?
       ORDER BY m.timestamp ASC`,
      [req.params.userId, req.params.userId]
    );
    if (messages.length === 0) {
      return res.json([]);
    }
    const messageIds = messages.map(msg => msg.message_id);
    const [mediaRows] = await pool.query(
      `SELECT * FROM media_uploads WHERE message_id IN (?) ORDER BY upload_time ASC`,
      [messageIds]
    );
    const mediaMap = {};
    mediaRows.forEach(media => {
      if (!mediaMap[media.message_id]) {
        mediaMap[media.message_id] = [];
      }
      mediaMap[media.message_id].push(media);
    });
    const messagesWithMedia = messages.map(message => ({
      ...message,
      media: mediaMap[message.message_id] || [],
    }));
    res.json(messagesWithMedia);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
