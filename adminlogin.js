const express = require('express');
const { Pool } = require('pg'); // PostgreSQL instead of mysql2
const bcrypt = require('bcrypt');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple'); // PostgreSQL session store
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// =========================
// MIDDLEWARE CONFIGURATION
// =========================

app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? process.env.VERCEL_URL 
        : 'http://localhost:3000',
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// POSTGRESQL CONFIGURATION (Supabase) - FIXED
// =========================

// Function to encode password in connection string
function encodeDatabaseUrl(url) {
    if (!url) return url;
    // Match password part between : and @
    return url.replace(/:(.*?)@/, (match, p1) => {
        // If password contains special characters, encode it
        if (p1.includes('@') || p1.includes('#') || p1.includes('!')) {
            return ':' + encodeURIComponent(p1) + '@';
        }
        return match;
    });
}

// Get and fix the connection string
const databaseUrl = encodeDatabaseUrl(process.env.DATABASE_URL);

// Supabase PostgreSQL configuration with increased timeout
const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
        rejectUnauthorized: false,
        sslmode: 'require'
    },
    max: 10, // Reduced max connections
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000, // Increased to 10 seconds
});

// Global connection status
let dbConnected = false;
let connectionChecked = false;

// Better connection test
async function testDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Connected to Supabase PostgreSQL!');
        dbConnected = true;
        connectionChecked = true;
        client.release();
        
        // Test a simple query
        await client.query('SELECT 1');
        console.log('✅ Database queries working');
        
        return true;
    } catch (err) {
        console.error('❌ Error connecting to Supabase PostgreSQL:', err.message);
        dbConnected = false;
        connectionChecked = true;
        
        if (err.message.includes('ECONNREFUSED')) {
            console.log('📌 Connection refused - check:');
            console.log('   1. Your DATABASE_URL in .env file');
            console.log('   2. If password contains @, replace with %40');
            console.log('   3. Your IP is allowed in Supabase dashboard');
            console.log('   4. The database is not paused');
        }
        return false;
    }
}

// Test connection immediately
testDatabaseConnection();

// Retry connection every 30 seconds
setInterval(testDatabaseConnection, 30000);

// Middleware to check database status
app.use((req, res, next) => {
    req.dbConnected = dbConnected;
    req.connectionChecked = connectionChecked;
    next();
});

// =========================
// SESSION CONFIGURATION (PostgreSQL) - WITH FALLBACK
// =========================

let sessionStore;
try {
    const PgSession = connectPgSimple(session);
    if (dbConnected) {
        sessionStore = new PgSession({
            pool: pool,
            tableName: 'user_sessions',
            createTableIfMissing: true
        });
    }
} catch (error) {
    console.log('⚠️ Session store using memory (PostgreSQL unavailable)');
}

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

// =========================
// UTILITY FUNCTIONS
// =========================

function isRealisticEmail(email) {
    if (!email) return false;
    email = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return false;
    if (email.includes("..")) return false;
    if (email.length < 6) return false;
    const tldRegex = /\.(com|net|org|edu|gov|io|ng|co|info|biz|me|tech)$/;
    if (!tldRegex.test(email)) return false;
    return true;
};

const requireLogin = (req, res, next) => {
    if (!req.session || !req.session.isLoggedIn) {
        return res.status(401).json({ error: 'Please login first' });
    }
    next();
};

// =========================
// DATABASE INITIALIZATION
// =========================

async function initializeDatabase() {
    if (!dbConnected) {
        console.log('⏳ Skipping database initialization - not connected');
        return;
    }
    
    try {
        // Check if jambuser table exists
        const result = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'jambuser'
            );
        `);
        
        if (!result.rows[0].exists) {
            console.log('⚠️ jambuser table does not exist. Creating it...');
            
            await pool.query(`
                CREATE TABLE jambuser (
                    id SERIAL PRIMARY KEY,
                    "userName" VARCHAR(100) NOT NULL,
                    email VARCHAR(255) NOT NULL UNIQUE,
                    password VARCHAR(255) NOT NULL,
                    role VARCHAR(50) DEFAULT 'student',
                    is_activated BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            
            console.log('✅ jambuser table created successfully');
        } else {
            const countResult = await pool.query("SELECT COUNT(*) as count FROM jambuser");
            console.log(`📊 Database has ${countResult.rows[0].count} existing users`);
        }
        
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
    }
}

