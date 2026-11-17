const express = require('express');
const c = require('../controllers/employeeController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorize('Admin'));

router.get('/', c.listEmployees);
router.post('/', c.createEmployee);
router.get('/:id', c.getEmployee);
router.patch('/:id', c.updateEmployee);
router.patch('/:id/deactivate', c.deactivateEmployee);
router.patch('/:id/reactivate', c.reactivateEmployee);
router.patch('/:id/pin', c.resetPin);

module.exports = router;