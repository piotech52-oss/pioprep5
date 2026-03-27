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
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.vbpehelxdstkasscjiov:PioPrep2024!@aws-1-eu-west-1.pooler.supabase.com:6543/postgres',
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
                        <a href="http://localhost:3000/admin/dashboard" 
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
                            setTimeout(() => {
                                window.location.href = '/admin/dashboard';
                            }, 1000);
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

// ========== DEBUG ROUTE ==========
// Add this debug route to check admin database connection
router.get("/api/admin/debug-db", async (req, res) => {
    res.json({
        dbConnected: dbConnected,
        connectionChecked: connectionChecked,
        databaseUrl: process.env.DATABASE_URL ? 'Set' : 'Not set',
        supabaseUrl: process.env.SUPABASE_URL ? 'Set' : 'Not set',
        nodeEnv: process.env.NODE_ENV,
        timestamp: new Date().toISOString()
    });
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
router.get("/admin/dashboard", checkAdminAuth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Dashboard - JAMB Prep</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
                }

                :root {
                    --primary: #4361ee;
                    --primary-dark: #3a56d4;
                    --secondary: #7209b7;
                    --success: #06d6a0;
                    --warning: #ffd166;
                    --danger: #ef476f;
                    --dark: #1a1a2e;
                    --light: #f8f9fa;
                    --gray: #6c757d;
                    --gray-light: #e9ecef;
                    --border-radius: 12px;
                    --shadow: 0 8px 30px rgba(0,0,0,0.08);
                    --transition: all 0.3s ease;
                }

                body {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    padding: 20px;
                }

                .dashboard-container {
                    max-width: 1800px;
                    margin: 0 auto;
                }

                .dashboard-header {
                    background: white;
                    border-radius: var(--border-radius);
                    padding: 25px 30px;
                    margin-bottom: 30px;
                    box-shadow: var(--shadow);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .header-left h1 {
                    color: var(--dark);
                    font-size: 28px;
                    margin-bottom: 8px;
                }

                .header-left p {
                    color: var(--gray);
                    font-size: 16px;
                }

                .header-right {
                    display: flex;
                    align-items: center;
                    gap: 20px;
                }

                .notification-wrapper {
                    position: relative;
                }

                .notification-bell {
                    width: 50px;
                    height: 50px;
                    background: var(--light);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    transition: var(--transition);
                    position: relative;
                }

                .notification-bell:hover {
                    background: var(--primary);
                    color: white;
                    transform: translateY(-2px);
                }

                .notification-bell i {
                    font-size: 20px;
                }

                .notification-count {
                    position: absolute;
                    top: -5px;
                    right: -5px;
                    background: var(--danger);
                    color: white;
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 12px;
                    font-weight: bold;
                    animation: pulse 2s infinite;
                }

                @keyframes pulse {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.1); }
                    100% { transform: scale(1); }
                }

                .logout-btn {
                    background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                    color: white;
                    border: none;
                    padding: 12px 28px;
                    border-radius: 8px;
                    font-weight: 600;
                    font-size: 14px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    transition: var(--transition);
                }

                .logout-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 20px rgba(67, 97, 238, 0.3);
                }

                .dashboard-grid {
                    display: grid;
                    grid-template-columns: 2fr 1fr;
                    gap: 30px;
                }

                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 20px;
                    margin-bottom: 30px;
                }

                .stat-card {
                    background: white;
                    border-radius: var(--border-radius);
                    padding: 25px;
                    box-shadow: var(--shadow);
                    transition: var(--transition);
                    position: relative;
                    overflow: hidden;
                }

                .stat-card:hover {
                    transform: translateY(-5px);
                    box-shadow: 0 15px 35px rgba(0,0,0,0.1);
                }

                .stat-card::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 4px;
                }

                .stat-card.users::before { background: linear-gradient(90deg, #667eea 0%, #764ba2 100%); }
                .stat-card.revenue::before { background: linear-gradient(90deg, #06d6a0 0%, #1b9aaa 100%); }
                .stat-card.payments::before { background: linear-gradient(90deg, #ffd166 0%, #ff9e00 100%); }
                .stat-card.notifications::before { background: linear-gradient(90deg, #ef476f 0%, #ff6b6b 100%); }

                .stat-icon {
                    width: 56px;
                    height: 56px;
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-bottom: 20px;
                    font-size: 24px;
                    color: white;
                }

                .stat-card.users .stat-icon { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                .stat-card.revenue .stat-icon { background: linear-gradient(135deg, #06d6a0 0%, #1b9aaa 100%); }
                .stat-card.payments .stat-icon { background: linear-gradient(135deg, #ffd166 0%, #ff9e00 100%); }
                .stat-card.notifications .stat-icon { background: linear-gradient(135deg, #ef476f 0%, #ff6b6b 100%); }

                .stat-value {
                    font-size: 32px;
                    font-weight: 700;
                    color: var(--dark);
                    margin-bottom: 5px;
                    line-height: 1;
                }

                .stat-label {
                    color: var(--gray);
                    font-size: 14px;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .stat-change {
                    font-size: 12px;
                    margin-top: 8px;
                    display: flex;
                    align-items: center;
                    gap: 5px;
                }

                .stat-change.positive { color: #06d6a0; }
                .stat-change.negative { color: #ef476f; }

                .quick-actions {
                    background: white;
                    border-radius: var(--border-radius);
                    padding: 30px;
                    margin-bottom: 30px;
                    box-shadow: var(--shadow);
                }

                .section-title {
                    color: var(--dark);
                    font-size: 20px;
                    font-weight: 600;
                    margin-bottom: 25px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .actions-grid {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 15px;
                }

                .action-btn {
                    background: white;
                    border: 2px solid var(--gray-light);
                    border-radius: 10px;
                    padding: 25px 20px;
                    text-align: center;
                    cursor: pointer;
                    transition: var(--transition);
                    text-decoration: none;
                    color: var(--dark);
                    display: block;
                }

                .action-btn:hover {
                    background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                    color: white;
                    transform: translateY(-5px);
                    box-shadow: 0 15px 30px rgba(67, 97, 238, 0.2);
                    border-color: var(--primary);
                }

                .action-icon {
                    font-size: 32px;
                    margin-bottom: 15px;
                    display: block;
                }

                .action-text {
                    font-size: 16px;
                    font-weight: 600;
                    margin-bottom: 5px;
                }

                .action-desc {
                    font-size: 13px;
                    opacity: 0.8;
                }

                .recent-payments {
                    background: white;
                    border-radius: var(--border-radius);
                    padding: 30px;
                    box-shadow: var(--shadow);
                    overflow: hidden;
                }

                .table-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }

                .table-container {
                    overflow-x: auto;
                }

                .payments-table {
                    width: 100%;
                    border-collapse: collapse;
                    min-width: 800px;
                }

                .payments-table th {
                    background: var(--light);
                    padding: 16px 20px;
                    text-align: left;
                    font-weight: 600;
                    color: var(--dark);
                    font-size: 14px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .payments-table td {
                    padding: 16px 20px;
                    border-bottom: 1px solid var(--gray-light);
                    color: var(--dark);
                    font-size: 14px;
                }

                .payments-table tr {
                    transition: var(--transition);
                    cursor: pointer;
                }

                .payments-table tr:hover {
                    background: rgba(67, 97, 238, 0.05);
                }

                .user-cell {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .user-avatar {
                    width: 36px;
                    height: 36px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 14px;
                }

                .user-info {
                    line-height: 1.4;
                }

                .user-name {
                    font-weight: 500;
                    color: var(--dark);
                }

                .user-email {
                    font-size: 12px;
                    color: var(--gray);
                }

                .status-badge {
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 600;
                    display: inline-block;
                }

                .status-completed {
                    background: rgba(6, 214, 160, 0.1);
                    color: #06d6a0;
                }

                .status-pending {
                    background: rgba(255, 209, 102, 0.1);
                    color: #ff9e00;
                }

                .status-failed {
                    background: rgba(239, 71, 111, 0.1);
                    color: #ef476f;
                }

                .sidebar-section {
                    margin-bottom: 30px;
                }

                .activation-form {
                    background: white;
                    border-radius: var(--border-radius);
                    padding: 30px;
                    box-shadow: var(--shadow);
                }

                .form-group {
                    margin-bottom: 20px;
                }

                .form-group label {
                    display: block;
                    margin-bottom: 8px;
                    color: var(--dark);
                    font-weight: 500;
                    font-size: 14px;
                }

                .form-input {
                    width: 100%;
                    padding: 14px 16px;
                    border: 2px solid var(--gray-light);
                    border-radius: 8px;
                    font-size: 14px;
                    transition: var(--transition);
                }

                .form-input:focus {
                    outline: none;
                    border-color: var(--primary);
                    box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.1);
                }

                .submit-btn {
                    background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                    color: white;
                    border: none;
                    padding: 16px;
                    border-radius: 8px;
                    font-size: 15px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: var(--transition);
                    width: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 10px;
                }

                .submit-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 25px rgba(67, 97, 238, 0.3);
                }

                .submit-btn:disabled {
                    opacity: 0.7;
                    cursor: not-allowed;
                    transform: none;
                }

                .notifications-panel {
                    background: white;
                    border-radius: var(--border-radius);
                    padding: 30px;
                    box-shadow: var(--shadow);
                    max-height: 500px;
                    overflow-y: auto;
                }

                .notification-item {
                    padding: 16px;
                    border-bottom: 1px solid var(--gray-light);
                    cursor: pointer;
                    transition: var(--transition);
                }

                .notification-item:hover {
                    background: rgba(67, 97, 238, 0.05);
                }

                .notification-item.unread {
                    background: rgba(67, 97, 238, 0.08);
                    border-left: 3px solid var(--primary);
                }

                .notification-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 8px;
                }

                .notification-title {
                    font-weight: 600;
                    color: var(--dark);
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .notification-time {
                    font-size: 12px;
                    color: var(--gray);
                }

                .notification-content {
                    font-size: 13px;
                    color: var(--dark);
                    line-height: 1.5;
                    margin-bottom: 5px;
                }

                .notification-meta {
                    font-size: 12px;
                    color: var(--gray);
                }

                .notification-empty {
                    text-align: center;
                    padding: 40px 20px;
                    color: var(--gray);
                }

                .notification-empty i {
                    font-size: 48px;
                    margin-bottom: 15px;
                    opacity: 0.5;
                }

                .modal {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    backdrop-filter: blur(4px);
                    z-index: 1000;
                    justify-content: center;
                    align-items: center;
                    padding: 20px;
                }

                .modal-content {
                    background: white;
                    border-radius: var(--border-radius);
                    width: 100%;
                    max-width: 500px;
                    max-height: 90vh;
                    overflow-y: auto;
                    position: relative;
                    animation: modalSlideIn 0.3s ease;
                }

                @keyframes modalSlideIn {
                    from {
                        opacity: 0;
                        transform: translateY(-20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .modal-header {
                    padding: 25px 30px;
                    border-bottom: 1px solid var(--gray-light);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .modal-header h2 {
                    color: var(--dark);
                    font-size: 24px;
                    font-weight: 600;
                }

                .modal-close {
                    background: none;
                    border: none;
                    font-size: 24px;
                    color: var(--gray);
                    cursor: pointer;
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: var(--transition);
                }

                .modal-close:hover {
                    background: var(--gray-light);
                    color: var(--dark);
                }

                .modal-body {
                    padding: 30px;
                }

                .notification-details {
                    background: var(--light);
                    border-radius: 10px;
                    padding: 25px;
                    margin-bottom: 25px;
                }

                .detail-row {
                    display: flex;
                    margin-bottom: 15px;
                }

                .detail-label {
                    width: 120px;
                    color: var(--gray);
                    font-size: 14px;
                    font-weight: 500;
                }

                .detail-value {
                    flex: 1;
                    color: var(--dark);
                    font-size: 14px;
                    font-weight: 500;
                }

                .detail-value.highlight {
                    color: var(--primary);
                    font-weight: 600;
                }

                .modal-actions {
                    display: flex;
                    gap: 12px;
                    justify-content: flex-end;
                }

                .modal-btn {
                    padding: 12px 24px;
                    border: none;
                    border-radius: 8px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: var(--transition);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .modal-btn.primary {
                    background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                    color: white;
                }

                .modal-btn.success {
                    background: linear-gradient(135deg, #06d6a0 0%, #1b9aaa 100%);
                    color: white;
                }

                .modal-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 20px rgba(0,0,0,0.15);
                }

                .message {
                    padding: 15px;
                    border-radius: 8px;
                    margin-top: 20px;
                    font-size: 14px;
                    display: none;
                }

                .message.success {
                    background: rgba(6, 214, 160, 0.1);
                    color: #06d6a0;
                    border: 1px solid rgba(6, 214, 160, 0.2);
                    display: block;
                }

                .message.error {
                    background: rgba(239, 71, 111, 0.1);
                    color: #ef476f;
                    border: 1px solid rgba(239, 71, 111, 0.2);
                    display: block;
                }

                @media (max-width: 1200px) {
                    .dashboard-grid {
                        grid-template-columns: 1fr;
                    }
                    .stats-grid {
                        grid-template-columns: repeat(4, 1fr);
                    }
                }

                @media (max-width: 992px) {
                    .stats-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }
                    .actions-grid {
                        grid-template-columns: 1fr;
                    }
                }

                @media (max-width: 768px) {
                    .dashboard-header {
                        flex-direction: column;
                        gap: 20px;
                        text-align: center;
                    }
                    .header-right {
                        flex-direction: column;
                    }
                    .stats-grid {
                        grid-template-columns: 1fr;
                    }
                    .modal-content {
                        margin: 20px;
                    }
                    .modal-actions {
                        flex-direction: column;
                    }
                    .modal-btn {
                        width: 100%;
                    }
                }

                .loading {
                    display: inline-block;
                    width: 20px;
                    height: 20px;
                    border: 3px solid rgba(255,255,255,.3);
                    border-radius: 50%;
                    border-top-color: white;
                    animation: spin 1s ease-in-out infinite;
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }

                .loading-overlay {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(255,255,255,0.9);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: var(--border-radius);
                    z-index: 10;
                }
            </style>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </head>
        <body>
            <div class="dashboard-container">
                <div class="dashboard-header">
                    <div class="header-left">
                        <h1>🎯 JAMB Prep Admin Dashboard</h1>
                        <p>Welcome back, ${req.session.adminUsername || 'Admin'}! • ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
                    </div>
                    <div class="header-right">
                        <div class="notification-wrapper">
                            <div class="notification-bell" onclick="toggleNotifications()">
                                <i class="fas fa-bell"></i>
                                <span class="notification-count" id="notificationCount">0</span>
                            </div>
                        </div>
                        <button class="logout-btn" onclick="logout()">
                            <i class="fas fa-sign-out-alt"></i> Logout
                        </button>
                    </div>
                </div>

                <div class="dashboard-grid">
                    <div>
                        <div class="stats-grid">
                            <div class="stat-card users">
                                <div class="stat-icon"><i class="fas fa-users"></i></div>
                                <div class="stat-value" id="totalUsers">0</div>
                                <div class="stat-label">Total Users</div>
                                <div class="stat-change positive" id="userChange"><i class="fas fa-arrow-up"></i> 0% this month</div>
                            </div>
                            <div class="stat-card revenue">
                                <div class="stat-icon"><i class="fas fa-money-bill-wave"></i></div>
                                <div class="stat-value" id="totalRevenue">₦0</div>
                                <div class="stat-label">Total Revenue</div>
                                <div class="stat-change positive" id="revenueChange"><i class="fas fa-arrow-up"></i> 0% this month</div>
                            </div>
                            <div class="stat-card payments">
                                <div class="stat-icon"><i class="fas fa-credit-card"></i></div>
                                <div class="stat-value" id="totalPayments">0</div>
                                <div class="stat-label">Total Payments</div>
                                <div class="stat-change positive" id="paymentChange"><i class="fas fa-arrow-up"></i> 0% this month</div>
                            </div>
                            <div class="stat-card notifications">
                                <div class="stat-icon"><i class="fas fa-bell"></i></div>
                                <div class="stat-value" id="unreadNotifications">0</div>
                                <div class="stat-label">Unread Notifications</div>
                                <div class="stat-change negative" id="notificationChange"><i class="fas fa-circle"></i> New payments</div>
                            </div>
                        </div>

                        <div class="quick-actions">
                            <h2 class="section-title"><i class="fas fa-bolt"></i> Quick Actions</h2>
                            <div class="actions-grid">
                                <a href="/admin/users" class="action-btn">
                                    <span class="action-icon"><i class="fas fa-users"></i></span>
                                    <div class="action-text">User Management</div>
                                    <div class="action-desc">View and manage all users</div>
                                </a>
                                <a href="/admin/payments" class="action-btn">
                                    <span class="action-icon"><i class="fas fa-money-bill-wave"></i></span>
                                    <div class="action-text">Payment Management</div>
                                    <div class="action-desc">View all payment transactions</div>
                                </a>
                                <a href="/admin/questions" class="action-btn">
                                    <span class="action-icon"><i class="fas fa-question-circle"></i></span>
                                    <div class="action-text">Question Management</div>
                                    <div class="action-desc">Manage JAMB questions</div>
                                </a>
                                <button class="action-btn" onclick="showSendActivationModal()">
                                    <span class="action-icon"><i class="fas fa-key"></i></span>
                                    <div class="action-text">Send Activation</div>
                                    <div class="action-desc">Send activation code to user</div>
                                </button>
                            </div>
                        </div>

                        <div class="recent-payments">
                            <div class="table-header">
                                <h2 class="section-title"><i class="fas fa-history"></i> Recent Payments</h2>
                                <a href="/admin/payments" style="color: var(--primary); text-decoration: none; font-size: 14px; font-weight: 500;">View All <i class="fas fa-arrow-right"></i></a>
                            </div>
                            <div class="table-container">
                                <table class="payments-table">
                                    <thead><tr><th>User</th><th>Payment ID</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th></tr></thead>
                                    <tbody id="recentPayments"><tr><td colspan="6" style="text-align: center; padding: 50px;"><div style="display: inline-block; width: 40px; height: 40px; border: 3px solid #f3f3f3; border-top: 3px solid var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div><p style="margin-top: 15px; color: var(--gray);">Loading payments...</p></td></tr></tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <div>
                        <div class="sidebar-section">
                            <div class="activation-form">
                                <h2 class="section-title"><i class="fas fa-envelope"></i> Send Activation Code</h2>
                                <form id="activationForm">
                                    <div class="form-group">
                                        <label for="email"><i class="fas fa-user"></i> User Email</label>
                                        <input type="email" id="email" class="form-input" placeholder="Enter user's email address" required>
                                    </div>
                                    <button type="submit" class="submit-btn" id="submitBtn">
                                        <span id="btnText"><i class="fas fa-paper-plane"></i> Send Activation Code</span>
                                        <span id="btnLoading" style="display: none;"><div class="loading"></div> Sending...</span>
                                    </button>
                                </form>
                                <div id="activationMessage" class="message"></div>
                            </div>
                        </div>

                        <div class="sidebar-section">
                            <div class="notifications-panel">
                                <h2 class="section-title"><i class="fas fa-bell"></i> Recent Notifications</h2>
                                <div id="recentNotificationsList"><div class="notification-empty"><i class="fas fa-bell-slash"></i><p>No recent notifications</p></div></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div id="notificationsModal" class="modal">
                <div class="modal-content">
                    <div class="modal-header"><h2><i class="fas fa-bell"></i> Payment Notifications</h2><button class="modal-close" onclick="closeModal('notificationsModal')">×</button></div>
                    <div class="modal-body"><div id="notificationsList"><div class="notification-empty"><i class="fas fa-bell-slash"></i><p>No notifications found</p></div></div></div>
                </div>
            </div>

            <div id="notificationDetailsModal" class="modal">
                <div class="modal-content">
                    <div class="modal-header"><h2><i class="fas fa-money-bill-wave"></i> Payment Details</h2><button class="modal-close" onclick="closeModal('notificationDetailsModal')">×</button></div>
                    <div class="modal-body">
                        <div id="notificationDetailsContent"></div>
                        <div class="modal-actions">
                            <button class="modal-btn primary" onclick="sendActivationToNotification()"><i class="fas fa-key"></i> Send Activation</button>
                            <button class="modal-btn success" onclick="markAsRead()"><i class="fas fa-check"></i> Mark as Read</button>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                let currentNotificationId = null;
                let refreshInterval;
                let notifications = [];

                document.addEventListener('DOMContentLoaded', function() {
                    loadDashboardData();
                    refreshInterval = setInterval(loadDashboardData, 10000);
                    document.getElementById('activationForm').addEventListener('submit', handleActivationForm);
                });

                async function loadDashboardData() {
                    try {
                        await Promise.all([loadStatistics(), loadRecentPayments(), loadRecentNotifications()]);
                    } catch (error) {
                        console.error('Error loading dashboard:', error);
                    }
                }

                async function loadStatistics() {
                    try {
                        const response = await fetch('/api/admin/statistics');
                        const data = await response.json();
                        if (data.success) {
                            const stats = data.statistics;
                            document.getElementById('totalUsers').textContent = stats.totalUsers?.count || 0;
                            document.getElementById('totalRevenue').textContent = '₦' + (parseInt(stats.totalRevenue?.total || 0)).toLocaleString();
                            document.getElementById('totalPayments').textContent = stats.totalPayments?.count || 0;
                            const unreadCount = stats.unreadNotifications?.count || 0;
                            document.getElementById('unreadNotifications').textContent = unreadCount;
                            const notificationCount = document.getElementById('notificationCount');
                            notificationCount.textContent = unreadCount;
                            notificationCount.style.display = unreadCount > 0 ? 'flex' : 'none';
                        }
                    } catch (error) {
                        console.error('Error loading statistics:', error);
                    }
                }

                async function loadRecentPayments() {
                    try {
                        const response = await fetch('/api/admin/payments');
                        const data = await response.json();
                        if (data.success) {
                            const paymentsElement = document.getElementById('recentPayments');
                            if (!data.payments || data.payments.length === 0) {
                                paymentsElement.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 50px; color: var(--gray);"><i class="fas fa-credit-card" style="font-size: 32px; margin-bottom: 15px; opacity: 0.5;"></i><p>No payments found</p></td></tr>';
                                return;
                            }
                            let html = '';
                            data.payments.slice(0, 5).forEach(payment => {
                                const date = new Date(payment.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                                const initials = payment.userName ? payment.userName.charAt(0).toUpperCase() : payment.email.charAt(0).toUpperCase();
                                html += `<tr onclick="viewPayment('${payment.id}')">
                                    <td><div class="user-cell"><div class="user-avatar">${initials}</div><div class="user-info"><div class="user-name">${payment.userName || 'N/A'}</div><div class="user-email">${payment.email}</div></div></div></td>
                                    <td style="font-family: monospace; font-size: 13px;">${payment.payment_id}</td>
                                    <td style="font-weight: 600;">₦${parseFloat(payment.amount).toFixed(2)}</td>
                                    <td>${payment.payment_method || 'N/A'}</td>
                                    <td><span class="status-badge status-${payment.status}">${payment.status}</span></td>
                                    <td style="font-size: 13px; color: var(--gray);">${date}</td>
                                </tr>`;
                            });
                            paymentsElement.innerHTML = html;
                        }
                    } catch (error) {
                        console.error('Error loading payments:', error);
                    }
                }

                async function loadRecentNotifications() {
                    try {
                        const response = await fetch('/api/admin/notifications/unread');
                        const data = await response.json();
                        if (data.success) {
                            notifications = data.notifications;
                            const listElement = document.getElementById('recentNotificationsList');
                            if (!notifications || notifications.length === 0) {
                                listElement.innerHTML = '<div class="notification-empty"><i class="fas fa-bell-slash"></i><p>No recent notifications</p></div>';
                                return;
                            }
                            let html = '';
                            notifications.slice(0, 3).forEach(notification => {
                                const timeAgo = getTimeAgo(notification.created_at);
                                const amount = notification.currency === 'NGN' ? '₦' : '';
                                html += `<div class="notification-item ${notification.is_read == 0 ? 'unread' : ''}" onclick="viewNotificationDetails(${notification.id})">
                                    <div class="notification-header"><div class="notification-title"><i class="fas fa-money-bill-wave" style="color: #06d6a0;"></i> New Payment</div><div class="notification-time">${timeAgo}</div></div>
                                    <div class="notification-content">${notification.userName || notification.user_email} paid <strong>${amount}${notification.amount}</strong></div>
                                    <div class="notification-meta">Via ${notification.payment_method} • ID: ${notification.payment_id}</div>
                                </div>`;
                            });
                            listElement.innerHTML = html;
                        }
                    } catch (error) {
                        console.error('Error loading notifications:', error);
                    }
                }

                async function handleActivationForm(e) {
                    e.preventDefault();
                    const email = document.getElementById('email').value;
                    const submitBtn = document.getElementById('submitBtn');
                    const btnText = document.getElementById('btnText');
                    const btnLoading = document.getElementById('btnLoading');
                    const messageDiv = document.getElementById('activationMessage');
                    
                    if (!email || !email.includes('@')) {
                        showMessage(messageDiv, 'Please enter a valid email address', 'error');
                        return;
                    }
                    
                    submitBtn.disabled = true;
                    btnText.style.display = 'none';
                    btnLoading.style.display = 'inline-flex';
                    btnLoading.style.alignItems = 'center';
                    btnLoading.style.gap = '10px';
                    
                    try {
                        const response = await fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) });
                        const data = await response.json();
                        if (data.success) {
                            showMessage(messageDiv, '✅ Activation code sent successfully!', 'success');
                            document.getElementById('activationForm').reset();
                        } else {
                            showMessage(messageDiv, '❌ ' + (data.message || 'Failed to send activation code'), 'error');
                        }
                    } catch (error) {
                        showMessage(messageDiv, '❌ Connection error. Please try again.', 'error');
                        console.error('Error sending activation code:', error);
                    } finally {
                        submitBtn.disabled = false;
                        btnText.style.display = 'inline';
                        btnLoading.style.display = 'none';
                    }
                }

                async function viewNotificationDetails(id) {
                    const notification = notifications.find(n => n.id == id);
                    if (!notification) return;
                    currentNotificationId = id;
                    const modal = document.getElementById('notificationDetailsModal');
                    const content = document.getElementById('notificationDetailsContent');
                    const date = new Date(notification.created_at).toLocaleString();
                    const amount = notification.currency === 'NGN' ? '₦' : '';
                    content.innerHTML = `<div class="notification-details">
                        <div class="detail-row"><div class="detail-label">User:</div><div class="detail-value highlight">${notification.userName || notification.user_email}</div></div>
                        <div class="detail-row"><div class="detail-label">Amount:</div><div class="detail-value highlight">${amount}${notification.amount}</div></div>
                        <div class="detail-row"><div class="detail-label">Payment ID:</div><div class="detail-value">${notification.payment_id}</div></div>
                        <div class="detail-row"><div class="detail-label">Method:</div><div class="detail-value">${notification.payment_method}</div></div>
                        <div class="detail-row"><div class="detail-label">Status:</div><div class="detail-value">${notification.status}</div></div>
                        <div class="detail-row"><div class="detail-label">Date:</div><div class="detail-value">${date}</div></div>
                        ${notification.note ? `<div class="detail-row"><div class="detail-label">Note:</div><div class="detail-value">${notification.note}</div></div>` : ''}
                    </div>`;
                    modal.style.display = 'flex';
                }

                async function sendActivationToNotification() {
                    const notification = notifications.find(n => n.id == currentNotificationId);
                    if (!notification) return;
                    if (confirm(`Send activation code to ${notification.user_email}?`)) {
                        try {
                            const response = await fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: notification.user_email }) });
                            const data = await response.json();
                            if (data.success) {
                                alert('✅ Activation code sent successfully!');
                                closeModal('notificationDetailsModal');
                            } else {
                                alert('❌ ' + (data.message || 'Failed to send activation code'));
                            }
                        } catch (error) {
                            console.error('Error sending activation:', error);
                            alert('Error sending activation code');
                        }
                    }
                }

                async function markAsRead() {
                    if (!currentNotificationId) return;
                    try {
                        const response = await fetch(`/api/admin/notifications/${currentNotificationId}/read`, { method: 'POST' });
                        const data = await response.json();
                        if (data.success) {
                            loadDashboardData();
                            closeModal('notificationDetailsModal');
                        }
                    } catch (error) {
                        console.error('Error marking as read:', error);
                        alert('Error marking notification as read');
                    }
                }

                async function toggleNotifications() {
                    const modal = document.getElementById('notificationsModal');
                    if (modal.style.display === 'flex') {
                        closeModal('notificationsModal');
                    } else {
                        await loadAllNotifications();
                        modal.style.display = 'flex';
                    }
                }

                async function loadAllNotifications() {
                    try {
                        const response = await fetch('/api/admin/notifications/unread');
                        const data = await response.json();
                        if (data.success) {
                            const listElement = document.getElementById('notificationsList');
                            if (!data.notifications || data.notifications.length === 0) {
                                listElement.innerHTML = '<div class="notification-empty"><i class="fas fa-bell-slash"></i><p>No notifications found</p></div>';
                                return;
                            }
                            let html = '';
                            data.notifications.forEach(notification => {
                                const timeAgo = getTimeAgo(notification.created_at);
                                const amount = notification.currency === 'NGN' ? '₦' : '';
                                html += `<div class="notification-item ${notification.is_read == 0 ? 'unread' : ''}" onclick="viewNotificationDetails(${notification.id})">
                                    <div class="notification-header"><div class="notification-title"><i class="fas fa-money-bill-wave" style="color: #06d6a0;"></i> New Payment Received</div><div class="notification-time">${timeAgo}</div></div>
                                    <div class="notification-content"><strong>${notification.userName || notification.user_email}</strong> paid <strong>${amount}${notification.amount}</strong> via ${notification.payment_method}</div>
                                    <div class="notification-meta">ID: ${notification.payment_id}</div>
                                </div>`;
                            });
                            listElement.innerHTML = html;
                        }
                    } catch (error) {
                        console.error('Error loading notifications:', error);
                    }
                }

                function viewPayment(paymentId) { window.location.href = `/admin/payments#payment-${paymentId}`; }
                function showSendActivationModal() { const email = prompt('Enter user email to send activation code:'); if (email) { document.getElementById('email').value = email; document.getElementById('email').focus(); } }
                function closeModal(modalId) { document.getElementById(modalId).style.display = 'none'; }
                async function logout() { try { const response = await fetch('/api/auth/logout', { method: 'POST' }); const data = await response.json(); if (data.success) window.location.href = '/admin/login'; } catch (error) { console.error('Logout error:', error); } }
                function getTimeAgo(dateString) { const date = new Date(dateString); const now = new Date(); const seconds = Math.floor((now - date) / 1000); if (seconds < 60) return 'Just now'; if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago'; if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago'; if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago'; return date.toLocaleDateString(); }
                function showMessage(element, text, type) { element.textContent = text; element.className = 'message ' + type; element.style.display = 'block'; if (type === 'success') setTimeout(() => element.style.display = 'none', 5000); }
                window.onclick = function(event) { if (event.target.classList.contains('modal')) event.target.style.display = 'none'; }
                document.addEventListener('keydown', function(event) { if (event.key === 'Escape') { closeModal('notificationsModal'); closeModal('notificationDetailsModal'); } });
            </script>
        </body>
        </html>
    `);
});

// ========== PAYMENT NOTIFICATION ROUTES ==========

router.post("/api/admin/payment-notification", async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    try {
        const { payment_id, user_email, amount, currency, payment_method, status, note } = req.body;
        const insertQuery = `INSERT INTO payment_notifications (payment_id, user_email, amount, currency, payment_method, status, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
        const result = await pool.query(insertQuery, [payment_id, user_email, amount, currency, payment_method, status, note]);
        const emailSent = await sendPaymentEmailNotification({ payment_id, user_email, amount, currency, payment_method, note });
        await pool.query("UPDATE payment_notifications SET admin_notified = $1 WHERE id = $2", [emailSent ? 1 : 0, result.rows[0].id]);
        res.json({ success: true, notificationId: result.rows[0].id, emailSent: emailSent });
    } catch (error) {
        console.error('❌ Error in payment notification:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get("/api/admin/notifications/unread", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    const query = `SELECT pn.*, ju."userName" FROM payment_notifications pn LEFT JOIN jambuser ju ON pn.user_email = ju.email WHERE pn.is_read = 0 ORDER BY pn.created_at DESC LIMIT 20`;
    try {
        const result = await pool.query(query);
        res.json({ success: true, notifications: result.rows, count: result.rows.length });
    } catch (err) {
        console.error('❌ Error fetching notifications:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.post("/api/admin/notifications/:id/read", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    try {
        await pool.query("UPDATE payment_notifications SET is_read = 1 WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: 'Notification marked as read' });
    } catch (err) {
        console.error('❌ Error marking notification as read:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.post("/api/admin/notifications/mark-all-read", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    try {
        const result = await pool.query("UPDATE payment_notifications SET is_read = 1 WHERE is_read = 0");
        res.json({ success: true, message: 'All notifications marked as read', affectedRows: result.rowCount });
    } catch (err) {
        console.error('❌ Error marking all notifications as read:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ========== PAYMENTS MANAGEMENT ==========

router.get("/api/admin/payments", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    const query = `SELECT up.*, ju."userName" FROM user_payments up LEFT JOIN jambuser ju ON up.email = ju.email ORDER BY up.created_at DESC`;
    try {
        const result = await pool.query(query);
        res.json({ success: true, payments: result.rows });
    } catch (err) {
        console.error('❌ Error fetching payments:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.get("/admin/payments", checkAdminAuth, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Payments Management</title><style>...</style></head><body>...</body></html>`);
});

// ========== USER MANAGEMENT ==========

router.get("/api/admin/users", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    try {
        const usersQuery = `SELECT id, "userName", email, role, is_activated, "activationCode", created_at, updated_at FROM jambuser ORDER BY created_at DESC`;
        const usersResult = await pool.query(usersQuery);
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
                stats[key] = 0;
            }
        }
        res.json({ success: true, users: usersResult.rows, stats: stats });
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.get("/admin/users", checkAdminAuth, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>User Management</title><style>...</style></head><body>...</body></html>`);
});

// ========== USER ACTIVATION API ROUTES ==========

router.post("/api/admin/users/:id/activate", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    try {
        const result = await pool.query(`UPDATE jambuser SET is_activated = '1', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, email, "userName", is_activated`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, message: 'User activated successfully', user: result.rows[0] });
    } catch (err) {
        console.error('Error activating user:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.post("/api/admin/users/:id/deactivate", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    try {
        const result = await pool.query(`UPDATE jambuser SET is_activated = '0', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, email, "userName", is_activated`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, message: 'User deactivated successfully', user: result.rows[0] });
    } catch (err) {
        console.error('Error deactivating user:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ========== QUESTION MANAGEMENT ==========

router.get("/api/admin/statistics", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
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
                if (key === 'totalRevenue') results[key] = { total: parseFloat(result.rows[0]?.total) || 0 };
                else results[key] = { count: parseInt(result.rows[0]?.count) || 0 };
            } catch (err) {
                if (key === 'totalRevenue') results[key] = { total: 0 };
                else results[key] = { count: 0 };
            }
        }
        res.json({ success: true, statistics: results });
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.get("/api/admin/check-access", (req, res) => {
    const isAdmin = req.session && req.session.adminLoggedIn && ['super_admin', 'admin', 'moderator'].includes(req.session.adminRole);
    res.json({ success: true, canAccessAdmin: isAdmin, isAdmin: isAdmin });
});

// ========== ACTIVATION CODE ROUTES ==========

router.post("/send", async (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    function generateActivationCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }
    const { email } = req.body;
    const activationCode = generateActivationCode();
    try {
        const paymentResult = await pool.query("SELECT * FROM user_payments WHERE email = $1", [email]);
        if (paymentResult.rows.length === 0) return res.status(400).json({ success: false, message: "User has not made payment" });
        const userResult = await pool.query("SELECT * FROM jambuser WHERE email = $1", [email]);
        if (userResult.rows.length === 0) return res.status(400).json({ success: false, message: "User not found. Please register first." });
        await pool.query('UPDATE jambuser SET "activationCode" = $1 WHERE email = $2', [activationCode, email]);
        const emailContent = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><div style="background: linear-gradient(135deg, #1a237e 0%, #311b92 100%); padding: 30px; text-align: center;"><h1 style="color: white; margin: 0;">🎯 JAMB Prep</h1></div><div style="padding: 30px; background: white;"><h2 style="color: #1a237e;">Your Activation Code</h2><p>Hello,</p><p>Thank you for registering with JAMB Prep. Here is your activation code:</p><div style="background: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0; border-radius: 10px; border: 2px dashed #1a237e;"><div style="font-size: 2.5rem; font-weight: bold; color: #1a237e; letter-spacing: 5px;">${activationCode}</div></div><p>Use this code to activate your account and access all features.</p><p>If you didn't request this code, please ignore this email.</p><div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;"><p style="color: #666; font-size: 0.9rem;">Best regards,<br>The JAMB Prep Team</p></div></div></div>`;
        const msg = { to: email, from: 'piotech52@gmail.com', subject: "Your JAMB Prep Activation Code", html: emailContent };
        await sgMail.send(msg);
        res.json({ success: true, message: 'Activation code sent successfully' });
    } catch (error) {
        console.error('General error:', error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ========== QUESTION MANAGEMENT API ROUTES ==========

router.get("/api/subjects", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    try {
        const result = await pool.query('SELECT id, subject_code, subject_name FROM subjects ORDER BY subject_name');
        res.json({ success: true, subjects: result.rows });
    } catch (err) {
        console.error('Error fetching subjects:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

router.get("/api/subject-tables/:subject", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    const subject = req.params.subject.toLowerCase();
    const tableName = `${subject}_questions`;
    try {
        const checkResult = await pool.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`, [tableName]);
        if (!checkResult.rows[0].exists) return res.json({ success: false, message: 'Table does not exist' });
        const structureResult = await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [tableName]);
        const countResult = await pool.query(`SELECT COUNT(*) as count FROM "${tableName}"`);
        res.json({ success: true, tableExists: true, tableName: tableName, rowCount: parseInt(countResult.rows[0]?.count) || 0, structure: structureResult.rows });
    } catch (err) {
        console.error('Error checking table:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

router.post("/api/insert-question", checkAdminAuth, upload.single('question_image'), async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    const { subject, question_number, year, question_text, option_a, option_b, option_c, option_d, correct_answer, topic, explanation } = req.body;
    if (!subject || !question_text || !option_a || !option_b || !option_c || !option_d || !correct_answer) return res.status(400).json({ success: false, error: 'Missing required fields' });
    const tableName = `${subject.toLowerCase()}_questions`;
    let imageFilename = null, imageData = null;
    if (req.file) {
        imageFilename = req.file.filename;
        try { imageData = fs.readFileSync(req.file.path).toString('base64'); } catch (error) { console.error('Error reading image file:', error); }
    }
    const columnResult = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'explanation'`, [tableName]);
    const hasExplanation = columnResult.rows.length > 0;
    try {
        let insertQuery, insertValues;
        if (hasExplanation) {
            insertQuery = `INSERT INTO "${tableName}" (question_number, year, subject, question_text, option_a, option_b, option_c, option_d, correct_answer, topic, image_filename, image_data, explanation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`;
            insertValues = [question_number || null, year || null, subject.toUpperCase(), question_text, option_a, option_b, option_c, option_d, correct_answer, topic || null, imageFilename, imageData, explanation || null];
        } else {
            insertQuery = `INSERT INTO "${tableName}" (question_number, year, subject, question_text, option_a, option_b, option_c, option_d, correct_answer, topic, image_filename, image_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`;
            insertValues = [question_number || null, year || null, subject.toUpperCase(), question_text, option_a, option_b, option_c, option_d, correct_answer, topic || null, imageFilename, imageData];
        }
        const result = await pool.query(insertQuery, insertValues);
        res.json({ success: true, message: 'Question inserted successfully', questionId: result.rows[0].id });
    } catch (err) {
        console.error('Error inserting question:', err);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: 'Failed to insert question' });
    }
});

router.get("/api/search-questions", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    const { subject, searchTerm, searchBy } = req.query;
    if (!subject) return res.status(400).json({ success: false, error: 'Subject is required' });
    const tableName = `${subject.toLowerCase()}_questions`;
    try {
        let searchQuery, queryParams = [];
        if (searchTerm && searchBy) {
            switch (searchBy) {
                case 'question_text': searchQuery = `SELECT * FROM "${tableName}" WHERE question_text ILIKE $1 LIMIT 50`; queryParams = [`%${searchTerm}%`]; break;
                case 'question_number': searchQuery = `SELECT * FROM "${tableName}" WHERE question_number = $1`; queryParams = [searchTerm]; break;
                case 'year': searchQuery = `SELECT * FROM "${tableName}" WHERE year = $1 LIMIT 50`; queryParams = [searchTerm]; break;
                case 'topic': searchQuery = `SELECT * FROM "${tableName}" WHERE topic ILIKE $1 LIMIT 50`; queryParams = [`%${searchTerm}%`]; break;
                default: searchQuery = `SELECT * FROM "${tableName}" WHERE question_text ILIKE $1 LIMIT 50`; queryParams = [`%${searchTerm}%`];
            }
        } else {
            searchQuery = `SELECT * FROM "${tableName}" LIMIT 50`;
        }
        const result = await pool.query(searchQuery, queryParams);
        const formattedResults = result.rows.map(q => ({
            id: q.id, question_number: q.question_number, year: q.year, subject: q.subject,
            question_text: q.question_text?.substring(0, 100) + (q.question_text?.length > 100 ? '...' : ''),
            option_a: q.option_a?.substring(0, 50), option_b: q.option_b?.substring(0, 50), option_c: q.option_c?.substring(0, 50), option_d: q.option_d?.substring(0, 50),
            correct_answer: q.correct_answer, topic: q.topic, has_image: !!q.image_filename, image_filename: q.image_filename, created_at: q.created_at, explanation: q.explanation
        }));
        res.json({ success: true, count: result.rows.length, questions: formattedResults });
    } catch (err) {
        console.error('Error searching questions:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

router.get("/api/question/:subject/:id", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    const { subject, id } = req.params;
    const tableName = `${subject.toLowerCase()}_questions`;
    try {
        const result = await pool.query(`SELECT * FROM "${tableName}" WHERE id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Question not found' });
        const question = result.rows[0];
        let imageUrl = null;
        if (question.image_data) {
            let mimeType = 'image/jpeg';
            if (question.image_filename) {
                const ext = path.extname(question.image_filename).toLowerCase();
                if (ext === '.png') mimeType = 'image/png';
                else if (ext === '.gif') mimeType = 'image/gif';
                else if (ext === '.webp') mimeType = 'image/webp';
            }
            imageUrl = `data:${mimeType};base64,${question.image_data}`;
        } else if (question.image_filename) {
            imageUrl = `/question-images/${question.image_filename}`;
        }
        res.json({ success: true, question: { ...question, image_url: imageUrl } });
    } catch (err) {
        console.error('Error fetching question:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

router.delete("/api/question/:subject/:id", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    const { subject, id } = req.params;
    const tableName = `${subject.toLowerCase()}_questions`;
    try {
        const getResult = await pool.query(`SELECT image_filename FROM "${tableName}" WHERE id = $1`, [id]);
        if (getResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Question not found' });
        const imageFilename = getResult.rows[0].image_filename;
        if (imageFilename) {
            const imagePath = path.join('question-images', imageFilename);
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        }
        await pool.query(`DELETE FROM "${tableName}" WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Question deleted successfully', deletedId: id });
    } catch (err) {
        console.error('Error deleting question:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

router.put("/api/question/:subject/:id", checkAdminAuth, upload.single('question_image'), async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    const { subject, id } = req.params;
    const { question_number, year, question_text, option_a, option_b, option_c, option_d, correct_answer, topic, explanation } = req.body;
    const tableName = `${subject.toLowerCase()}_questions`;
    try {
        const getResult = await pool.query(`SELECT image_filename FROM "${tableName}" WHERE id = $1`, [id]);
        if (getResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Question not found' });
        let imageFilename = getResult.rows[0].image_filename, imageData = null;
        if (req.file) {
            imageFilename = req.file.filename;
            try { imageData = fs.readFileSync(req.file.path).toString('base64'); } catch (error) {}
            if (getResult.rows[0].image_filename) {
                const oldImagePath = path.join('question-images', getResult.rows[0].image_filename);
                if (fs.existsSync(oldImagePath)) fs.unlinkSync(oldImagePath);
            }
        }
        const columnResult = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'explanation'`, [tableName]);
        const hasExplanation = columnResult.rows.length > 0;
        let updateQuery, updateValues;
        if (req.file) {
            if (hasExplanation) {
                updateQuery = `UPDATE "${tableName}" SET question_number = $1, year = $2, question_text = $3, option_a = $4, option_b = $5, option_c = $6, option_d = $7, correct_answer = $8, topic = $9, image_filename = $10, image_data = $11, explanation = $12 WHERE id = $13`;
                updateValues = [question_number || null, year || null, question_text, option_a, option_b, option_c, option_d, correct_answer, topic || null, imageFilename, imageData, explanation || null, id];
            } else {
                updateQuery = `UPDATE "${tableName}" SET question_number = $1, year = $2, question_text = $3, option_a = $4, option_b = $5, option_c = $6, option_d = $7, correct_answer = $8, topic = $9, image_filename = $10, image_data = $11 WHERE id = $12`;
                updateValues = [question_number || null, year || null, question_text, option_a, option_b, option_c, option_d, correct_answer, topic || null, imageFilename, imageData, id];
            }
        } else {
            if (hasExplanation) {
                updateQuery = `UPDATE "${tableName}" SET question_number = $1, year = $2, question_text = $3, option_a = $4, option_b = $5, option_c = $6, option_d = $7, correct_answer = $8, topic = $9, explanation = $10 WHERE id = $11`;
                updateValues = [question_number || null, year || null, question_text, option_a, option_b, option_c, option_d, correct_answer, topic || null, explanation || null, id];
            } else {
                updateQuery = `UPDATE "${tableName}" SET question_number = $1, year = $2, question_text = $3, option_a = $4, option_b = $5, option_c = $6, option_d = $7, correct_answer = $8, topic = $9 WHERE id = $10`;
                updateValues = [question_number || null, year || null, question_text, option_a, option_b, option_c, option_d, correct_answer, topic || null, id];
            }
        }
        await pool.query(updateQuery, updateValues);
        res.json({ success: true, message: 'Question updated successfully' });
    } catch (err) {
        console.error('Error updating question:', err);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: 'Failed to update question' });
    }
});

router.get("/admin/questions", checkAdminAuth, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Question Management</title><style>...</style></head><body>...</body></html>`);
});

module.exports = router;