// Call initialization when connected
if (dbConnected) {
    initializeDatabase();
}

// =========================
// API ROUTES
// =========================

// Health check endpoint
app.get('/api/health', async (req, res) => {
    const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'JAMB CBT Authentication',
        database: {
            connected: dbConnected,
            type: 'PostgreSQL (Supabase)',
            checked: connectionChecked
        }
    };
    
    if (dbConnected) {
        try {
            const dbTest = await pool.query('SELECT NOW() as time');
            status.database.time = dbTest.rows[0].time;
        } catch (error) {
            status.database.error = error.message;
        }
    }
    
    res.json(status);
});

// Check session status
app.get('/api/session', (req, res) => {
    if (req.session && req.session.isLoggedIn) {
        res.json({
            loggedIn: true,
            user: {
                id: req.session.userId,
                userName: req.session.userName,
                email: req.session.email,
                is_activated: req.session.is_activated
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// Register user - WITH PROPER ERROR HANDLING
app.post('/api/register', async (req, res) => {
    let { userName, email, password } = req.body;

    console.log('📝 Registration attempt:', { userName, email });

    // Check if database is connected
    if (!dbConnected) {
        console.log('❌ Database not connected');
        return res.status(503).json({ 
            error: "Database is currently unavailable. Please try again in a few moments.",
            details: "Unable to connect to Supabase PostgreSQL"
        });
    }

    try {
        // Basic validation
        if (!userName || !email || !password) {
            console.log('❌ Missing fields');
            return res.status(400).json({ error: "All fields are required" });
        }

        if (!isRealisticEmail(email)) {
            console.log('❌ Invalid email format:', email);
            return res.status(400).json({ error: "Invalid email format" });
        }

        // Trim inputs
        userName = userName.trim();
        email = email.trim().toLowerCase();
        password = password.trim();

        // Check password length
        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

        // Check if user exists
        console.log('🔍 Checking if user exists:', email);
        
        const existingUsers = await pool.query(
            "SELECT id FROM jambuser WHERE email = $1",
            [email]
        );

        console.log('📊 Existing user check result:', existingUsers.rows);

        if (existingUsers.rows.length > 0) {
            console.log('❌ Email already exists:', email);
            return res.status(400).json({ error: "Email already registered" });
        }

        // Hash password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        console.log('🔐 Password hashed successfully');

        // Insert new user
        const result = await pool.query(
            "INSERT INTO jambuser (\"userName\", email, password, role, is_activated) VALUES ($1, $2, $3, $4, $5) RETURNING id, \"userName\", email",
            [userName, email, hashedPassword, 'student', false]
        );

        console.log('✅ Insert result:', result.rows[0]);
        console.log(`✅ New user registered: ${email} (ID: ${result.rows[0].id})`);
        
        return res.json({
            success: true,
            message: "Registration successful! Please login."
        });

    } catch (error) {
        console.error('❌ Registration error:', error.message);
        
        // Handle specific PostgreSQL errors
        if (error.code === '23505') {
            return res.status(400).json({ error: "Email already registered" });
        } else if (error.code === '42703') {
            return res.status(500).json({ error: "Database column mismatch. Check server logs." });
        } else if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
            dbConnected = false;
            return res.status(503).json({ 
                error: "Database connection lost. Please try again."
            });
        }
        
        return res.status(500).json({ error: "Server error during registration" });
    }
});

// Login user - FIXED to check for '1' as string
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    console.log(`🔐 Login attempt for: ${email}`);

    // Check if database is connected
    if (!dbConnected) {
        return res.status(503).json({ 
            error: "Database is currently unavailable. Please try again later."
        });
    }

    try {
        // Basic validation
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const cleanEmail = email.trim().toLowerCase();
        
        // Find user in database
        const userResult = await pool.query(
            "SELECT * FROM jambuser WHERE email = $1",
            [cleanEmail]
        );

        console.log(`📊 Database returned ${userResult.rows.length} results`);

        if (userResult.rows.length === 0) {
            console.log('❌ User not found:', cleanEmail);
            return res.status(401).json({ error: "Invalid email or password" });
        }

        const user = userResult.rows[0];
        console.log('✅ User found in database:', {
            id: user.id,
            email: user.email,
            userName: user.userName,
            is_activated: user.is_activated
        });

        // Check password
        if (!user.password) {
            return res.status(500).json({ error: "Account error: No password set" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) {
            console.log('❌ Password does not match for:', user.email);
            return res.status(401).json({ error: "Incorrect password" });
        }

        console.log('✅ Password correct for:', user.email);
        
        // FIXED: Check activation status for VARCHAR(1) column storing '1'
        const isActivated = user.is_activated === '1' || user.is_activated === true;

        // Store user in session
        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.userName = user.userName;
        req.session.isLoggedIn = true;
        req.session.is_activated = isActivated;

        return res.json({
            success: true,
            message: "Login successful!",
            user: {
                id: user.id,
                userName: user.userName,
                email: user.email,
                is_activated: isActivated
            },
            redirectTo: isActivated ? "/home.html" : "/homeforall.html"
        });

    } catch (error) {
        console.error('Login error:', error.message);
        if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
            dbConnected = false;
            return res.status(503).json({ 
                error: "Database connection lost. Please try again."
            });
        }
        return res.status(500).json({ error: "Server error during authentication" });
    }
});

// =========================
// QUESTION ROUTES
// =========================

// Get accounting questions
app.get('/api/questions/accounting', async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ error: "Database unavailable" });
    }
    
    try {
        const { year, limit = 50 } = req.query;
        
        let query = 'SELECT * FROM acct_questions';
        const params = [];
        
        if (year) {
            query += ' WHERE year = $1';
            params.push(year);
        }
        
        query += ' ORDER BY id LIMIT $' + (params.length + 1);
        params.push(parseInt(limit));
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            count: result.rows.length,
            questions: result.rows
        });
    } catch (error) {
        console.error('Error fetching accounting questions:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

// Get biology questions
app.get('/api/questions/biology', async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ error: "Database unavailable" });
    }
    
    try {
        const result = await pool.query(
            'SELECT * FROM bio_questions ORDER BY id LIMIT $1',
            [req.query.limit || 50]
        );
        
        res.json({
            success: true,
            count: result.rows.length,
            questions: result.rows
        });
    } catch (error) {
        console.error('Error fetching biology questions:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

// Get chemistry questions
app.get('/api/questions/chemistry', async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ error: "Database unavailable" });
    }
    
    try {
        const result = await pool.query(
            'SELECT * FROM chem_questions ORDER BY id LIMIT $1',
            [req.query.limit || 50]
        );
        
        res.json({
            success: true,
            count: result.rows.length,
            questions: result.rows
        });
    } catch (error) {
        console.error('Error fetching chemistry questions:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

// Get questions by subject
app.get('/api/questions/:subject', async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ error: "Database unavailable" });
    }
    
    try {
        const { subject } = req.params;
        const { year, topic, limit = 20 } = req.query;
        
        const validSubjects = ['accounting', 'biology', 'chemistry', 'agriculture'];
        if (!validSubjects.includes(subject.toLowerCase())) {
            return res.status(400).json({ error: "Invalid subject" });
        }
        
        const tableName = `${subject}_questions`;
        let query = `SELECT * FROM ${tableName}`;
        const params = [];
        let paramCount = 0;
        
        const conditions = [];
        if (year) {
            paramCount++;
            conditions.push(`year = $${paramCount}`);
            params.push(year);
        }
        if (topic) {
            paramCount++;
            conditions.push(`topic ILIKE $${paramCount}`);
            params.push(`%${topic}%`);
        }
        
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        paramCount++;
        query += ` ORDER BY id LIMIT $${paramCount}`;
        params.push(parseInt(limit));
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            subject: subject,
            count: result.rows.length,
            questions: result.rows
        });
        
    } catch (error) {
        console.error('Error fetching questions:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

// Profile route
app.get('/api/profile', requireLogin, async (req, res) => {
    if (!dbConnected) {
        return res.status(503).json({ error: "Database unavailable" });
    }
    
    try {
        const result = await pool.query(
            "SELECT id, \"userName\", email, role, is_activated, created_at FROM jambuser WHERE id = $1",
            [req.session.userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        
        res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Profile fetch error:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: "Could not logout" });
        }
        res.json({ success: true, message: "Logged out successfully" });
    });
});

