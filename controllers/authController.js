const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const signup = async (req, res, next) => {
  try {
    const { name, email, password, confirmPassword, phone, address, role = 'buyer' } = req.body;

    if (!name || !email || !password || !confirmPassword || !phone || !address) {
      return res.status(400).json({ error: 'Name, email, password, confirm password, phone, and address are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    // Password complexity check: At least one number and one special character
    const passwordRegex = /^(?=.*[0-9])(?=.*[!@#$%^&*(),.?":{}|<>]).*$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one number and one special character.' });
    }

    // Check if user already exists
    const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user into the database
    const result = await pool.query(
      'INSERT INTO users (name, email, password, phone, address, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, role',
      [name, email, hashedPassword, phone, address, role]
    );

    const user = result.rows[0];

    // Generate a JWT token (Matches the structure seen in your index.html)
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your_default_secret',
      { expiresIn: '1h' }
    );

    res.status(201).json({
      message: 'User registered successfully',
      user,
      token
    });
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // 1. Find user by email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // 2. Compare passwords
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // 3. Generate JWT Token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your_default_secret',
      { expiresIn: '1h' }
    );

    // 4. Send response (preventing the hang)
    res.status(200).json({
      message: 'Login successful',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      token
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { signup, login };