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
  },
  pingTimeout: 60000,
  pingInterval: 25000
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
const adminChats = new Set(); // Track which chats admin is currently in

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
        media_type ENUM('image', 'video', 'gif', 'file') NOT NULL,
        upload_time DATETIME NOT NULL,
        file_size INT,
        mime_type VARCHAR(100),
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

// Function to update admin online status
function updateAdminStatus() {
  const adminCount = Object.values(users).filter(user => user.type === 'admin').length;
  const newAdminOnline = adminCount > 0;
  
  if (newAdminOnline !== adminOnline) {
    adminOnline = newAdminOnline;
    io.emit('adminStatus', adminOnline);
    console.log(`🔄 Admin status changed to: ${adminOnline ? 'ONLINE' : 'OFFLINE'}`);
  }
  
  return adminOnline;
}

// Function to get online users list
function getOnlineUsersList() {
  return Object.entries(users).map(([id, user]) => ({
    id,
    name: user.name,
    type: user.type,
    driverId: user.driverId,
  }));
}

// Function to notify driver about admin status
function notifyDriverAdminStatus(driverId, isOnline) {
  const driverSocket = Object.entries(users).find(
    ([id, user]) => user.driverId === driverId && user.type === 'user'
  );
  
  if (driverSocket) {
    io.to(driverSocket[0]).emit('adminStatus', isOnline);
    console.log(`📢 Notified driver ${driverId} that admin is ${isOnline ? 'online' : 'offline'}`);
  }
}

