const attendanceService = require('../services/attendanceService');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['Present', 'Late', 'Absent', 'On Leave']; 

function handleError(res, err) {
  if (err.status) return res.status(err.status).json({ success: false, message: err.message });
  console.error(err);
  return res.status(500).json({ success: false, message: 'Internal server error' });
}

exports.clockIn = async (req, res) => {
  try {
    const record = await attendanceService.clockIn(req.user.user_id);
    res.status(201).json({ success: true, message: `Clocked in (${record.status})`, data: record });
  } catch (err) {
    handleError(res, err);
  }
};

exports.clockOut = async (req, res) => {
  try {
    const record = await attendanceService.clockOut(req.user.user_id);
    res.json({ success: true, message: 'Clocked out', data: record });
  } catch (err) {
    handleError(res, err);
  }
};

exports.getAttendance = async (req, res) => {
  try {
    const { date_from, date_to, status } = req.query;

    if ((date_from && !DATE_RE.test(date_from)) || (date_to && !DATE_RE.test(date_to))) {
      return res.status(400).json({ success: false, message: 'Dates must be YYYY-MM-DD' });
    }
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status filter' });
    }

    const result = await attendanceService.getRecords(req.user, req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};