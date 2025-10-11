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
  user: "u442108067_mydb",
  password: "mOhe6ln0iP>",
  database: "u442108067_mydb",
  waitForConnections: true,
  connectionLimit: 20, // Increased from 10
  queueLimit: 0,
  acquireTimeout: 60000, // 60 seconds
  timeout: 60000, // 60 seconds
  reconnect: true
};

// Create MySQL connection pool
const pool = mysql.createPool(dbConfig);

// Track online status and users
let adminOnline = false;
const users = {}; // { socketId: { type: 'user'|'admin', name: string, driverId?: string } }

// Message queue for handling rapid messages
const messageQueue = new Map(); // { socketId: [] }

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
    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error("Database initialization error:", error);
  } finally {
    connection.release();
  }
}

initializeDatabase();

// Database connection event handlers
pool.on('connection', (connection) => {
  console.log('🔵 New database connection established');
});

pool.on('acquire', (connection) => {
  console.log('🔵 Connection acquired');
});

pool.on('release', (connection) => {
  console.log('🔴 Connection released');
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err);
});

// Message queue processing function
async function processMessageQueue(socketId) {
  if (!messageQueue.has(socketId) || messageQueue.get(socketId).length === 0) {
    return;
  }

  const queue = messageQueue.get(socketId);
  const messageData = queue[0];

  console.log(`🔄 Processing message from queue: ${messageData.message_id}, Queue length: ${queue.length}`);

  let connection;
  try {
    connection = await pool.getConnection();
    console.log(`🔵 Database connection acquired for message: ${messageData.message_id}`);

    await connection.beginTransaction();

    // Insert into messages table
    const [messageResult] = await connection.query(
      'INSERT INTO messages (message_id, sender_id, receiver_id, driver_id, text, timestamp, sender_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
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

    console.log(`✅ Message saved to database: ${messageData.message_id}`);

    // If media is present, insert media records
    if (messageData.media && messageData.media.length > 0) {
      for (const item of messageData.media) {
        await connection.query(
          'INSERT INTO media_uploads (message_id, driver_id, file_name, file_url, media_type, upload_time, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
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

    // Remove from queue and emit to clients
    queue.shift();
    
    // Emit the original message to clients
    const receiverId = messageData.receiver_id;
    const driverId = messageData.driver_id;
    const originalMessage = messageData.originalMessage;

    // Message routing logic
    if (receiverId) {
      if (users[receiverId]) {
        io.to(receiverId).emit('receiveMessage', originalMessage);
        const receiverInfo = users[receiverId];
        console.log(`📨 Message DELIVERED to ${receiverInfo.name} (${receiverInfo.type})`);
      } else if (receiverId === 'admin') {
        io.to('admin').emit('receiveMessage', originalMessage);
        console.log(`📨 Message DELIVERED to Admin`);
      } else if (driverId) {
        const driverSocket = Object.entries(users).find(
          ([id, user]) => user.driverId === driverId && user.type === 'user'
        );
        if (driverSocket) {
          io.to(driverSocket[0]).emit('receiveMessage', originalMessage);
          console.log(`📨 Message DELIVERED to Driver ${driverId}`);
        }
      }
    } else {
      io.emit('receiveMessage', originalMessage);
      console.log(`📨 Message BROADCASTED to all users`);
    }

  } catch (error) {
    console.error('❌ Error processing message from queue:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      await connection.rollback();
    }
    
    // Retry the same message after a delay
    console.log(`🔄 Retrying message: ${messageData.message_id} after 500ms`);
    setTimeout(() => processMessageQueue(socketId), 500);
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
    setTimeout(() => processMessageQueue(socketId), 50);
  } else {
    console.log(`✅ Message queue empty for socket: ${socketId}`);
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`🔗 User connected: ${socket.id}`);

  socket.on('register', (userType, userName, driverId) => {
    users[socket.id] = {
      type: userType,
      name: userName || `User-${socket.id.slice(0, 4)}`,
      driverId,
    };
    socket.join(userType);
    if (userType === 'admin') {
      adminOnline = true;
      io.emit('adminStatus', true);
      console.log('👑 Admin registered and online');
    }
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    io.emit('onlineUsers', onlineUsers);
    console.log(`✅ User registered: ${userName} (${userType})`);
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
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      driverId: user.driverId,
    }));
    io.emit('onlineUsers', onlineUsers);
    console.log(`🔴 User manually disconnected: ${driverId}`);
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

  // Handle incoming messages - Using queue system
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
      media: media,
      originalMessage: message
    };

    // Log sent message
    const senderInfo = users[socket.id];
    const senderName = senderInfo ? senderInfo.name : 'Unknown';
    console.log(`📤 Message SENT from ${senderName} (${sender_type}):`, text || '[Media message]', `ID: ${id}`);

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
    const receiverInfo = users[socket.id];
    const receiverName = receiverInfo ? receiverInfo.name : 'Unknown';
    console.log(`📥 Message RECEIVED by ${receiverName}:`, message.text || '[Media message]');
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔴 User disconnected: ${socket.id}, reason: ${reason}`);
    
    // Clean up message queue for disconnected socket
    if (messageQueue.has(socket.id)) {
      messageQueue.delete(socket.id);
      console.log(`🧹 Cleaned up message queue for disconnected socket: ${socket.id}`);
    }
    
    const disconnectedUser = users[socket.id];
    if (disconnectedUser?.type === 'admin') {
      adminOnline = false;
      io.emit('adminStatus', false);
      console.log('👑 Admin went offline');
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

      console.log(`✅ Found ${messageRows.length} message records for driver: ${req.params.driverId}`);

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
      console.log(`📦 Returning ${messages.length} grouped messages for driver: ${req.params.driverId}`);
      
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

// Get queue status endpoint
app.get('/api/queue-status', (req, res) => {
  const queueStatus = {};
  messageQueue.forEach((queue, socketId) => {
    queueStatus[socketId] = {
      queueLength: queue.length,
      user: users[socketId] || 'Unknown'
    };
  });
  
  res.json({
    totalQueues: messageQueue.size,
    queues: queueStatus,
    totalConnectedUsers: Object.keys(users).length,
    adminOnline: adminOnline
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    adminOnline: adminOnline,
    connectedUsers: Object.keys(users).length,
    messageQueues: messageQueue.size
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
  console.log(`   - GET /api/messages/:driverId - Get messages for driver`);
  console.log(`   - DELETE /api/messages/:messageId - Delete specific message`);
  console.log(`   - GET /api/queue-status - Check message queue status`);
  console.log(`\n📊 Server features:`);
  console.log(`   ✅ Message queue system for rapid messaging`);
  console.log(`   ✅ Database connection pooling (20 connections)`);
  console.log(`   ✅ Transaction support for data consistency`);
  console.log(`   ✅ Automatic retry on database errors`);
  console.log(`   ✅ Real-time message delivery tracking`);
});
