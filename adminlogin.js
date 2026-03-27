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

// ========== ENHANCED ADMIN DASHBOARD ==========

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

                /* Header */
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

                /* Notification Bell */
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

                /* Dashboard Grid */
                .dashboard-grid {
                    display: grid;
                    grid-template-columns: 2fr 1fr;
                    gap: 30px;
                }

                /* Stats Cards */
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

                /* Quick Actions */
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

                /* Recent Payments Table */
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

                /* Right Column */
                .sidebar-section {
                    margin-bottom: 30px;
                }

                /* Activation Form */
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

                /* Notifications Panel */
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

                /* Modals */
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

                /* Messages */
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

                /* Responsive */
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

                /* Loading States */
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
                <!-- Header -->
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

                <!-- Main Dashboard -->
                <div class="dashboard-grid">
                    <!-- Left Column -->
                    <div>
                        <!-- Statistics -->
                        <div class="stats-grid">
                            <div class="stat-card users">
                                <div class="stat-icon">
                                    <i class="fas fa-users"></i>
                                </div>
                                <div class="stat-value" id="totalUsers">0</div>
                                <div class="stat-label">Total Users</div>
                                <div class="stat-change positive" id="userChange">
                                    <i class="fas fa-arrow-up"></i> 0% this month
                                </div>
                            </div>
                            <div class="stat-card revenue">
                                <div class="stat-icon">
                                    <i class="fas fa-money-bill-wave"></i>
                                </div>
                                <div class="stat-value" id="totalRevenue">₦0</div>
                                <div class="stat-label">Total Revenue</div>
                                <div class="stat-change positive" id="revenueChange">
                                    <i class="fas fa-arrow-up"></i> 0% this month
                                </div>
                            </div>
                            <div class="stat-card payments">
                                <div class="stat-icon">
                                    <i class="fas fa-credit-card"></i>
                                </div>
                                <div class="stat-value" id="totalPayments">0</div>
                                <div class="stat-label">Total Payments</div>
                                <div class="stat-change positive" id="paymentChange">
                                    <i class="fas fa-arrow-up"></i> 0% this month
                                </div>
                            </div>
                            <div class="stat-card notifications">
                                <div class="stat-icon">
                                    <i class="fas fa-bell"></i>
                                </div>
                                <div class="stat-value" id="unreadNotifications">0</div>
                                <div class="stat-label">Unread Notifications</div>
                                <div class="stat-change negative" id="notificationChange">
                                    <i class="fas fa-circle"></i> New payments
                                </div>
                            </div>
                        </div>

                        <!-- Quick Actions -->
                        <div class="quick-actions">
                            <h2 class="section-title">
                                <i class="fas fa-bolt"></i> Quick Actions
                            </h2>
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

                        <!-- Recent Payments -->
                        <div class="recent-payments">
                            <div class="table-header">
                                <h2 class="section-title">
                                    <i class="fas fa-history"></i> Recent Payments
                                </h2>
                                <a href="/admin/payments" style="color: var(--primary); text-decoration: none; font-size: 14px; font-weight: 500;">
                                    View All <i class="fas fa-arrow-right"></i>
                                </a>
                            </div>
                            <div class="table-container">
                                <table class="payments-table">
                                    <thead>
                                        <tr>
                                            <th>User</th>
                                            <th>Payment ID</th>
                                            <th>Amount</th>
                                            <th>Method</th>
                                            <th>Status</th>
                                            <th>Date</th>
                                        </thead>
                                    <tbody id="recentPayments">
                                        <tr>
                                            <td colspan="6" style="text-align: center; padding: 50px;">
                                                <div style="display: inline-block; width: 40px; height: 40px; border: 3px solid #f3f3f3; border-top: 3px solid var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div>
                                                <p style="margin-top: 15px; color: var(--gray);">Loading payments...</p>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <!-- Right Column -->
                    <div>
                        <!-- Activation Form -->
                        <div class="sidebar-section">
                            <div class="activation-form">
                                <h2 class="section-title">
                                    <i class="fas fa-envelope"></i> Send Activation Code
                                </h2>
                                <form id="activationForm">
                                    <div class="form-group">
                                        <label for="email">
                                            <i class="fas fa-user"></i> User Email
                                        </label>
                                        <input type="email" id="email" class="form-input" placeholder="Enter user's email address" required>
                                    </div>
                                    <button type="submit" class="submit-btn" id="submitBtn">
                                        <span id="btnText">
                                            <i class="fas fa-paper-plane"></i> Send Activation Code
                                        </span>
                                        <span id="btnLoading" style="display: none;">
                                            <div class="loading"></div> Sending...
                                        </span>
                                    </button>
                                </form>
                                <div id="activationMessage" class="message"></div>
                            </div>
                        </div>

                        <!-- Recent Notifications -->
                        <div class="sidebar-section">
                            <div class="notifications-panel">
                                <h2 class="section-title">
                                    <i class="fas fa-bell"></i> Recent Notifications
                                </h2>
                                <div id="recentNotificationsList">
                                    <div class="notification-empty">
                                        <i class="fas fa-bell-slash"></i>
                                        <p>No recent notifications</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Notifications Modal -->
            <div id="notificationsModal" class="modal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2><i class="fas fa-bell"></i> Payment Notifications</h2>
                        <button class="modal-close" onclick="closeModal('notificationsModal')">×</button>
                    </div>
                    <div class="modal-body">
                        <div id="notificationsList">
                            <div class="notification-empty">
                                <i class="fas fa-bell-slash"></i>
                                <p>No notifications found</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Notification Details Modal -->
            <div id="notificationDetailsModal" class="modal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2><i class="fas fa-money-bill-wave"></i> Payment Details</h2>
                        <button class="modal-close" onclick="closeModal('notificationDetailsModal')">×</button>
                    </div>
                    <div class="modal-body">
                        <div id="notificationDetailsContent">
                            <!-- Details will be loaded here -->
                        </div>
                        <div class="modal-actions">
                            <button class="modal-btn primary" onclick="sendActivationToNotification()">
                                <i class="fas fa-key"></i> Send Activation
                            </button>
                            <button class="modal-btn success" onclick="markAsRead()">
                                <i class="fas fa-check"></i> Mark as Read
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                // Global variables
                let currentNotificationId = null;
                let refreshInterval;
                let notifications = [];

                // Initialize dashboard
                document.addEventListener('DOMContentLoaded', function() {
                    loadDashboardData();
                    refreshInterval = setInterval(loadDashboardData, 10000); // Refresh every 10 seconds
                    document.getElementById('activationForm').addEventListener('submit', handleActivationForm);
                });

                // Load all dashboard data
                async function loadDashboardData() {
                    try {
                        await Promise.all([
                            loadStatistics(),
                            loadRecentPayments(),
                            loadRecentNotifications()
                        ]);
                    } catch (error) {
                        console.error('Error loading dashboard:', error);
                    }
                }

                // Load statistics
                async function loadStatistics() {
                    try {
                        const response = await fetch('/api/admin/statistics');
                        const data = await response.json();
                        
                        if (data.success) {
                            const stats = data.statistics;
                            
                            // Update statistics
                            document.getElementById('totalUsers').textContent = stats.totalUsers?.count || 0;
                            document.getElementById('totalRevenue').textContent = '₦' + (parseInt(stats.totalRevenue?.total || 0)).toLocaleString();
                            document.getElementById('totalPayments').textContent = stats.totalPayments?.count || 0;
                            const unreadCount = stats.unreadNotifications?.count || 0;
                            document.getElementById('unreadNotifications').textContent = unreadCount;
                            
                            // Update notification bell
                            const notificationCount = document.getElementById('notificationCount');
                            notificationCount.textContent = unreadCount;
                            if (unreadCount > 0) {
                                notificationCount.style.display = 'flex';
                            } else {
                                notificationCount.style.display = 'none';
                            }
                        }
                    } catch (error) {
                        console.error('Error loading statistics:', error);
                    }
                }

                // Load recent payments
                async function loadRecentPayments() {
                    try {
                        const response = await fetch('/api/admin/payments');
                        const data = await response.json();
                        
                        if (data.success) {
                            const paymentsElement = document.getElementById('recentPayments');
                            
                            if (!data.payments || data.payments.length === 0) {
                                paymentsElement.innerHTML = \`
                                    <tr>
                                        <td colspan="6" style="text-align: center; padding: 50px; color: var(--gray);">
                                            <i class="fas fa-credit-card" style="font-size: 32px; margin-bottom: 15px; opacity: 0.5;"></i>
                                            <p>No payments found</p>
                                        </td>
                                    </tr>
                                \`;
                                return;
                            }
                            
                            let html = '';
                            data.payments.slice(0, 5).forEach(payment => {
                                const date = new Date(payment.created_at).toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit'
                                });
                                
                                const initials = payment.userName ? payment.userName.charAt(0).toUpperCase() : payment.email.charAt(0).toUpperCase();
                                
                                html += \`
                                    <tr onclick="viewPayment('\${payment.id}')">
                                        <td>
                                            <div class="user-cell">
                                                <div class="user-avatar">\${initials}</div>
                                                <div class="user-info">
                                                    <div class="user-name">\${payment.userName || 'N/A'}</div>
                                                    <div class="user-email">\${payment.email}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td style="font-family: monospace; font-size: 13px;">\${payment.payment_id}</td>
                                        <td style="font-weight: 600;">₦\${parseFloat(payment.amount).toFixed(2)}</td>
                                        <td>\${payment.payment_method || 'N/A'}</td>
                                        <td>
                                            <span class="status-badge status-\${payment.status}">
                                                \${payment.status}
                                            </span>
                                        </td>
                                        <td style="font-size: 13px; color: var(--gray);">\${date}</td>
                                    </tr>
                                \`;
                            });
                            
                            paymentsElement.innerHTML = html;
                        }
                    } catch (error) {
                        console.error('Error loading payments:', error);
                    }
                }

                // Load recent notifications for sidebar - FIXED: Compare with 0 not false
                async function loadRecentNotifications() {
                    try {
                        const response = await fetch('/api/admin/notifications/unread');
                        const data = await response.json();
                        
                        if (data.success) {
                            notifications = data.notifications;
                            const listElement = document.getElementById('recentNotificationsList');
                            
                            if (!notifications || notifications.length === 0) {
                                listElement.innerHTML = \`
                                    <div class="notification-empty">
                                        <i class="fas fa-bell-slash"></i>
                                        <p>No recent notifications</p>
                                    </div>
                                \`;
                                return;
                            }
                            
                            let html = '';
                            notifications.slice(0, 3).forEach(notification => {
                                const timeAgo = getTimeAgo(notification.created_at);
                                const amount = notification.currency === 'NGN' ? '₦' : '';
                                
                                html += \`
                                    <div class="notification-item \${notification.is_read == 0 ? 'unread' : ''}" 
                                         onclick="viewNotificationDetails(\${notification.id})">
                                        <div class="notification-header">
                                            <div class="notification-title">
                                                <i class="fas fa-money-bill-wave" style="color: #06d6a0;"></i>
                                                New Payment
                                            </div>
                                            <div class="notification-time">\${timeAgo}</div>
                                        </div>
                                        <div class="notification-content">
                                            \${notification.userName || notification.user_email} paid <strong>\${amount}\${notification.amount}</strong>
                                        </div>
                                        <div class="notification-meta">
                                            Via \${notification.payment_method} • ID: \${notification.payment_id}
                                        </div>
                                    </div>
                                \`;
                            });
                            
                            listElement.innerHTML = html;
                        }
                    } catch (error) {
                        console.error('Error loading notifications:', error);
                    }
                }

                // Handle activation form submission
                async function handleActivationForm(e) {
                    e.preventDefault();
                    
                    const email = document.getElementById('email').value;
                    const submitBtn = document.getElementById('submitBtn');
                    const btnText = document.getElementById('btnText');
                    const btnLoading = document.getElementById('btnLoading');
                    const messageDiv = document.getElementById('activationMessage');
                    
                    // Validate email
                    if (!email || !email.includes('@')) {
                        showMessage(messageDiv, 'Please enter a valid email address', 'error');
                        return;
                    }
                    
                    // Show loading
                    submitBtn.disabled = true;
                    btnText.style.display = 'none';
                    btnLoading.style.display = 'inline-flex';
                    btnLoading.style.alignItems = 'center';
                    btnLoading.style.gap = '10px';
                    
                    try {
                        const response = await fetch('/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: email })
                        });
                        
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

                // View notification details
                async function viewNotificationDetails(id) {
                    try {
                        const notification = notifications.find(n => n.id == id);
                        if (!notification) return;
                        
                        currentNotificationId = id;
                        
                        const modal = document.getElementById('notificationDetailsModal');
                        const content = document.getElementById('notificationDetailsContent');
                        
                        const date = new Date(notification.created_at).toLocaleString();
                        const amount = notification.currency === 'NGN' ? '₦' : '';
                        
                        content.innerHTML = \`
                            <div class="notification-details">
                                <div class="detail-row">
                                    <div class="detail-label">User:</div>
                                    <div class="detail-value highlight">\${notification.userName || notification.user_email}</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">Amount:</div>
                                    <div class="detail-value highlight">\${amount}\${notification.amount}</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">Payment ID:</div>
                                    <div class="detail-value">\${notification.payment_id}</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">Method:</div>
                                    <div class="detail-value">\${notification.payment_method}</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">Status:</div>
                                    <div class="detail-value">\${notification.status}</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">Date:</div>
                                    <div class="detail-value">\${date}</div>
                                </div>
                                \${notification.note ? \`
                                    <div class="detail-row">
                                        <div class="detail-label">Note:</div>
                                        <div class="detail-value">\${notification.note}</div>
                                    </div>
                                \` : ''}
                            </div>
                        \`;
                        
                        modal.style.display = 'flex';
                    } catch (error) {
                        console.error('Error viewing notification:', error);
                        alert('Error loading notification details');
                    }
                }

                // Send activation code for current notification
                async function sendActivationToNotification() {
                    const notification = notifications.find(n => n.id == currentNotificationId);
                    if (!notification) return;
                    
                    if (confirm(\`Send activation code to \${notification.user_email}?\`)) {
                        try {
                            const response = await fetch('/send', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ email: notification.user_email })
                            });
                            
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

                // Mark notification as read
                async function markAsRead() {
                    if (!currentNotificationId) return;
                    
                    try {
                        const response = await fetch(\`/api/admin/notifications/\${currentNotificationId}/read\`, {
                            method: 'POST'
                        });
                        
                        const data = await response.json();
                        
                        if (data.success) {
                            loadDashboardData(); // Refresh dashboard
                            closeModal('notificationDetailsModal');
                        }
                    } catch (error) {
                        console.error('Error marking as read:', error);
                        alert('Error marking notification as read');
                    }
                }

                // Toggle notifications modal
                async function toggleNotifications() {
                    const modal = document.getElementById('notificationsModal');
                    
                    if (modal.style.display === 'flex') {
                        closeModal('notificationsModal');
                    } else {
                        await loadAllNotifications();
                        modal.style.display = 'flex';
                    }
                }

                // Load all notifications for modal - FIXED: Compare with 0 not false
                async function loadAllNotifications() {
                    try {
                        const response = await fetch('/api/admin/notifications/unread');
                        const data = await response.json();
                        
                        if (data.success) {
                            const listElement = document.getElementById('notificationsList');
                            
                            if (!data.notifications || data.notifications.length === 0) {
                                listElement.innerHTML = \`
                                    <div class="notification-empty">
                                        <i class="fas fa-bell-slash"></i>
                                        <p>No notifications found</p>
                                    </div>
                                \`;
                                return;
                            }
                            
                            let html = '';
                            data.notifications.forEach(notification => {
                                const timeAgo = getTimeAgo(notification.created_at);
                                const amount = notification.currency === 'NGN' ? '₦' : '';
                                
                                html += \`
                                    <div class="notification-item \${notification.is_read == 0 ? 'unread' : ''}" 
                                         onclick="viewNotificationDetails(\${notification.id})">
                                        <div class="notification-header">
                                            <div class="notification-title">
                                                <i class="fas fa-money-bill-wave" style="color: #06d6a0;"></i>
                                                New Payment Received
                                            </div>
                                            <div class="notification-time">\${timeAgo}</div>
                                        </div>
                                        <div class="notification-content">
                                            <strong>\${notification.userName || notification.user_email}</strong> paid <strong>\${amount}\${notification.amount}</strong> via \${notification.payment_method}
                                        </div>
                                        <div class="notification-meta">
                                            ID: \${notification.payment_id}
                                        </div>
                                    </div>
                                \`;
                            });
                            
                            listElement.innerHTML = html;
                        }
                    } catch (error) {
                        console.error('Error loading notifications:', error);
                    }
                }

                // View payment details
                function viewPayment(paymentId) {
                    window.location.href = \`/admin/payments#payment-\${paymentId}\`;
                }

                // Show activation modal
                function showSendActivationModal() {
                    const email = prompt('Enter user email to send activation code:');
                    if (email) {
                        document.getElementById('email').value = email;
                        document.getElementById('email').focus();
                    }
                }

                // Close modal
                function closeModal(modalId) {
                    document.getElementById(modalId).style.display = 'none';
                }

                // Logout
                async function logout() {
                    try {
                        const response = await fetch('/api/auth/logout', {
                            method: 'POST'
                        });
                        const data = await response.json();
                        if (data.success) {
                            window.location.href = '/admin/login';
                        }
                    } catch (error) {
                        console.error('Logout error:', error);
                    }
                }

                // Utility functions
                function getTimeAgo(dateString) {
                    const date = new Date(dateString);
                    const now = new Date();
                    const seconds = Math.floor((now - date) / 1000);
                    
                    if (seconds < 60) return 'Just now';
                    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
                    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
                    if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
                    return date.toLocaleDateString();
                }

                function showMessage(element, text, type) {
                    element.textContent = text;
                    element.className = 'message ' + type;
                    element.style.display = 'block';
                    
                    if (type === 'success') {
                        setTimeout(() => {
                            element.style.display = 'none';
                        }, 5000);
                    }
                }

                // Close modals when clicking outside
                window.onclick = function(event) {
                    if (event.target.classList.contains('modal')) {
                        event.target.style.display = 'none';
                    }
                }

                // Close modals with Escape key
                document.addEventListener('keydown', function(event) {
                    if (event.key === 'Escape') {
                        closeModal('notificationsModal');
                        closeModal('notificationDetailsModal');
                    }
                });
            </script>
        </body>
        </html>
    `);
});

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
            <title>Payments Management - Admin Dashboard</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                
                body { 
                    font-family: Arial, sans-serif; 
                    padding: 20px;
                    background: #f5f5f5;
                }
                
                .nav { 
                    background: #34495e; 
                    padding: 15px; 
                    margin-bottom: 20px;
                    border-radius: 5px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                
                .nav a { 
                    color: white; 
                    margin-right: 20px; 
                    text-decoration: none;
                    padding: 8px 15px;
                    border-radius: 4px;
                    transition: background 0.3s;
                }
                
                .nav a:hover { 
                    background: rgba(255,255,255,0.1);
                }
                
                .nav a.active {
                    background: rgba(255,255,255,0.2);
                }
                
                .logout { 
                    background: #e74c3c; 
                    color: white; 
                    padding: 8px 15px; 
                    text-decoration: none; 
                    border-radius: 4px;
                    border: none;
                    cursor: pointer;
                }
                
                .logout:hover {
                    background: #c0392b;
                }
                
                h1 { 
                    color: #2c3e50;
                    margin-bottom: 10px;
                }
                
                .welcome {
                    color: #7f8c8d;
                    margin-bottom: 30px;
                }
                
                .page-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    background: white;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
                }
                
                .search-box {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                }
                
                .search-box input {
                    padding: 10px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    width: 300px;
                }
                
                .search-box button {
                    padding: 10px 20px;
                    background: #3498db;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                }
                
                .search-box button:hover {
                    background: #2980b9;
                }
                
                .filters {
                    display: flex;
                    gap: 15px;
                    margin-bottom: 20px;
                    background: white;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
                }
                
                .filter-select {
                    padding: 8px 15px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    background: white;
                    min-width: 150px;
                }
                
                .stats {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 15px;
                    margin-bottom: 20px;
                }
                
                .stat-box { 
                    background: white; 
                    padding: 20px; 
                    border-radius: 5px; 
                    box-shadow: 0 2px 5px rgba(0,0,0,0.1); 
                    text-align: center;
                }
                
                .stat-box h3 {
                    margin: 0;
                    color: #7f8c8d;
                    font-size: 14px;
                    margin-bottom: 10px;
                }
                
                .stat-box p {
                    margin: 0;
                    font-size: 24px;
                    font-weight: bold;
                    color: #2c3e50;
                }
                
                .payments-table {
                    background: white;
                    border-radius: 8px;
                    overflow: hidden;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                
                .payments-table table {
                    width: 100%;
                    border-collapse: collapse;
                }
                
                .payments-table th {
                    background: #f8f9fa;
                    padding: 15px;
                    text-align: left;
                    font-weight: 600;
                    color: #495057;
                    border-bottom: 2px solid #dee2e6;
                }
                
                .payments-table td {
                    padding: 15px;
                    border-bottom: 1px solid #e9ecef;
                    color: #495057;
                }
                
                .payments-table tr:hover {
                    background: #f8f9fa;
                }
                
                .status-badge {
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 500;
                }
                
                .status-completed {
                    background: #d4edda;
                    color: #155724;
                }
                
                .status-pending {
                    background: #fff3cd;
                    color: #856404;
                }
                
                .status-failed {
                    background: #f8d7da;
                    color: #721c24;
                }
                
                .action-btn {
                    padding: 6px 12px;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    margin-right: 5px;
                }
                
                .btn-view {
                    background: #3498db;
                    color: white;
                }
                
                .btn-edit {
                    background: #f39c12;
                    color: white;
                }
                
                .btn-delete {
                    background: #e74c3c;
                    color: white;
                }
                
                .loading {
                    text-align: center;
                    padding: 50px;
                    color: #7f8c8d;
                }
                
                .loading:after {
                    content: '...';
                    animation: dots 1.5s steps(5, end) infinite;
                }
                
                @keyframes dots {
                    0%, 20% { content: ''; }
                    40% { content: '.'; }
                    60% { content: '..'; }
                    80%, 100% { content: '...'; }
                }
                
                .error {
                    text-align: center;
                    padding: 50px;
                    color: #e74c3c;
                }
                
                @media (max-width: 768px) {
                    .stats {
                        grid-template-columns: repeat(2, 1fr);
                    }
                    
                    .search-box input {
                        width: 200px;
                    }
                    
                    .filters {
                        flex-direction: column;
                    }
                    
                    .filter-select {
                        width: 100%;
                    }
                    
                    th, td {
                        padding: 10px;
                        font-size: 14px;
                    }
                    
                    .payments-table {
                        overflow-x: auto;
                    }
                }
            </style>
        </head>
        <body>
            <div class="nav">
                <div>
                    <a href="/admin/dashboard">Dashboard</a>
                    <a href="/admin/users">Users</a>
                    <a href="/admin/payments" class="active">Payments</a>
                    <a href="/admin/questions">Questions</a>
                </div>
                <button class="logout" onclick="logout()">Logout</button>
            </div>
            
            <h1>💰 Payments Management</h1>
            <div class="welcome">View and manage all payment transactions</div>
            
            <div class="page-header">
                <div class="search-box">
                    <input type="text" id="searchInput" placeholder="Search payments...">
                    <button onclick="searchPayments()">Search</button>
                </div>
            </div>
            
            <div class="stats">
                <div class="stat-box">
                    <h3>Total Payments</h3>
                    <p id="totalPaymentsStat">0</p>
                </div>
                <div class="stat-box">
                    <h3>Completed</h3>
                    <p id="completedPayments">0</p>
                </div>
                <div class="stat-box">
                    <h3>Pending</h3>
                    <p id="pendingPayments">0</p>
                </div>
                <div class="stat-box">
                    <h3>Total Revenue</h3>
                    <p id="totalRevenueStat">₦0</p>
                </div>
            </div>
            
            <div class="filters">
                <select id="statusFilter" class="filter-select" onchange="filterPayments()">
                    <option value="">All Status</option>
                    <option value="completed">Completed</option>
                    <option value="pending">Pending</option>
                    <option value="failed">Failed</option>
                </select>
                <select id="methodFilter" class="filter-select" onchange="filterPayments()">
                    <option value="">All Methods</option>
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="card">Card</option>
                    <option value="bank">Bank</option>
                </select>
                <select id="dateFilter" class="filter-select" onchange="filterPayments()">
                    <option value="">All Time</option>
                    <option value="today">Today</option>
                    <option value="week">This Week</option>
                    <option value="month">This Month</option>
                </select>
            </div>
            
            <div class="payments-table">
                <table id="paymentsTable">
                    <thead>
                         <tr>
                            <th>Payment ID</th>
                            <th>Email</th>
                            <th>Amount</th>
                            <th>Method</th>
                            <th>Status</th>
                            <th>Date</th>
                            <th>Note</th>
                            <th>Actions</th>
                         </tr>
                    </thead>
                    <tbody id="paymentsTableBody">
                         <tr>
                            <td colspan="8" class="loading">Loading payments</td>
                         </tr>
                    </tbody>
                 </table>
            </div>
            
            <script>
                let allPayments = [];
                
                async function loadPayments() {
                    try {
                        const response = await fetch('/api/admin/payments');
                        const data = await response.json();
                        
                        if (data.success) {
                            allPayments = data.payments;
                            displayPayments(allPayments);
                            updatePaymentStats(data.payments);
                        } else {
                            document.getElementById('paymentsTableBody').innerHTML = \`
                                 <tr>
                                    <td colspan="8" class="error">Error loading payments: \${data.message}</td>
                                 </tr>
                            \`;
                        }
                    } catch (error) {
                        console.error('Error loading payments:', error);
                        document.getElementById('paymentsTableBody').innerHTML = \`
                             <tr>
                                <td colspan="8" class="error">Failed to load payments. Please try again.</td>
                             </tr>
                        \`;
                    }
                }
                
                function displayPayments(payments) {
                    const tableBody = document.getElementById('paymentsTableBody');
                    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
                    const statusFilter = document.getElementById('statusFilter').value;
                    const methodFilter = document.getElementById('methodFilter').value;
                    
                    // Filter payments
                    const filteredPayments = payments.filter(payment => {
                        const matchesSearch = 
                            (payment.payment_id && payment.payment_id.toLowerCase().includes(searchTerm)) ||
                            (payment.email && payment.email.toLowerCase().includes(searchTerm)) ||
                            (payment.note && payment.note.toLowerCase().includes(searchTerm));
                        
                        const matchesStatus = !statusFilter || payment.status === statusFilter;
                        const matchesMethod = !methodFilter || payment.payment_method === methodFilter;
                        
                        return matchesSearch && matchesStatus && matchesMethod;
                    });
                    
                    if (filteredPayments.length === 0) {
                        tableBody.innerHTML = \`
                             <tr>
                                <td colspan="8" style="text-align: center; padding: 50px; color: #7f8c8d;">
                                    No payments found matching your criteria.
                                 </td>
                             </tr>
                        \`;
                        return;
                    }
                    
                    let html = '';
                    filteredPayments.forEach(payment => {
                        const date = new Date(payment.created_at).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                        
                        html += \`
                             <tr>
                                <td style="font-size: 12px; color: #7f8c8d; font-family: monospace;">
                                    \${payment.payment_id}
                                 </td>
                                <td>\${payment.email}</td>
                                <td>\${payment.currency === 'NGN' ? '₦' : ''}\${payment.amount}</td>
                                <td>
                                    <span style="padding: 4px 8px; background: #e3f2fd; color: #1565c0; border-radius: 4px; font-size: 12px;">
                                        \${payment.payment_method || 'N/A'}
                                    </span>
                                 </td>
                                <td>
                                    <span class="status-badge status-\${payment.status}">
                                        \${payment.status}
                                    </span>
                                 </td>
                                <td>\${date}</td>
                                <td>\${payment.note || '-'}</td>
                                <td>
                                    <button class="action-btn btn-view" onclick="viewPayment(\${payment.id})">
                                        View
                                    </button>
                                    <button class="action-btn btn-edit" onclick="editPayment(\${payment.id})">
                                        Edit
                                    </button>
                                 </td>
                             </tr>
                        \`;
                    });
                    
                    tableBody.innerHTML = html;
                }
                
                function updatePaymentStats(payments) {
                    const totalPayments = payments.length;
                    const completedPayments = payments.filter(p => p.status === 'completed').length;
                    const pendingPayments = payments.filter(p => p.status === 'pending').length;
                    const totalRevenue = payments
                        .filter(p => p.status === 'completed')
                        .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
                    
                    document.getElementById('totalPaymentsStat').textContent = totalPayments;
                    document.getElementById('completedPayments').textContent = completedPayments;
                    document.getElementById('pendingPayments').textContent = pendingPayments;
                    document.getElementById('totalRevenueStat').textContent = '₦' + totalRevenue.toFixed(2);
                }
                
                function searchPayments() {
                    displayPayments(allPayments);
                }
                
                function filterPayments() {
                    displayPayments(allPayments);
                }
                
                function viewPayment(paymentId) {
                    alert('View payment details for ID: ' + paymentId + ' (Feature coming soon)');
                }
                
                function editPayment(paymentId) {
                    alert('Edit payment for ID: ' + paymentId + ' (Feature coming soon)');
                }
                
                async function logout() {
                    try {
                        const response = await fetch('/api/auth/logout', {
                            method: 'POST'
                        });
                        const data = await response.json();
                        if (data.success) {
                            window.location.href = '/admin/login';
                        }
                    } catch (error) {
                        console.error('Logout error:', error);
                    }
                }
                
                // Initial load
                loadPayments();
                
                // Auto-refresh every 30 seconds
                setInterval(loadPayments, 30000);
            </script>
        </body>
        </html>
    `);
});

// ========== USER MANAGEMENT ==========
// UPDATED: Shows active/inactive status based on is_activated field

// Get all users API - UPDATED to include is_activated status
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
        
        // Get statistics
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
        
        res.json({
            success: true,
            users: users,
            stats: stats
        });
        
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Users Management Page - UPDATED to show active/inactive status correctly
router.get("/admin/users", checkAdminAuth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>User Management - Admin Dashboard</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                
                body { 
                    font-family: Arial, sans-serif; 
                    padding: 20px;
                    background: #f5f5f5;
                }
                
                .nav { 
                    background: #34495e; 
                    padding: 15px; 
                    margin-bottom: 20px;
                    border-radius: 5px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                
                .nav a { 
                    color: white; 
                    margin-right: 20px; 
                    text-decoration: none;
                    padding: 8px 15px;
                    border-radius: 4px;
                    transition: background 0.3s;
                }
                
                .nav a:hover { 
                    background: rgba(255,255,255,0.1);
                }
                
                .nav a.active {
                    background: rgba(255,255,255,0.2);
                }
                
                .logout { 
                    background: #e74c3c; 
                    color: white; 
                    padding: 8px 15px; 
                    text-decoration: none; 
                    border-radius: 4px;
                    border: none;
                    cursor: pointer;
                }
                
                .logout:hover {
                    background: #c0392b;
                }
                
                h1 { 
                    color: #2c3e50;
                    margin-bottom: 10px;
                }
                
                .welcome {
                    color: #7f8c8d;
                    margin-bottom: 30px;
                }
                
                .page-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    background: white;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
                }
                
                .search-box {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                }
                
                .search-box input {
                    padding: 10px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    width: 300px;
                }
                
                .search-box button {
                    padding: 10px 20px;
                    background: #3498db;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                }
                
                .search-box button:hover {
                    background: #2980b9;
                }
                
                .add-user-btn {
                    background: #2ecc71;
                    color: white;
                    padding: 10px 20px;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-weight: bold;
                }
                
                .add-user-btn:hover {
                    background: #27ae60;
                }
                
                .stats {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 15px;
                    margin-bottom: 20px;
                }
                
                .stat-box { 
                    background: white; 
                    padding: 20px; 
                    border-radius: 5px; 
                    box-shadow: 0 2px 5px rgba(0,0,0,0.1); 
                    text-align: center;
                }
                
                .stat-box h3 {
                    margin: 0;
                    color: #7f8c8d;
                    font-size: 14px;
                    margin-bottom: 10px;
                }
                
                .stat-box p {
                    margin: 0;
                    font-size: 24px;
                    font-weight: bold;
                    color: #2c3e50;
                }
                
                .filters {
                    display: flex;
                    gap: 15px;
                    margin-bottom: 20px;
                    background: white;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
                }
                
                .filter-select {
                    padding: 8px 15px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    background: white;
                    min-width: 150px;
                }
                
                .users-table {
                    background: white;
                    border-radius: 8px;
                    overflow: hidden;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                
                .users-table table {
                    width: 100%;
                    border-collapse: collapse;
                }
                
                .users-table th {
                    background: #f8f9fa;
                    padding: 15px;
                    text-align: left;
                    font-weight: 600;
                    color: #495057;
                    border-bottom: 2px solid #dee2e6;
                }
                
                .users-table td {
                    padding: 15px;
                    border-bottom: 1px solid #e9ecef;
                    color: #495057;
                }
                
                .users-table tr:hover {
                    background: #f8f9fa;
                    cursor: pointer;
                }
                
                .user-avatar {
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    font-size: 18px;
                }
                
                .user-cell {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                
                .user-info h4 {
                    margin: 0;
                    color: #2c3e50;
                }
                
                .user-info p {
                    margin: 3px 0 0;
                    color: #7f8c8d;
                    font-size: 12px;
                }
                
                .status-badge {
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 500;
                }
                
                .status-active {
                    background: #d4edda;
                    color: #155724;
                }
                
                .status-inactive {
                    background: #f8d7da;
                    color: #721c24;
                }
                
                .role-badge {
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 500;
                }
                
                .role-student {
                    background: #e3f2fd;
                    color: #1565c0;
                }
                
                .role-admin {
                    background: #f3e5f5;
                    color: #7b1fa2;
                }
                
                .action-btn {
                    padding: 6px 12px;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    margin-right: 5px;
                }
                
                .btn-view {
                    background: #3498db;
                    color: white;
                }
                
                .btn-edit {
                    background: #f39c12;
                    color: white;
                }
                
                .btn-delete {
                    background: #e74c3c;
                    color: white;
                }
                
                .btn-activate {
                    background: #2ecc71;
                    color: white;
                }
                
                .btn-deactivate {
                    background: #e67e22;
                    color: white;
                }
                
                .loading {
                    text-align: center;
                    padding: 50px;
                    color: #7f8c8d;
                }
                
                .loading:after {
                    content: '...';
                    animation: dots 1.5s steps(5, end) infinite;
                }
                
                @keyframes dots {
                    0%, 20% { content: ''; }
                    40% { content: '.'; }
                    60% { content: '..'; }
                    80%, 100% { content: '...'; }
                }
                
                .error {
                    text-align: center;
                    padding: 50px;
                    color: #e74c3c;
                }
                
                @media (max-width: 768px) {
                    .stats {
                        grid-template-columns: repeat(2, 1fr);
                    }
                    
                    .page-header {
                        flex-direction: column;
                        gap: 15px;
                        align-items: stretch;
                    }
                    
                    .search-box input {
                        width: 100%;
                    }
                    
                    .filters {
                        flex-direction: column;
                    }
                    
                    .filter-select {
                        width: 100%;
                    }
                    
                    th, td {
                        padding: 10px;
                        font-size: 14px;
                    }
                    
                    .users-table {
                        overflow-x: auto;
                    }
                    
                    .action-btn {
                        margin-bottom: 5px;
                        display: block;
                        width: 100%;
                    }
                }
            </style>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </head>
        <body>
            <div class="nav">
                <div>
                    <a href="/admin/dashboard">Dashboard</a>
                    <a href="/admin/users" class="active">Users</a>
                    <a href="/admin/payments">Payments</a>
                    <a href="/admin/questions">Questions</a>
                </div>
                <button class="logout" onclick="logout()">Logout</button>
            </div>
            
            <h1>👥 User Management</h1>
            <div class="welcome">Manage and view all registered users</div>
            
            <div class="page-header">
                <div class="search-box">
                    <input type="text" id="searchInput" placeholder="Search users by name, email, or ID...">
                    <button onclick="searchUsers()">🔍 Search</button>
                </div>
            </div>
            
            <div class="stats">
                <div class="stat-box">
                    <h3>Total Users</h3>
                    <p id="totalUsersStat">0</p>
                </div>
                <div class="stat-box">
                    <h3>Active Users</h3>
                    <p id="activeUsersStat">0</p>
                </div>
                <div class="stat-box">
                    <h3>Students</h3>
                    <p id="studentsCount">0</p>
                </div>
                <div class="stat-box">
                    <h3>Paid Users</h3>
                    <p id="paidUsersStat">0</p>
                </div>
            </div>
            
            <div class="filters">
                <select id="roleFilter" class="filter-select" onchange="filterUsers()">
                    <option value="">All Roles</option>
                    <option value="student">Student</option>
                    <option value="admin">Admin</option>
                </select>
                <select id="statusFilter" class="filter-select" onchange="filterUsers()">
                    <option value="">All Status</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                </select>
                <select id="dateFilter" class="filter-select" onchange="filterUsers()">
                    <option value="">All Time</option>
                    <option value="today">Today</option>
                    <option value="week">This Week</option>
                    <option value="month">This Month</option>
                </select>
            </div>
            
            <div class="users-table">
                <table id="usersTable">
                    <thead>
                         <tr>
                            <th>User</th>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th>Activation Code</th>
                            <th>Created At</th>
                            <th>Actions</th>
                         </tr>
                    </thead>
                    <tbody id="usersTableBody">
                         <tr>
                            <td colspan="7" class="loading">Loading users</td>
                         </tr>
                    </tbody>
                 </table>
            </div>
            
            <script>
                let allUsers = [];
                
                async function loadUsers() {
                    try {
                        const response = await fetch('/api/admin/users');
                        const data = await response.json();
                        
                        if (data.success) {
                            allUsers = data.users;
                            displayUsers(allUsers);
                            updateUserStats(data.stats);
                        } else {
                            document.getElementById('usersTableBody').innerHTML = \`
                                 <tr>
                                    <td colspan="7" class="error">Error loading users: \${data.message}</td>
                                 </tr>
                            \`;
                        }
                    } catch (error) {
                        console.error('Error loading users:', error);
                        document.getElementById('usersTableBody').innerHTML = \`
                             <tr>
                                <td colspan="7" class="error">Failed to load users. Please try again.</td>
                             </tr>
                        \`;
                    }
                }
                
                function displayUsers(users) {
                    const tableBody = document.getElementById('usersTableBody');
                    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
                    const roleFilter = document.getElementById('roleFilter').value;
                    const statusFilter = document.getElementById('statusFilter').value;
                    
                    // Filter users
                    const filteredUsers = users.filter(user => {
                        const matchesSearch = 
                            (user.userName && user.userName.toLowerCase().includes(searchTerm)) ||
                            (user.email && user.email.toLowerCase().includes(searchTerm)) ||
                            (user.id && user.id.toString().includes(searchTerm));
                        
                        const matchesRole = !roleFilter || (user.role && user.role === roleFilter);
                        // FIXED: Check is_activated correctly (comparing with '1')
                        const matchesStatus = !statusFilter || 
                            (statusFilter === 'active' ? user.is_activated === '1' : user.is_activated !== '1');
                        
                        return matchesSearch && matchesRole && matchesStatus;
                    });
                    
                    if (filteredUsers.length === 0) {
                        tableBody.innerHTML = \`
                             <tr>
                                <td colspan="7" style="text-align: center; padding: 50px; color: #7f8c8d;">
                                    No users found matching your criteria.
                                 </td>
                             </tr>
                        \`;
                        return;
                    }
                    
                    let html = '';
                    filteredUsers.forEach(user => {
                        const initials = user.userName ? user.userName.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase();
                        const createdAt = new Date(user.created_at).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric'
                        });
                        
                        // FIXED: Check is_activated correctly (comparing with '1')
                        const isActive = user.is_activated === '1';
                        
                        html += \`
                             <tr>
                                <td>
                                    <div class="user-cell">
                                        <div class="user-avatar">\${initials}</div>
                                        <div class="user-info">
                                            <h4>\${user.userName || 'N/A'}</h4>
                                            <p>ID: \${user.id}</p>
                                        </div>
                                    </div>
                                 </td>
                                <td>\${user.email}</td>
                                <td>
                                    <span class="role-badge role-\${user.role || 'student'}">
                                        \${user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : 'Student'}
                                    </span>
                                 </td>
                                <td>
                                    <span class="status-badge \${isActive ? 'status-active' : 'status-inactive'}">
                                        \${isActive ? 'Active' : 'Inactive'}
                                    </span>
                                 </td>
                                <td>
                                    \${user.activationCode ? 
                                        '<span style="font-family: monospace; background: #f0f0f0; padding: 4px 8px; border-radius: 4px;">' + user.activationCode + '</span>' : 
                                        '<span style="color: #999;">No code</span>'}
                                 </td>
                                <td>\${createdAt}</td>
                                <td>
                                    <button class="action-btn btn-view" onclick="sendActivationCode('\${user.email}')" title="Send Activation Code">
                                        <i class="fas fa-key"></i>
                                    </button>
                                    \${!isActive ? 
                                        '<button class="action-btn btn-activate" onclick="activateUser(' + user.id + ')" title="Activate User"><i class="fas fa-check-circle"></i></button>' : 
                                        '<button class="action-btn btn-deactivate" onclick="deactivateUser(' + user.id + ')" title="Deactivate User"><i class="fas fa-ban"></i></button>'
                                    }
                                    <button class="action-btn btn-delete" onclick="deleteUser(\${user.id})" title="Delete User">
                                        <i class="fas fa-trash"></i>
                                    </button>
                                 </td>
                             </tr>
                        \`;
                    });
                    
                    tableBody.innerHTML = html;
                }
                
                function updateUserStats(stats) {
                    document.getElementById('totalUsersStat').textContent = stats.totalUsers || 0;
                    document.getElementById('activeUsersStat').textContent = stats.activeUsers || 0;
                    document.getElementById('studentsCount').textContent = stats.students || 0;
                    document.getElementById('paidUsersStat').textContent = stats.paidUsers || 0;
                }
                
                function searchUsers() {
                    displayUsers(allUsers);
                }
                
                function filterUsers() {
                    displayUsers(allUsers);
                }
                
                // FIXED: Activate user function (sets is_activated to '1')
                async function activateUser(userId) {
                    if (confirm('Are you sure you want to activate this user?')) {
                        try {
                            const response = await fetch(\`/api/admin/users/\${userId}/activate\`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ activate: true })
                            });
                            
                            const data = await response.json();
                            
                            if (data.success) {
                                alert('User activated successfully!');
                                loadUsers();
                            } else {
                                alert('Failed to activate user: ' + data.message);
                            }
                        } catch (error) {
                            console.error('Error activating user:', error);
                            alert('Error activating user');
                        }
                    }
                }
                
                // FIXED: Deactivate user function (sets is_activated to '0' or NULL)
                async function deactivateUser(userId) {
                    if (confirm('Are you sure you want to deactivate this user?')) {
                        try {
                            const response = await fetch(\`/api/admin/users/\${userId}/deactivate\`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' }
                            });
                            
                            const data = await response.json();
                            
                            if (data.success) {
                                alert('User deactivated successfully!');
                                loadUsers();
                            } else {
                                alert('Failed to deactivate user: ' + data.message);
                            }
                        } catch (error) {
                            console.error('Error deactivating user:', error);
                            alert('Error deactivating user');
                        }
                    }
                }
                
                async function deleteUser(userId) {
                    if (confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
                        try {
                            const response = await fetch(\`/api/admin/users/\${userId}\`, {
                                method: 'DELETE'
                            });
                            
                            const data = await response.json();
                            
                            if (data.success) {
                                alert('User deleted successfully!');
                                loadUsers();
                            } else {
                                alert('Failed to delete user: ' + data.message);
                            }
                        } catch (error) {
                            console.error('Error deleting user:', error);
                            alert('Error deleting user');
                        }
                    }
                }
                
                async function sendActivationCode(email) {
                    if (confirm(\`Send activation code to \${email}?\`)) {
                        try {
                            const response = await fetch('/send', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ email: email })
                            });
                            
                            const data = await response.json();
                            
                            if (data.success) {
                                alert('Activation code sent successfully!');
                            } else {
                                alert('Failed to send activation code: ' + (data.message || 'Unknown error'));
                            }
                        } catch (error) {
                            console.error('Error sending activation code:', error);
                            alert('Error sending activation code');
                        }
                    }
                }
                
                async function logout() {
                    try {
                        const response = await fetch('/api/auth/logout', {
                            method: 'POST'
                        });
                        const data = await response.json();
                        if (data.success) {
                            window.location.href = '/admin/login';
                        }
                    } catch (error) {
                        console.error('Logout error:', error);
                    }
                }
                
                // Initial load
                loadUsers();
                
                // Auto-refresh every 30 seconds
                setInterval(loadUsers, 30000);
            </script>
        </body>
        </html>
    `);
});

// ========== USER ACTIVATION API ROUTES ==========

// Activate user (set is_activated = '1')
router.post("/api/admin/users/:id/activate", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const userId = req.params.id;
    
    try {
        const query = `
            UPDATE jambuser 
            SET is_activated = '1', updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
            RETURNING id, email, "userName", is_activated
        `;
        
        const result = await pool.query(query, [userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        console.log(`✅ User ${result.rows[0].email} activated successfully`);
        
        res.json({
            success: true,
            message: 'User activated successfully',
            user: result.rows[0]
        });
        
    } catch (err) {
        console.error('Error activating user:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Deactivate user (set is_activated = '0')
router.post("/api/admin/users/:id/deactivate", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const userId = req.params.id;
    
    try {
        const query = `
            UPDATE jambuser 
            SET is_activated = '0', updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
            RETURNING id, email, "userName", is_activated
        `;
        
        const result = await pool.query(query, [userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        console.log(`✅ User ${result.rows[0].email} deactivated successfully`);
        
        res.json({
            success: true,
            message: 'User deactivated successfully',
            user: result.rows[0]
        });
        
    } catch (err) {
        console.error('Error deactivating user:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ========== QUESTION MANAGEMENT ==========

// Admin statistics API
router.get("/api/admin/statistics", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const queries = {
        totalUsers: "SELECT COUNT(*) as count FROM jambuser",
        // FIXED: Count active users where is_activated = '1'
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

// Check admin access
router.get("/api/admin/check-access", (req, res) => {
    const isAdmin = req.session && req.session.adminLoggedIn && 
                   ['super_admin', 'admin', 'moderator'].includes(req.session.adminRole);
    
    res.json({
        success: true,
        canAccessAdmin: isAdmin,
        isAdmin: isAdmin
    });
});

// ========== ACTIVATION CODE ROUTES ==========

// Send activation code
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
        const checkQuery = "SELECT * FROM user_payments WHERE email = $1";
        const paymentResult = await pool.query(checkQuery, [email]);

        if (paymentResult.rows.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: "User has not made payment" 
            });
        }

        // Check if user exists in jambuser table
        const checkUserQuery = "SELECT * FROM jambuser WHERE email = $1";
        const userResult = await pool.query(checkUserQuery, [email]);

        if (userResult.rows.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: "User not found. Please register first." 
            });
        }

        // Update activation code - using "activationCode" with quotes for camelCase
        const updateQuery = 'UPDATE jambuser SET "activationCode" = $1 WHERE email = $2';
        await pool.query(updateQuery, [activationCode, email]);

        console.log(`✅ Activation code ${activationCode} updated for ${email}`);

        // Send email with activation code using SendGrid
        const emailContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #1a237e 0%, #311b92 100%); padding: 30px; text-align: center;">
                    <h1 style="color: white; margin: 0;">🎯 JAMB Prep</h1>
                </div>
                <div style="padding: 30px; background: white;">
                    <h2 style="color: #1a237e;">Your Activation Code</h2>
                    <p>Hello,</p>
                    <p>Thank you for registering with JAMB Prep. Here is your activation code:</p>
                    <div style="background: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0; border-radius: 10px; border: 2px dashed #1a237e;">
                        <div style="font-size: 2.5rem; font-weight: bold; color: #1a237e; letter-spacing: 5px;">
                            ${activationCode}
                        </div>
                    </div>
                    <p>Use this code to activate your account and access all features.</p>
                    <p>If you didn't request this code, please ignore this email.</p>
                    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                        <p style="color: #666; font-size: 0.9rem;">
                            Best regards,<br>
                            The JAMB Prep Team
                        </p>
                    </div>
                </div>
            </div>
        `;

        const msg = {
            to: email,
            from: 'piotech52@gmail.com',
            subject: "Your JAMB Prep Activation Code",
            html: emailContent
        };
        
        await sgMail.send(msg);

        res.json({
            success: true,
            message: 'Activation code sent successfully'
        });

    } catch (error) {
        console.error('General error:', error);
        res.status(500).json({ 
            success: false,
            message: "Server error" 
        });
    }
});

// ========== QUESTION MANAGEMENT API ROUTES ==========

// Get all subjects for dropdown
router.get("/api/subjects", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const query = 'SELECT id, subject_code, subject_name FROM subjects ORDER BY subject_name';
    
    try {
        const result = await pool.query(query);
        res.json({ success: true, subjects: result.rows });
    } catch (err) {
        console.error('Error fetching subjects:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Get question tables for a subject
router.get("/api/subject-tables/:subject", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const subject = req.params.subject.toLowerCase();
    const tableName = `${subject}_questions`;
    
    try {
        // Check if table exists in PostgreSQL
        const checkQuery = `
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = $1
            )
        `;
        const checkResult = await pool.query(checkQuery, [tableName]);
        
        if (!checkResult.rows[0].exists) {
            return res.json({ success: false, message: 'Table does not exist' });
        }
        
        // Get table structure
        const descQuery = `
            SELECT column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_name = $1
            ORDER BY ordinal_position
        `;
        const structureResult = await pool.query(descQuery, [tableName]);
        
        // Get row count
        const countQuery = `SELECT COUNT(*) as count FROM "${tableName}"`;
        const countResult = await pool.query(countQuery);
        
        res.json({
            success: true,
            tableExists: true,
            tableName: tableName,
            rowCount: parseInt(countResult.rows[0]?.count) || 0,
            structure: structureResult.rows
        });
        
    } catch (err) {
        console.error('Error checking table:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Insert new question with image
router.post("/api/insert-question", checkAdminAuth, upload.single('question_image'), async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const {
        subject,
        question_number,
        year,
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_answer,
        topic,
        explanation
    } = req.body;
    
    // Validate required fields
    if (!subject || !question_text || !option_a || !option_b || !option_c || !option_d || !correct_answer) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const tableName = `${subject.toLowerCase()}_questions`;
    let imageFilename = null;
    let imageData = null;
    
    // Handle image if uploaded
    if (req.file) {
        imageFilename = req.file.filename;
        // Convert image to base64 for storage
        const imagePath = req.file.path;
        try {
            const imageBuffer = fs.readFileSync(imagePath);
            imageData = imageBuffer.toString('base64');
        } catch (error) {
            console.error('Error reading image file:', error);
        }
    }
    
    // Build query based on whether explanation column exists
    const checkColumnsQuery = `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = $1 AND column_name = 'explanation'
    `;
    
    try {
        const columnResult = await pool.query(checkColumnsQuery, [tableName]);
        const hasExplanation = columnResult.rows.length > 0;
        
        let insertQuery, insertValues;
        
        if (hasExplanation) {
            insertQuery = `
                INSERT INTO "${tableName}" 
                (question_number, year, subject, question_text, option_a, option_b, option_c, option_d, correct_answer, topic, image_filename, image_data, explanation) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING id
            `;
            insertValues = [
                question_number || null,
                year || null,
                subject.toUpperCase(),
                question_text,
                option_a,
                option_b,
                option_c,
                option_d,
                correct_answer,
                topic || null,
                imageFilename,
                imageData,
                explanation || null
            ];
        } else {
            insertQuery = `
                INSERT INTO "${tableName}" 
                (question_number, year, subject, question_text, option_a, option_b, option_c, option_d, correct_answer, topic, image_filename, image_data) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING id
            `;
            insertValues = [
                question_number || null,
                year || null,
                subject.toUpperCase(),
                question_text,
                option_a,
                option_b,
                option_c,
                option_d,
                correct_answer,
                topic || null,
                imageFilename,
                imageData
            ];
        }
        
        const result = await pool.query(insertQuery, insertValues);
        
        res.json({
            success: true,
            message: 'Question inserted successfully',
            questionId: result.rows[0].id
        });
        
    } catch (err) {
        console.error('Error inserting question:', err);
        // Delete uploaded file if database insert fails
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: 'Failed to insert question' });
    }
});

// Search questions
router.get("/api/search-questions", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const { subject, searchTerm, searchBy } = req.query;
    
    if (!subject) {
        return res.status(400).json({ success: false, error: 'Subject is required' });
    }
    
    const tableName = `${subject.toLowerCase()}_questions`;
    let searchQuery;
    let queryParams = [];
    
    try {
        if (searchTerm && searchBy) {
            switch (searchBy) {
                case 'question_text':
                    searchQuery = `SELECT * FROM "${tableName}" WHERE question_text ILIKE $1 LIMIT 50`;
                    queryParams = [`%${searchTerm}%`];
                    break;
                case 'question_number':
                    searchQuery = `SELECT * FROM "${tableName}" WHERE question_number = $1`;
                    queryParams = [searchTerm];
                    break;
                case 'year':
                    searchQuery = `SELECT * FROM "${tableName}" WHERE year = $1 LIMIT 50`;
                    queryParams = [searchTerm];
                    break;
                case 'topic':
                    searchQuery = `SELECT * FROM "${tableName}" WHERE topic ILIKE $1 LIMIT 50`;
                    queryParams = [`%${searchTerm}%`];
                    break;
                default:
                    searchQuery = `SELECT * FROM "${tableName}" WHERE question_text ILIKE $1 LIMIT 50`;
                    queryParams = [`%${searchTerm}%`];
            }
        } else {
            searchQuery = `SELECT * FROM "${tableName}" LIMIT 50`;
        }
        
        const result = await pool.query(searchQuery, queryParams);
        
        // Format results
        const formattedResults = result.rows.map(question => ({
            id: question.id,
            question_number: question.question_number,
            year: question.year,
            subject: question.subject,
            question_text: question.question_text?.substring(0, 100) + (question.question_text?.length > 100 ? '...' : ''),
            option_a: question.option_a?.substring(0, 50),
            option_b: question.option_b?.substring(0, 50),
            option_c: question.option_c?.substring(0, 50),
            option_d: question.option_d?.substring(0, 50),
            correct_answer: question.correct_answer,
            topic: question.topic,
            has_image: !!question.image_filename,
            image_filename: question.image_filename,
            created_at: question.created_at,
            explanation: question.explanation
        }));
        
        res.json({
            success: true,
            count: result.rows.length,
            questions: formattedResults
        });
        
    } catch (err) {
        console.error('Error searching questions:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Question Management Page
router.get("/admin/questions", checkAdminAuth, (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JAMB Admin - Question Management</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body { background-color: #f8f9fa; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .navbar { background: linear-gradient(135deg, #2c3e50, #34495e); }
        .sidebar { background-color: #fff; min-height: 100vh; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        .main-content { padding: 20px; }
        .card { border: none; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .card-header { background: linear-gradient(135deg, #3498db, #2980b9); color: white; border-radius: 10px 10px 0 0 !important; }
        .form-section { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .question-preview-img { max-width: 100%; max-height: 200px; object-fit: contain; }
        .question-table { font-size: 0.9rem; }
        .question-table th { background-color: #f8f9fa; }
        .badge-subject { font-size: 0.8rem; padding: 5px 10px; }
        .action-buttons .btn { margin-right: 5px; }
        .search-box { max-width: 300px; }
        .status-badge { font-size: 0.75rem; }
        .image-preview-container { border: 2px dashed #ddd; padding: 15px; text-align: center; border-radius: 5px; }
        .image-preview { max-width: 100%; max-height: 150px; }
        .tab-content { padding-top: 20px; }
        .nav-tabs .nav-link { border: none; color: #6c757d; }
        .nav-tabs .nav-link.active { color: #3498db; border-bottom: 2px solid #3498db; background: transparent; }
        .toast { position: fixed; top: 20px; right: 20px; z-index: 9999; }
        .loading { display: none; text-align: center; padding: 20px; }
        .loading.active { display: block; }
        .question-text { max-height: 100px; overflow-y: auto; }
    </style>
</head>
<body>
    <!-- Navigation -->
    <nav class="navbar navbar-expand-lg navbar-dark">
        <div class="container-fluid">
            <a class="navbar-brand" href="#">
                <i class="fas fa-graduation-cap"></i> JAMB Admin Portal
            </a>
            <div class="navbar-text text-light">
                <i class="fas fa-user-shield"></i> Question Management System
            </div>
        </div>
    </nav>

    <div class="container-fluid">
        <div class="row">
            <!-- Sidebar -->
            <div class="col-md-3 col-lg-2 sidebar p-3">
                <h5 class="mb-3"><i class="fas fa-tasks"></i> Menu</h5>
                <ul class="nav flex-column">
                    <li class="nav-item">
                        <a class="nav-link active" href="#" id="nav-insert">
                            <i class="fas fa-plus-circle"></i> Insert Question
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link" href="#" id="nav-search">
                            <i class="fas fa-search"></i> Search Questions
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link" href="#" id="nav-stats">
                            <i class="fas fa-chart-bar"></i> Statistics
                        </a>
                    </li>
                </ul>
                
                <hr>
                
                <h6 class="mt-3"><i class="fas fa-book"></i> Subjects</h6>
                <div id="subject-list" class="mb-3">
                    <div class="spinner-border spinner-border-sm" role="status">
                        <span class="visually-hidden">Loading...</span>
                    </div>
                </div>
                
                <div class="mt-4">
                    <div class="alert alert-info small">
                        <i class="fas fa-info-circle"></i> 
                        <strong>Tip:</strong> Use Ctrl+F to quickly search in tables
                    </div>
                </div>
            </div>

            <!-- Main Content -->
            <div class="col-md-9 col-lg-10 main-content">
                <div id="loading" class="loading">
                    <div class="spinner-border text-primary" role="status">
                        <span class="visually-hidden">Loading...</span>
                    </div>
                    <p class="mt-2">Loading...</p>
                </div>

                <!-- Insert Question Tab -->
                <div id="insert-tab" class="tab-content">
                    <div class="card">
                        <div class="card-header">
                            <h4 class="mb-0"><i class="fas fa-plus-circle"></i> Insert New Question</h4>
                        </div>
                        <div class="card-body">
                            <form id="question-form" enctype="multipart/form-data">
                                <div class="row">
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Subject *</label>
                                            <select class="form-select" id="subject" name="subject" required>
                                                <option value="">Select Subject</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div class="col-md-3">
                                        <div class="mb-3">
                                            <label class="form-label">Question Number</label>
                                            <input type="number" class="form-control" id="question_number" name="question_number">
                                        </div>
                                    </div>
                                    <div class="col-md-3">
                                        <div class="mb-3">
                                            <label class="form-label">Year</label>
                                            <input type="number" class="form-control" id="year" name="year" min="2000" max="2030">
                                        </div>
                                    </div>
                                </div>

                                <div class="mb-3">
                                    <label class="form-label">Question Text *</label>
                                    <textarea class="form-control" id="question_text" name="question_text" rows="3" required></textarea>
                                </div>

                                <div class="row">
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Option A *</label>
                                            <input type="text" class="form-control" id="option_a" name="option_a" required>
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label">Option B *</label>
                                            <input type="text" class="form-control" id="option_b" name="option_b" required>
                                        </div>
                                    </div>
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Option C *</label>
                                            <input type="text" class="form-control" id="option_c" name="option_c" required>
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label">Option D *</label>
                                            <input type="text" class="form-control" id="option_d" name="option_d" required>
                                        </div>
                                    </div>
                                </div>

                                <div class="row">
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Correct Answer *</label>
                                            <select class="form-select" id="correct_answer" name="correct_answer" required>
                                                <option value="">Select correct option</option>
                                                <option value="A">Option A</option>
                                                <option value="B">Option B</option>
                                                <option value="C">Option C</option>
                                                <option value="D">Option D</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Topic</label>
                                            <input type="text" class="form-control" id="topic" name="topic">
                                        </div>
                                    </div>
                                </div>

                                <div class="mb-3">
                                    <label class="form-label">Explanation (Optional)</label>
                                    <textarea class="form-control" id="explanation" name="explanation" rows="2"></textarea>
                                </div>

                                <div class="mb-3">
                                    <label class="form-label">Question Image (Optional)</label>
                                    <input type="file" class="form-control" id="question_image" name="question_image" accept="image/*">
                                    <div class="form-text">Maximum size: 5MB. Supported formats: JPG, PNG, GIF, WebP</div>
                                    <div id="image-preview" class="image-preview-container mt-2" style="display: none;">
                                        <img id="preview-image" class="image-preview" src="" alt="Image Preview">
                                        <div id="preview-text" class="text-muted mt-2"></div>
                                    </div>
                                </div>

                                <div class="d-grid gap-2 d-md-flex justify-content-md-end">
                                    <button type="button" class="btn btn-secondary" id="clear-form">
                                        <i class="fas fa-eraser"></i> Clear Form
                                    </button>
                                    <button type="submit" class="btn btn-primary">
                                        <i class="fas fa-save"></i> Insert Question
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>

                <!-- Search Questions Tab -->
                <div id="search-tab" class="tab-content" style="display: none;">
                    <div class="card">
                        <div class="card-header d-flex justify-content-between align-items-center">
                            <h4 class="mb-0"><i class="fas fa-search"></i> Search Questions</h4>
                            <div class="search-box">
                                <div class="input-group">
                                    <input type="text" class="form-control" id="search-input" placeholder="Search...">
                                    <button class="btn btn-outline-secondary" type="button" id="search-btn">
                                        <i class="fas fa-search"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div class="card-body">
                            <div class="row mb-3">
                                <div class="col-md-4">
                                    <label class="form-label">Search By</label>
                                    <select class="form-select" id="search-by">
                                        <option value="question_text">Question Text</option>
                                        <option value="question_number">Question Number</option>
                                        <option value="year">Year</option>
                                        <option value="topic">Topic</option>
                                    </select>
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label">Subject</label>
                                    <select class="form-select" id="search-subject">
                                        <option value="">All Subjects</option>
                                    </select>
                                </div>
                                <div class="col-md-4 d-flex align-items-end">
                                    <button class="btn btn-primary w-100" id="load-questions">
                                        <i class="fas fa-sync-alt"></i> Load Questions
                                    </button>
                                </div>
                            </div>

                            <div id="search-results">
                                <div class="alert alert-info">
                                    <i class="fas fa-info-circle"></i> Select a subject and click "Load Questions" to view questions.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Statistics Tab -->
                <div id="stats-tab" class="tab-content" style="display: none;">
                    <div class="card">
                        <div class="card-header">
                            <h4 class="mb-0"><i class="fas fa-chart-bar"></i> Database Statistics</h4>
                        </div>
                        <div class="card-body">
                            <div class="row" id="stats-content">
                                <div class="col-md-12 text-center">
                                    <div class="spinner-border" role="status">
                                        <span class="visually-hidden">Loading...</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Toast Notifications -->
    <div id="toast-container" class="toast-container"></div>

    <!-- Question Modal -->
    <div class="modal fade" id="questionModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Question Details</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body" id="question-details">
                    Loading...
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                    <button type="button" class="btn btn-danger" id="delete-question-btn">Delete</button>
                    <button type="button" class="btn btn-primary" id="edit-question-btn">Edit</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Edit Question Modal -->
    <div class="modal fade" id="editQuestionModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Edit Question</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <form id="edit-question-form" enctype="multipart/form-data">
                    <div class="modal-body" id="edit-question-form-content">
                        Loading...
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                        <button type="submit" class="btn btn-primary">Save Changes</button>
                    </div>
                </form>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        // Global variables
        let currentSubject = '';
        let currentQuestionId = '';
        let subjects = [];
        let questionTables = {};

        // Initialize
        document.addEventListener('DOMContentLoaded', function() {
            loadSubjects();
            setupEventListeners();
        });

        // Load subjects dropdown
        async function loadSubjects() {
            showLoading(true);
            try {
                const response = await fetch('/api/subjects');
                const data = await response.json();
                
                if (data.success) {
                    subjects = data.subjects;
                    const subjectSelect = document.getElementById('subject');
                    const searchSubjectSelect = document.getElementById('search-subject');
                    
                    // Clear existing options
                    subjectSelect.innerHTML = '<option value="">Select Subject</option>';
                    searchSubjectSelect.innerHTML = '<option value="">All Subjects</option>';
                    
                    // Add subjects
                    data.subjects.forEach(subject => {
                        const option = document.createElement('option');
                        option.value = subject.subject_code;
                        option.textContent = subject.subject_name;
                        subjectSelect.appendChild(option);
                        
                        const searchOption = option.cloneNode(true);
                        searchSubjectSelect.appendChild(searchOption);
                    });
                    
                    // Update subject list in sidebar
                    updateSubjectList(data.subjects);
                }
            } catch (error) {
                console.error('Error loading subjects:', error);
                showToast('Error loading subjects', 'danger');
            } finally {
                showLoading(false);
            }
        }

        // Update subject list in sidebar
        function updateSubjectList(subjects) {
            const subjectList = document.getElementById('subject-list');
            subjectList.innerHTML = '';
            
            subjects.forEach(subject => {
                const badge = document.createElement('span');
                badge.className = 'badge bg-secondary badge-subject me-2 mb-2';
                badge.textContent = subject.subject_code;
                badge.style.cursor = 'pointer';
                badge.title = subject.subject_name;
                badge.addEventListener('click', () => {
                    document.getElementById('search-subject').value = subject.subject_code;
                    loadQuestionsBySubject(subject.subject_code);
                });
                subjectList.appendChild(badge);
            });
        }

        // Setup event listeners
        function setupEventListeners() {
            // Navigation
            document.getElementById('nav-insert').addEventListener('click', (e) => {
                e.preventDefault();
                showTab('insert');
            });
            
            document.getElementById('nav-search').addEventListener('click', (e) => {
                e.preventDefault();
                showTab('search');
            });
            
            document.getElementById('nav-stats').addEventListener('click', (e) => {
                e.preventDefault();
                showTab('stats');
                loadStatistics();
            });

            // Question form
            document.getElementById('question-form').addEventListener('submit', insertQuestion);
            document.getElementById('clear-form').addEventListener('click', clearForm);
            
            // Image preview
            document.getElementById('question_image').addEventListener('change', previewImage);
            
            // Search
            document.getElementById('load-questions').addEventListener('click', loadQuestions);
            document.getElementById('search-btn').addEventListener('click', loadQuestions);
            document.getElementById('search-input').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') loadQuestions();
            });
        }

        // Show loading indicator
        function showLoading(show) {
            document.getElementById('loading').classList.toggle('active', show);
        }

        // Show toast notification
        function showToast(message, type = 'info') {
            const toastContainer = document.getElementById('toast-container');
            const toastId = 'toast-' + Date.now();
            
            const toast = document.createElement('div');
            toast.className = 'toast align-items-center text-white bg-' + type + ' border-0';
            toast.id = toastId;
            toast.setAttribute('role', 'alert');
            
            let icon = 'info-circle';
            if (type === 'success') icon = 'check-circle';
            else if (type === 'danger') icon = 'exclamation-circle';
            else if (type === 'warning') icon = 'exclamation-triangle';
            
            toast.innerHTML = '<div class="d-flex">' +
                '<div class="toast-body">' +
                '<i class="fas fa-' + icon + '"></i> ' +
                message +
                '</div>' +
                '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>' +
                '</div>';
            
            toastContainer.appendChild(toast);
            
            const bsToast = new bootstrap.Toast(toast, { delay: 3000 });
            bsToast.show();
            
            toast.addEventListener('hidden.bs.toast', () => {
                toast.remove();
            });
        }

        // Show tab content
        function showTab(tabName) {
            // Hide all tabs
            document.getElementById('insert-tab').style.display = 'none';
            document.getElementById('search-tab').style.display = 'none';
            document.getElementById('stats-tab').style.display = 'none';
            
            // Remove active class from all nav items
            document.querySelectorAll('.nav-link').forEach(link => {
                link.classList.remove('active');
            });
            
            // Show selected tab
            document.getElementById(tabName + '-tab').style.display = 'block';
            document.getElementById('nav-' + tabName).classList.add('active');
        }

        // Insert new question
        async function insertQuestion(e) {
            e.preventDefault();
            
            const form = e.target;
            const formData = new FormData(form);
            
            // Validate form
            if (!formData.get('subject')) {
                showToast('Please select a subject', 'warning');
                return;
            }
            
            if (!formData.get('question_text') || !formData.get('option_a') || 
                !formData.get('option_b') || !formData.get('option_c') || 
                !formData.get('option_d') || !formData.get('correct_answer')) {
                showToast('Please fill all required fields', 'warning');
                return;
            }
            
            showLoading(true);
            
            try {
                const response = await fetch('/api/insert-question', {
                    method: 'POST',
                    body: formData
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showToast('Question inserted successfully!', 'success');
                    clearForm();
                    // Load questions for this subject
                    loadQuestionsBySubject(formData.get('subject'));
                } else {
                    showToast(data.error || 'Error inserting question', 'danger');
                }
            } catch (error) {
                console.error('Error inserting question:', error);
                showToast('Error inserting question', 'danger');
            } finally {
                showLoading(false);
            }
        }

        // Clear form
        function clearForm() {
            document.getElementById('question-form').reset();
            document.getElementById('image-preview').style.display = 'none';
            document.getElementById('preview-image').src = '';
        }

        // Preview image before upload
        function previewImage(e) {
            const file = e.target.files[0];
            const preview = document.getElementById('preview-image');
            const previewContainer = document.getElementById('image-preview');
            const previewText = document.getElementById('preview-text');
            
            if (file) {
                const reader = new FileReader();
                
                reader.onload = function(e) {
                    preview.src = e.target.result;
                    previewContainer.style.display = 'block';
                    previewText.textContent = file.name + ' (' + formatFileSize(file.size) + ')';
                };
                
                reader.readAsDataURL(file);
            } else {
                previewContainer.style.display = 'none';
            }
        }

        // Load questions
        async function loadQuestions() {
            const subject = document.getElementById('search-subject').value;
            const searchTerm = document.getElementById('search-input').value;
            const searchBy = document.getElementById('search-by').value;
            
            if (!subject) {
                showToast('Please select a subject first', 'warning');
                return;
            }
            
            await loadQuestionsBySubject(subject, searchTerm, searchBy);
        }

        // Load questions by subject
        async function loadQuestionsBySubject(subject, searchTerm = '', searchBy = 'question_text') {
            showLoading(true);
            
            try {
                const params = new URLSearchParams({
                    subject: subject,
                    searchTerm: searchTerm,
                    searchBy: searchBy
                });
                
                const response = await fetch('/api/search-questions?' + params);
                const data = await response.json();
                
                if (data.success) {
                    displayQuestions(data.questions, subject);
                } else {
                    showToast(data.error || 'Error loading questions', 'danger');
                }
            } catch (error) {
                console.error('Error loading questions:', error);
                showToast('Error loading questions', 'danger');
            } finally {
                showLoading(false);
            }
        }

        // Display questions in table
        function displayQuestions(questions, subject) {
            const resultsDiv = document.getElementById('search-results');
            
            if (questions.length === 0) {
                resultsDiv.innerHTML = '<div class="alert alert-warning">' +
                    '<i class="fas fa-exclamation-triangle"></i> No questions found for ' + subject +
                    '</div>';
                return;
            }
            
            let html = '<div class="alert alert-success">' +
                '<i class="fas fa-database"></i> Found ' + questions.length + ' questions' +
                '</div>' +
                '<div class="table-responsive">' +
                '<table class="table table-hover question-table">' +
                '<thead>' +
                '<tr>' +
                '<th>#</th>' +
                '<th>Q.No</th>' +
                '<th>Year</th>' +
                '<th>Question</th>' +
                '<th>Correct</th>' +
                '<th>Topic</th>' +
                '<th>Image</th>' +
                '<th>Actions</th>' +
                '</tr>' +
                '</thead>' +
                '<tbody>';
            
            questions.forEach((question, index) => {
                html += '<tr>' +
                    '<td>' + (index + 1) + '</td>' +
                    '<td>' + (question.question_number || '-') + '</td>' +
                    '<td>' + (question.year || '-') + '</td>' +
                    '<td><div class="question-text">' + question.question_text + '</div></td>' +
                    '<td><span class="badge bg-success">' + question.correct_answer + '</span></td>' +
                    '<td>' + (question.topic || '-') + '</td>' +
                    '<td>' + (question.has_image ? 
                        '<i class="fas fa-image text-success" title="Has image"></i>' : 
                        '<i class="fas fa-times text-muted"></i>') + '</td>' +
                    '<td class="action-buttons">' +
                    '<button class="btn btn-sm btn-outline-primary" onclick="viewQuestion(\'' + subject + '\', ' + question.id + ')">' +
                    '<i class="fas fa-eye"></i></button>' +
                    '<button class="btn btn-sm btn-outline-danger" onclick="deleteQuestion(\'' + subject + '\', ' + question.id + ')">' +
                    '<i class="fas fa-trash"></i></button>' +
                    '</td></tr>';
            });
            
            html += '</tbody></table></div>';
            
            resultsDiv.innerHTML = html;
        }

        // View question details
        async function viewQuestion(subject, questionId) {
            showLoading(true);
            
            try {
                const response = await fetch('/api/question/' + subject + '/' + questionId);
                const data = await response.json();
                
                if (data.success) {
                    displayQuestionModal(data.question, subject);
                } else {
                    showToast(data.error || 'Error loading question', 'danger');
                }
            } catch (error) {
                console.error('Error loading question:', error);
                showToast('Error loading question', 'danger');
            } finally {
                showLoading(false);
            }
        }

        // Display question in modal
        function displayQuestionModal(question, subject) {
            currentSubject = subject;
            currentQuestionId = question.id;
            
            const modalBody = document.getElementById('question-details');
            
            let imageHtml = '';
            if (question.image_url) {
                imageHtml = '<div class="mb-3">' +
                    '<label class="form-label">Question Image:</label>' +
                    '<div>' +
                    '<img src="' + question.image_url + '" alt="Question Image" class="img-fluid rounded" style="max-height: 200px;">' +
                    '</div>' +
                    '</div>';
            }
            
            modalBody.innerHTML = '<div class="row">' +
                '<div class="col-md-12">' +
                '<div class="mb-3">' +
                '<label class="form-label fw-bold">Subject:</label>' +
                '<span class="badge bg-primary">' + question.subject + '</span>' +
                '</div>' +
                '<div class="row mb-3">' +
                '<div class="col-md-3">' +
                '<label class="form-label">Question #:</label>' +
                '<div>' + (question.question_number || 'N/A') + '</div>' +
                '</div>' +
                '<div class="col-md-3">' +
                '<label class="form-label">Year:</label>' +
                '<div>' + (question.year || 'N/A') + '</div>' +
                '</div>' +
                '<div class="col-md-6">' +
                '<label class="form-label">Topic:</label>' +
                '<div>' + (question.topic || 'N/A') + '</div>' +
                '</div>' +
                '</div>' +
                '<div class="mb-3">' +
                '<label class="form-label fw-bold">Question:</label>' +
                '<div class="border p-3 rounded bg-light">' + question.question_text + '</div>' +
                '</div>' +
                '<div class="row mb-3">' +
                '<div class="col-md-6">' +
                '<div class="mb-2">' +
                '<label class="form-label">Option A:</label>' +
                '<div class="border p-2 rounded ' + (question.correct_answer === 'A' ? 'bg-success text-white' : '') + '">' + question.option_a + '</div>' +
                '</div>' +
                '<div class="mb-2">' +
                '<label class="form-label">Option B:</label>' +
                '<div class="border p-2 rounded ' + (question.correct_answer === 'B' ? 'bg-success text-white' : '') + '">' + question.option_b + '</div>' +
                '</div>' +
                '</div>' +
                '<div class="col-md-6">' +
                '<div class="mb-2">' +
                '<label class="form-label">Option C:</label>' +
                '<div class="border p-2 rounded ' + (question.correct_answer === 'C' ? 'bg-success text-white' : '') + '">' + question.option_c + '</div>' +
                '</div>' +
                '<div class="mb-2">' +
                '<label class="form-label">Option D:</label>' +
                '<div class="border p-2 rounded ' + (question.correct_answer === 'D' ? 'bg-success text-white' : '') + '">' + question.option_d + '</div>' +
                '</div>' +
                '</div>' +
                '</div>' +
                imageHtml +
                (question.explanation ? '<div class="mb-3">' +
                    '<label class="form-label fw-bold">Explanation:</label>' +
                    '<div class="border p-3 rounded bg-info bg-opacity-10">' + question.explanation + '</div>' +
                    '</div>' : '') +
                '<div class="mb-3">' +
                '<label class="form-label">Created At:</label>' +
                '<div>' + new Date(question.created_at).toLocaleString() + '</div>' +
                '</div>' +
                '</div>' +
                '</div>';
            
            // Setup action buttons
            document.getElementById('delete-question-btn').onclick = () => deleteQuestion(subject, questionId);
            document.getElementById('edit-question-btn').onclick = () => editQuestion(subject, questionId);
            
            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('questionModal'));
            modal.show();
        }

        // Delete question
        async function deleteQuestion(subject, questionId) {
            if (!confirm('Are you sure you want to delete this question? This action cannot be undone.')) {
                return;
            }
            
            showLoading(true);
            
            try {
                const response = await fetch('/api/question/' + subject + '/' + questionId, {
                    method: 'DELETE'
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showToast('Question deleted successfully', 'success');
                    // Close modal
                    bootstrap.Modal.getInstance(document.getElementById('questionModal')).hide();
                    // Reload questions
                    loadQuestionsBySubject(subject);
                } else {
                    showToast(data.error || 'Error deleting question', 'danger');
                }
            } catch (error) {
                console.error('Error deleting question:', error);
                showToast('Error deleting question', 'danger');
            } finally {
                showLoading(false);
            }
        }

        // Edit question
        async function editQuestion(subject, questionId) {
            showLoading(true);
            
            try {
                const response = await fetch('/api/question/' + subject + '/' + questionId);
                const data = await response.json();
                
                if (data.success) {
                    displayEditForm(data.question, subject);
                } else {
                    showToast(data.error || 'Error loading question for edit', 'danger');
                }
            } catch (error) {
                console.error('Error loading question for edit:', error);
                showToast('Error loading question for edit', 'danger');
            } finally {
                showLoading(false);
            }
        }

        // Display edit form
        function displayEditForm(question, subject) {
            currentSubject = subject;
            currentQuestionId = question.id;
            
            const formContent = document.getElementById('edit-question-form-content');
            
            let currentImageHtml = '';
            if (question.image_url) {
                currentImageHtml = '<div class="mb-3">' +
                    '<label class="form-label">Current Image:</label>' +
                    '<div>' +
                    '<img src="' + question.image_url + '" alt="Current Image" class="img-fluid rounded" style="max-height: 150px;">' +
                    '<div class="form-text">Leave blank to keep current image</div>' +
                    '</div>' +
                    '</div>';
            }
            
            formContent.innerHTML = '<input type="hidden" name="subject" value="' + subject + '">' +
                '<div class="row">' +
                '<div class="col-md-6">' +
                '<div class="mb-3">' +
                '<label class="form-label">Question Number</label>' +
                '<input type="number" class="form-control" name="question_number" value="' + (question.question_number || '') + '">' +
                '</div>' +
                '</div>' +
                '<div class="col-md-6">' +
                '<div class="mb-3">' +
                '<label class="form-label">Year</label>' +
                '<input type="number" class="form-control" name="year" value="' + (question.year || '') + '">' +
                '</div>' +
                '</div>' +
                '</div>' +
                '<div class="mb-3">' +
                '<label class="form-label">Question Text *</label>' +
                '<textarea class="form-control" name="question_text" rows="3" required>' + question.question_text + '</textarea>' +
                '</div>' +
                '<div class="row">' +
                '<div class="col-md-6">' +
                '<div class="mb-3">' +
                '<label class="form-label">Option A *</label>' +
                '<input type="text" class="form-control" name="option_a" value="' + question.option_a + '" required>' +
                '</div>' +
                '<div class="mb-3">' +
                '<label class="form-label">Option B *</label>' +
                '<input type="text" class="form-control" name="option_b" value="' + question.option_b + '" required>' +
                '</div>' +
                '</div>' +
                '<div class="col-md-6">' +
                '<div class="mb-3">' +
                '<label class="form-label">Option C *</label>' +
                '<input type="text" class="form-control" name="option_c" value="' + question.option_c + '" required>' +
                '</div>' +
                '<div class="mb-3">' +
                '<label class="form-label">Option D *</label>' +
                '<input type="text" class="form-control" name="option_d" value="' + question.option_d + '" required>' +
                '</div>' +
                '</div>' +
                '</div>' +
                '<div class="row">' +
                '<div class="col-md-6">' +
                '<div class="mb-3">' +
                '<label class="form-label">Correct Answer *</label>' +
                '<select class="form-select" name="correct_answer" required>' +
                '<option value="A" ' + (question.correct_answer === 'A' ? 'selected' : '') + '>Option A</option>' +
                '<option value="B" ' + (question.correct_answer === 'B' ? 'selected' : '') + '>Option B</option>' +
                '<option value="C" ' + (question.correct_answer === 'C' ? 'selected' : '') + '>Option C</option>' +
                '<option value="D" ' + (question.correct_answer === 'D' ? 'selected' : '') + '>Option D</option>' +
                '</select>' +
                '</div>' +
                '</div>' +
                '<div class="col-md-6">' +
                '<div class="mb-3">' +
                '<label class="form-label">Topic</label>' +
                '<input type="text" class="form-control" name="topic" value="' + (question.topic || '') + '">' +
                '</div>' +
                '</div>' +
                '</div>' +
                '<div class="mb-3">' +
                '<label class="form-label">Explanation</label>' +
                '<textarea class="form-control" name="explanation" rows="2">' + (question.explanation || '') + '</textarea>' +
                '</div>' +
                currentImageHtml +
                '<div class="mb-3">' +
                '<label class="form-label">New Image (Optional)</label>' +
                '<input type="file" class="form-control" name="question_image" accept="image/*">' +
                '<div class="form-text">Leave empty to keep current image. Maximum size: 5MB</div>' +
                '</div>';
            
            // Setup form submission
            document.getElementById('edit-question-form').onsubmit = updateQuestion;
            
            // Show edit modal
            const modal = new bootstrap.Modal(document.getElementById('editQuestionModal'));
            modal.show();
        }

        // Update question
        async function updateQuestion(e) {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            formData.append('subject', currentSubject);
            
            showLoading(true);
            
            try {
                const response = await fetch('/api/question/' + currentSubject + '/' + currentQuestionId, {
                    method: 'PUT',
                    body: formData
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showToast('Question updated successfully!', 'success');
                    // Close modals
                    bootstrap.Modal.getInstance(document.getElementById('editQuestionModal')).hide();
                    bootstrap.Modal.getInstance(document.getElementById('questionModal')).hide();
                    // Reload questions
                    loadQuestionsBySubject(currentSubject);
                } else {
                    showToast(data.error || 'Error updating question', 'danger');
                }
            } catch (error) {
                console.error('Error updating question:', error);
                showToast('Error updating question', 'danger');
            } finally {
                showLoading(false);
            }
        }

        // Load statistics
        async function loadStatistics() {
            showLoading(true);
            
            try {
                // Load all subjects with their question counts
                const statsPromises = subjects.map(async (subject) => {
                    try {
                        const response = await fetch('/api/subject-tables/' + subject.subject_code);
                        const data = await response.json();
                        
                        if (data.success && data.tableExists) {
                            return {
                                subject: subject.subject_name,
                                code: subject.subject_code,
                                count: data.rowCount || 0
                            };
                        }
                    } catch (error) {
                        console.error('Error loading stats for ' + subject.subject_code + ':', error);
                    }
                    
                    return {
                        subject: subject.subject_name,
                        code: subject.subject_code,
                        count: 0
                    };
                });
                
                const stats = await Promise.all(statsPromises);
                const totalQuestions = stats.reduce((sum, stat) => sum + stat.count, 0);
                
                displayStatistics(stats, totalQuestions);
            } catch (error) {
                console.error('Error loading statistics:', error);
                showToast('Error loading statistics', 'danger');
            } finally {
                showLoading(false);
            }
        }

        // Display statistics
        function displayStatistics(stats, totalQuestions) {
            const statsContent = document.getElementById('stats-content');
            
            let html = '<div class="col-md-12 mb-4">' +
                '<div class="card bg-primary text-white">' +
                '<div class="card-body text-center">' +
                '<h1 class="display-4">' + totalQuestions + '</h1>' +
                '<p class="lead">Total Questions in Database</p>' +
                '</div>' +
                '</div>' +
                '</div>' +
                '<div class="col-md-12">' +
                '<h5>Questions by Subject</h5>' +
                '<div class="table-responsive">' +
                '<table class="table table-striped">' +
                '<thead>' +
                '<tr>' +
                '<th>Subject</th>' +
                '<th>Code</th>' +
                '<th>Question Count</th>' +
                '<th>Percentage</th>' +
                '<th>Progress</th>' +
                '</tr>' +
                '</thead>' +
                '<tbody>';
            
            stats.forEach(stat => {
                const percentage = totalQuestions > 0 ? ((stat.count / totalQuestions) * 100).toFixed(1) : 0;
                
                html += '<tr>' +
                    '<td>' + stat.subject + '</td>' +
                    '<td><span class="badge bg-secondary">' + stat.code + '</span></td>' +
                    '<td>' + stat.count + '</td>' +
                    '<td>' + percentage + '%</td>' +
                    '<td><div class="progress" style="height: 20px;">' +
                    '<div class="progress-bar" role="progressbar" style="width: ' + percentage + '%">' +
                    percentage + '%</div></div></td></tr>';
            });
            
            html += '</tbody></table></div></div>';
            
            statsContent.innerHTML = html;
        }

        // Format file size
        function formatFileSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        // Make functions available globally
        window.viewQuestion = viewQuestion;
        window.deleteQuestion = deleteQuestion;
        window.loadQuestionsBySubject = loadQuestionsBySubject;
    </script>
</body>
</html>`;
    
    res.send(html);
});

// Get single question details
router.get("/api/question/:subject/:id", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const { subject, id } = req.params;
    const tableName = `${subject.toLowerCase()}_questions`;
    
    try {
        const query = `SELECT * FROM "${tableName}" WHERE id = $1`;
        const result = await pool.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Question not found' });
        }
        
        const question = result.rows[0];
        
        // Convert base64 image to data URL if exists
        let imageUrl = null;
        if (question.image_data) {
            // Determine MIME type from filename
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
        
        res.json({
            success: true,
            question: {
                ...question,
                image_url: imageUrl
            }
        });
        
    } catch (err) {
        console.error('Error fetching question:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Delete question
router.delete("/api/question/:subject/:id", checkAdminAuth, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const { subject, id } = req.params;
    const tableName = `${subject.toLowerCase()}_questions`;
    
    try {
        // First get the question to delete associated image file
        const getQuery = `SELECT image_filename FROM "${tableName}" WHERE id = $1`;
        const getResult = await pool.query(getQuery, [id]);
        
        if (getResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Question not found' });
        }
        
        // Delete associated image file if exists
        const imageFilename = getResult.rows[0].image_filename;
        if (imageFilename) {
            const imagePath = path.join('question-images', imageFilename);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
                console.log(`Deleted image file: ${imagePath}`);
            }
        }
        
        // Delete question from database
        const deleteQuery = `DELETE FROM "${tableName}" WHERE id = $1`;
        await pool.query(deleteQuery, [id]);
        
        res.json({
            success: true,
            message: 'Question deleted successfully',
            deletedId: id
        });
        
    } catch (err) {
        console.error('Error deleting question:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Update question
router.put("/api/question/:subject/:id", checkAdminAuth, upload.single('question_image'), async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const { subject, id } = req.params;
    const {
        question_number,
        year,
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_answer,
        topic,
        explanation
    } = req.body;

    const tableName = `${subject.toLowerCase()}_questions`;

    try {
        // Get current question data
        const getQuery = `SELECT image_filename FROM "${tableName}" WHERE id = $1`;
        const getResult = await pool.query(getQuery, [id]);
        
        if (getResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Question not found' });
        }
        
        const oldImageFilename = getResult.rows[0].image_filename;
        let imageFilename = oldImageFilename;
        let imageData = null;
        
        // Handle new image if uploaded
        if (req.file) {
            imageFilename = req.file.filename;
            // Convert image to base64
            const imagePath = req.file.path;
            try {
                const imageBuffer = fs.readFileSync(imagePath);
                imageData = imageBuffer.toString('base64');
            } catch (error) {
                console.error('Error reading image file:', error);
            }
            
            // Delete old image file
            if (oldImageFilename) {
                const oldImagePath = path.join('question-images', oldImageFilename);
                if (fs.existsSync(oldImagePath)) {
                    fs.unlinkSync(oldImagePath);
                }
            }
        }
        
        // Build update query
        const checkColumnsQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = $1 AND column_name = 'explanation'
        `;
        
        const columnResult = await pool.query(checkColumnsQuery, [tableName]);
        const hasExplanation = columnResult.rows.length > 0;
        
        let updateQuery, updateValues;
        
        if (req.file) {
            // Update with new image
            if (hasExplanation) {
                updateQuery = `
                    UPDATE "${tableName}" 
                    SET question_number = $1, year = $2, question_text = $3, option_a = $4, option_b = $5, 
                        option_c = $6, option_d = $7, correct_answer = $8, topic = $9, image_filename = $10, 
                        image_data = $11, explanation = $12 
                    WHERE id = $13
                `;
                updateValues = [
                    question_number || null,
                    year || null,
                    question_text,
                    option_a,
                    option_b,
                    option_c,
                    option_d,
                    correct_answer,
                    topic || null,
                    imageFilename,
                    imageData,
                    explanation || null,
                    id
                ];
            } else {
                updateQuery = `
                    UPDATE "${tableName}" 
                    SET question_number = $1, year = $2, question_text = $3, option_a = $4, option_b = $5, 
                        option_c = $6, option_d = $7, correct_answer = $8, topic = $9, image_filename = $10, 
                        image_data = $11 
                    WHERE id = $12
                `;
                updateValues = [
                    question_number || null,
                    year || null,
                    question_text,
                    option_a,
                    option_b,
                    option_c,
                    option_d,
                    correct_answer,
                    topic || null,
                    imageFilename,
                    imageData,
                    id
                ];
            }
        } else {
            // Update without changing image
            if (hasExplanation) {
                updateQuery = `
                    UPDATE "${tableName}" 
                    SET question_number = $1, year = $2, question_text = $3, option_a = $4, option_b = $5, 
                        option_c = $6, option_d = $7, correct_answer = $8, topic = $9, explanation = $10 
                    WHERE id = $11
                `;
                updateValues = [
                    question_number || null,
                    year || null,
                    question_text,
                    option_a,
                    option_b,
                    option_c,
                    option_d,
                    correct_answer,
                    topic || null,
                    explanation || null,
                    id
                ];
            } else {
                updateQuery = `
                    UPDATE "${tableName}" 
                    SET question_number = $1, year = $2, question_text = $3, option_a = $4, option_b = $5, 
                        option_c = $6, option_d = $7, correct_answer = $8, topic = $9 
                    WHERE id = $10
                `;
                updateValues = [
                    question_number || null,
                    year || null,
                    question_text,
                    option_a,
                    option_b,
                    option_c,
                    option_d,
                    correct_answer,
                    topic || null,
                    id
                ];
            }
        }
        
        await pool.query(updateQuery, updateValues);
        
        res.json({
            success: true,
            message: 'Question updated successfully'
        });
        
    } catch (err) {
        console.error('Error updating question:', err);
        // Delete new uploaded file if update fails
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: 'Failed to update question' });
    }
});

// ========== EXPORT ROUTER ==========
module.exports = router;
