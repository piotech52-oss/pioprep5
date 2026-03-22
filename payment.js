// payment.js - Complete Payment Routes for Supabase PostgreSQL
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

// ==================== SENDGRID EMAIL SETUP ====================
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey('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');

// ==================== SUPABASE PostgreSQL CONNECTION ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Supabase
    }
});

// Test connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Supabase connection error:', err.message);
    } else {
        console.log('✅ Connected to Supabase PostgreSQL (Payment Routes)');
        release();
        createTables();
    }
});

// ==================== CREATE TABLES ====================
async function createTables() {
    try {
        // Create user_payments table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_payments (
                id SERIAL PRIMARY KEY,
                email VARCHAR(100) NOT NULL,
                payment_id VARCHAR(100) NOT NULL UNIQUE,
                amount DECIMAL(10,2) NOT NULL,
                currency VARCHAR(10) DEFAULT 'NGN',
                payment_method VARCHAR(50) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                transaction_date TIMESTAMP NOT NULL,
                note TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE INDEX IF NOT EXISTS idx_user_payments_email ON user_payments(email);
            CREATE INDEX IF NOT EXISTS idx_user_payments_payment_id ON user_payments(payment_id);
        `);
        console.log('✅ user_payments table ready');

        // Create payment_notifications table with BOOLEAN for is_read (matching your database)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS payment_notifications (
                id SERIAL PRIMARY KEY,
                payment_id VARCHAR(100) NOT NULL,
                user_email VARCHAR(100) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                currency VARCHAR(10) NOT NULL,
                payment_method VARCHAR(50) NOT NULL,
                status VARCHAR(50) NOT NULL,
                note TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                admin_notified BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE INDEX IF NOT EXISTS idx_payment_notifications_payment_id ON payment_notifications(payment_id);
            CREATE INDEX IF NOT EXISTS idx_payment_notifications_user_email ON payment_notifications(user_email);
            CREATE INDEX IF NOT EXISTS idx_payment_notifications_is_read ON payment_notifications(is_read);
        `);
        console.log('✅ payment_notifications table ready');

    } catch (err) {
        console.error('❌ Error creating tables:', err.message);
    }
}

// ==================== EMAIL FUNCTIONS ====================

// Send admin email notification - UPDATED with proper footer
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
                    <p>A new payment has been received:</p>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <table style="width: 100%; border-collapse: collapse;">
                                 <tr>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; width: 30%;"><strong>Payment ID:</strong></td>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-family: monospace;">${payment_id}</td>
                                 </tr>
                                 <tr>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>User Email:</strong></td>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;">${user_email}</td>
                                 </tr>
                                 <tr>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>Amount:</strong></td>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>${currency === 'NGN' ? '₦' : ''}${amount}</strong></td>
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
                    
                    <div style="margin-top: 30px; text-align: center;">
                        <a href="http://localhost:3000/admin-dashboard.html" 
                           style="display: inline-block; background: #1a237e; color: white; padding: 15px 30px; 
                                  text-decoration: none; border-radius: 5px; font-weight: bold;">
                            Go to Admin Dashboard
                        </a>
                    </div>
                    
                    <!-- Required Footer for Spam Prevention -->
                    <div style="margin-top: 30px; padding: 20px; border-top: 2px solid #e0e0e0; font-size: 12px; color: #666;">
                        <p style="margin: 5px 0;">
                            <strong>PIO Prep Educational Services</strong><br>
                            1 Ziks Avenue, Awka, Anambra State, Nigeria<br>
                            support@pioprep.com.ng
                        </p>
                        <p style="margin: 10px 0 0;">
                            This is a transactional email from PIO Prep.<br>
                            <a href="https://pioprep.com.ng/unsubscribe" style="color: #1a237e;">Unsubscribe</a> | 
                            <a href="https://pioprep.com.ng/privacy" style="color: #1a237e;">Privacy Policy</a>
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        const msg = {
            to: adminEmail,
            from: 'hello@pioprep.com.ng', // ✅ Using verified domain
            subject: `💰 New Payment Received - ${payment_id}`,
            html: emailContent
        };
        
        await sgMail.send(msg);
        
        console.log(`✅ Admin email sent to ${adminEmail}`);
        return true;
    } catch (error) {
        console.error('❌ Error sending admin email:', error);
        return false;
    }
}

