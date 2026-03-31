const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg'); // PostgreSQL
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ========== SENDGRID EMAIL SETUP ==========
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey('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');

// ========== SUPABASE POSTGRESQL CONNECTION ==========
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.vbpehelxdstkasscjiov:6AEm4AvvZPgEkpSx@aws-1-eu-west-1.pooler.supabase.com:6543/postgres',
    ssl: {
        rejectUnauthorized: false,
        sslmode: 'require'
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// Global connection status
let dbConnected = false;
let connectionChecked = false;

// Test database connection
async function testDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Admin DB connected to Supabase PostgreSQL!');
        dbConnected = true;
        connectionChecked = true;
        client.release();
        
        // Test a simple query
        await client.query('SELECT 1');
        console.log('✅ Admin database queries working');
        
        // Create tables if they don't exist
        await createAdminTable();
        
        return true;
    } catch (err) {
        console.error('❌ Error connecting admin to Supabase PostgreSQL:', err.message);
        dbConnected = false;
        connectionChecked = true;
        return false;
    }
}

// Test connection immediately
testDatabaseConnection();

// Retry connection every 30 seconds
setInterval(testDatabaseConnection, 30000);

// Middleware to check database status
router.use((req, res, next) => {
    req.dbConnected = dbConnected;
    req.connectionChecked = connectionChecked;
    next();
});

// ========== ADMIN TABLES SETUP ==========

// Create admin table (PostgreSQL version with your exact table structure)
async function createAdminTable() {
    if (!dbConnected) return;
    
    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS admin_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            security_code VARCHAR(10) NOT NULL,
            full_name VARCHAR(100) NOT NULL,
            email VARCHAR(100) NOT NULL UNIQUE,
            role VARCHAR(20) DEFAULT 'admin',
            is_active BOOLEAN DEFAULT TRUE,
            login_attempts INTEGER DEFAULT 0,
            account_locked_until TIMESTAMP,
            last_login TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;
    
    try {
        await pool.query(createTableSQL);
        console.log('✅ Admin table checked/created');
        await createDefaultAdmin();
    } catch (err) {
        console.error('❌ Error creating admin table:', err);
    }
}

// Create payment notifications table
async function createPaymentNotificationsTable() {
    if (!dbConnected) return;
    
    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS payment_notifications (
            id SERIAL PRIMARY KEY,
            payment_id VARCHAR(100) NOT NULL,
            user_email VARCHAR(100) NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            currency VARCHAR(10) NOT NULL,
            payment_method VARCHAR(50) NOT NULL,
            status VARCHAR(50) NOT NULL,
            note TEXT,
            is_read SMALLINT DEFAULT 0,
            admin_notified SMALLINT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;
    
    try {
        await pool.query(createTableSQL);
        console.log('✅ Payment notifications table checked/created');
    } catch (err) {
        console.error('❌ Error creating payment notifications table:', err);
    }
}

// Create default admin user
async function createDefaultAdmin() {
    if (!dbConnected) return;
    
    try {
        const adminUsername = 'piotech52@gmail.com';
        const adminEmail = 'piotech52@gmail.com';
        const adminPassword = 'piotech@52gmail.com';
        const adminSecurityCode = 'piotech52@gmail.com';
        const adminFullName = 'Pio Tech Administrator';
        
        const checkQuery = "SELECT id FROM admin_users WHERE username = $1 OR email = $2";
        const result = await pool.query(checkQuery, [adminUsername, adminEmail]);
        
        if (result.rows.length === 0) {
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);
            
            const insertQuery = `
                INSERT INTO admin_users 
                (username, email, password, security_code, full_name, role, is_active) 
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `;
            
            await pool.query(insertQuery, [
                adminUsername,
                adminEmail,
                hashedPassword,
                adminSecurityCode,
                adminFullName,
                'super_admin',
                true
            ]);
            
            console.log('✅ Default admin user created successfully');
            console.log('📋 Admin Credentials:');
            console.log('   Username/Email:', adminUsername);
            console.log('   Password:', adminPassword);
            console.log('   Security Code:', adminSecurityCode);
            
            // Create payment notifications table after admin is created
            await createPaymentNotificationsTable();
        } else {
            console.log('✅ Default admin user already exists');
            await createPaymentNotificationsTable();
        }
        
    } catch (error) {
        console.error('❌ Error in createDefaultAdmin:', error);
    }
}

