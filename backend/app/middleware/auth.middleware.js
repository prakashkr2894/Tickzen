import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import TrialAdmin from '../models/TrialAdmin.js';


export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided, authorization denied' });
    }

    const token = authHeader.split(' ')[1];
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    let user = await User.findById(decoded.userId).select('-password');
    if (!user) {
      user = await TrialAdmin.findById(decoded.userId).select('-password');
    }
    
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    res.status(500).json({ message: 'Server error during authentication' });
  }
};

export const authorizeAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admin role required.' });
  }

  // Check if trial admin has expired
  if (req.user.isTrialAdmin && req.user.trialExpiresAt) {
    const now = new Date();
    if (now > new Date(req.user.trialExpiresAt)) {
      return res.status(403).json({
        message: 'Your 30-minute admin trial has expired. Please complete payment to continue.',
        trialExpired: true,
        redirectTo: '/signup',
      });
    }
  }

  next();
};

export const authorizeDeveloper = (req, res, next) => {
  if (req.user.role !== 'developer' && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied.' });
  }
  next();
};

export const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};
