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
  methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"]
}));

// Add JSON parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const httpServer = createServer(app);

// Enhanced Socket.IO configuration for stability
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds
  connectTimeout: 45000, // 45 seconds
  transports: ['websocket', 'polling'], // Fallback transport
  allowUpgrades: true,
  maxHttpBufferSize: 1e8, // 100MB max message size
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true
  }
});

// MySQL Configuration with better timeout settings
const dbConfig = {
  host: "srv657.hstgr.io",
  user: "u442108067_mydb",
  password: "mOhe6ln0iP>",
  database: "u442108067_mydb",
  waitForConnections: true,
  connectionLimit: 25, // Increased for better concurrency
  queueLimit: 0,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

// Create MySQL connection pool
const pool = mysql.createPool(dbConfig);

// Track online status and users with connection metadata
let adminOnline = false;
const users = new Map(); // Use Map for better performance

// Message queue for handling rapid messages with enhanced tracking
const messageQueue = new Map();

// Connection tracker for debugging
const connectionStats = {
  totalConnections: 0,
  totalDisconnections: 0,
  currentConnections: 0
};

// Create messages table if not exists
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) NOT NULL UNIQUE,
        sender_id VARCHAR(100) NOT NULL,
        receiver_id VARCHAR(100),
        driver_id VARCHAR(100) NOT NULL,
        text TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        sender_type ENUM('user', 'support', 'admin') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_message_id (message_id),
        INDEX idx_driver_id (driver_id),
        INDEX idx_timestamp (timestamp),
        INDEX idx_sender_driver (sender_id, driver_id)
      )
    `);
    
    await connection.query(`
      CREATE TABLE IF NOT EXISTS media_uploads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) NOT NULL,
        driver_id VARCHAR(100) NOT NULL,
        file_name VARCHAR(500) NOT NULL,
        file_url VARCHAR(1000) NOT NULL,
        media_type ENUM('image', 'video', 'gif', 'file') NOT NULL,
        upload_time DATETIME NOT NULL,
        file_size BIGINT,
        mime_type VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_message_id (message_id),
        INDEX idx_driver_id (driver_id),
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      )
    `);
    
    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error("❌ Database initialization error:", error);
  } finally {
    connection.release();
  }
}

initializeDatabase();

// Enhanced database connection event handlers
pool.on('connection', (connection) => {
  console.log('🔵 New database connection established');
});

pool.on('acquire', (connection) => {
  console.log('🔵 Connection acquired from pool');
});

pool.on('release', (connection) => {
  console.log('🔴 Connection released to pool');
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err);
});

// Enhanced message queue processing with connection stability check
async function processMessageQueue(socketId) {
  if (!messageQueue.has(socketId) || messageQueue.get(socketId).length === 0) {
    return;
  }

  const queue = messageQueue.get(socketId);
  const messageData = queue[0];

  // Check if socket is still connected
  const socket = io.sockets.sockets.get(socketId);
  if (!socket || !socket.connected) {
    console.log(`⚠️ Socket ${socketId} disconnected, cleaning up queue`);
    messageQueue.delete(socketId);
    return;
  }

  console.log(`🔄 Processing message from queue: ${messageData.message_id}, Queue length: ${queue.length}`);

  let connection;
  try {
    connection = await pool.getConnection();
    console.log(`🔵 Database connection acquired for message: ${messageData.message_id}`);

    await connection.beginTransaction();

    // Insert into messages table with duplicate check
    const [messageResult] = await connection.query(
      `INSERT IGNORE INTO messages (message_id, sender_id, receiver_id, driver_id, text, timestamp, sender_type) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        messageData.message_id,
        messageData.sender_id,
        messageData.receiver_id,
        messageData.driver_id,
        messageData.text,
        messageData.timestamp,
        messageData.sender_type,
      ]
    );

    if (messageResult.affectedRows === 0) {
      console.log(`⚠️ Message already exists, skipping: ${messageData.message_id}`);
    } else {
      console.log(`✅ Message saved to database: ${messageData.message_id}`);
    }

    // If media is present, insert media records
    if (messageData.media && messageData.media.length > 0) {
      for (const item of messageData.media) {
        await connection.query(
          `INSERT IGNORE INTO media_uploads (message_id, driver_id, file_name, file_url, media_type, upload_time, file_size, mime_type) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            messageData.message_id,
            messageData.driver_id,
            item.file_name,
            item.file_url,
            item.media_type,
            messageData.timestamp,
            item.file_size,
            item.mime_type,
          ]
        );
        console.log(`✅ Media saved for message: ${messageData.message_id} - ${item.file_name}`);
      }
    }

    // Commit the transaction
    await connection.commit();
    console.log(`✅ Transaction committed for message: ${messageData.message_id}`);

    // Remove from queue
    queue.shift();
    
    // Emit the original message to clients only if socket is still connected
    if (socket.connected) {
      const receiverId = messageData.receiver_id;
      const driverId = messageData.driver_id;
      const originalMessage = messageData.originalMessage;

      // Enhanced message routing logic
      if (receiverId) {
        if (users.has(receiverId)) {
          socket.to(receiverId).emit('receiveMessage', originalMessage);
          const receiverInfo = users.get(receiverId);
          console.log(`📨 Message DELIVERED to ${receiverInfo.name} (${receiverInfo.type})`);
        } else if (receiverId === 'admin') {
          io.to('admin').emit('receiveMessage', originalMessage);
          console.log(`📨 Message DELIVERED to Admin`);
        } else if (driverId) {
          // Find all sockets for this driver
          for (let [sockId, user] of users) {
            if (user.driverId === driverId && user.type === 'user') {
              socket.to(sockId).emit('receiveMessage', originalMessage);
              console.log(`📨 Message DELIVERED to Driver ${driverId}`);
            }
          }
        }
      } else {
        // Broadcast to relevant parties
        io.emit('receiveMessage', originalMessage);
        console.log(`📨 Message BROADCASTED to all users`);
      }
    } else {
      console.log(`⚠️ Socket disconnected, message not delivered: ${messageData.message_id}`);
    }

  } catch (error) {
    console.error('❌ Error processing message from queue:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      await connection.rollback();
    }
    
    // Enhanced retry logic with exponential backoff
    const retryCount = messageData.retryCount || 0;
    if (retryCount < 3) {
      messageData.retryCount = retryCount + 1;
      const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff max 10s
      console.log(`🔄 Retrying message (attempt ${retryCount + 1}): ${messageData.message_id} after ${delay}ms`);
      setTimeout(() => processMessageQueue(socketId), delay);
    } else {
      console.error(`❌ Max retries exceeded for message: ${messageData.message_id}`);
      queue.shift(); // Remove failed message after max retries
    }
    return;
  } finally {
    // Always release the connection back to the pool
    if (connection) {
      connection.release();
      console.log(`🔴 Database connection released for message: ${messageData.message_id}`);
    }
  }

  // Process next message in queue after a small delay
  if (queue.length > 0) {
    setTimeout(() => processMessageQueue(socketId), 30); // Reduced delay for better throughput
  } else {
    console.log(`✅ Message queue empty for socket: ${socketId}`);
  }
}

// Enhanced Socket.io connection handling with stability features
io.on('connection', (socket) => {
  connectionStats.totalConnections++;
  connectionStats.currentConnections++;
  
  console.log(`🔗 User connected: ${socket.id} | Active: ${connectionStats.currentConnections} | Total: ${connectionStats.totalConnections}`);

  // Add connection metadata
  socket.connectionTime = new Date();
  socket.connectionId = socket.id;

  socket.on('register', (userType, userName, driverId) => {
    users.set(socket.id, {
      type: userType,
      name: userName || `User-${socket.id.slice(0, 4)}`,
      driverId,
      connectedAt: new Date(),
      socketId: socket.id
    });
    
    socket.join(userType);
    
    if (userType === 'admin') {
      adminOnline = true;
      io.emit('adminStatus', true);
      console.log('👑 Admin registered and online');
    }
    
    // Broadcast online users
    const onlineUsers = Array.from(users.entries()).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
      connectedAt: user.connectedAt
    }));
    
    io.emit('onlineUsers', onlineUsers);
    console.log(`✅ User registered: ${userName} (${userType}) | Total online: ${users.size}`);
  });

  // Enhanced getDriverSocketId with better error handling
  socket.on('getDriverSocketId', (driverId, callback) => {
    try {
      for (let [sockId, user] of users) {
        if (user.driverId === driverId && user.type === 'user' && io.sockets.sockets.get(sockId)?.connected) {
          callback(sockId);
          return;
        }
      }
      callback(null);
    } catch (error) {
      console.error('Error in getDriverSocketId:', error);
      callback(null);
    }
  });

  // Handle manual driver disconnection
  socket.on('disconnectUser', (driverId) => {
    let disconnectedCount = 0;
    for (let [sockId, user] of users) {
      if (user.driverId === driverId && user.type === 'user') {
        users.delete(sockId);
        const driverSocket = io.sockets.sockets.get(sockId);
        if (driverSocket) {
          driverSocket.disconnect(true);
          disconnectedCount++;
        }
      }
    }
    
    const onlineUsers = Array.from(users.entries()).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    
    io.emit('onlineUsers', onlineUsers);
    console.log(`🔴 ${disconnectedCount} user(s) manually disconnected: ${driverId}`);
  });

  // Handle message deletion with enhanced error handling
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
        
        console.log(`✅ Message deleted from database: ${messageId}, affected rows: ${messageResult.affectedRows}`);
        
        // Emit event to all clients to remove the message
        io.emit('messageDeleted', messageId);
        console.log(`📢 Message deleted event emitted: ${messageId}`);
        
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('❌ Error deleting message:', error);
      socket.emit('error', { type: 'DELETE_MESSAGE_ERROR', message: error.message });
    }
  });

  // Enhanced message handling with connection validation
  socket.on('sendMessage', async (message) => {
    // Validate socket connection
    if (!socket.connected) {
      console.log(`⚠️ Socket not connected, ignoring message from: ${socket.id}`);
      return;
    }

    const { id, receiverId, driverId, text, media, sender_type } = message;
    
    const messageWithTimestamp = {
      message_id: id,
      sender_id: socket.id,
      receiver_id: receiverId,
      driver_id: driverId,
      text: text || '',
      timestamp: new Date().toISOString(),
      sender_type: sender_type,
      media: media,
      originalMessage: message,
      queuedAt: new Date()
    };

    // Log sent message
    const senderInfo = users.get(socket.id);
    const senderName = senderInfo ? senderInfo.name : 'Unknown';
    console.log(`📤 Message SENT from ${senderName} (${sender_type}):`, text?.substring(0, 50) || '[Media message]', `ID: ${id}`);

    // Initialize queue for socket if not exists
    if (!messageQueue.has(socket.id)) {
      messageQueue.set(socket.id, []);
    }

    // Add message to queue
    messageQueue.get(socket.id).push(messageWithTimestamp);
    console.log(`📥 Added to queue. Socket ${socket.id} queue length: ${messageQueue.get(socket.id).length}`);

    // Start processing if this is the first message in queue
    if (messageQueue.get(socket.id).length === 1) {
      processMessageQueue(socket.id);
    }
  });

  // Listen for received messages
  socket.on('receiveMessage', (message) => {
    const receiverInfo = users.get(socket.id);
    const receiverName = receiverInfo ? receiverInfo.name : 'Unknown';
    console.log(`📥 Message RECEIVED by ${receiverName}:`, message.text?.substring(0, 50) || '[Media message]');
  });

  // Enhanced disconnect handler with better cleanup
  socket.on('disconnect', (reason) => {
    connectionStats.totalDisconnections++;
    connectionStats.currentConnections--;
    
    console.log(`🔴 User disconnected: ${socket.id}, reason: ${reason} | Active: ${connectionStats.currentConnections}`);
    
    // Enhanced cleanup with connection duration
    const userInfo = users.get(socket.id);
    const connectionDuration = userInfo ? 
      Math.round((new Date() - userInfo.connectedAt) / 1000) : 0;
    
    // Clean up message queue for disconnected socket
    if (messageQueue.has(socket.id)) {
      const pendingMessages = messageQueue.get(socket.id).length;
      messageQueue.delete(socket.id);
      console.log(`🧹 Cleaned up message queue for disconnected socket: ${socket.id} (${pendingMessages} pending messages)`);
    }
    
    // Update admin status if admin disconnected
    if (userInfo?.type === 'admin') {
      adminOnline = false;
      io.emit('adminStatus', false);
      console.log(`👑 Admin went offline (connected for ${connectionDuration}s)`);
    }
    
    users.delete(socket.id);
    
    // Broadcast updated online users
    const onlineUsers = Array.from(users.entries()).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    
    io.emit('onlineUsers', onlineUsers);
  });

  // Heartbeat mechanism for connection health
  socket.on('heartbeat', () => {
    socket.emit('heartbeat_ack');
  });

  // Error handling
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
});

// Enhanced API endpoint to fetch old messages with better error handling
app.get('/api/messages/:driverId', async (req, res) => {
  try {
    const driverId = req.params.driverId;
    console.log(`📋 Fetching messages for driver: ${driverId}`);
    
    const connection = await pool.getConnection();
    try {
      const [messageRows] = await connection.query(
        `SELECT m.*,
         CASE
           WHEN m.sender_type = 'admin' OR m.sender_type = 'support' THEN 'support'
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
        [driverId]
      );

      console.log(`✅ Found ${messageRows.length} message records for driver: ${driverId}`);

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
            senderName: row.sender_type === 'support' || row.sender_type === 'admin' ? 'Support' : 'User',
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
      console.log(`📦 Returning ${messages.length} grouped messages for driver: ${driverId}`);
      
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
      
      console.log(`✅ API: Message deleted successfully: ${messageId}, affected rows: ${messageResult.affectedRows}`);
      res.json({ 
        success: true, 
        message: 'Message deleted successfully',
        deletedId: messageId,
        affectedRows: messageResult.affectedRows
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

// Enhanced queue status endpoint
app.get('/api/queue-status', (req, res) => {
  const queueStatus = {};
  let totalPending = 0;
  
  messageQueue.forEach((queue, socketId) => {
    const user = users.get(socketId);
    queueStatus[socketId] = {
      queueLength: queue.length,
      user: user || 'Unknown',
      pendingMessages: queue.map(m => ({
        id: m.message_id,
        text: m.text?.substring(0, 50) || '[Media]',
        queuedAt: m.queuedAt
      }))
    };
    totalPending += queue.length;
  });
  
  res.json({
    totalQueues: messageQueue.size,
    totalPendingMessages: totalPending,
    queues: queueStatus,
    connectionStats: {
      ...connectionStats,
      onlineUsers: users.size
    },
    adminOnline: adminOnline,
    serverTime: new Date().toISOString()
  });
});

// Enhanced health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    adminOnline: adminOnline,
    connectedUsers: users.size,
    messageQueues: messageQueue.size,
    connectionStats: connectionStats,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Test database connection endpoint
app.get('/api/test-db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [result] = await connection.query('SELECT 1 as test, NOW() as time');
    connection.release();
    res.json({ 
      success: true, 
      message: 'Database connection successful',
      result: result,
      serverTime: new Date().toISOString()
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

// Server info endpoint
app.get('/api/server-info', (req, res) => {
  res.json({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    env: process.env.NODE_ENV || 'development'
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
  console.log(`\n🚀 Enhanced Socket.IO Server Started!`);
  console.log(`   ======================================`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIp}:${PORT}`);
  console.log(`   ======================================`);
  console.log(`   📊 Enhanced Features:`);
  console.log(`   ✅ Message queue with connection validation`);
  console.log(`   ✅ Exponential backoff retry mechanism`);
  console.log(`   ✅ Connection stability improvements`);
  console.log(`   ✅ Enhanced error handling and logging`);
  console.log(`   ✅ Database connection pooling (25 connections)`);
  console.log(`   ✅ Connection recovery support`);
  console.log(`   ======================================`);
  console.log(`   🔧 API Endpoints:`);
  console.log(`   - GET  /api/health - Health check`);
  console.log(`   - GET  /api/test-db - Test database`);
  console.log(`   - GET  /api/messages/:driverId - Get messages`);
  console.log(`   - DEL  /api/messages/:messageId - Delete message`);
  console.log(`   - GET  /api/queue-status - Queue monitoring`);
  console.log(`   - GET  /api/server-info - Server information`);
  console.log(`   ======================================\n`);
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  
  // Close Socket.IO
  io.close(() => {
    console.log('✅ Socket.IO closed');
  });
  
  // Close database pool
  await pool.end();
  console.log('✅ Database pool closed');
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🔄 SIGINT received, shutting down gracefully...');
  
  io.close(() => {
    console.log('✅ Socket.IO closed');
  });
  
  await pool.end();
  console.log('✅ Database pool closed');
  
  process.exit(0);
});