// ========== MIDDLEWARE ==========

// Middleware to check admin authentication
const checkAdminAuth = (req, res, next) => {
    if (!req.session || !req.session.adminLoggedIn) {
        return res.redirect('/admin/login');
    }
    next();
};

// Configure multer for question images
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'question-images/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|webp/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only image files are allowed!'));
    }
});

// ========== EMAIL FUNCTIONS ==========

// Function to send admin email notification
async function sendPaymentEmailNotification(paymentData) {
    try {
        const adminEmail = 'piotech52@gmail.com';
        const { user_email, amount, currency, payment_method, payment_id, note } = paymentData;
        
        const emailContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #1a237e 0%, #311b92 100%); padding: 30px; text-align: center;">
                    <h1 style="color: white; margin: 0;">💰 New Payment Received</h1>
                </div>
                <div style="padding: 30px; background: white;">
                    <h2 style="color: #1a237e;">Payment Notification</h2>
                    <p>A new payment has been received on JAMB Prep platform:</p>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <table style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>Payment ID:</strong></td>
                                <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;">${payment_id}</td>
                              </tr>
                              <tr>
                                <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>User Email:</strong></td>
                                <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;">${user_email}</td>
                              </tr>
                              <tr>
                                <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>Amount:</strong></td>
                                <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;">${currency} ${amount}</td>
                              </tr>
                              <tr>
                                <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>Payment Method:</strong></td>
                                <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;">${payment_method}</td>
                              </tr>
                              <tr>
                                <td style="padding: 10px;"><strong>Note:</strong></td>
                                <td style="padding: 10px;">${note || 'No note provided'}</td>
                              </tr>
                            </table>
                    </div>
                    
                    <div style="margin-top: 30px; padding: 15px; background: #e8f4fd; border-radius: 8px; border-left: 4px solid #3498db;">
                        <p style="margin: 0; color: #2c3e50;">
                            <strong>Action Required:</strong> Please log in to the admin dashboard to view complete details and process this payment.
                        </p>
                    </div>
                    
                    <div style="margin-top: 30px; text-align: center;">
                        <a href="/admin/dashboard" 
                           style="display: inline-block; background: #1a237e; color: white; padding: 15px 30px; 
                                  text-decoration: none; border-radius: 5px; font-weight: bold;">
                            Go to Admin Dashboard
                        </a>
                    </div>
                    
                    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                        <p style="color: #666; font-size: 0.9rem;">
                            This is an automated notification. Please do not reply to this email.<br>
                            Best regards,<br>
                            The JAMB Prep System
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        const msg = {
            to: adminEmail,
            from: 'piotech52@gmail.com',
            subject: `💰 New Payment Received - ${payment_id}`,
            html: emailContent
        };
        
        await sgMail.send(msg);
        
        console.log(`✅ Payment email notification sent to admin`);
        return true;
    } catch (error) {
        console.error('❌ Error sending payment email notification:', error);
        return false;
    }
}

// ========== ADMIN LOGIN ROUTES ==========