// =========================
// STATIC FILE SERVING
// =========================

app.use(express.static('public'));
app.use('/scripts', express.static('scripts'));
app.use('/styles', express.static('styles'));
app.use('/images', express.static('images'));

// =========================
// SERVER STARTUP
// =========================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🎯 JAMB CBT Authentication Server (PostgreSQL)');
    console.log('='.repeat(50));
    console.log(`✅ Server: http://localhost:${PORT}`);
    console.log(`📊 Database: ${dbConnected ? '✅ Connected' : '❌ Disconnected'}`);
    console.log('='.repeat(50));
    console.log('\n📚 Available Routes:');
    console.log('   • GET  /api/health                   - Health check');
    console.log('   • GET  /api/session                  - Check session');
    console.log('   • POST /api/register                 - Register');
    console.log('   • POST /api/login                    - Login');
    console.log('   • POST /api/logout                   - Logout');
    console.log('   • GET  /api/questions/accounting     - Accounting Qs');
    console.log('   • GET  /api/questions/biology        - Biology Qs');
    console.log('   • GET  /api/questions/chemistry      - Chemistry Qs');
    console.log('   • GET  /api/questions/:subject       - Questions by subject');
    console.log('\n⚡ Status: Ready');
    console.log('='.repeat(50) + '\n');
});

