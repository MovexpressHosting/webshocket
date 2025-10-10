const express = require('express'); // changes
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
  },
  pingTimeout: 60000,
  pingInterval: 25000
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
const driverSockets = new Map();

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
        text TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        sender_type ENUM('user', 'support') NOT NULL,
        INDEX (sender_id),
        INDEX (receiver_id),
        INDEX (driver_id),
        INDEX (timestamp)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS media_uploads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(50) NOT NULL,
        driver_id VARCHAR(50) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_url VARCHAR(255) NOT NULL,
        media_type ENUM('image', 'video', 'gif', 'file') NOT NULL,
        upload_time DATETIME NOT NULL,
        file_size INT,
        mime_type VARCHAR(100),
        INDEX (message_id),
        INDEX (driver_id)
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
    
    if (userType === 'user' && driverId) {
      driverSockets.set(driverId, socket.id);
    }
    
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

  socket.on('getDriverSocketId', (driverId, callback) => {
    const driverSocket = Object.entries(users).find(
      ([id, user]) => user.driverId === driverId && user.type === 'user'
    );
    if (driverSocket) {
      callback(driverSocket[0]);
    } else {
      callback(null);
    }
  });

  socket.on('disconnectUser', (driverId) => {
    console.log('Manual driver disconnection:', driverId);
    const driverSockets = Object.entries(users).filter(
      ([id, user]) => user.driverId === driverId && user.type === 'user'
    );
    driverSockets.forEach(([socketId, user]) => {
      console.log(`Removing driver socket: ${socketId} for driver: ${driverId}`);
      delete users[socketId];
      const driverSocket = io.sockets.sockets.get(socketId);
      if (driverSocket) {
        driverSocket.disconnect(true);
      }
    });
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    io.emit('onlineUsers', onlineUsers);
    console.log(`Driver ${driverId} manually disconnected. Remaining users:`, Object.keys(users).length);
  });

  socket.on('sendMessage', async (message, callback) => {
  console.log('Message received:', message);
  const { id, receiverId, driverId, text, media, sender_type } = message;
  const messageWithTimestamp = {
    message_id: id,
    sender_id: socket.id,
    receiver_id: receiverId,
    driver_id: driverId,
    text: text || '',
    timestamp: new Date().toISOString(),
    sender_type: sender_type,
  };

  let connection;
  try {
    connection = await pool.getConnection();
    
    await connection.query(
      'INSERT INTO messages (message_id, sender_id, receiver_id, driver_id, text, timestamp, sender_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        messageWithTimestamp.message_id,
        messageWithTimestamp.sender_id,
        messageWithTimestamp.receiver_id,
        messageWithTimestamp.driver_id,
        messageWithTimestamp.text,
        messageWithTimestamp.timestamp,
        messageWithTimestamp.sender_type,
      ]
    );

    if (media && media.length > 0) {
      for (const item of media) {
        const [existingMedia] = await connection.query(
          'SELECT id FROM media_uploads WHERE message_id = ? AND file_url = ?',
          [messageWithTimestamp.message_id, item.file_url]
        );

        if (existingMedia.length === 0) {
          await connection.query(
            'INSERT INTO media_uploads (message_id, driver_id, file_name, file_url, media_type, upload_time, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              messageWithTimestamp.message_id,
              messageWithTimestamp.driver_id,
              item.file_name,
              item.file_url,
              item.media_type,
              messageWithTimestamp.timestamp,
              item.file_size,
              item.mime_type,
            ]
          );
          console.log('Inserted new media record:', item.file_name);
        } else {
          console.log('Media already exists, skipping insert:', item.file_name);
        }
      }
    }

    if (callback) {
      callback({ success: true, message: 'Message delivered' });
    }
  } catch (error) {
    console.error('Error saving message or media:', error);
    if (callback) {
      callback({ success: false, error: 'Failed to save message' });
    }
    return;
  } finally {
    if (connection) connection.release();
  }

  let messageDelivered = false;

  if (receiverId) {
    if (users[receiverId]) {
      io.to(receiverId).emit('receiveMessage', message);
      messageDelivered = true;
    } else if (receiverId === 'admin') {
      io.to('admin').emit('receiveMessage', message);
      messageDelivered = true;
    }
  }

  if (messageWithTimestamp.driver_id) {
    const driverSocketId = driverSockets.get(messageWithTimestamp.driver_id);
    if (driverSocketId && users[driverSocketId]) {
      io.to(driverSocketId).emit('receiveMessage', message);
      messageDelivered = true;
      console.log(`Message delivered to driver ${messageWithTimestamp.driver_id} via socket ${driverSocketId}`);
    } else {
      console.log(`Driver ${messageWithTimestamp.driver_id} not found online, storing message in database`);
    }
  }

  if (!messageDelivered) {
    io.emit('receiveMessage', message);
  }
});

  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
    const disconnectedUser = users[socket.id];
    
    if (disconnectedUser?.type === 'user' && disconnectedUser.driverId) {
      driverSockets.delete(disconnectedUser.driverId);
    }
    
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
      driverId: user.driverId,
    }));
    io.emit('onlineUsers', onlineUsers);
    console.log(`User disconnected. Remaining users:`, Object.keys(users).length);
  });
});

app.get('/api/messages/:driverId', async (req, res) => {
  try {
    const [messageRows] = await pool.query(
      `SELECT *,
       CASE
         WHEN sender_id = 'admin' THEN 'support'
         ELSE 'user'
       END as sender,
       sender_type
       FROM messages
       WHERE driver_id = ?
       ORDER BY timestamp ASC`,
      [req.params.driverId]
    );
    const messagesWithMedia = await Promise.all(messageRows.map(async (message) => {
      const [mediaRows] = await pool.query(
        'SELECT * FROM media_uploads WHERE message_id = ?',
        [message.message_id]
      );
      return {
        ...message,
        media: mediaRows
      };
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