// Admin login page
router.get("/admin/login", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login</title>
            <style>
                body { font-family: Arial; padding: 50px; text-align: center; 
                    background: linear-gradient(135deg, #1a237e 0%, #311b92 100%);
                    height: 100vh; display: flex; justify-content: center; align-items: center; }
                .login-box { background: white; padding: 40px; border-radius: 10px; 
                    box-shadow: 0 15px 35px rgba(0,0,0,0.3); width: 100%; max-width: 400px; }
                h1 { color: #1a237e; margin-bottom: 30px; }
                input { width: 100%; padding: 12px; margin: 10px 0; border: 2px solid #ddd; 
                    border-radius: 5px; font-size: 16px; }
                button { width: 100%; padding: 12px; background: #1a237e; color: white; 
                    border: none; border-radius: 5px; font-size: 16px; cursor: pointer; 
                    margin-top: 20px; }
                button:hover { background: #311b92; }
                .back { display: inline-block; margin-top: 20px; color: #1a237e; 
                    text-decoration: none; }
                .credentials { margin-top: 20px; padding: 15px; background: #f8f9fa; 
                    border-radius: 5px; font-size: 14px; text-align: left; }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h1>🔐 Admin Login</h1>
                <form id="loginForm">
                    <input type="text" id="username" placeholder="Username or Email" required>
                    <input type="password" id="password" placeholder="Password" required>
                    <input type="text" id="securityCode" placeholder="Security Code" required>
                    <button type="submit">Login</button>
                </form>
                <div id="message" style="margin-top: 15px;"></div>
                <div class="credentials">
                    <strong>Default Admin Credentials:</strong><br>
                    Username/Email: <code>piotech52@gmail.com</code><br>
                    Password: <code>piotech@52gmail.com</code><br>
                    Security Code: <code>piotech52@gmail.com</code>
                </div>
                <a href="/" class="back">← Back to Home</a>
            </div>
            <script>
                document.getElementById('loginForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const username = document.getElementById('username').value;
                    const password = document.getElementById('password').value;
                    const securityCode = document.getElementById('securityCode').value;
                    const messageDiv = document.getElementById('message');
                    
                    messageDiv.textContent = 'Logging in...';
                    messageDiv.style.color = 'green';
                    
                    try {
                        const response = await fetch('/api/auth/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ username, password, security_code: securityCode })
                        });
                        
                        const data = await response.json();
                        
                        if (data.success) {
                            messageDiv.textContent = 'Login successful! Redirecting...';
                            window.location.href = '/admin/dashboard';
                        } else {
                            messageDiv.textContent = data.message || 'Login failed';
                            messageDiv.style.color = 'red';
                        }
                    } catch (error) {
                        messageDiv.textContent = 'Connection error';
                        messageDiv.style.color = 'red';
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// Admin login API
router.post("/api/auth/login", async (req, res) => {
    const { username, password, security_code } = req.body;
    
    console.log('🔐 Admin login attempt:', username);

    // Check if database is connected
    if (!dbConnected) {
        return res.status(503).json({
            success: false,
            message: 'Database is currently unavailable. Please try again later.'
        });
    }

    if (!username || !password || !security_code) {
        return res.status(400).json({
            success: false,
            message: 'All fields are required'
        });
    }

    try {
        // Use TRUE for BOOLEAN column
        const query = "SELECT * FROM admin_users WHERE (username = $1 OR email = $1) AND is_active = TRUE";
        
        const result = await pool.query(query, [username]);

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const admin = result.rows[0];
        
        if (admin.role === 'user') {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        if (admin.security_code !== security_code) {
            return res.status(401).json({
                success: false,
                message: 'Invalid security code'
            });
        }

        const isPasswordValid = await bcrypt.compare(password, admin.password);
        
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid password'
            });
        }

        console.log('✅ Admin login successful:', username);
        
        // Create admin session
        req.session.adminId = admin.id;
        req.session.adminUsername = admin.username;
        req.session.adminEmail = admin.email;
        req.session.adminRole = admin.role;
        req.session.adminLoggedIn = true;
        
        const token = jwt.sign(
            { id: admin.id, username: admin.username, role: admin.role, email: admin.email },
            'jamb-admin-secret-key-2024',
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            message: 'Admin login successful',
            token: token,
            user: {
                id: admin.id,
                username: admin.username,
                email: admin.email,
                full_name: admin.full_name,
                role: admin.role
            }
        });
        
    } catch (error) {
        console.error('❌ Login error details:', {
            message: error.message,
            code: error.code,
            hint: error.hint
        });
        
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// Admin logout
router.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Logout failed' });
        }
        res.json({ success: true, message: 'Logged out' });
    });
});