// Export for Vercel
module.exports = app;   u can see how i used to compare my password used the same way here const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ========== SENDGRID EMAIL SETUP ==========
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey('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');

// ========== SUPABASE CLIENT SETUP (SAME AS INDEX.JS) ==========
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
let dbConnected = false;
let connectionChecked = false;

console.log('🔧 Admin Environment Check:');
console.log(`   SUPABASE_URL: ${supabaseUrl ? supabaseUrl : 'NOT SET'}`);
console.log(`   SUPABASE_KEY: ${supabaseKey ? 'SET (length: ' + supabaseKey.length + ')' : 'NOT SET'}`);

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        console.log('✅ Admin Supabase client initialized');
        
        // Test connection immediately
        (async () => {
            try {
                const { data, error } = await supabase.from('admin_users').select('*').limit(1);
                if (!error) {
                    dbConnected = true;
                    connectionChecked = true;
                    console.log('✅ Admin: Connected to Supabase');
                    console.log(`   Admin users found: ${data ? data.length : 0}`);
                    await createAdminTable();
                } else {
                    console.log('⚠️ Admin: Table check failed -', error.message);
                    connectionChecked = true;
                    await createAdminTable();
                }
            } catch (err) {
                console.log('⚠️ Admin: Connection failed -', err.message);
                connectionChecked = true;
            }
        })();
    } catch (error) {
        console.log('⚠️ Admin Supabase client error:', error.message);
        connectionChecked = true;
    }
} else {
    console.log('⚠️ Admin: Supabase credentials not available');
    connectionChecked = true;
}

// Middleware to check database status
router.use((req, res, next) => {
    req.dbConnected = dbConnected;
    req.connectionChecked = connectionChecked;
    next();
});

// ========== ADMIN TABLES SETUP ==========

