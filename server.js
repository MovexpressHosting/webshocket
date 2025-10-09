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
        driver_id VARCHAR(50) NOT NULL,
        text TEXT,
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
        file_url TEXT NOT NULL,
        media_type ENUM('image', 'video', 'gif') NOT NULL,
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
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

  socket.on('sendMessage', async (message) => {
    console.log('📨 Message received with media:', message.media?.length || 0);

    const messageId = message.id || `msg-${Date.now()}`;
    const messageWithTimestamp = {
      ...message,
      id: messageId,
      timestamp: new Date().toISOString(),
      senderId: socket.id,
      senderName: users[socket.id]?.name || 'Unknown',
      sender: users[socket.id]?.type === 'admin' ? 'support' : 'user',
      sender_type: users[socket.id]?.type === 'admin' ? 'support' : 'user',
      driverId: message.driverId || users[socket.id]?.driverId,
    };

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Save ONLY the message to database (media is already saved via PHP upload)
      await connection.query(
        'INSERT INTO messages (message_id, sender_id, receiver_id, driver_id, text, timestamp, sender_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          messageWithTimestamp.id,
          socket.id,
          messageWithTimestamp.receiverId,
          messageWithTimestamp.driverId,
          messageWithTimestamp.text || '',
          messageWithTimestamp.timestamp,
          messageWithTimestamp.sender_type,
        ]
      );

      // REMOVE THIS ENTIRE BLOCK - media is already saved via PHP upload
      // if (message.media && message.media.length > 0) {
      //     console.log('💾 Saving media files to database:', message.media.length);
      //     for (const media of message.media) {
      //         await connection.query(
      //             'INSERT INTO media_uploads (message_id, driver_id, file_name, file_url, media_type) VALUES (?, ?, ?, ?, ?)',
      //             [
      //                 messageId,
      //                 messageWithTimestamp.driverId,
      //                 media.file_name,
      //                 media.file_url,
      //                 media.media_type
      //             ]
      //         );
      //     }
      // }

      await connection.commit();
      console.log('✅ Message saved to database (media already uploaded)');

    } catch (error) {
      await connection.rollback();
      console.error('❌ Error saving message:', error);
      return;
    } finally {
      connection.release();
    }

    // Rest of your emit logic remains the same...
    if (messageWithTimestamp.receiverId) {
      if (users[messageWithTimestamp.receiverId]) {
        io.to(messageWithTimestamp.receiverId).emit('receiveMessage', messageWithTimestamp);
      } else if (messageWithTimestamp.receiverId === 'admin') {
        io.to('admin').emit('receiveMessage', messageWithTimestamp);
      } else if (messageWithTimestamp.driverId) {
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
    console.log('📡 Fetching messages for driver:', req.params.driverId);

    const [messages] = await pool.query(
      `SELECT m.*,
       CASE
         WHEN m.sender_id = 'admin' THEN 'support'
         ELSE 'user'
       END as sender,
       m.sender_type
       FROM messages m
       WHERE m.driver_id = ?
       ORDER BY m.timestamp ASC`,
      [req.params.driverId]
    );

    console.log(`📦 Found ${messages.length} messages for driver ${req.params.driverId}`);

    if (messages.length === 0) {
      return res.json([]);
    }

    const messageIds = messages.map(msg => msg.message_id);

    console.log('🖼️ Fetching media for message IDs:', messageIds);

    const [mediaRows] = await pool.query(
      `SELECT * FROM media_uploads WHERE message_id IN (?) ORDER BY upload_time ASC`,
      [messageIds]
    );

    console.log(`📸 Found ${mediaRows.length} media files`);

    const mediaMap = {};
    mediaRows.forEach(media => {
      if (!mediaMap[media.message_id]) {
        mediaMap[media.message_id] = [];
      }
      mediaMap[media.message_id].push({
        id: media.id,
        message_id: media.message_id,
        driver_id: media.driver_id,
        file_name: media.file_name,
        file_url: media.file_url,
        media_type: media.media_type,
        upload_time: media.upload_time
      });
    });

    const messagesWithMedia = messages.map(message => {
      const media = mediaMap[message.message_id] || [];
      if (media.length > 0) {
        console.log(`📨 Message ${message.message_id} has ${media.length} media files`);
      }
      return {
        ...message,
        media: media
      };
    });

    console.log(`✅ Loaded ${messagesWithMedia.length} messages with ${mediaRows.length} media files`);

    res.json(messagesWithMedia);
  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/debug-media', async (req, res) => {
  try {
    const [mediaRows] = await pool.query('SELECT * FROM media_uploads ORDER BY upload_time DESC LIMIT 10');
    const [messageRows] = await pool.query('SELECT message_id, driver_id, text FROM messages ORDER BY timestamp DESC LIMIT 10');

    res.json({
      media_uploads: mediaRows,
      recent_messages: messageRows
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
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