// Add message deletion event handler
io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  socket.on('register', (userType, userName, driverId) => {
    users[socket.id] = {
      type: userType,
      name: userName || `User-${socket.id.slice(0, 4)}`,
      driverId,
    };
    
    socket.join(userType);
    
    if (userType === 'admin') {
      console.log('👨‍💼 Admin registered:', userName);
      // Update admin status and notify all users
      updateAdminStatus();
    } else if (userType === 'user') {
      console.log('👤 Driver registered:', userName, 'ID:', driverId);
      // Notify this specific driver about current admin status
      socket.emit('adminStatus', adminOnline);
      console.log(`📢 Sent initial admin status to driver ${driverId}: ${adminOnline ? 'online' : 'offline'}`);
    }
    
    // Update online users list
    const onlineUsers = getOnlineUsersList();
    io.emit('onlineUsers', onlineUsers);
    console.log(`✅ User registered: ${userName} (${userType})`);
  });

  // Admin joining a specific driver chat
  socket.on('adminJoinChat', (driverId) => {
    console.log(`👨‍💼 Admin ${socket.id} joined chat with driver: ${driverId}`);
    
    // Add to admin chats tracking
    adminChats.add(driverId);
    
    // Notify the specific driver that admin joined their chat
    notifyDriverAdminStatus(driverId, true);
    
    // Join the specific chat room
    socket.join(`admin_chat_${driverId}`);
    
    console.log(`💬 Admin now in chat with driver: ${driverId}`);
  });

  // Admin leaving a specific driver chat
  socket.on('adminLeaveChat', (driverId) => {
    console.log(`👨‍💼 Admin ${socket.id} left chat with driver: ${driverId}`);
    
    // Remove from admin chats tracking
    adminChats.delete(driverId);
    
    // Notify the specific driver that admin left their chat
    notifyDriverAdminStatus(driverId, false);
    
    // Leave the specific chat room
    socket.leave(`admin_chat_${driverId}`);
    
    console.log(`🚪 Admin left chat with driver: ${driverId}`);
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
    const driverSockets = Object.entries(users).filter(
      ([id, user]) => user.driverId === driverId && user.type === 'user'
    );
    driverSockets.forEach(([socketId, user]) => {
      delete users[socketId];
      const driverSocket = io.sockets.sockets.get(socketId);
      if (driverSocket) {
        driverSocket.disconnect(true);
      }
    });
    
    const onlineUsers = getOnlineUsersList();
    io.emit('onlineUsers', onlineUsers);
    console.log(`👤 User manually disconnected: ${driverId}`);
  });

  // Handle message deletion
  socket.on('deleteMessage', async (messageId, driverId) => {
    try {
      console.log(`🗑️ Deleting message: ${messageId} for driver: ${driverId}`);
      
      const connection = await pool.getConnection();
      try {
        // Delete from messages table
        const [messageResult] = await connection.query(
          'DELETE FROM messages WHERE message_id = ? AND driver_id = ?',
          [messageId, driverId]
        );
        
        // Delete associated media
        await connection.query(
          'DELETE FROM media_uploads WHERE message_id = ?',
          [messageId]
        );
        
        console.log(`✅ Message deleted from database: ${messageId}`);
        
        // Emit event to all clients to remove the message
        io.emit('messageDeleted', messageId);
        console.log(`📢 Message deleted event emitted: ${messageId}`);
        
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('❌ Error deleting message:', error);
    }
  });

  socket.on('sendMessage', async (message) => {
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

    // Log sent message
    const senderInfo = users[socket.id];
    const senderName = senderInfo ? senderInfo.name : 'Unknown';
    console.log(`📤 Message SENT from ${senderName} (${sender_type}):`, text || '[Media message]');

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

      // If media is present, check if it already exists before inserting
      if (media && media.length > 0) {
        for (const item of media) {
          // Check if this media item already exists for this message
          const [existingMedia] = await connection.query(
            'SELECT id FROM media_uploads WHERE message_id = ? AND file_url = ?',
            [messageWithTimestamp.message_id, item.file_url]
          );

          // Only insert if it doesn't exist
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
          }
        }
      }
    } catch (error) {
      console.error('❌ Error saving message or media:', error);
    } finally {
      if (connection) connection.release();
    }

    // Message routing logic
    if (receiverId) {
      if (users[receiverId]) {
        io.to(receiverId).emit('receiveMessage', message);
        const receiverInfo = users[receiverId];
        console.log(`📨 Message DELIVERED to ${receiverInfo.name} (${receiverInfo.type})`);
      } else if (receiverId === 'admin') {
        io.to('admin').emit('receiveMessage', message);
        console.log(`📨 Message DELIVERED to Admin`);
      } else if (messageWithTimestamp.driver_id) {
        const driverSocket = Object.entries(users).find(
          ([id, user]) => user.driverId === messageWithTimestamp.driver_id && user.type === 'user'
        );
        if (driverSocket) {
          io.to(driverSocket[0]).emit('receiveMessage', message);
          console.log(`📨 Message DELIVERED to Driver ${messageWithTimestamp.driver_id}`);
        }
      }
    } else {
      io.emit('receiveMessage', message);
      console.log(`📨 Message BROADCASTED to all users`);
    }
  });

  // Listen for received messages
  socket.on('receiveMessage', (message) => {
    const receiverInfo = users[socket.id];
    const receiverName = receiverInfo ? receiverInfo.name : 'Unknown';
    console.log(`📥 Message RECEIVED by ${receiverName}:`, message.text || '[Media message]');
  });

  // Handle user connection status
  socket.on('userConnected', (userData) => {
    console.log(`👤 User connected event:`, userData);
    const onlineUsers = getOnlineUsersList();
    io.emit('onlineUsers', onlineUsers);
  });

  // Handle user disconnection status
  socket.on('userDisconnected', (userData) => {
    console.log(`👤 User disconnected event:`, userData);
    const onlineUsers = getOnlineUsersList();
    io.emit('onlineUsers', onlineUsers);
  });

  // Get online users
  socket.on('getOnlineUsers', () => {
    const onlineUsers = getOnlineUsersList();
    socket.emit('onlineUsers', onlineUsers);
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 User disconnected: ${socket.id}, reason: ${reason}`);
    const disconnectedUser = users[socket.id];
    
    if (disconnectedUser) {
      if (disconnectedUser.type === 'admin') {
        console.log('👨‍💼 Admin disconnected');
        
        // Remove admin from all chat rooms they were in
        for (const driverId of adminChats) {
          if (adminChats.has(driverId)) {
            notifyDriverAdminStatus(driverId, false);
            console.log(`📢 Notified driver ${driverId} that admin left chat`);
          }
        }
        
        // Clear admin chats
        adminChats.clear();
      } else if (disconnectedUser.type === 'user') {
        console.log(`👤 Driver disconnected: ${disconnectedUser.driverId}`);
      }
      
      delete users[socket.id];
    }
    
    // Update admin status after user removal
    updateAdminStatus();
    
    // Update online users list
    const onlineUsers = getOnlineUsersList();
    io.emit('onlineUsers', onlineUsers);
  });

  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error('❌ Socket connection error:', error);
  });
});

// Periodic admin status check and broadcast
setInterval(() => {
  const currentAdminOnline = updateAdminStatus();
  const onlineUsers = getOnlineUsersList();
  
  console.log(`🔄 Periodic status check - Admin: ${currentAdminOnline ? 'ONLINE' : 'OFFLINE'}, Users: ${onlineUsers.length}`);
  
  // Broadcast online users list periodically
  io.emit('onlineUsers', onlineUsers);
}, 10000); // Check every 10 seconds

// API endpoint to fetch old messages with associated media
app.get('/api/messages/:driverId', async (req, res) => {
  try {
    console.log(`📋 Fetching messages for driver: ${req.params.driverId}`);
    
    const connection = await pool.getConnection();
    try {
      const [messageRows] = await connection.query(
        `SELECT m.*,
         CASE
           WHEN m.sender_id = 'admin' THEN 'support'
           ELSE 'user'
         END as sender,
         m.sender_type,
         mu.id as media_id,
         mu.file_name,
         mu.file_url,
         mu.media_type,
         mu.file_size,
         mu.mime_type
         FROM messages m
         LEFT JOIN media_uploads mu ON m.message_id = mu.message_id
         WHERE m.driver_id = ?
         ORDER BY m.timestamp ASC`,
        [req.params.driverId]
      );

      console.log(`📦 Found ${messageRows.length} message records`);

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
            mime_type: row.mime_type
          });
        }
      });

      const messages = Array.from(messagesMap.values());
      console.log(`✅ Returning ${messages.length} grouped messages`);
      
      res.json(messages);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch messages',
      details: error.message 
    });
  }
});

// API endpoint to delete a specific message
app.delete('/api/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    console.log(`🗑️ API: Deleting message: ${messageId}`);
    
    const connection = await pool.getConnection();
    try {
      // Delete from messages table
      const [messageResult] = await connection.query(
        'DELETE FROM messages WHERE message_id = ?',
        [messageId]
      );
      
      // Delete associated media
      await connection.query(
        'DELETE FROM media_uploads WHERE message_id = ?',
        [messageId]
      );
      
      console.log(`✅ API: Message deleted successfully: ${messageId}`);
      res.json({ 
        success: true, 
        message: 'Message deleted successfully',
        deletedId: messageId 
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ API: Error deleting message:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete message',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  const onlineUsers = getOnlineUsersList();
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    adminOnline: adminOnline,
    connectedUsers: onlineUsers.length,
    onlineUsers: onlineUsers,
    adminChats: Array.from(adminChats)
  });
});

// Test database connection endpoint
app.get('/api/test-db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [result] = await connection.query('SELECT 1 as test');
    connection.release();
    res.json({ 
      success: true, 
      message: 'Database connection successful',
      result: result 
    });
  } catch (error) {
    console.error('❌ Database test failed:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Database connection failed',
      details: error.message 
    });
  }
});

// Get current admin status
app.get('/api/admin-status', (req, res) => {
  res.json({ 
    adminOnline: adminOnline,
    timestamp: new Date().toISOString()
  });
});

// Get driver's admin chat status
app.get('/api/driver-status/:driverId', (req, res) => {
  const driverId = req.params.driverId;
  const isAdminInChat = adminChats.has(driverId);
  const driverSocket = Object.entries(users).find(
    ([id, user]) => user.driverId === driverId && user.type === 'user'
  );
  
  res.json({ 
    driverId: driverId,
    driverOnline: !!driverSocket,
    adminOnline: adminOnline,
    adminInChat: isAdminInChat,
    timestamp: new Date().toISOString()
  });
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
  console.log(`🚀 Socket.IO server running at:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIp}:${PORT}`);
  console.log(`   API endpoints:`);
  console.log(`   - GET /api/health - Health check`);
  console.log(`   - GET /api/test-db - Test database connection`);
  console.log(`   - GET /api/admin-status - Get admin status`);
  console.log(`   - GET /api/driver-status/:driverId - Get driver chat status`);
  console.log(`   - GET /api/messages/:driverId - Get messages for driver`);
  console.log(`   - DELETE /api/messages/:messageId - Delete specific message`);
});
