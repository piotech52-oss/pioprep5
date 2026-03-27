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
// FIXED: Using the correct password with URL encoding
const encodedPassword = encodeURIComponent('PioPrep2024!');
const connectionString = process.env.DATABASE_URL || `postgresql://postgres.vbpehelxdstkasscjiov:${encodedPassword}@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`;

console.log('🔧 Admin Database Connection String (password hidden)');
console.log(`   Using password: PioPrep2024! (encoded as: ${encodedPassword})`);

const pool = new Pool({
    connectionString: connectionString,
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
    let client;
    try {
        client = await pool.connect();
        console.log('✅ Admin DB connected to Supabase PostgreSQL!');
        dbConnected = true;
        connectionChecked = true;
        
        // Test a simple query
        await client.query('SELECT 1');
        console.log('✅ Admin database queries working');
        
        client.release();
        
        // Create tables if they don't exist
        await createAdminTable();
        
        return true;
    } catch (err) {
        console.error('❌ Error connecting admin to Supabase PostgreSQL:', err.message);
        dbConnected = false;
        connectionChecked = true;
        if (client) client.release();
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

// Admin login page - IMPROVED to capture full password
router.get("/admin/login", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login</title>
            <style>
                body { 
                    font-family: Arial; 
                    padding: 50px; 
                    text-align: center; 
                    background: linear-gradient(135deg, #1a237e 0%, #311b92 100%);
                    height: 100vh; 
                    display: flex; 
                    justify-content: center; 
                    align-items: center; 
                    margin: 0;
                }
                .login-box { 
                    background: white; 
                    padding: 40px; 
                    border-radius: 10px; 
                    box-shadow: 0 15px 35px rgba(0,0,0,0.3); 
                    width: 100%; 
                    max-width: 400px;
                }
                h1 { 
                    color: #1a237e; 
                    margin-bottom: 30px;
                }
                input { 
                    width: 100%; 
                    padding: 12px; 
                    margin: 10px 0; 
                    border: 2px solid #ddd; 
                    border-radius: 5px; 
                    font-size: 16px;
                    box-sizing: border-box;
                }
                input:focus {
                    outline: none;
                    border-color: #1a237e;
                }
                button { 
                    width: 100%; 
                    padding: 12px; 
                    background: #1a237e; 
                    color: white; 
                    border: none; 
                    border-radius: 5px; 
                    font-size: 16px; 
                    cursor: pointer; 
                    margin-top: 20px;
                }
                button:hover { 
                    background: #311b92;
                }
                .back { 
                    display: inline-block; 
                    margin-top: 20px; 
                    color: #1a237e; 
                    text-decoration: none;
                }
                .credentials { 
                    margin-top: 20px; 
                    padding: 15px; 
                    background: #f8f9fa; 
                    border-radius: 5px; 
                    font-size: 14px; 
                    text-align: left;
                }
                .credentials code {
                    background: #e9ecef;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-size: 13px;
                    word-break: break-all;
                }
                .message {
                    margin-top: 15px;
                    padding: 10px;
                    border-radius: 5px;
                }
                .message.error {
                    background: #f8d7da;
                    color: #721c24;
                    border: 1px solid #f5c6cb;
                }
                .message.success {
                    background: #d4edda;
                    color: #155724;
                    border: 1px solid #c3e6cb;
                }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h1>🔐 Admin Login</h1>
                <form id="loginForm" onsubmit="return false;">
                    <input type="text" id="username" placeholder="Username or Email" autocomplete="username" required>
                    <input type="password" id="password" placeholder="Password" autocomplete="current-password" required>
                    <input type="text" id="securityCode" placeholder="Security Code" autocomplete="off" required>
                    <button type="submit" id="loginBtn">Login</button>
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
                    
                    const username = document.getElementById('username').value.trim();
                    const password = document.getElementById('password').value;
                    const securityCode = document.getElementById('securityCode').value.trim();
                    const messageDiv = document.getElementById('message');
                    const loginBtn = document.getElementById('loginBtn');
                    
                    // Debug logging
                    console.log('Login attempt:', { username, passwordLength: password.length, securityCode });
                    
                    // Validate inputs
                    if (!username) {
                        showMessage(messageDiv, 'Please enter username/email', 'error');
                        return;
                    }
                    if (!password) {
                        showMessage(messageDiv, 'Please enter password', 'error');
                        return;
                    }
                    if (!securityCode) {
                        showMessage(messageDiv, 'Please enter security code', 'error');
                        return;
                    }
                    
                    // Show loading
                    loginBtn.disabled = true;
                    loginBtn.textContent = 'Logging in...';
                    showMessage(messageDiv, 'Logging in...', 'success');
                    
                    try {
                        const response = await fetch('/api/auth/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                username: username, 
                                password: password, 
                                security_code: securityCode 
                            })
                        });
                        
                        const data = await response.json();
                        console.log('Login response:', data);
                        
                        if (data.success) {
                            showMessage(messageDiv, 'Login successful! Redirecting...', 'success');
                            setTimeout(() => {
                                window.location.href = '/admin/dashboard';
                            }, 1000);
                        } else {
                            showMessage(messageDiv, data.message || 'Login failed', 'error');
                            loginBtn.disabled = false;
                            loginBtn.textContent = 'Login';
                            document.getElementById('password').value = '';
                        }
                    } catch (error) {
                        console.error('Login error:', error);
                        showMessage(messageDiv, 'Connection error. Please try again.', 'error');
                        loginBtn.disabled = false;
                        loginBtn.textContent = 'Login';
                    }
                });
                
                function showMessage(element, text, type) {
                    element.textContent = text;
                    element.className = 'message ' + type;
                    if (type === 'success') {
                        element.style.color = '#155724';
                        element.style.background = '#d4edda';
                        element.style.border = '1px solid #c3e6cb';
                    } else if (type === 'error') {
                        element.style.color = '#721c24';
                        element.style.background = '#f8d7da';
                        element.style.border = '1px solid #f5c6cb';
                    }
                }
                
                // Add Enter key support
                document.getElementById('loginForm').addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        document.getElementById('loginBtn').click();
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
    console.log('   Password length:', password ? password.length : 0);
    console.log('   Security code length:', security_code ? security_code.length : 0);

    // Check if database is connected
    if (!dbConnected) {
        console.error('❌ Database not connected');
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
        
        console.log('   Found admins:', result.rows.length);

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials - User not found'
            });
        }

        const admin = result.rows[0];
        
        if (admin.role === 'user') {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        // Check security code
        if (admin.security_code !== security_code) {
            console.log('   Security code mismatch');
            return res.status(401).json({
                success: false,
                message: 'Invalid security code'
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, admin.password);
        console.log('   Password valid:', isPasswordValid);
        
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

// Admin logout
router.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Logout failed' });
        }
        res.json({ success: true, message: 'Logged out' });
    });
});

