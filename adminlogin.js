const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ========== SUPABASE CLIENT SETUP ==========
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
let dbConnected = false;
let connectionChecked = false;

console.log('🔧 Admin: Environment Check:');
console.log(`   SUPABASE_URL: ${supabaseUrl ? supabaseUrl : 'NOT SET'}`);
console.log(`   SUPABASE_KEY: ${supabaseKey ? 'SET (length: ' + supabaseKey.length + ')' : 'NOT SET'}`);

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        console.log('✅ Admin: Supabase client initialized');
        
        // Test connection immediately
        (async () => {
            try {
                const { data, error } = await supabase.from('admin_users').select('count').limit(1);
                if (!error) {
                    dbConnected = true;
                    connectionChecked = true;
                    console.log('✅ Admin: Connected to Supabase');
                    await createAdminTable();
                } else {
                    console.log('⚠️ Admin: Table check failed -', error.message);
                    connectionChecked = true;
                    // Try to create tables anyway
                    await createAdminTable();
                }
            } catch (err) {
                console.log('⚠️ Admin: Connection failed -', err.message);
                connectionChecked = true;
            }
        })();
    } catch (error) {
        console.log('⚠️ Admin: Supabase client error -', error.message);
        connectionChecked = true;
    }
} else {
    console.log('⚠️ Admin: Supabase credentials not available');
    connectionChecked = true;
}

// ========== SENDGRID EMAIL SETUP ==========
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey('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');

// Middleware to check database status
router.use((req, res, next) => {
    req.dbConnected = dbConnected;
    req.connectionChecked = connectionChecked;
    next();
});

// ========== ADMIN TABLES SETUP ==========

// Create admin table
async function createAdminTable() {
    if (!supabase) return;
    
    try {
        // Check if admin_users table exists by trying to select from it
        const { data: tableCheck, error: checkError } = await supabase
            .from('admin_users')
            .select('id')
            .limit(1);
        
        if (checkError && checkError.code === '42P01') {
            // Table doesn't exist, create it using raw SQL via Supabase
            console.log('📝 Creating admin_users table...');
            
            // Try to create table using Supabase's SQL execution
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
            
            // Note: This requires Supabase to have pg_execute function
            const { error: createError } = await supabase.rpc('exec_sql', { sql: createTableSQL });
            
            if (createError) {
                console.log('⚠️ Could not create table via RPC, will continue with existing data');
            } else {
                console.log('✅ Admin table created');
            }
        }
        
        await createDefaultAdmin();
    } catch (err) {
        console.error('❌ Error in createAdminTable:', err);
    }
}

// Create payment notifications table
async function createPaymentNotificationsTable() {
    if (!supabase) return;
    
    try {
        const { data: tableCheck, error: checkError } = await supabase
            .from('payment_notifications')
            .select('id')
            .limit(1);
        
        if (checkError && checkError.code === '42P01') {
            console.log('📝 Creating payment_notifications table...');
            
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
            
            const { error: createError } = await supabase.rpc('exec_sql', { sql: createTableSQL });
            
            if (createError) {
                console.log('⚠️ Could not create payment_notifications table');
            } else {
                console.log('✅ Payment notifications table created');
            }
        }
    } catch (err) {
        console.error('❌ Error creating payment notifications table:', err);
    }
}