// Send user confirmation email - UPDATED with proper footer and from address
async function sendUserConfirmationEmail(email, userName, paymentId, amount) {
    try {
        const emailContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #1a237e 0%, #311b92 100%); padding: 30px; text-align: center;">
                    <h1 style="color: white; margin: 0;">✅ Payment Received</h1>
                </div>
                <div style="padding: 30px; background: white;">
                    <h2 style="color: #1a237e;">Payment Confirmation</h2>
                    <p>Dear ${userName || 'User'},</p>
                    <p>Thank you for your payment! Your details have been received.</p>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <table style="width: 100%; border-collapse: collapse;">
                                 <tr>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; width: 40%;"><strong>Payment ID:</strong></td>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-family: monospace;">${paymentId}</td>
                                 </tr>
                                 <tr>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>Amount:</strong></td>
                                    <td style="padding: 10px; border-bottom: 1px solid #e0e0e0;"><strong>₦${amount}</strong></td>
                                 </tr>
                                 <tr>
                                    <td style="padding: 10px;"><strong>Status:</strong></td>
                                    <td style="padding: 10px;">
                                        <span style="padding: 5px 10px; background: #fff3cd; color: #856404; border-radius: 4px;">
                                            Pending Review
                                        </span>
                                    </td>
                                 </tr>
                             </table>
                    </div>
                    
                    <div style="margin-top: 30px; padding: 15px; background: #e8f4fd; border-radius: 8px;">
                        <p style="margin: 0; color: #2c3e50;">
                            <strong>Next Steps:</strong> Our team will review your payment and send an activation code within 1-2 hours.
                        </p>
                    </div>
                    
                    <!-- Required Footer for Spam Prevention -->
                    <div style="margin-top: 30px; padding: 20px; border-top: 2px solid #e0e0e0; font-size: 12px; color: #666;">
                        <p style="margin: 5px 0;">
                            <strong>PIO Prep Educational Services</strong><br>
                            1 Ziks Avenue, Awka, Anambra State, Nigeria<br>
                            support@pioprep.com.ng
                        </p>
                        <p style="margin: 10px 0 0;">
                            You received this email because you submitted a payment on PIO Prep.<br>
                            If you have questions, contact us at <a href="mailto:support@pioprep.com.ng" style="color: #1a237e;">support@pioprep.com.ng</a><br>
                            <a href="https://pioprep.com.ng/unsubscribe" style="color: #1a237e;">Unsubscribe</a> | 
                            <a href="https://pioprep.com.ng/privacy" style="color: #1a237e;">Privacy Policy</a>
                        </p>
                        <p style="margin: 10px 0 0; font-size: 11px;">
                            This is a transactional email from PIO Prep. We respect your privacy and never send spam.
                        </p>
                    </div>
                </div>
            </div>
        `;
        
        const msg = {
            to: email,
            from: 'hello@pioprep.com.ng', // ✅ Using verified domain
            subject: `✅ Payment Received - ${paymentId}`,
            html: emailContent
        };
        
        await sgMail.send(msg);
        
        console.log(`✅ User email sent to ${email}`);
        return true;
    } catch (error) {
        console.error('❌ Error sending user email:', error);
        return false;
    }
}

// Create payment notification - Using BOOLEAN (true/false)
async function createPaymentNotification(paymentData) {
    try {
        const { payment_id, user_email, amount, currency, payment_method, status, note } = paymentData;
        
        const insertQuery = `
            INSERT INTO payment_notifications 
            (payment_id, user_email, amount, currency, payment_method, status, note, is_read, admin_notified) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `;
        
        const result = await pool.query(insertQuery, [
            payment_id, user_email, amount, currency, payment_method, status, note, false, false
        ]);
        
        console.log(`✅ Notification saved: ${payment_id}`);
        
        // Send email to admin
        const emailSent = await sendPaymentEmailNotification(paymentData);
        
        // Update notification with email status (using true/false for BOOLEAN)
        await pool.query(
            "UPDATE payment_notifications SET admin_notified = $1 WHERE id = $2",
            [emailSent, result.rows[0].id]
        );
        
        return {
            success: true,
            notificationId: result.rows[0].id,
            emailSent: emailSent
        };
    } catch (error) {
        console.error('❌ Error saving notification:', error);
        throw error;
    }
}

// ==================== PAYMENT ROUTES ====================

// Serve payment form
router.get('/payment', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

// Handle payment submission - ✅ Redirects to active3.html on success
router.post('/payment', async (req, res) => {
    const { email, payment_id, amount, currency, payment_method, transaction_date, note } = req.body;

    console.log('💰 Payment received:', { email, payment_id, amount });

    // Validate required fields
    if (!email || !payment_id || !amount || !payment_method || !transaction_date) {
        return res.status(400).json({
            success: false,
            message: 'Please fill all required fields'
        });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({
            success: false,
            message: 'Please enter a valid email address'
        });
    }

    // Validate amount
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({
            success: false,
            message: 'Please enter a valid amount'
        });
    }

    try {
        // Check if email exists in jambuser table
        const checkQuery = `SELECT * FROM jambuser WHERE email = $1`;
        const userResult = await pool.query(checkQuery, [email]);

        if (userResult.rows.length < 1) {
            return res.status(400).json({
                success: false,
                message: 'Email not registered. Please register first.'
            });
        }

        const userName = userResult.rows[0].userName || userResult.rows[0].email;

        // Check if payment already exists for this email
        const checkExistingPaymentQuery = `SELECT * FROM user_payments WHERE email = $1`;
        const existingPaymentResult = await pool.query(checkExistingPaymentQuery, [email]);

        if (existingPaymentResult.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'This email has already submitted payment. Contact support.'
            });
        }

        // Check if payment_id already exists
        const checkPaymentIdQuery = `SELECT * FROM user_payments WHERE payment_id = $1`;
        const paymentIdResult = await pool.query(checkPaymentIdQuery, [payment_id]);

        if (paymentIdResult.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'This payment ID has already been used.'
            });
        }

        // Insert the payment record
        const insertQuery = `
            INSERT INTO user_payments 
            (email, payment_id, amount, currency, payment_method, status, transaction_date, note) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `;
        
        await pool.query(insertQuery, [
            email, payment_id, amountNum, currency || 'NGN', 
            payment_method, 'pending', transaction_date, note || ''
        ]);

        console.log(`✅ Payment saved: ${payment_id} for ${email}`);

        // Send notifications (don't await to not block response)
        createPaymentNotification({
            payment_id,
            user_email: email,
            amount: amountNum,
            currency: currency || 'NGN',
            payment_method,
            status: 'pending',
            note: note || ''
        }).catch(err => console.error('Background notification error:', err));
        
        sendUserConfirmationEmail(email, userName, payment_id, amountNum)
            .catch(err => console.error('Background email error:', err));

        // ✅ Redirect to active3.html after successful payment
        return res.json({
            success: true,
            message: 'Payment submitted successfully!',
            redirect: '/active3.html'
        });

    } catch (error) {
        console.error('❌ Payment error:', error);
        return res.status(500).json({
            success: false,
            message: 'An error occurred. Please try again.'
        });
    }
});

// ==================== API ROUTES ====================

// Get payment notifications - Using false for unread (BOOLEAN)
router.get('/api/payments/notifications', async (req, res) => {
    try {
        const query = `
            SELECT pn.*, ju.username 
            FROM payment_notifications pn
            LEFT JOIN jambuser ju ON pn.user_email = ju.email
            WHERE pn.is_read = false
            ORDER BY pn.created_at DESC
            LIMIT 20
        `;
        
        const result = await pool.query(query);
        
        res.json({
            success: true,
            notifications: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('❌ Error fetching notifications:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Get recent payments
router.get('/api/payments/recent', async (req, res) => {
    try {
        const query = `
            SELECT up.*, ju.username 
            FROM user_payments up
            LEFT JOIN jambuser ju ON up.email = ju.email
            ORDER BY up.created_at DESC
            LIMIT 10
        `;
        
        const result = await pool.query(query);
        
        res.json({
            success: true,
            payments: result.rows
        });
    } catch (error) {
        console.error('❌ Error fetching recent payments:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Mark notification as read - Using true for read (BOOLEAN)
router.post('/api/payments/notifications/:id/read', async (req, res) => {
    try {
        await pool.query(
            "UPDATE payment_notifications SET is_read = true WHERE id = $1",
            [req.params.id]
        );
        
        res.json({ success: true, message: 'Notification marked as read' });
    } catch (error) {
        console.error('❌ Error marking notification as read:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Get all payments with filters
router.get('/api/payments/all', async (req, res) => {
    try {
        const { status, email, start_date, end_date } = req.query;
        let query = `
            SELECT up.*, ju.username 
            FROM user_payments up
            LEFT JOIN jambuser ju ON up.email = ju.email
            WHERE 1=1
        `;
        
        const params = [];
        let paramCount = 1;
        
        if (status && status !== 'all') {
            query += ` AND up.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }
        
        if (email) {
            query += ` AND up.email ILIKE $${paramCount}`;
            params.push(`%${email}%`);
            paramCount++;
        }
        
        if (start_date) {
            query += ` AND up.transaction_date >= $${paramCount}`;
            params.push(start_date);
            paramCount++;
        }
        
        if (end_date) {
            query += ` AND up.transaction_date <= $${paramCount}`;
            params.push(end_date);
            paramCount++;
        }
        
        query += ` ORDER BY up.created_at DESC`;
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            payments: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('❌ Error fetching payments:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Get payment statistics
router.get('/api/payments/stats', async (req, res) => {
    try {
        const totalResult = await pool.query('SELECT COUNT(*) as total FROM user_payments');
        const completedResult = await pool.query("SELECT COUNT(*) as completed FROM user_payments WHERE status = 'completed'");
        const pendingResult = await pool.query("SELECT COUNT(*) as pending FROM user_payments WHERE status = 'pending'");
        const revenueResult = await pool.query("SELECT SUM(amount) as revenue FROM user_payments WHERE status = 'completed'");
        
        res.json({
            success: true,
            stats: {
                total: parseInt(totalResult.rows[0].total) || 0,
                completed: parseInt(completedResult.rows[0].completed) || 0,
                pending: parseInt(pendingResult.rows[0].pending) || 0,
                revenue: parseFloat(revenueResult.rows[0].revenue) || 0
            }
        });
    } catch (error) {
        console.error('❌ Error fetching stats:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Health check
router.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            success: true,
            status: 'healthy', 
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            status: 'unhealthy', 
            database: 'disconnected',
            error: error.message 
        });
    }
});

// Test notification route
router.get('/test-notification', async (req, res) => {
    try {
        const testPayment = {
            payment_id: 'TEST-' + Date.now(),
            user_email: 'test@example.com',
            amount: 4000.00,
            currency: 'NGN',
            payment_method: 'Test Payment',
            status: 'pending',
            note: 'Test notification'
        };
        
        const result = await createPaymentNotification(testPayment);
        
        res.json({
            success: true,
            message: 'Test notification sent',
            result: result
        });
    } catch (error) {
        console.error('❌ Test notification error:', error);
        res.status(500).json({
            success: false,
            message: 'Test notification failed',
            error: error.message
        });
    }
});

module.exports = router;