async function createAdminTable() {
    if (!supabase) return;
    
    try {
        // Check if admin_users table exists
        const { error: checkError } = await supabase
            .from('admin_users')
            .select('id')
            .limit(1);
        
        if (checkError && checkError.code === '42P01') {
            console.log('📝 Creating admin_users table...');
            
            // Create table using raw SQL via Supabase RPC (if available)
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
            
            // Try to execute SQL (this may require pg_execute function)
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

async function createPaymentNotificationsTable() {
    if (!supabase) return;
    
    try {
        const { error: checkError } = await supabase
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
        
        if (!existingAdmin) {
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);
            
            const { error: insertError } = await supabase
                .from('admin_users')
                .insert([{
                    username: adminUsername,
                    email: adminEmail,
                    password: hashedPassword,
                    security_code: adminSecurityCode,
                    full_name: adminFullName,
                    role: 'super_admin',
                    is_active: true
                }]);
            
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
                        <p><strong>Payment ID:</strong> ${payment_id}</p>
                        <p><strong>User Email:</strong> ${user_email}</p>
                        <p><strong>Amount:</strong> ${currency} ${amount}</p>
                        <p><strong>Payment Method:</strong> ${payment_method}</p>
                        <p><strong>Note:</strong> ${note || 'No note provided'}</p>
                    </div>
                    
                    <div style="margin-top: 30px; text-align: center;">
                        <a href="/admin/dashboard" 
                           style="display: inline-block; background: #1a237e; color: white; padding: 10px 20px; 
                                  text-decoration: none; border-radius: 5px;">
                            Go to Admin Dashboard
                        </a>
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
                    height: 100vh; display: flex; justify-content: center; align-items: center; margin: 0; }
                .login-box { background: white; padding: 40px; border-radius: 10px; 
                    box-shadow: 0 15px 35px rgba(0,0,0,0.3); width: 100%; max-width: 400px; }
                h1 { color: #1a237e; margin-bottom: 30px; }
                input { width: 100%; padding: 12px; margin: 10px 0; border: 2px solid #ddd; 
                    border-radius: 5px; font-size: 16px; box-sizing: border-box; }
                button { width: 100%; padding: 12px; background: #1a237e; color: white; 
                    border: none; border-radius: 5px; font-size: 16px; cursor: pointer; margin-top: 20px; }
                button:hover { background: #311b92; }
                .back { display: inline-block; margin-top: 20px; color: #1a237e; text-decoration: none; }
                .credentials { margin-top: 20px; padding: 15px; background: #f8f9fa; 
                    border-radius: 5px; font-size: 14px; text-align: left; }
                .credentials code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; }
                .message { margin-top: 15px; padding: 10px; border-radius: 5px; }
                .message.error { background: #f8d7da; color: #721c24; }
                .message.success { background: #d4edda; color: #155724; }
                .status { margin-top: 10px; padding: 8px; border-radius: 5px; font-size: 12px; }
                .status.connected { background: #d4edda; color: #155724; }
                .status.disconnected { background: #f8d7da; color: #721c24; }
                .debug-info {
                    margin-top: 10px;
                    font-size: 12px;
                    color: #666;
                    text-align: left;
                    border-top: 1px solid #eee;
                    padding-top: 10px;
                }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h1>🔐 Admin Login</h1>
                <div id="dbStatus" class="status">Checking database connection...</div>
                <form id="loginForm">
                    <input type="text" id="username" placeholder="Username or Email" autocomplete="username" required>
                    <input type="password" id="password" placeholder="Password" autocomplete="current-password" required>
                    <input type="text" id="securityCode" placeholder="Security Code" required>
                    <button type="submit">Login</button>
                </form>
                <div id="message"></div>
                <div class="credentials">
                    <strong>Default Admin Credentials:</strong><br>
                    Username/Email: <code>piotech52@gmail.com</code><br>
                    Password: <code>piotech@52gmail.com</code><br>
                    Security Code: <code>piotech52@gmail.com</code>
                </div>
                <div class="debug-info">
                    <a href="/api/admin/check-admin" target="_blank" style="color: #1a237e;">Check Admin Password</a>
                </div>
                <a href="/" class="back">← Back to Home</a>
            </div>
            <script>
                async function checkDBStatus() {
                    try {
                        const response = await fetch('/api/admin/debug-db');
                        const data = await response.json();
                        const statusDiv = document.getElementById('dbStatus');
                        if (data.dbConnected) {
                            statusDiv.innerHTML = '✅ Database: Connected';
                            statusDiv.className = 'status connected';
                        } else {
                            statusDiv.innerHTML = '❌ Database: Not Connected - Check server logs';
                            statusDiv.className = 'status disconnected';
                        }
                    } catch (error) {
                        document.getElementById('dbStatus').innerHTML = '❌ Cannot connect to server';
                        document.getElementById('dbStatus').className = 'status disconnected';
                    }
                }
                
                checkDBStatus();
                setInterval(checkDBStatus, 5000);
                
                document.getElementById('loginForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const username = document.getElementById('username').value.trim();
                    const password = document.getElementById('password').value;
                    const securityCode = document.getElementById('securityCode').value.trim();
                    const messageDiv = document.getElementById('message');
                    
                    if (!username || !password || !securityCode) {
                        messageDiv.textContent = 'All fields are required';
                        messageDiv.className = 'message error';
                        return;
                    }
                    
                    messageDiv.textContent = 'Logging in...';
                    messageDiv.className = 'message success';
                    
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
                            messageDiv.className = 'message error';
                        }
                    } catch (error) {
                        messageDiv.textContent = 'Connection error. Please try again.';
                        messageDiv.className = 'message error';
                        console.error('Login error:', error);
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// Admin login API - USING SUPABASE CLIENT
router.post("/api/auth/login", async (req, res) => {
    const { username, password, security_code } = req.body;
    
    console.log('🔐 Admin login attempt:', username);
    console.log('   Password length:', password ? password.length : 0);

    if (!supabase || !dbConnected) {
        console.log('❌ Database not connected');
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
            console.log('   Admin user not found');
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials - User not found'
            });
        }

        const admin = admins[0];
        console.log('   Found admin:', admin.email);
        
        if (admin.security_code !== security_code) {
            console.log('   Security code mismatch');
            return res.status(401).json({
                success: false,
                message: 'Invalid security code'
            });
        }

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
        console.error('❌ Login error:', error);
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

// ========== DEBUG ROUTES ==========
router.get("/api/admin/debug-db", async (req, res) => {
    res.json({
        supabaseAvailable: !!supabase,
        dbConnected: dbConnected,
        connectionChecked: connectionChecked,
        supabaseUrl: process.env.SUPABASE_URL ? 'Set' : 'Not set',
        supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Set' : 'Not set',
        timestamp: new Date().toISOString()
    });
});

// DEBUG ROUTE TO CHECK ADMIN PASSWORD - ADDED
router.get("/api/admin/check-admin", async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.json({ success: false, message: 'Database not connected' });
    }
    
    try {
        const { data: admins, error } = await supabase
            .from('admin_users')
            .select('id, username, email, role, is_active, password')
            .eq('email', 'piotech52@gmail.com');
        
        if (error) {
            return res.json({ success: false, error: error.message });
        }
        
        if (!admins || admins.length === 0) {
            return res.json({ success: false, message: 'Admin user not found' });
        }
        
        const admin = admins[0];
        
        // Test password verification
        const testPassword = 'piotech@52gmail.com';
        const isValid = await bcrypt.compare(testPassword, admin.password);
        
        res.json({
            success: true,
            adminExists: true,
            email: admin.email,
            role: admin.role,
            is_active: admin.is_active,
            passwordHashLength: admin.password.length,
            passwordHashPrefix: admin.password.substring(0, 30) + '...',
            testPassword: testPassword,
            testPasswordLength: testPassword.length,
            passwordVerification: {
                testPassword: testPassword,
                isValid: isValid
            },
            message: isValid ? '✅ Password is correct!' : '❌ Password hash does not match!'
        });
    } catch (err) {
        console.error('Debug error:', err);
        res.json({ success: false, error: err.message });
    }
});

// ========== STATISTICS API - USING SUPABASE ==========
router.get("/api/admin/statistics", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        // Get total users
        const { count: totalUsers } = await supabase
            .from('jambuser')
            .select('*', { count: 'exact', head: true });
        
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
        
        res.json({
            success: true,
            statistics: {
                totalUsers: { count: totalUsers || 0 },
                totalPayments: { count: totalPayments || 0 },
                totalRevenue: { total: totalRevenue },
                unreadNotifications: { count: unreadNotifications || 0 }
            }
        });
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// ========== DASHBOARD ==========
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
                    <p>Send activation code</p>
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

// ========== USER MANAGEMENT - USING SUPABASE ==========
router.get("/api/admin/users", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) {
        return res.status(503).json({ success: false, message: 'Database unavailable' });
    }
    
    try {
        const { data: users, error } = await supabase
            .from('jambuser')
            .select('id, userName, email, role, is_activated, activationCode, created_at')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        // Get statistics
        const { count: totalUsers } = await supabase.from('jambuser').select('*', { count: 'exact', head: true });
        const { count: activeUsers } = await supabase.from('jambuser').select('*', { count: 'exact', head: true }).eq('is_activated', '1');
        const { count: students } = await supabase.from('jambuser').select('*', { count: 'exact', head: true }).eq('role', 'student');
        const { count: paidUsers } = await supabase.from('user_payments').select('*', { count: 'exact', head: true }).eq('status', 'completed');
        
        const stats = {
            totalUsers: totalUsers || 0,
            activeUsers: activeUsers || 0,
            students: students || 0,
            paidUsers: paidUsers || 0
        };
        
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
        <head><title>User Management</title>
        <style>
            body { font-family: Arial; padding: 20px; background: #f5f5f5; }
            table { width: 100%; background: white; border-collapse: collapse; }
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
            <h1>👥 User Management</h1>
            <div id="users"></div>
            <script>
                async function loadUsers() {
                    const response = await fetch('/api/admin/users');
                    const data = await response.json();
                    if (data.success) {
                        let html = ' <tr><th>Name</th><th>Email</th><th>Status</th><th>Code</th><th>Actions</th></tr>';
                        data.users.forEach(user => {
                            const isActive = user.is_activated === '1';
                            html += \`
                                <tr>
                                    <td>\${user.userName || 'N/A'}</td>
                                    <td>\${user.email}</td>
                                    <td class="status-\${isActive ? 'active' : 'inactive'}">\${isActive ? 'Active' : 'Inactive'}</td>
                                    <td>\${user.activationCode || 'No code'}</td>
                                    <td>
                                        <button class="btn btn-code" onclick="sendCode('\${user.email}')">Send Code</button>
                                        \${!isActive ? 
                                            '<button class="btn btn-activate" onclick="activateUser(' + user.id + ')">Activate</button>' : 
                                            '<button class="btn btn-deactivate" onclick="deactivateUser(' + user.id + ')">Deactivate</button>'
                                        }
                                    </td>
                                </tr>
                            \`;
                        });
                        html += '</table>';
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
                
                loadUsers();
            </script>
        </body>
        </html>
    `);
});

router.post("/api/admin/users/:id/activate", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) return res.status(503).json({ success: false });
    try {
        const { error } = await supabase
            .from('jambuser')
            .update({ is_activated: '1' })
            .eq('id', req.params.id);
        
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

router.post("/api/admin/users/:id/deactivate", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) return res.status(503).json({ success: false });
    try {
        const { error } = await supabase
            .from('jambuser')
            .update({ is_activated: '0' })
            .eq('id', req.params.id);
        
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// ========== PAYMENT MANAGEMENT - USING SUPABASE ==========
router.get("/api/admin/payments", checkAdminAuth, async (req, res) => {
    if (!supabase || !dbConnected) return res.status(503).json({ success: false });
    try {
        const { data: payments, error } = await supabase
            .from('user_payments')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        // Get user names
        const { data: users } = await supabase.from('jambuser').select('email, userName');
        const userMap = {};
        users?.forEach(u => { userMap[u.email] = u.userName; });
        
        const paymentsWithNames = payments.map(p => ({
            ...p,
            userName: userMap[p.email] || null
        }));
        
        res.json({ success: true, payments: paymentsWithNames });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

router.get("/admin/payments", checkAdminAuth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Payment Management</title>
        <style>
            body { font-family: Arial; padding: 20px; background: #f5f5f5; }
            table { width: 100%; background: white; border-collapse: collapse; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
            th { background: #1a237e; color: white; }
        </style>
        </head>
        <body>
            <h1>💰 Payment Management</h1>
            <div id="payments"></div>
            <script>
                async function loadPayments() {
                    const response = await fetch('/api/admin/payments');
                    const data = await response.json();
                    if (data.success && data.payments) {
                        let html = ' 60% <th>User</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th>  </tr';
                        data.payments.forEach(p => {
                            html += \`<tr><td>\${p.userName || p.email}</td><td>₦\${p.amount}</td><td>\${p.payment_method}</td><td>\${p.status}</td><td>\${new Date(p.created_at).toLocaleDateString()}</td></tr>\`;
                        });
                        html += '</table>';
                        document.getElementById('payments').innerHTML = html;
                    }
                }
                loadPayments();
            </script>
        </body>
        </html>
    `);
});

// ========== ACTIVATION CODE ROUTE - USING SUPABASE ==========
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
        
        if (paymentError) throw paymentError;
        
        if (!payments || payments.length === 0) {
            return res.status(400).json({ success: false, message: "User has not made payment" });
        }
        
        // Check if user exists
        const { data: users, error: userError } = await supabase
            .from('jambuser')
            .select('*')
            .eq('email', email);
        
        if (userError) throw userError;
        
        if (!users || users.length === 0) {
            return res.status(400).json({ success: false, message: "User not found" });
        }
        
        // Update activation code
        const { error: updateError } = await supabase
            .from('jambuser')
            .update({ activationCode: activationCode })
            .eq('email', email);
        
        if (updateError) throw updateError;
        
        // Send email
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
        <head><title>Question Management</title>
        <style>body{font-family:Arial;padding:20px;background:#f5f5f5;}</style>
        </head>
        <body>
            <h1>📚 Question Management</h1>
            <p>Question management features coming soon...</p>
            <a href="/admin/dashboard">Back to Dashboard</a>
        </body>
        </html>
    `);
});

router.get("/api/admin/check-access", (req, res) => {
    res.json({ success: true, isAdmin: req.session?.adminLoggedIn || false });
});

module.exports = router;