// Create default admin user
async function createDefaultAdmin() {
    if (!supabase) return;
    
    try {
        const adminUsername = 'piotech52@gmail.com';
        const adminEmail = 'piotech52@gmail.com';
        const adminPassword = 'piotech@52gmail.com';
        const adminSecurityCode = 'piotech52@gmail.com';
        const adminFullName = 'Pio Tech Administrator';
        
        // Check if admin exists
        const { data: existingAdmin, error: checkError } = await supabase
            .from('admin_users')
            .select('id')
            .or(`username.eq.${adminUsername},email.eq.${adminEmail}`)
            .maybeSingle();
        
        if (checkError && checkError.code !== 'PGRST116') {
            console.log('⚠️ Error checking admin:', checkError.message);
            return;
        }
        
        if (!existingAdmin) {
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);
            
            const { data: newAdmin, error: insertError } = await supabase
                .from('admin_users')
                .insert([{
                    username: adminUsername,
                    email: adminEmail,
                    password: hashedPassword,
                    security_code: adminSecurityCode,
                    full_name: adminFullName,
                    role: 'super_admin',
                    is_active: true
                }])
                .select();
            
            if (insertError) {
                console.log('⚠️ Error creating admin:', insertError.message);
            } else {
                console.log('✅ Default admin user created successfully');
                console.log('📋 Admin Credentials:');
                console.log('   Username/Email:', adminUsername);
                console.log('   Password:', adminPassword);
                console.log('   Security Code:', adminSecurityCode);
                
                await createPaymentNotificationsTable();
            }
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

// Admin login API - UPDATED to use Supabase
router.post("/api/auth/login", async (req, res) => {
    const { username, password, security_code } = req.body;
    
    console.log('🔐 Admin login attempt:', username);

    // Check if database is connected
    if (!supabase || !dbConnected) {
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
        // Query admin user using Supabase
        const { data: admins, error } = await supabase
            .from('admin_users')
            .select('*')
            .or(`username.eq.${username},email.eq.${username}`)
            .eq('is_active', true);

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({
                success: false,
                message: 'Database error: ' + error.message
            });
        }

        if (!admins || admins.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const admin = admins[0];
        
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
            code: error.code
        });
        
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// ========== DEBUG ROUTE ==========
router.get("/api/admin/debug-db", async (req, res) => {
    res.json({
        supabaseAvailable: !!supabase,
        dbConnected: dbConnected,
        connectionChecked: connectionChecked,
        supabaseUrl: process.env.SUPABASE_URL ? 'Set' : 'Not set',
        supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Set' : 'Not set',
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
// [Keep your existing dashboard HTML - it's very long, so I'm omitting it here for brevity]
// The dashboard HTML remains exactly the same as in your original code
router.get("/admin/dashboard", checkAdminAuth, (req, res) => {
    // Your existing dashboard HTML here
    res.send(`...`); // Keep your existing dashboard HTML
});

// ========== PAYMENT NOTIFICATION ROUTES - UPDATED for Supabase ==========

router.post("/api/admin/payment-notification", async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { payment_id, user_email, amount, currency, payment_method, status, note } = req.body;
        
        const { data, error } = await supabase
            .from('payment_notifications')
            .insert([{
                payment_id: payment_id,
                user_email: user_email,
                amount: amount,
                currency: currency,
                payment_method: payment_method,
                status: status,
                note: note,
                is_read: 0,
                admin_notified: 0
            }])
            .select();
        
        if (error) {
            console.error('Error inserting notification:', error);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        
        const notificationId = data[0].id;
        const emailSent = await sendPaymentEmailNotification({ payment_id, user_email, amount, currency, payment_method, note });
        
        if (emailSent) {
            await supabase
                .from('payment_notifications')
                .update({ admin_notified: 1 })
                .eq('id', notificationId);
        }
        
        res.json({ success: true, notificationId: notificationId, emailSent: emailSent });
    } catch (error) {
        console.error('❌ Error in payment notification:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get("/api/admin/notifications/unread", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { data: notifications, error } = await supabase
            .from('payment_notifications')
            .select(`
                *,
                jambuser:user_email (userName)
            `)
            .eq('is_read', 0)
            .order('created_at', { ascending: false })
            .limit(20);
        
        if (error) {
            console.error('Error fetching notifications:', error);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        
        // Format notifications to match expected structure
        const formattedNotifications = notifications.map(n => ({
            ...n,
            userName: n.jambuser ? n.jambuser.userName : null
        }));
        
        res.json({ success: true, notifications: formattedNotifications, count: formattedNotifications.length });
    } catch (err) {
        console.error('❌ Error fetching notifications:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.post("/api/admin/notifications/:id/read", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { error } = await supabase
            .from('payment_notifications')
            .update({ is_read: 1 })
            .eq('id', req.params.id);
        
        if (error) {
            console.error('Error marking notification as read:', error);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        
        res.json({ success: true, message: 'Notification marked as read' });
    } catch (err) {
        console.error('❌ Error marking notification as read:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.post("/api/admin/notifications/mark-all-read", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { data, error } = await supabase
            .from('payment_notifications')
            .update({ is_read: 1 })
            .eq('is_read', 0)
            .select();
        
        if (error) {
            console.error('Error marking all notifications as read:', error);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        
        res.json({ success: true, message: 'All notifications marked as read', affectedRows: data?.length || 0 });
    } catch (err) {
        console.error('❌ Error marking all notifications as read:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ========== PAYMENTS MANAGEMENT - UPDATED for Supabase ==========

router.get("/api/admin/payments", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { data: payments, error } = await supabase
            .from('user_payments')
            .select(`
                *,
                jambuser:email (userName)
            `)
            .order('created_at', { ascending: false });
        
        if (error) {
            console.error('Error fetching payments:', error);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        
        const formattedPayments = payments.map(p => ({
            ...p,
            userName: p.jambuser ? p.jambuser.userName : null
        }));
        
        res.json({ success: true, payments: formattedPayments });
    } catch (err) {
        console.error('❌ Error fetching payments:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.get("/admin/payments", checkAdminAuth, (req, res) => {
    // Your existing payments management HTML
    res.send(`...`); // Keep your existing HTML
});

// ========== USER MANAGEMENT - UPDATED for Supabase ==========

router.get("/api/admin/users", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { data: users, error } = await supabase
            .from('jambuser')
            .select('id, userName, email, role, is_activated, activationCode, created_at, updated_at')
            .order('created_at', { ascending: false });
        
        if (error) {
            console.error('Error fetching users:', error);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        
        // Get statistics
        const { count: totalUsers, error: totalError } = await supabase
            .from('jambuser')
            .select('*', { count: 'exact', head: true });
        
        const { count: activeUsers, error: activeError } = await supabase
            .from('jambuser')
            .select('*', { count: 'exact', head: true })
            .eq('is_activated', '1');
        
        const { count: students, error: studentError } = await supabase
            .from('jambuser')
            .select('*', { count: 'exact', head: true })
            .eq('role', 'student');
        
        const { data: paidData, error: paidError } = await supabase
            .from('user_payments')
            .select('email', { count: 'exact', head: true })
            .eq('status', 'completed');
        
        const stats = {
            totalUsers: totalUsers || 0,
            activeUsers: activeUsers || 0,
            students: students || 0,
            paidUsers: paidData?.length || 0
        };
        
        res.json({ success: true, users: users, stats: stats });
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.get("/admin/users", checkAdminAuth, (req, res) => {
    // Your existing user management HTML
    res.send(`...`); // Keep your existing HTML
});

// ========== USER ACTIVATION API ROUTES - UPDATED for Supabase ==========

router.post("/api/admin/users/:id/activate", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { data, error } = await supabase
            .from('jambuser')
            .update({ is_activated: '1', updated_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .select('id, email, userName, is_activated');
        
        if (error) {
            console.error('Error activating user:', error);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        
        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        res.json({ success: true, message: 'User activated successfully', user: data[0] });
    } catch (err) {
        console.error('Error activating user:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.post("/api/admin/users/:id/deactivate", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { data, error } = await supabase
            .from('jambuser')
            .update({ is_activated: '0', updated_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .select('id, email, userName, is_activated');
        
        if (error) {
            console.error('Error deactivating user:', error);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        
        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        res.json({ success: true, message: 'User deactivated successfully', user: data[0] });
    } catch (err) {
        console.error('Error deactivating user:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ========== QUESTION MANAGEMENT - UPDATED for Supabase ==========

router.get("/api/admin/statistics", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        // Get total users
        const { count: totalUsers } = await supabase
            .from('jambuser')
            .select('*', { count: 'exact', head: true });
        
        // Get active users
        const { count: activeUsers } = await supabase
            .from('jambuser')
            .select('*', { count: 'exact', head: true })
            .eq('is_activated', '1');
        
        // Get total payments
        const { count: totalPayments } = await supabase
            .from('user_payments')
            .select('*', { count: 'exact', head: true });
        
        // Get total revenue
        const { data: revenueData } = await supabase
            .from('user_payments')
            .select('amount')
            .eq('status', 'completed');
        
        const totalRevenue = revenueData?.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0) || 0;
        
        // Get unread notifications
        const { count: unreadNotifications } = await supabase
            .from('payment_notifications')
            .select('*', { count: 'exact', head: true })
            .eq('is_read', 0);
        
        const results = {
            totalUsers: { count: totalUsers || 0 },
            activeUsers: { count: activeUsers || 0 },
            totalPayments: { count: totalPayments || 0 },
            totalRevenue: { total: totalRevenue },
            unreadNotifications: { count: unreadNotifications || 0 }
        };
        
        res.json({ success: true, statistics: results });
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

router.get("/api/admin/check-access", (req, res) => {
    const isAdmin = req.session && req.session.adminLoggedIn && 
                   ['super_admin', 'admin', 'moderator'].includes(req.session.adminRole);
    
    res.json({ success: true, canAccessAdmin: isAdmin, isAdmin: isAdmin });
});

// ========== ACTIVATION CODE ROUTES - UPDATED for Supabase ==========

router.post("/send", async (req, res) => {
    if (!req.session || !req.session.adminLoggedIn) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    function generateActivationCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    const { email } = req.body;
    const activationCode = generateActivationCode();
    
    try {
        // Check if user has made payment
        const { data: payments, error: paymentError } = await supabase
            .from('user_payments')
            .select('*')
            .eq('email', email);
        
        if (paymentError) {
            console.error('Payment check error:', paymentError);
            return res.status(500).json({ success: false, message: "Database error" });
        }
        
        if (!payments || payments.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: "User has not made payment" 
            });
        }
        
        // Check if user exists in jambuser table
        const { data: users, error: userError } = await supabase
            .from('jambuser')
            .select('*')
            .eq('email', email);
        
        if (userError) {
            console.error('User check error:', userError);
            return res.status(500).json({ success: false, message: "Database error" });
        }
        
        if (!users || users.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: "User not found. Please register first." 
            });
        }
        
        // Update activation code
        const { error: updateError } = await supabase
            .from('jambuser')
            .update({ activationCode: activationCode })
            .eq('email', email);
        
        if (updateError) {
            console.error('Update error:', updateError);
            return res.status(500).json({ success: false, message: "Database error" });
        }
        
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
            message: "Server error: " + error.message 
        });
    }
});

// ========== QUESTION MANAGEMENT API ROUTES - UPDATED for Supabase ==========

// Get all subjects
router.get("/api/subjects", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { data, error } = await supabase
            .from('subjects')
            .select('id, subject_code, subject_name')
            .order('subject_name');
        
        if (error) {
            console.error('Error fetching subjects:', error);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        res.json({ success: true, subjects: data });
    } catch (err) {
        console.error('Error fetching subjects:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Check if subject table exists
router.get("/api/subject-tables/:subject", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const subject = req.params.subject.toLowerCase();
    const tableName = `${subject}_questions`;
    
    try {
        // Try to query the table to see if it exists
        const { data, error, count } = await supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true });
        
        if (error && error.code === '42P01') {
            return res.json({ success: false, message: 'Table does not exist' });
        }
        
        if (error) {
            console.error('Error checking table:', error);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        res.json({
            success: true,
            tableExists: true,
            tableName: tableName,
            rowCount: count || 0,
            structure: []
        });
        
    } catch (err) {
        console.error('Error checking table:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Insert new question with image - UPDATED for Supabase
router.post("/api/insert-question", checkAdminAuth, upload.single('question_image'), async (req, res) => {
    if (!supabase || !dbConnected) {
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
    
    if (!subject || !question_text || !option_a || !option_b || !option_c || !option_d || !correct_answer) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const tableName = `${subject.toLowerCase()}_questions`;
    let imageFilename = null;
    let imageData = null;
    
    if (req.file) {
        imageFilename = req.file.filename;
        try {
            const imageBuffer = fs.readFileSync(req.file.path);
            imageData = imageBuffer.toString('base64');
        } catch (error) {
            console.error('Error reading image file:', error);
        }
    }
    
    try {
        const insertData = {
            question_number: question_number || null,
            year: year || null,
            subject: subject.toUpperCase(),
            question_text: question_text,
            option_a: option_a,
            option_b: option_b,
            option_c: option_c,
            option_d: option_d,
            correct_answer: correct_answer,
            topic: topic || null,
            image_filename: imageFilename,
            image_data: imageData
        };
        
        if (explanation) {
            insertData.explanation = explanation;
        }
        
        const { data, error } = await supabase
            .from(tableName)
            .insert([insertData])
            .select();
        
        if (error) {
            console.error('Error inserting question:', error);
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(500).json({ success: false, error: 'Failed to insert question: ' + error.message });
        }
        
        res.json({
            success: true,
            message: 'Question inserted successfully',
            questionId: data[0]?.id
        });
        
    } catch (err) {
        console.error('Error inserting question:', err);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: 'Failed to insert question' });
    }
});

// Search questions - UPDATED for Supabase
router.get("/api/search-questions", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const { subject, searchTerm, searchBy } = req.query;
    
    if (!subject) {
        return res.status(400).json({ success: false, error: 'Subject is required' });
    }
    
    const tableName = `${subject.toLowerCase()}_questions`;
    
    try {
        let query = supabase.from(tableName).select('*');
        
        if (searchTerm && searchBy) {
            switch (searchBy) {
                case 'question_text':
                    query = query.ilike('question_text', `%${searchTerm}%`);
                    break;
                case 'question_number':
                    query = query.eq('question_number', searchTerm);
                    break;
                case 'year':
                    query = query.eq('year', searchTerm);
                    break;
                case 'topic':
                    query = query.ilike('topic', `%${searchTerm}%`);
                    break;
                default:
                    query = query.ilike('question_text', `%${searchTerm}%`);
            }
        }
        
        const { data, error } = await query.limit(50);
        
        if (error) {
            console.error('Error searching questions:', error);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        const formattedResults = data.map(q => ({
            id: q.id,
            question_number: q.question_number,
            year: q.year,
            subject: q.subject,
            question_text: q.question_text?.substring(0, 100) + (q.question_text?.length > 100 ? '...' : ''),
            option_a: q.option_a?.substring(0, 50),
            option_b: q.option_b?.substring(0, 50),
            option_c: q.option_c?.substring(0, 50),
            option_d: q.option_d?.substring(0, 50),
            correct_answer: q.correct_answer,
            topic: q.topic,
            has_image: !!q.image_filename,
            image_filename: q.image_filename,
            created_at: q.created_at,
            explanation: q.explanation
        }));
        
        res.json({
            success: true,
            count: data.length,
            questions: formattedResults
        });
        
    } catch (err) {
        console.error('Error searching questions:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Get single question - UPDATED for Supabase
router.get("/api/question/:subject/:id", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const { subject, id } = req.params;
    const tableName = `${subject.toLowerCase()}_questions`;
    
    try {
        const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .eq('id', id)
            .single();
        
        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ success: false, error: 'Question not found' });
            }
            console.error('Error fetching question:', error);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        let imageUrl = null;
        if (data.image_data) {
            let mimeType = 'image/jpeg';
            if (data.image_filename) {
                const ext = path.extname(data.image_filename).toLowerCase();
                if (ext === '.png') mimeType = 'image/png';
                else if (ext === '.gif') mimeType = 'image/gif';
                else if (ext === '.webp') mimeType = 'image/webp';
            }
            imageUrl = `data:${mimeType};base64,${data.image_data}`;
        } else if (data.image_filename) {
            imageUrl = `/question-images/${data.image_filename}`;
        }
        
        res.json({
            success: true,
            question: {
                ...data,
                image_url: imageUrl
            }
        });
        
    } catch (err) {
        console.error('Error fetching question:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Delete question - UPDATED for Supabase
router.delete("/api/question/:subject/:id", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    const { subject, id } = req.params;
    const tableName = `${subject.toLowerCase()}_questions`;
    
    try {
        // First get the question to delete associated image file
        const { data: question, error: getError } = await supabase
            .from(tableName)
            .select('image_filename')
            .eq('id', id)
            .single();
        
        if (getError && getError.code !== 'PGRST116') {
            console.error('Error fetching question for deletion:', getError);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        if (!question) {
            return res.status(404).json({ success: false, error: 'Question not found' });
        }
        
        // Delete associated image file if exists
        if (question.image_filename) {
            const imagePath = path.join('question-images', question.image_filename);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
                console.log(`Deleted image file: ${imagePath}`);
            }
        }
        
        // Delete question from database
        const { error: deleteError } = await supabase
            .from(tableName)
            .delete()
            .eq('id', id);
        
        if (deleteError) {
            console.error('Error deleting question:', deleteError);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
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

// Update question - UPDATED for Supabase
router.put("/api/question/:subject/:id", checkAdminAuth, upload.single('question_image'), async (req, res) => {
    if (!supabase || !dbConnected) {
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
        const { data: currentQuestion, error: getError } = await supabase
            .from(tableName)
            .select('image_filename')
            .eq('id', id)
            .single();
        
        if (getError && getError.code !== 'PGRST116') {
            console.error('Error fetching current question:', getError);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        if (!currentQuestion) {
            return res.status(404).json({ success: false, error: 'Question not found' });
        }
        
        let imageFilename = currentQuestion.image_filename;
        let imageData = null;
        
        // Handle new image if uploaded
        if (req.file) {
            imageFilename = req.file.filename;
            try {
                const imageBuffer = fs.readFileSync(req.file.path);
                imageData = imageBuffer.toString('base64');
            } catch (error) {
                console.error('Error reading image file:', error);
            }
            
            // Delete old image file
            if (currentQuestion.image_filename) {
                const oldImagePath = path.join('question-images', currentQuestion.image_filename);
                if (fs.existsSync(oldImagePath)) {
                    fs.unlinkSync(oldImagePath);
                }
            }
        }
        
        // Prepare update data
        const updateData = {
            question_number: question_number || null,
            year: year || null,
            question_text: question_text,
            option_a: option_a,
            option_b: option_b,
            option_c: option_c,
            option_d: option_d,
            correct_answer: correct_answer,
            topic: topic || null
        };
        
        if (explanation) {
            updateData.explanation = explanation;
        }
        
        if (req.file) {
            updateData.image_filename = imageFilename;
            updateData.image_data = imageData;
        }
        
        // Update question
        const { error: updateError } = await supabase
            .from(tableName)
            .update(updateData)
            .eq('id', id);
        
        if (updateError) {
            console.error('Error updating question:', updateError);
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(500).json({ success: false, error: 'Failed to update question' });
        }
        
        res.json({
            success: true,
            message: 'Question updated successfully'
        });
        
    } catch (err) {
        console.error('Error updating question:', err);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: 'Failed to update question' });
    }
});

// Question Management Page
router.get("/admin/questions", checkAdminAuth, (req, res) => {
    // Your existing question management HTML - keep as is
    res.send(`...`); // Keep your existing HTML
});

module.exports = router;