// ========== ADMIN DASHBOARD ==========
// This route is now simplified and guaranteed to work
router.get("/admin/dashboard", checkAdminAuth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Dashboard</title>
            <style>
                body { font-family: Arial; margin: 0; padding: 20px; background: #f5f5f5; }
                .header { background: #1a237e; color: white; padding: 20px; margin-bottom: 20px; border-radius: 5px; }
                .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 20px; }
                .stat-card { background: white; padding: 20px; border-radius: 5px; text-align: center; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
                .stat-value { font-size: 32px; font-weight: bold; color: #1a237e; }
                .actions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
                .action-btn { background: white; padding: 20px; text-align: center; border-radius: 5px; text-decoration: none; color: #333; box-shadow: 0 2px 5px rgba(0,0,0,0.1); cursor: pointer; display: block; }
                .action-btn:hover { background: #1a237e; color: white; transform: translateY(-2px); }
                .logout-btn { background: #e74c3c; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; float: right; }
                .logout-btn:hover { background: #c0392b; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🎯 JAMB Prep Admin Dashboard</h1>
                <p>Welcome back, ${req.session.adminUsername || 'Admin'}!</p>
                <button class="logout-btn" onclick="logout()">Logout</button>
            </div>
            
            <div class="stats">
                <div class="stat-card">
                    <div class="stat-value" id="totalUsers">0</div>
                    <div>Total Users</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="totalRevenue">₦0</div>
                    <div>Total Revenue</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="totalPayments">0</div>
                    <div>Total Payments</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="unreadNotifications">0</div>
                    <div>Unread Notifications</div>
                </div>
            </div>
            
            <div class="actions">
                <a href="/admin/users" class="action-btn">
                    <h3>👥 User Management</h3>
                    <p>View and manage users</p>
                </a>
                <a href="/admin/payments" class="action-btn">
                    <h3>💰 Payment Management</h3>
                    <p>View all payments</p>
                </a>
                <a href="/admin/questions" class="action-btn">
                    <h3>📚 Question Management</h3>
                    <p>Manage JAMB questions</p>
                </a>
                <div class="action-btn" onclick="sendActivation()">
                    <h3>🔑 Send Activation</h3>
                    <p>Send activation code to user</p>
                </div>
            </div>
            
            <script>
                async function loadStats() {
                    try {
                        const response = await fetch('/api/admin/statistics');
                        const data = await response.json();
                        if (data.success) {
                            document.getElementById('totalUsers').textContent = data.statistics.totalUsers?.count || 0;
                            document.getElementById('totalRevenue').textContent = '₦' + (data.statistics.totalRevenue?.total || 0);
                            document.getElementById('totalPayments').textContent = data.statistics.totalPayments?.count || 0;
                            document.getElementById('unreadNotifications').textContent = data.statistics.unreadNotifications?.count || 0;
                        }
                    } catch (error) {
                        console.error('Error loading stats:', error);
                    }
                }
                
                function sendActivation() {
                    const email = prompt('Enter user email:');
                    if (email) {
                        fetch('/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email })
                        })
                        .then(res => res.json())
                        .then(data => alert(data.message || 'Activation code sent!'))
                        .catch(err => alert('Error sending activation code'));
                    }
                }
                
                async function logout() {
                    await fetch('/api/auth/logout', { method: 'POST' });
                    window.location.href = '/admin/login';
                }
                
                loadStats();
                setInterval(loadStats, 10000);
            </script>
        </body>
        </html>
    `);
});

// Keep all your other existing routes below...
// (Payment notification routes, payments management, user management, etc.)

// ========== PAYMENT NOTIFICATION ROUTES ==========
// API to create payment notification
router.post("/api/admin/payment-notification", async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { payment_id, user_email, amount, currency, payment_method, status, note } = req.body;
        
        console.log('💰 New payment notification:', { payment_id, user_email, amount });
        
        // Save notification to database
        const insertQuery = `
            INSERT INTO payment_notifications 
            (payment_id, user_email, amount, currency, payment_method, status, note) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `;
        
        const result = await pool.query(insertQuery, [payment_id, user_email, amount, currency, payment_method, status, note]);
        const notificationId = result.rows[0].id;
        
        // Send email notification to admin
        const emailSent = await sendPaymentEmailNotification({
            payment_id, user_email, amount, currency, payment_method, note
        });
        
        // Update notification record with email status
        const updateQuery = "UPDATE payment_notifications SET admin_notified = $1 WHERE id = $2";
        await pool.query(updateQuery, [emailSent ? 1 : 0, notificationId]);
        
        res.json({
            success: true,
            message: 'Payment notification created successfully',
            notificationId: notificationId,
            emailSent: emailSent
        });
        
    } catch (error) {
        console.error('❌ Error in payment notification:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// API to get unread notifications
router.get("/api/admin/notifications/unread", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const query = `
        SELECT pn.*, ju."userName" 
        FROM payment_notifications pn
        LEFT JOIN jambuser ju ON pn.user_email = ju.email
        WHERE pn.is_read = 0
        ORDER BY pn.created_at DESC
        LIMIT 20
    `;
    
    try {
        const result = await pool.query(query);
        res.json({
            success: true,
            notifications: result.rows,
            count: result.rows.length
        });
    } catch (err) {
        console.error('❌ Error fetching notifications:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// API to mark notification as read
router.post("/api/admin/notifications/:id/read", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const notificationId = req.params.id;
    
    const query = "UPDATE payment_notifications SET is_read = 1 WHERE id = $1";
    
    try {
        await pool.query(query, [notificationId]);
        res.json({ success: true, message: 'Notification marked as read' });
    } catch (err) {
        console.error('❌ Error marking notification as read:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// API to mark all notifications as read
router.post("/api/admin/notifications/mark-all-read", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const query = "UPDATE payment_notifications SET is_read = 1 WHERE is_read = 0";
    
    try {
        const result = await pool.query(query);
        res.json({
            success: true,
            message: 'All notifications marked as read',
            affectedRows: result.rowCount
        });
    } catch (err) {
        console.error('❌ Error marking all notifications as read:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ========== PAYMENTS MANAGEMENT ==========
// API to get all payments
router.get("/api/admin/payments", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const query = `
        SELECT up.*, ju."userName" 
        FROM user_payments up
        LEFT JOIN jambuser ju ON up.email = ju.email
        ORDER BY up.created_at DESC
    `;
    
    try {
        const result = await pool.query(query);
        res.json({ success: true, payments: result.rows });
    } catch (err) {
        console.error('❌ Error fetching payments:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Payments Management Page
router.get("/admin/payments", checkAdminAuth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Payments Management</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #f5f5f5; }
                .nav { background: #1a237e; padding: 15px; margin-bottom: 20px; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
                .nav a { color: white; margin-right: 20px; text-decoration: none; padding: 8px 15px; border-radius: 4px; }
                .nav a:hover { background: rgba(255,255,255,0.1); }
                .logout { background: #e74c3c; color: white; padding: 8px 15px; border: none; border-radius: 4px; cursor: pointer; }
                table { width: 100%; background: white; border-collapse: collapse; margin-top: 20px; }
                th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
                th { background: #1a237e; color: white; }
            </style>
        </head>
        <body>
            <div class="nav">
                <div>
                    <a href="/admin/dashboard">Dashboard</a>
                    <a href="/admin/users">Users</a>
                    <a href="/admin/payments">Payments</a>
                    <a href="/admin/questions">Questions</a>
                </div>
                <button class="logout" onclick="logout()">Logout</button>
            </div>
            <h1>💰 Payment Management</h1>
            <div id="payments"></div>
            <script>
                async function loadPayments() {
                    const response = await fetch('/api/admin/payments');
                    const data = await response.json();
                    if (data.success && data.payments) {
                        let html = '<table><tr><th>User</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th></tr>';
                        data.payments.forEach(p => {
                            html += `<tr><td>${p.userName || p.email}</td><td>₦${p.amount}</td><td>${p.payment_method}</td><td>${p.status}</td><td>${new Date(p.created_at).toLocaleDateString()}</td></tr>`;
                        });
                        html += '</table>';
                        document.getElementById('payments').innerHTML = html;
                    }
                }
                
                async function logout() {
                    await fetch('/api/auth/logout', { method: 'POST' });
                    window.location.href = '/admin/login';
                }
                
                loadPayments();
            </script>
        </body>
        </html>
    `);
});

// ========== USER MANAGEMENT ==========
router.get("/api/admin/users", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const usersQuery = `
            SELECT 
                id, 
                "userName", 
                email, 
                role, 
                is_activated, 
                "activationCode", 
                created_at,
                updated_at 
            FROM jambuser 
            ORDER BY created_at DESC
        `;
        const usersResult = await pool.query(usersQuery);
        const users = usersResult.rows;
        
        const statsQueries = {
            totalUsers: "SELECT COUNT(*) as count FROM jambuser",
            activeUsers: "SELECT COUNT(*) as count FROM jambuser WHERE is_activated = '1'",
            students: "SELECT COUNT(*) as count FROM jambuser WHERE role = 'student'",
            paidUsers: "SELECT COUNT(DISTINCT email) as count FROM user_payments WHERE status = 'completed'"
        };
        
        const stats = {};
        
        for (const [key, query] of Object.entries(statsQueries)) {
            try {
                const result = await pool.query(query);
                stats[key] = parseInt(result.rows[0]?.count) || 0;
            } catch (err) {
                console.error(`Error fetching ${key}:`, err);
                stats[key] = 0;
            }
        }
        
        res.json({ success: true, users: users, stats: stats });
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.get("/admin/users", checkAdminAuth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>User Management</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #f5f5f5; }
                .nav { background: #1a237e; padding: 15px; margin-bottom: 20px; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
                .nav a { color: white; margin-right: 20px; text-decoration: none; padding: 8px 15px; border-radius: 4px; }
                .nav a:hover { background: rgba(255,255,255,0.1); }
                .logout { background: #e74c3c; color: white; padding: 8px 15px; border: none; border-radius: 4px; cursor: pointer; }
                table { width: 100%; background: white; border-collapse: collapse; margin-top: 20px; }
                th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
                th { background: #1a237e; color: white; }
                .status-active { color: green; font-weight: bold; }
                .status-inactive { color: red; font-weight: bold; }
                .btn { padding: 5px 10px; margin: 2px; border: none; border-radius: 3px; cursor: pointer; }
                .btn-activate { background: #2ecc71; color: white; }
                .btn-deactivate { background: #e67e22; color: white; }
                .btn-code { background: #3498db; color: white; }
            </style>
        </head>
        <body>
            <div class="nav">
                <div>
                    <a href="/admin/dashboard">Dashboard</a>
                    <a href="/admin/users">Users</a>
                    <a href="/admin/payments">Payments</a>
                    <a href="/admin/questions">Questions</a>
                </div>
                <button class="logout" onclick="logout()">Logout</button>
            </div>
            <h1>👥 User Management</h1>
            <div id="users"></div>
            <script>
                async function loadUsers() {
                    const response = await fetch('/api/admin/users');
                    const data = await response.json();
                    if (data.success) {
                        let html = ' 60% <th>Name</th><th>Email</th><th>Status</th><th>Code</th><th>Actions</th>  </tr';
                        data.users.forEach(user => {
                            const isActive = user.is_activated === '1';
                            html += \`
                                 water
                                    <td>\${user.userName || 'N/A'} </td
                                    <td>\${user.email} </td
                                    <td class="status-\${isActive ? 'active' : 'inactive'}">\${isActive ? 'Active' : 'Inactive'} </td
                                    <td>\${user.activationCode || 'No code'} </td
                                    <td>
                                        <button class="btn btn-code" onclick="sendCode('\${user.email}')">Send Code</button>
                                        \${!isActive ? 
                                            '<button class="btn btn-activate" onclick="activateUser(' + user.id + ')">Activate</button>' : 
                                            '<button class="btn btn-deactivate" onclick="deactivateUser(' + user.id + ')">Deactivate</button>'
                                        }
                                     </td
                                   </tr
                            \`;
                        });
                        html += ' </table';
                        document.getElementById('users').innerHTML = html;
                    }
                }
                
                async function sendCode(email) {
                    const response = await fetch('/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email })
                    });
                    const data = await response.json();
                    alert(data.message);
                }
                
                async function activateUser(id) {
                    const response = await fetch(\`/api/admin/users/\${id}/activate\`, { method: 'POST' });
                    const data = await response.json();
                    if (data.success) loadUsers();
                }
                
                async function deactivateUser(id) {
                    const response = await fetch(\`/api/admin/users/\${id}/deactivate\`, { method: 'POST' });
                    const data = await response.json();
                    if (data.success) loadUsers();
                }
                
                async function logout() {
                    await fetch('/api/auth/logout', { method: 'POST' });
                    window.location.href = '/admin/login';
                }
                
                loadUsers();
            </script>
        </body>
        </html>
    `);
});

router.post("/api/admin/users/:id/activate", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false });
    try {
        await pool.query(`UPDATE jambuser SET is_activated = '1' WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

router.post("/api/admin/users/:id/deactivate", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false });
    try {
        await pool.query(`UPDATE jambuser SET is_activated = '0' WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// ========== STATISTICS API ==========
router.get("/api/admin/statistics", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const queries = {
        totalUsers: "SELECT COUNT(*) as count FROM jambuser",
        activeUsers: "SELECT COUNT(*) as count FROM jambuser WHERE is_activated = '1'",
        totalPayments: "SELECT COUNT(*) as count FROM user_payments",
        totalRevenue: "SELECT COALESCE(SUM(amount), 0) as total FROM user_payments WHERE status = 'completed'",
        unreadNotifications: "SELECT COUNT(*) as count FROM payment_notifications WHERE is_read = 0"
    };
    
    const results = {};
    
    try {
        for (const [key, query] of Object.entries(queries)) {
            try {
                const result = await pool.query(query);
                if (key === 'totalRevenue') {
                    results[key] = { total: parseFloat(result.rows[0]?.total) || 0 };
                } else {
                    results[key] = { count: parseInt(result.rows[0]?.count) || 0 };
                }
            } catch (err) {
                console.error(`Error fetching ${key}:`, err);
                if (key === 'totalRevenue') {
                    results[key] = { total: 0 };
                } else {
                    results[key] = { count: 0 };
                }
            }
        }
        
        res.json({ success: true, statistics: results });
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ========== ACTIVATION CODE ROUTE ==========
router.post("/send", async (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    function generateActivationCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    const { email } = req.body;
    const activationCode = generateActivationCode();
    
    try {
        const paymentResult = await pool.query("SELECT * FROM user_payments WHERE email = $1", [email]);
        if (paymentResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: "User has not made payment" });
        }
        
        const userResult = await pool.query("SELECT * FROM jambuser WHERE email = $1", [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: "User not found" });
        }
        
        await pool.query('UPDATE jambuser SET "activationCode" = $1 WHERE email = $2', [activationCode, email]);
        
        const emailContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #1a237e 0%, #311b92 100%); padding: 30px; text-align: center;">
                    <h1 style="color: white;">🎯 JAMB Prep</h1>
                </div>
                <div style="padding: 30px;">
                    <h2>Your Activation Code</h2>
                    <p>Hello,</p>
                    <p>Here is your activation code:</p>
                    <div style="background: #f0f0f0; padding: 20px; text-align: center; font-size: 24px; font-weight: bold;">
                        ${activationCode}
                    </div>
                    <p>Use this code to activate your account.</p>
                </div>
            </div>
        `;
        
        await sgMail.send({
            to: email,
            from: 'piotech52@gmail.com',
            subject: "Your JAMB Prep Activation Code",
            html: emailContent
        });
        
        res.json({ success: true, message: 'Activation code sent successfully' });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ========== QUESTION MANAGEMENT ==========
router.get("/admin/questions", checkAdminAuth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Question Management</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #f5f5f5; }
                .nav { background: #1a237e; padding: 15px; margin-bottom: 20px; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
                .nav a { color: white; margin-right: 20px; text-decoration: none; padding: 8px 15px; border-radius: 4px; }
                .nav a:hover { background: rgba(255,255,255,0.1); }
                .logout { background: #e74c3c; color: white; padding: 8px 15px; border: none; border-radius: 4px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="nav">
                <div>
                    <a href="/admin/dashboard">Dashboard</a>
                    <a href="/admin/users">Users</a>
                    <a href="/admin/payments">Payments</a>
                    <a href="/admin/questions">Questions</a>
                </div>
                <button class="logout" onclick="logout()">Logout</button>
            </div>
            <h1>📚 Question Management</h1>
            <p>Question management features coming soon...</p>
            <script>
                async function logout() {
                    await fetch('/api/auth/logout', { method: 'POST' });
                    window.location.href = '/admin/login';
                }
            </script>
        </body>
        </html>
    `);
});

router.get("/api/admin/check-access", (req, res) => {
    res.json({ success: true, isAdmin: req.session?.adminLoggedIn || false });
});

module.exports = router;
