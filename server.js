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
const users = {};

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
        text TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        sender_type ENUM('user', 'support', 'admin') NOT NULL,
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

  socket.on('sendMessage', async (message) => {
    console.log('Message received:', message);
    const { id, receiverId, driverId, text, media, sender_type } = message;
    
    const dbSenderType = sender_type === 'support' ? 'support' : 
                        sender_type === 'admin' ? 'admin' : 'user';
    
    const messageWithTimestamp = {
      message_id: id,
      sender_id: socket.id,
      receiver_id: receiverId,
      driver_id: driverId,
      text: text || '',
      timestamp: new Date().toISOString(),
      sender_type: dbSenderType,
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
        }
      }
    } catch (error) {
      console.error('Error saving message or media:', error);
    } finally {
      if (connection) connection.release();
    }

    if (driverId) {
      const driverSockets = Object.entries(users).filter(
        ([id, user]) => user.driverId === driverId && user.type === 'user'
      );
      
      driverSockets.forEach(([socketId, user]) => {
        io.to(socketId).emit('receiveMessage', message);
      });
      
      if (sender_type === 'user') {
        const adminSockets = Object.entries(users).filter(
          ([id, user]) => user.type === 'admin'
        );
        adminSockets.forEach(([socketId, user]) => {
          io.to(socketId).emit('receiveMessage', message);
        });
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
    const disconnectedUser = users[socket.id];
    if (disconnectedUser?.type === 'admin') {
      adminOnline = false;
      io.emit('adminStatus', false);
    }
    delete users[socket.id];
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    io.emit('onlineUsers', onlineUsers);
  });
});

// FIXED API endpoint - simplified and more robust
app.get('/api/messages/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    console.log(`Fetching messages for driver: ${driverId}, page: ${page}`);

    // Get messages
    const [messageRows] = await pool.query(
      `SELECT 
        m.message_id as id,
        m.message_id,
        m.sender_id,
        m.receiver_id,
        m.driver_id,
        m.text,
        m.timestamp,
        m.sender_type,
        mu.file_name,
        mu.file_url,
        mu.media_type,
        mu.file_size,
        mu.mime_type
      FROM messages m
      LEFT JOIN media_uploads mu ON m.message_id = mu.message_id
      WHERE m.driver_id = ?
      ORDER BY m.timestamp ASC
      LIMIT ? OFFSET ?`,
      [driverId, limit, offset]
    );

    console.log(`Found ${messageRows.length} messages`);

    // Group messages with their media
    const messagesMap = new Map();
    
    messageRows.forEach(row => {
      if (!messagesMap.has(row.id)) {
        messagesMap.set(row.id, {
          id: row.id,
          message_id: row.message_id,
          sender_id: row.sender_id,
          receiver_id: row.receiver_id,
          driver_id: row.driver_id,
          text: row.text,
          timestamp: row.timestamp,
          sender_type: row.sender_type,
          media: []
        });
      }
      
      if (row.file_url) {
        messagesMap.get(row.id).media.push({
          file_name: row.file_name,
          file_url: row.file_url,
          media_type: row.media_type,
          file_size: row.file_size,
          mime_type: row.mime_type
        });
      }
    });

    const messages = Array.from(messagesMap.values());
    
    // Get total count
    const [countRows] = await pool.query(
      'SELECT COUNT(DISTINCT message_id) as total FROM messages WHERE driver_id = ?',
      [driverId]
    );
    const totalMessages = countRows[0].total;

    res.json({
      success: true,
      messages: messages,
      totalMessages: totalMessages,
      currentPage: page,
      totalPages: Math.ceil(totalMessages / limit),
      hasMore: page < Math.ceil(totalMessages / limit)
    });

  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch messages',
      message: error.message 
    });
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
