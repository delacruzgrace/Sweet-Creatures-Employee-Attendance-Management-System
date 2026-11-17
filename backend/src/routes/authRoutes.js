const express = require('express');
const { register, login, me, unlockUser } = require('../controllers/authController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', login);
router.get('/me', authenticate, me);

// Admin-only: create employees and unlock accounts
router.post('/register', authenticate, authorize('Admin'), register);
router.patch('/users/:id/unlock', authenticate, authorize('Admin'), unlockUser);

module.exports = router;