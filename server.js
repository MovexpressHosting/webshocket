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
        sender_type ENUM('user', 'support', 'customer') NOT NULL,
        chat_type ENUM('driver', 'customer') NOT NULL DEFAULT 'driver',
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
        media_type ENUM('image', 'video', 'gif') NOT NULL,
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        chat_type ENUM('driver', 'customer') NOT NULL DEFAULT 'driver',
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
      userId: userId,
    };
    console.log(`User registered as ${userType}:`, socket.id, users[socket.id].name);
    
    if (userType === 'admin') {
      socket.join('admin');
      adminOnline = true;
      io.emit('adminStatus', true);
      console.log('Admin joined admin room');
    } else if (userType === 'user') {
      // Driver
      socket.join(`driver_${userId}`);
      console.log(`Driver joined driver_${userId} room`);
    } else if (userType === 'customer') {
      // Customer
      socket.join(`customer_${userId}`);
      console.log(`Customer joined customer_${userId} room`);
    }
    
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      userId: user.userId,
    }));
    io.emit('onlineUsers', onlineUsers);
  });

  socket.on('joinChat', (data) => {
    const { chatId, userType, userId } = data;
    users[socket.id] = {
      type: userType,
      name: userType === 'customer' ? `Customer-${userId}` : `User-${userId}`,
      userId: userId,
    };
    
    if (userType === 'customer') {
      socket.join(`customer_${chatId}`);
      console.log(`Customer ${userId} joined customer_${chatId} room`);
    } else if (userType === 'admin') {
      socket.join('admin');
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

  socket.on('getDriverSocketId', (driverId, callback) => {
    const driverSocket = Object.entries(users).find(
      ([id, user]) => user.userId === driverId && user.type === 'user'
    );
    if (driverSocket) {
      callback(driverSocket[0]);
    } else {
      callback(null);
    }
  });

  socket.on('getCustomerSocketId', (customerId, callback) => {
    const customerSocket = Object.entries(users).find(
      ([id, user]) => user.userId === customerId && user.type === 'customer'
    );
    if (customerSocket) {
      callback(customerSocket[0]);
    } else {
      callback(null);
    }
  });

  socket.on('disconnectUser', (userId, userType) => {
    console.log('Manual user disconnection:', userId, userType);

    const userSockets = Object.entries(users).filter(
      ([id, user]) => user.userId === userId && user.type === userType
    );

    userSockets.forEach(([socketId, user]) => {
      console.log(`Removing user socket: ${socketId} for ${userType}: ${userId}`);
      delete users[socketId];

      const userSocket = io.sockets.sockets.get(socketId);
      if (userSocket) {
        userSocket.disconnect(true);
      }
    });

    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      userId: user.userId,
    }));
    io.emit('onlineUsers', onlineUsers);

    console.log(`${userType} ${userId} manually disconnected. Remaining users:`, Object.keys(users).length);
  });

  socket.on('sendMessage', async (message) => {
    console.log('📨 Message received:', {
      id: message.id,
      sender_type: message.sender_type,
      chat_type: message.chat_type,
      driverId: message.driverId,
      customerId: message.customerId,
      has_media: message.media?.length || 0
    });

    const messageId = message.id || `msg-${Date.now()}`;
    const isCustomerChat = message.chat_type === 'customer' || message.customerId;
    const chatType = isCustomerChat ? 'customer' : 'driver';
    
    const messageWithTimestamp = {
      ...message,
      id: messageId,
      timestamp: new Date().toISOString(),
      senderId: socket.id,
      senderName: users[socket.id]?.name || 'Unknown',
      sender: users[socket.id]?.type === 'admin' ? 'support' : (isCustomerChat ? 'customer' : 'user'),
      sender_type: users[socket.id]?.type === 'admin' ? 'support' : (isCustomerChat ? 'customer' : 'user'),
      driverId: message.driverId,
      customerId: message.customerId,
      chat_type: chatType,
    };

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Save message to database
      await connection.query(
        'INSERT INTO messages (message_id, sender_id, receiver_id, driver_id, customer_id, text, timestamp, sender_type, chat_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          messageWithTimestamp.id,
          socket.id,
          messageWithTimestamp.receiverId,
          messageWithTimestamp.driverId || null,
          messageWithTimestamp.customerId || null,
          messageWithTimestamp.text || '',
          messageWithTimestamp.timestamp,
          messageWithTimestamp.sender_type,
          chatType
        ]
      );

      await connection.commit();
      console.log('✅ Message saved to database');

    } catch (error) {
      await connection.rollback();
      console.error('❌ Error saving message:', error);
      return;
    } finally {
      connection.release();
    }

    // Emit message to appropriate recipients
    if (isCustomerChat) {
      // Customer chat
      if (messageWithTimestamp.sender_type === 'customer') {
        // Customer sending to admin
        io.to('admin').emit('receiveMessage', messageWithTimestamp);
        console.log('📤 Customer message sent to admin');
      } else {
        // Admin sending to customer
        io.to(`customer_${messageWithTimestamp.customerId}`).emit('receiveMessage', messageWithTimestamp);
        console.log(`📤 Admin message sent to customer_${messageWithTimestamp.customerId}`);
      }
    } else {
      // Driver chat
      if (messageWithTimestamp.sender_type === 'user') {
        // Driver sending to admin
        io.to('admin').emit('receiveMessage', messageWithTimestamp);
        console.log('📤 Driver message sent to admin');
      } else {
        // Admin sending to driver
        io.to(`driver_${messageWithTimestamp.driverId}`).emit('receiveMessage', messageWithTimestamp);
        console.log(`📤 Admin message sent to driver_${messageWithTimestamp.driverId}`);
      }
    }

    // Send notification for offline users
    if (messageWithTimestamp.sender_type === 'customer' || messageWithTimestamp.sender_type === 'user') {
      // Customer or driver sent message, notify admin
      io.to('admin').emit('newMessageNotification', {
        from: messageWithTimestamp.senderName,
        message: messageWithTimestamp.text,
        chatType: chatType,
        chatId: isCustomerChat ? messageWithTimestamp.customerId : messageWithTimestamp.driverId,
        timestamp: messageWithTimestamp.timestamp
      });
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

// Get messages for driver
app.get('/api/messages/:driverId', async (req, res) => {
  try {
    console.log('📡 Fetching driver messages for:', req.params.driverId);

    const [messages] = await pool.query(
      `SELECT m.*,
       CASE
         WHEN m.sender_type = 'support' THEN 'support'
         ELSE 'user'
       END as sender
       FROM messages m
       WHERE m.driver_id = ? AND m.chat_type = 'driver'
       ORDER BY m.timestamp ASC`,
      [req.params.driverId]
    );

    console.log(`📦 Found ${messages.length} driver messages`);

    if (messages.length === 0) {
      return res.json([]);
    }

    const messageIds = messages.map(msg => msg.message_id);

    const [mediaRows] = await pool.query(
      `SELECT * FROM media_uploads WHERE message_id IN (?) ORDER BY upload_time ASC`,
      [messageIds]
    );

    console.log(`📸 Found ${mediaRows.length} media files for driver`);

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

    const messagesWithMedia = messages.map(message => ({
      ...message,
      media: mediaMap[message.message_id] || []
    }));

    console.log(`✅ Loaded ${messagesWithMedia.length} driver messages with ${mediaRows.length} media files`);

    res.json(messagesWithMedia);
  } catch (error) {
    console.error('❌ Error fetching driver messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Get messages for customer
app.get('/api/customer-messages/:customerId', async (req, res) => {
  try {
    console.log('📡 Fetching customer messages for:', req.params.customerId);

    const [messages] = await pool.query(
      `SELECT m.*,
       CASE
         WHEN m.sender_type = 'support' THEN 'support'
         ELSE 'customer'
       END as sender
       FROM messages m
       WHERE m.customer_id = ? AND m.chat_type = 'customer'
       ORDER BY m.timestamp ASC`,
      [req.params.customerId]
    );

    console.log(`📦 Found ${messages.length} customer messages`);

    if (messages.length === 0) {
      return res.json([]);
    }

    const messageIds = messages.map(msg => msg.message_id);

    const [mediaRows] = await pool.query(
      `SELECT * FROM media_uploads WHERE message_id IN (?) ORDER BY upload_time ASC`,
      [messageIds]
    );

    console.log(`📸 Found ${mediaRows.length} media files for customer`);

    const mediaMap = {};
    mediaRows.forEach(media => {
      if (!mediaMap[media.message_id]) {
        mediaMap[media.message_id] = [];
      }
      mediaMap[media.message_id].push({
        id: media.id,
        message_id: media.message_id,
        customer_id: media.customer_id,
        file_name: media.file_name,
        file_url: media.file_url,
        media_type: media.media_type,
        upload_time: media.upload_time
      });
    });

    const messagesWithMedia = messages.map(message => ({
      ...message,
      media: mediaMap[message.message_id] || []
    }));

    console.log(`✅ Loaded ${messagesWithMedia.length} customer messages with ${mediaRows.length} media files`);

    res.json(messagesWithMedia);
  } catch (error) {
    console.error('❌ Error fetching customer messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/debug-media', async (req, res) => {
  try {
    const [mediaRows] = await pool.query('SELECT * FROM media_uploads ORDER BY upload_time DESC LIMIT 10');
    const [messageRows] = await pool.query('SELECT message_id, driver_id, customer_id, text, chat_type FROM messages ORDER BY timestamp DESC LIMIT 10');

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
