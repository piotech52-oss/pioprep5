// index.js - COMPLETE WORKING VERSION WITH POSTGRESQL
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// =========================
// MIDDLEWARE CONFIGURATION
// =========================

app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? 'https://pioprep5-olwj.vercel.app'
        : 'http://localhost:3000',
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// =========================
// POSTGRESQL CONFIGURATION (Supabase)
// =========================

// ✅ FIXED: removed encodeDatabaseUrl
const databaseUrl = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
        rejectUnauthorized: false
    },
    max: 5, // ✅ increased
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

let dbConnected = false;
let connectionChecked = false;

async function testDatabaseConnection() {
    try {
        const client = await pool.connect();

        // ✅ FIXED: query before release
        await client.query('SELECT 1');

        console.log('✅ Connected to Supabase PostgreSQL!');
        dbConnected = true;
        connectionChecked = true;

        client.release(); // ✅ correct order

        await initializeDatabase();
        return true;
    } catch (err) {
        console.error('❌ Error connecting to Supabase:', err.message);
        dbConnected = false;
        connectionChecked = true;
        return false;
    }
}

// ✅ keep only this (no setInterval)
testDatabaseConnection();

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
    secret: process.env.SESSION_SECRET || 'jamb-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

// =========================
// DATABASE INITIALIZATION
// =========================

async function initializeDatabase() {
    if (!dbConnected) return;
    
    try {
        const result = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'jambuser'
            );
        `);
        
        if (!result.rows[0].exists) {
            console.log('📝 Creating jambuser table...');
            await pool.query(`
                CREATE TABLE jambuser (
                    id SERIAL PRIMARY KEY,
                    "userName" VARCHAR(100) NOT NULL,
                    email VARCHAR(255) NOT NULL UNIQUE,
                    password VARCHAR(255) NOT NULL,
                    role VARCHAR(50) DEFAULT 'student',
                    is_activated VARCHAR(1) DEFAULT '0',
                    "activationCode" VARCHAR(10),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            console.log('✅ jambuser table created');
        } else {
            const countResult = await pool.query("SELECT COUNT(*) as count FROM jambuser");
            console.log(`📊 Database has ${countResult.rows[0].count} existing users`);
        }
        
        const sessionTable = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'user_sessions'
            );
        `);
        
        if (!sessionTable.rows[0].exists) {
            await pool.query(`
                CREATE TABLE user_sessions (
                    sid VARCHAR NOT NULL PRIMARY KEY,
                    sess JSON NOT NULL,
                    expire TIMESTAMP NOT NULL
                );
            `);
            console.log('✅ user_sessions table created');
        }
        
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
    }
}

// =========================
// (REST OF YOUR CODE REMAINS EXACTLY THE SAME)
// =========================
