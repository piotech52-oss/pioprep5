const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
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
// POSTGRESQL CONFIGURATION (Supabase)
// =========================

function encodeDatabaseUrl(url) {
    if (!url) return url;
    return url.replace(/:(.*?)@/, (match, p1) => {
        if (p1.includes('@') || p1.includes('#') || p1.includes('!')) {
            return ':' + encodeURIComponent(p1) + '@';
        }
        return match;
    });
}

const databaseUrl = encodeDatabaseUrl(process.env.DATABASE_URL);

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
        rejectUnauthorized: false,
        sslmode: 'require'
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

let dbConnected = false;
let connectionChecked = false;

async function testDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Connected to Supabase PostgreSQL!');
        dbConnected = true;
        connectionChecked = true;
        client.release();
        await client.query('SELECT 1');
        console.log('✅ Database queries working');
        return true;
    } catch (err) {
        console.error('❌ Error connecting to Supabase PostgreSQL:', err.message);
        dbConnected = false;
        connectionChecked = true;
        return false;
    }
}

testDatabaseConnection();
setInterval(testDatabaseConnection, 30000);

app.use((req, res, next) => {
    req.dbConnected = dbConnected;
    req.connectionChecked = connectionChecked;
    next();
});

// =========================
// SESSION CONFIGURATION
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
    console.log('⚠️ Session store using memory');
}

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

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
                    is_activated INTEGER DEFAULT 0,
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

if (dbConnected) {
    initializeDatabase();
}

// =========================
// API ROUTES
// =========================

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

app.get('/api/session', (req, res) => {
    if (req.session && req.session.isLoggedIn) {
        res.json({
            loggedIn: true,
            user: {
                id: req.session.userId,
                userName: req.session.userName,
                email: req.session.email,
                is_activated: req.session.is_activated === 1 || req.session.is_activated === true
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/register', async (req, res) => {
    let { userName, email, password } = req.body;

    console.log('📝 Registration attempt:', { userName, email });

    if (!dbConnected) {
        console.log('❌ Database not connected');
        return res.status(503).json({ 
            error: "Database is currently unavailable. Please try again in a few moments.",
            details: "Unable to connect to Supabase PostgreSQL"
        });
    }

    try {
        if (!userName || !email || !password) {
            console.log('❌ Missing fields');
            return res.status(400).json({ error: "All fields are required" });
        }

        if (!isRealisticEmail(email)) {
            console.log('❌ Invalid email format:', email);
            return res.status(400).json({ error: "Invalid email format" });
        }

        userName = userName.trim();
        email = email.trim().toLowerCase();
        password = password.trim();

        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

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

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        console.log('🔐 Password hashed successfully');

        // New users: is_activated = 0 (not activated)
        const result = await pool.query(
            "INSERT INTO jambuser (\"userName\", email, password, role, is_activated) VALUES ($1, $2, $3, $4, $5) RETURNING id, \"userName\", email",
            [userName, email, hashedPassword, 'student', 0]
        );

        console.log('✅ Insert result:', result.rows[0]);
        console.log(`✅ New user registered: ${email} (ID: ${result.rows[0].id})`);
        
        return res.json({
            success: true,
            message: "Registration successful! Please login."
        });

    } catch (error) {
        console.error('❌ Registration error:', error.message);
        
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

// ============================================
// FIXED LOGIN - Handles is_activated as INTEGER (0 or 1)
// ============================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    console.log(`🔐 Login attempt for: ${email}`);

    if (!dbConnected) {
        return res.status(503).json({ 
            error: "Database is currently unavailable. Please try again later."
        });
    }

    try {
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const cleanEmail = email.trim().toLowerCase();
        
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
            is_activated: user.is_activated,
            role: user.role
        });

        if (!user.password) {
            return res.status(500).json({ error: "Account error: No password set" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) {
            console.log('❌ Password does not match for:', user.email);
            return res.status(401).json({ error: "Incorrect password" });
        }

        console.log('✅ Password correct for:', user.email);
        
        // FIXED: Check is_activated as INTEGER (0 = not activated, 1 = activated)
        const isActivated = user.is_activated === 1;
        const isAdmin = user.role === 'admin' || user.role === 'Administrator';

        console.log(`📌 User status - Activated: ${isActivated} (raw value: ${user.is_activated}), Admin: ${isAdmin}`);

        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.userName = user.userName;
        req.session.isLoggedIn = true;
        req.session.is_activated = isActivated;
        req.session.role = user.role;

        let redirectTo;
        if (isAdmin) {
            redirectTo = "/admin-dashboard.html";
            console.log('👑 Admin user - redirecting to admin dashboard');
        } else if (isActivated) {
            redirectTo = "/home.html";
            console.log('✅ Activated user (is_activated=1) - redirecting to home.html');
        } else {
            redirectTo = "/homeforall.html";
            console.log('⚠️ Non-activated user (is_activated=0) - redirecting to homeforall.html');
        }

        return res.json({
            success: true,
            message: "Login successful!",
            user: {
                id: user.id,
                userName: user.userName,
                email: user.email,
                is_activated: isActivated,
                role: user.role,
                isAdmin: isAdmin
            },
            redirectTo: redirectTo
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

module.exports = app;const express = require('express');
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
module.exports = app;
