const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
const mysql = require('mysql2/promise');

const app = express();

// Add CORS middleware before routes
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE"]
}));

// Add JSON parsing middleware
app.use(express.json());

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
  user: "u442108067_MoveExpress",
  password: "@1ItH~?ztgV",
  database: "u442108067_MoveExpress",
  waitForConnections: true,
  connectionLimit: 50,
  queueLimit: 10
};

// Create MySQL connection pool
const pool = mysql.createPool(dbConfig);

// Track online status and users
const users = {}; // { socketId: { type: 'user'|'admin', name: string, driverId?: string, isInChat: boolean } }
const adminUsers = {}; // Track all admin socket connections

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
        media_type ENUM('image', 'video', 'file', 'audio') NOT NULL,
        upload_time DATETIME NOT NULL,
        file_size INT,
        mime_type VARCHAR(100),
        duration INT,
        INDEX (message_id),
        INDEX (driver_id)
      )
    `);
    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error("Database initialization error:", error);
  } finally {
    connection.release();
  }
}

initializeDatabase();

// Helper function to check if admin is online
function isAdminOnline() {
  return Object.keys(adminUsers).length > 0;
}

// Helper function to get online users list
function getOnlineUsersList() {
  const onlineUsers = [];
  
  // Add admin status
  onlineUsers.push({
    id: 'admin',
    name: 'Admin',
    type: 'admin',
    isOnline: isAdminOnline()
  });
  
  // Add driver users
  Object.entries(users).forEach(([socketId, user]) => {
    if (user.type === 'user') {
      onlineUsers.push({
        id: socketId,
        name: user.name,
        type: user.type,
        driverId: user.driverId,
        isOnline: true // Driver is online if in users object
      });
    }
  });
  
  return onlineUsers;
}

// Helper function to emit online users to all clients
function emitOnlineUsers() {
  const onlineUsers = getOnlineUsersList();
  io.emit('onlineUsers', onlineUsers);
  console.log('Online users updated:', onlineUsers.length);
}

// Helper function to find driver socket by driverId
function findDriverSocket(driverId) {
  return Object.entries(users).find(
    ([socketId, user]) => user.driverId === driverId && user.type === 'user'
  );
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('register', (userType, userName, driverId) => {
    users[socket.id] = {
      type: userType,
      name: userName || `User-${socket.id.slice(0, 4)}`,
      driverId: driverId,
      isInChat: true // Both admin and driver are considered in chat when registered
    };
    
    if (userType === 'admin') {
      adminUsers[socket.id] = true;
      console.log(`Admin registered: ${socket.id}`);
    } else {
      console.log(`Driver registered: ${userName} (${driverId})`);
    }
    
    emitOnlineUsers();
    
    // Emit admin status to all drivers when admin connects/disconnects
    if (userType === 'admin') {
      io.emit('adminStatus', true);
    }
  });

  // Driver enters chat
  socket.on('enterChat', (driverId) => {
    if (users[socket.id] && users[socket.id].type === 'user') {
      users[socket.id].isInChat = true;
      console.log(`Driver ${driverId} entered chat`);
      
      // Notify all admins that driver entered chat
      Object.keys(adminUsers).forEach(adminSocketId => {
        io.to(adminSocketId).emit('adminJoinChat', driverId);
      });
    }
  });

  // Driver leaves chat
  socket.on('leaveChat', (driverId) => {
    if (users[socket.id] && users[socket.id].type === 'user') {
      users[socket.id].isInChat = false;
      console.log(`Driver ${driverId} left chat`);
      
      // Notify all admins that driver left chat
      Object.keys(adminUsers).forEach(adminSocketId => {
        io.to(adminSocketId).emit('adminLeaveChat', driverId);
      });
    }
  });

  // Handle message deletion
  socket.on('deleteMessage', async (messageId, driverId) => {
    try {
      console.log(`Deleting message: ${messageId} for driver: ${driverId}`);
      
      const connection = await pool.getConnection();
      try {
        // Delete from messages table
        await connection.query(
          'DELETE FROM messages WHERE message_id = ? AND driver_id = ?',
          [messageId, driverId]
        );
        
        // Delete associated media
        await connection.query(
          'DELETE FROM media_uploads WHERE message_id = ?',
          [messageId]
        );
        
        console.log(`Message deleted from database: ${messageId}`);
        
        // Emit event to all clients to remove the message
        io.emit('messageDeleted', messageId);
        console.log(`Message deleted event emitted: ${messageId}`);
        
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('Error deleting message:', error);
    }
  });

  socket.on('sendMessage', async (message) => {
    const { id, receiverId, driverId, text, media, sender_type, senderId } = message;
    
    const messageWithTimestamp = {
      message_id: id,
      sender_id: senderId || socket.id, // Use provided senderId or socket.id
      receiver_id: receiverId,
      driver_id: driverId,
      text: text || '',
      timestamp: new Date().toISOString(),
      sender_type: sender_type,
    };

    // Log sent message
    const senderInfo = users[socket.id];
    const senderName = senderInfo ? senderInfo.name : 'Unknown';
    console.log(`📤 Message SENT from ${senderName} (${sender_type}) to driver ${driverId}:`, text || '[Media message]');

    let connection;
    try {
      connection = await pool.getConnection();
      
      // Insert into messages table
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

      // If media is present, insert it
      if (media && media.length > 0) {
        for (const item of media) {
          await connection.query(
            'INSERT INTO media_uploads (message_id, driver_id, file_name, file_url, media_type, upload_time, file_size, mime_type, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              messageWithTimestamp.message_id,
              messageWithTimestamp.driver_id,
              item.file_name,
              item.file_url,
              item.media_type,
              messageWithTimestamp.timestamp,
              item.file_size,
              item.mime_type,
              item.duration || null
            ]
          );
        }
      }
    } catch (error) {
      console.error('Error saving message or media:', error);
    } finally {
      if (connection) connection.release();
    }

    // **FIXED: Improved message routing logic**
    const finalMessage = {
      ...message,
      timestamp: messageWithTimestamp.timestamp
    };

    console.log(`Routing message: sender_type=${sender_type}, driverId=${driverId}`);

    if (sender_type === 'support') {
      // Message from admin to driver
      const driverSocket = findDriverSocket(driverId);
      if (driverSocket) {
        const [driverSocketId, driverUser] = driverSocket;
        io.to(driverSocketId).emit('receiveMessage', finalMessage);
        console.log(`📨 Message DELIVERED to Driver: ${driverUser.name} (${driverId})`);
      } else {
        console.log(`❌ Driver ${driverId} not found online, message stored but not delivered`);
      }
      
      // Also send to all admins for their chat windows
      Object.keys(adminUsers).forEach(adminSocketId => {
        io.to(adminSocketId).emit('receiveMessage', finalMessage);
      });
      console.log(`📨 Message SENT to all admins`);
      
    } else if (sender_type === 'user') {
      // Message from driver
      // Send to all admins
      Object.keys(adminUsers).forEach(adminSocketId => {
        io.to(adminSocketId).emit('receiveMessage', finalMessage);
      });
      console.log(`📨 Message from Driver DELIVERED to all admins`);
      
      // Also send back to the driver for their own chat
      io.to(socket.id).emit('receiveMessage', finalMessage);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
    const disconnectedUser = users[socket.id];
    
    if (disconnectedUser) {
      if (disconnectedUser.type === 'admin') {
        delete adminUsers[socket.id];
        console.log('Admin disconnected');
        // Notify all drivers that admin is offline
        io.emit('adminStatus', false);
      } else {
        // Driver disconnected - notify admins
        Object.keys(adminUsers).forEach(adminSocketId => {
          io.to(adminSocketId).emit('userDisconnected', disconnectedUser.driverId);
        });
      }
      delete users[socket.id];
    }
    
    emitOnlineUsers();
  });

  // Admin status request
  socket.on('getAdminStatus', () => {
    socket.emit('adminStatus', isAdminOnline());
  });
});

// API endpoint to get all connected drivers
app.get('/api/connected-drivers', (req, res) => {
  try {
    const connectedDrivers = Object.values(users)
      .filter(user => user.type === 'user')
      .map(user => ({
        driverId: user.driverId,
        name: user.name,
        isOnline: true
      }));

    console.log(`Found ${connectedDrivers.length} connected drivers`);
    
    res.json({
      success: true,
      count: connectedDrivers.length,
      drivers: connectedDrivers
    });
  } catch (error) {
    console.error('Error fetching connected drivers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch connected drivers'
    });
  }
});

// API endpoint to get messages for a driver
app.get('/api/messages/:driverId', async (req, res) => {
  try {
    console.log(`Fetching messages for driver: ${req.params.driverId}`);
    
    const connection = await pool.getConnection();
    try {
      const [messageRows] = await connection.query(
        `SELECT m.*,
         CASE
           WHEN m.sender_type = 'support' THEN 'support'
           ELSE 'user'
         END as sender,
         m.sender_type,
         mu.id as media_id,
         mu.file_name,
         mu.file_url,
         mu.media_type,
         mu.file_size,
         mu.mime_type,
         mu.duration
         FROM messages m
         LEFT JOIN media_uploads mu ON m.message_id = mu.message_id
         WHERE m.driver_id = ?
         ORDER BY m.timestamp ASC`,
        [req.params.driverId]
      );

      console.log(`Found ${messageRows.length} message records`);

      // Group messages and their media
      const messagesMap = new Map();
      
      messageRows.forEach(row => {
        if (!messagesMap.has(row.message_id)) {
          messagesMap.set(row.message_id, {
            id: row.message_id,
            text: row.text,
            sender_type: row.sender_type,
            sender: row.sender,
            timestamp: row.timestamp,
            senderId: row.sender_id,
            senderName: row.sender_type === 'support' ? 'Support' : 'User',
            receiverId: row.receiver_id,
            driverId: row.driver_id,
            media: []
          });
        }
        
        // Add media if it exists
        if (row.file_url) {
          const message = messagesMap.get(row.message_id);
          message.media.push({
            id: row.media_id,
            file_name: row.file_name,
            file_url: row.file_url,
            media_type: row.media_type,
            file_size: row.file_size,
            mime_type: row.mime_type,
            duration: row.duration
          });
        }
      });

      const messages = Array.from(messagesMap.values());
      console.log(`Returning ${messages.length} grouped messages`);
      
      res.json(messages);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch messages'
    });
  }
});

// API endpoint to delete a specific message
app.delete('/api/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    console.log(`API: Deleting message: ${messageId}`);
    
    const connection = await pool.getConnection();
    try {
      await connection.query('DELETE FROM messages WHERE message_id = ?', [messageId]);
      await connection.query('DELETE FROM media_uploads WHERE message_id = ?', [messageId]);
      
      console.log(`API: Message deleted successfully: ${messageId}`);
      res.json({ 
        success: true, 
        message: 'Message deleted successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('API: Error deleting message:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete message'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    adminOnline: isAdminOnline(),
    connectedUsers: Object.keys(users).length
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  const localIp = require('os').networkInterfaces();
  console.log(`🚀 Socket.IO server running on port ${PORT}`);
  console.log(`   API endpoints available at http://localhost:${PORT}/api`);
});