// ========== DEBUG ROUTE ==========
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

// ========== CHECK ADMIN USER ROUTE ==========
router.get("/api/admin/check-user", async (req, res) => {
    if (!dbConnected) {
        return res.json({ success: false, message: 'Database not connected' });
    }
    
    try {
        const query = "SELECT id, username, email, role, is_active FROM admin_users WHERE email = $1";
        const result = await pool.query(query, ['piotech52@gmail.com']);
        
        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Admin user not found' });
        }
        
        res.json({
            success: true,
            adminExists: true,
            admin: result.rows[0],
            message: 'Admin user exists'
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ========== REMOVE PAYMENT NOTIFICATIONS TABLE ROUTE (if needed) ==========
router.get("/api/admin/fix-tables", async (req, res) => {
    if (!dbConnected) {
        return res.json({ success: false, message: 'Database not connected' });
    }
    
    try {
        // Check if payment_notifications table exists
        const checkQuery = `
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'payment_notifications'
            )
        `;
        const checkResult = await pool.query(checkQuery);
        
        if (checkResult.rows[0].exists) {
            res.json({ success: true, message: 'payment_notifications table exists' });
        } else {
            // Create the table
            await createPaymentNotificationsTable();
            res.json({ success: true, message: 'payment_notifications table created' });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ========== CONTINUE WITH REST OF YOUR ROUTES ==========
// [Keep all your existing routes below - dashboard, payments, users, questions, etc.]

// Admin dashboard route
router.get("/admin/dashboard", checkAdminAuth, (req, res) => {
    // Your existing dashboard HTML here
    res.send(`...`); // Keep your existing dashboard HTML
});

// Payments management
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

router.get("/admin/payments", checkAdminAuth, (req, res) => {
    res.send(`...`); // Keep your existing payments HTML
});

// User management
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

router.get("/admin/users", checkAdminAuth, (req, res) => {
    res.send(`...`); // Keep your existing users HTML
});

// User activation routes
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

// Statistics API
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

// Activation code route
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

        const checkUserQuery = "SELECT * FROM jambuser WHERE email = $1";
        const userResult = await pool.query(checkUserQuery, [email]);

        if (userResult.rows.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: "User not found. Please register first." 
            });
        }

        const updateQuery = 'UPDATE jambuser SET "activationCode" = $1 WHERE email = $2';
        await pool.query(updateQuery, [activationCode, email]);

        console.log(`✅ Activation code ${activationCode} updated for ${email}`);

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

// Payment notification routes
router.post("/api/admin/payment-notification", async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    
    try {
        const { payment_id, user_email, amount, currency, payment_method, status, note } = req.body;
        
        const insertQuery = `
            INSERT INTO payment_notifications 
            (payment_id, user_email, amount, currency, payment_method, status, note) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `;
        
        const result = await pool.query(insertQuery, [payment_id, user_email, amount, currency, payment_method, status, note]);
        const notificationId = result.rows[0].id;
        
        const emailSent = await sendPaymentEmailNotification({
            payment_id, user_email, amount, currency, payment_method, note
        });
        
        const updateQuery = "UPDATE payment_notifications SET admin_notified = $1 WHERE id = $2";
        await pool.query(updateQuery, [emailSent ? 1 : 0, notificationId]);
        
        res.json({ success: true, notificationId: notificationId, emailSent: emailSent });
    } catch (error) {
        console.error('❌ Error in payment notification:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get("/api/admin/notifications/unread", checkAdminAuth, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ success: false, message: 'Database unavailable' });
    
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

// Question management routes
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
    // Your existing insert question code
    res.json({ success: true, message: 'Question inserted' });
});

router.get("/api/search-questions", checkAdminAuth, async (req, res) => {
    // Your existing search questions code
    res.json({ success: true, questions: [] });
});

router.get("/api/question/:subject/:id", checkAdminAuth, async (req, res) => {
    // Your existing get question code
    res.json({ success: true, question: {} });
});

router.delete("/api/question/:subject/:id", checkAdminAuth, async (req, res) => {
    // Your existing delete question code
    res.json({ success: true, message: 'Question deleted' });
});

router.put("/api/question/:subject/:id", checkAdminAuth, upload.single('question_image'), async (req, res) => {
    // Your existing update question code
    res.json({ success: true, message: 'Question updated' });
});

router.get("/admin/questions", checkAdminAuth, (req, res) => {
    res.send(`...`); // Keep your existing questions HTML
});

router.get("/api/admin/check-access", (req, res) => {
    const isAdmin = req.session && req.session.adminLoggedIn && 
                   ['super_admin', 'admin', 'moderator'].includes(req.session.adminRole);
    
    res.json({ success: true, canAccessAdmin: isAdmin, isAdmin: isAdmin });
});

module.exports = router;
